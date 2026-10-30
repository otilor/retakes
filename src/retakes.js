import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DevServer } from './devserver.js';
import { AgentRun, probeAgent, agentKnows, agentReady } from './agent.js';
import { UserError, spawnGroup, stopTree, Tail, stripAnsi } from './proc.js';
import { installCommand, filesToCopy, EFFORTS, MODELS, isModelName } from './project.js';
import * as G from './git.js';
import { takePrompt, refinePrompt, fixPrompt, continuePrompt } from './prompt.js';
import { FlowRunner, loadFlows, saveFlow, deleteFlow, describeStep } from './flows.js';

const MAX_ERRORS = 20;
// Give hot reload a moment to apply the agent's last edits before replaying flows.
const FLOW_SETTLE_MS = 1500;

/**
 * Owns every version of the app: main (your own checkout) and the takes, each a
 * git worktree with its own dev server and its own Claude Code session.
 */
export class Retakes extends EventEmitter {
  constructor(project, { log = () => {}, agent = {} } = {}) {
    super();
    this.p = project;
    this.log = log;
    this.stateFile = path.join(project.stateDir, 'state.json');
    this.logsDir = path.join(project.stateDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(project.takesDir, { recursive: true });
    this.state = this.loadState();
    // The model and effort picked in the dock. --model and --effort on the command line replace the saved pick.
    const saved = this.state.agent || {};
    this.state.agent = {
      model: agent.model || (isModelName(saved.model) ? saved.model : null),
      effort: agent.effort || (EFFORTS.includes(saved.effort) ? saved.effort : null),
    };
    this.takes = new Map();
    this.branch = null;
    this.flowsShotDir = path.join(project.stateDir, 'flows');
    this.flows = loadFlows(project.appDir);
    this.flowRunner = new FlowRunner({
      appDir: project.appDir,
      runtimeDir: path.join(path.dirname(path.dirname(project.stateDir)), 'runtime'),
      log: (...a) => this.log(...a),
      notice: (kind, text) => this.notice(kind, text),
    });
    this.main = {
      id: 'main',
      errors: new Map(),
      flows: new Map(),
      flowsGen: 0,
      server: new DevServer({
        project,
        appDir: project.appDir,
        stopAt: project.gitRoot,
        logFile: path.join(this.logsDir, 'main.log'),
      }),
    };
    this.main.server.on('change', (info) => this.onServerChange('main', info));
    this.emitTimer = null;
    this.closed = false;
  }

  // ---------- state ----------

  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s && Array.isArray(s.takes) && Number.isInteger(s.next)) return s;
    } catch {
      /* first run */
    }
    return { v: 1, next: 1, takes: [] };
  }

  save() {
    this.state.takes = [...this.takes.values()].map((t) => t.meta);
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  changed() {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('state', this.snapshot());
    }, 40);
  }

  notice(kind, text, extra = {}) {
    this.emit('notice', { kind, text, at: Date.now(), ...extra });
  }

  snapshot() {
    const errs = (m) => [...m.values()].sort((a, b) => b.at - a.at);
    const versions = [
      {
        id: 'main',
        kind: 'main',
        label: 'main',
        branch: this.branch,
        server: this.main.server.info(),
        errors: errs(this.main.errors),
        flows: this.flowResults(this.main),
        switchable: this.main.server.status === 'ready',
      },
    ];
    for (const t of this.takes.values()) {
      const m = t.meta;
      versions.push({
        id: m.id,
        kind: 'take',
        n: m.n,
        label: `agent-${m.n}`,
        prompt: m.prompt,
        element: m.element ? { selector: m.element.selector, component: m.element.component, text: m.element.text } : null,
        branch: m.branch,
        takeOf: m.takeOf || null,
        attempt: m.attempt || 1,
        phase: t.phase,
        phaseError: t.phaseError,
        server: t.server ? t.server.info() : { status: 'stopped', port: null, error: null },
        agent: { ...t.agent },
        runs: m.runs.length,
        canRetry: !t.run && m.runs.length > 0 && m.runs[m.runs.length - 1].ok === false,
        lastResult: lastResult(m),
        model: m.model || null,
        effort: m.effort || null,
        errors: errs(t.errors),
        flows: this.flowResults(t),
        switchable: !!t.server && t.server.status === 'ready',
        createdAt: m.createdAt,
      });
    }
    const flows = this.flows.map((f) => ({ id: f.id, name: f.name, start: f.start, steps: f.steps.length }));
    return { project: { name: this.p.name, branch: this.branch }, versions, flows, agent: this.agentInfo() };
  }

  // ---------- model and effort ----------

  /** The model and effort the next run uses: the dock's pick, else the config, else Sonnet on low. */
  agentChoice() {
    const cfg = this.p.config.agent || {};
    return {
      model: this.state.agent.model || cfg.model || 'sonnet',
      effort: this.state.agent.effort || cfg.effort || 'low',
    };
  }

  agentInfo() {
    const extra = (this.p.config.agent && this.p.config.agent.args) || [];
    const has = (flag) => extra.some((a) => a === flag || a.startsWith(`${flag}=`));
    const knows = agentKnows('--effort');
    // agent.args with its own --model or --effort wins, so show that.
    const choice = this.agentChoice();
    const model = flagValue(extra, '--model') || choice.model;
    const effort = flagValue(extra, '--effort') || choice.effort;
    return {
      model,
      effort,
      models: MODELS.includes(model) ? MODELS : [...MODELS, model],
      // null until we know; false when this Claude Code has no --effort.
      efforts: knows === null ? null : knows ? EFFORTS : false,
      locked: { model: has('--model'), effort: has('--effort') },
    };
  }

  setAgent({ model, effort } = {}) {
    if (model !== undefined && !isModelName(model)) throw new UserError('Pick a model, like sonnet, haiku or opus.');
    if (effort !== undefined && !EFFORTS.includes(effort)) throw new UserError(`Effort is one of ${EFFORTS.join(', ')}.`);
    if (model !== undefined) this.state.agent.model = model;
    if (effort !== undefined) this.state.agent.effort = effort;
    const now = this.agentChoice();
    this.log(`agent: new runs use ${now.model}, ${now.effort} effort`);
    this.save();
    this.changed();
    return this.agentInfo();
  }

  flowResults(v) {
    return this.flows.map((f) => {
      const r = v.flows.get(f.id);
      if (!r) return { id: f.id, name: f.name, status: 'none' };
      return {
        id: f.id,
        name: f.name,
        status: r.status,
        failedStep: r.failedStep || null,
        error: r.error || null,
        problems: r.problems || [],
        alsoOnMain: !!r.alsoOnMain,
        shot: !!r.shot,
        ms: r.ms || null,
      };
    });
  }

  version(id) {
    if (id === 'main') return this.main;
    return this.takes.get(id) || null;
  }

  /** Where the proxy should send requests for a version, or null if it isn't serving. */
  target(id) {
    const v = this.version(id);
    const s = v && v.server;
    if (!s || s.status !== 'ready') return null;
    return { host: s.host, port: s.port };
  }

  logFile(id) {
    return path.join(this.logsDir, `${id}.log`);
  }

  // ---------- lifecycle ----------

  async start() {
    // Once we know whether this Claude Code takes --effort, the dock can offer it.
    probeAgent((this.p.config.agent && this.p.config.agent.command) || 'claude').then(() => {
      const cfg = this.p.config.agent || {};
      if (agentKnows('--effort') === false && (this.state.agent.effort || cfg.effort)) {
        this.log('agent: your Claude Code has no --effort, so the effort setting is ignored. Update Claude Code to use it.');
      }
      this.changed();
    });
    this.branch = await G.currentBranch(this.p.gitRoot).catch(() => null);
    this.branchTimer = setInterval(async () => {
      const b = await G.currentBranch(this.p.gitRoot).catch(() => this.branch);
      if (b !== this.branch) {
        this.branch = b;
        this.changed();
      }
    }, 5000);
    this.branchTimer.unref();
    const main = this.main.server.start();
    for (const meta of this.state.takes) this.restoreTake(meta);
    this.save();
    await main;
  }

  restoreTake(meta) {
    if (!fs.existsSync(meta.appDir)) {
      this.log(`agent-${meta.n}: its folder is gone, so it was removed`);
      return;
    }
    const t = this.newRuntime(meta);
    const last = meta.runs[meta.runs.length - 1];
    if (last && last.ok === undefined) {
      last.ok = false;
      last.error = 'Retakes was closed while the agent was working.';
      // Claude Code refuses a --session-id it has seen before, so start the next run on a fresh one.
      if (!meta.hasSession) meta.sessionId = crypto.randomUUID();
    }
    t.agent = last
      ? { status: last.ok ? 'done' : last.stopped ? 'stopped' : 'failed', step: null, error: last.ok ? null : last.error || null, startedAt: null }
      : { status: 'idle', step: null, error: null, startedAt: null };
    this.takes.set(meta.id, t);
    const lockRel = path.relative(this.p.gitRoot, this.p.pm.root);
    this.bootTake(t, { install: !fs.existsSync(path.join(meta.dir, lockRel, 'node_modules')) });
  }

  async shutdown() {
    this.closed = true;
    clearInterval(this.branchTimer);
    clearTimeout(this.emitTimer);
    const jobs = [this.main.server.stop()];
    for (const t of this.takes.values()) {
      if (t.run) jobs.push(t.run.stop());
      if (t.install) jobs.push(t.install.stop());
      if (t.server) jobs.push(t.server.stop());
    }
    jobs.push(this.flowRunner.close());
    await Promise.allSettled(jobs);
    try {
      this.save();
    } catch {
      /* best effort */
    }
  }

  onServerChange(id, info) {
    this.changed();
    const name = id === 'main' ? 'Your dev server' : `agent-${this.takes.get(id)?.meta.n}'s dev server`;
    if (info.status === 'failed') {
      this.log(`${id === 'main' ? 'main' : name}: failed to start`, info.error);
      this.notice('error', `${name} didn't start. See the terminal for details.`, { version: id });
    } else if (info.status === 'crashed') {
      this.log(`${name} stopped`, info.error);
      this.notice('error', `${name} stopped.`, { version: id });
    } else if (info.status === 'ready') {
      this.log(`${id === 'main' ? 'main' : `agent-${this.takes.get(id)?.meta.n}`}: dev server ready on port ${info.port}`);
    }
  }

  // ---------- takes ----------

  newRuntime(meta) {
    return {
      meta,
      phase: 'setup',
      phaseError: null,
      server: null,
      install: null,
      run: null,
      agent: { status: 'idle', step: null, error: null, startedAt: null },
      errors: new Map(),
      flows: new Map(),
      flowsGen: 0,
      flowsPending: false,
    };
  }

  async createTake({ prompt, element, from }) {
    let attempt = 1;
    let takeOf = null;
    if (from) {
      const src = this.takes.get(from);
      if (!src) throw new UserError("That take doesn't exist anymore.");
      prompt = src.meta.prompt;
      element = src.meta.element;
      takeOf = src.meta.takeOf || src.meta.id;
      attempt = 1 + [...this.takes.values()].filter((t) => (t.meta.takeOf || t.meta.id) === takeOf).length;
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new UserError('Describe the change you want.');
    if (prompt.length > 8000) throw new UserError('That prompt is too long. Keep it under 8,000 characters.');

    const n = this.state.next++;
    const id = `t${n}`;
    let branch = `retakes/take-${n}`;
    for (let i = 2; await G.branchExists(this.p.gitRoot, branch); i++) branch = `retakes/take-${n}-${i}`;
    const dir = path.join(this.p.takesDir, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const meta = {
      id,
      n,
      prompt: prompt.trim(),
      element: element || null,
      takeOf,
      attempt,
      branch,
      dir,
      appDir: path.join(dir, this.p.rel),
      base: this.branch,
      baseSha: await G.headSha(this.p.gitRoot),
      sessionId: crypto.randomUUID(),
      hasSession: false,
      copied: [],
      runs: [],
      cost: 0,
      createdAt: Date.now(),
    };
    const t = this.newRuntime(meta);
    this.takes.set(id, t);
    this.save();
    this.changed();
    this.log(`agent-${n}: started "${clip(meta.prompt, 70)}"`);

    try {
      await G.addWorktree(this.p.gitRoot, dir, branch, meta.baseSha);
    } catch (err) {
      this.takes.delete(id);
      this.save();
      this.changed();
      throw new UserError(`Couldn't create a worktree for agent-${n}: ${err.message}`);
    }
    meta.copied = this.copyFiles(meta);
    this.save();

    this.runAgent(t, 'start', meta.prompt, takePrompt({ request: meta.prompt, element: meta.element, take: attempt }));
    this.bootTake(t, { install: true });
    return this.snapshot().versions.find((v) => v.id === id);
  }

  copyFiles(meta) {
    const copied = [];
    for (const rel of filesToCopy(this.p.appDir, this.p.config)) {
      const src = path.join(this.p.appDir, rel);
      const dst = path.join(meta.appDir, rel);
      if (fs.existsSync(dst)) continue;
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied.push(path.join(this.p.rel, rel));
      } catch (err) {
        this.log(`agent-${meta.n}: couldn't copy ${rel}: ${err.message}`);
      }
    }
    return copied;
  }

  async bootTake(t, { install }) {
    const m = t.meta;
    try {
      if (install) {
        t.phase = 'installing';
        this.changed();
        await this.installDeps(t);
        if (!this.takes.has(m.id)) return;
      }
      t.phase = 'starting';
      this.changed();
      t.server = new DevServer({ project: this.p, appDir: m.appDir, stopAt: m.dir, logFile: this.logFile(m.id) });
      t.server.on('change', (info) => {
        if (info.status === 'ready') {
          t.phase = 'live';
          if (t.flowsPending) this.flowsAfterRun(t);
        }
        else if (info.status === 'failed' || info.status === 'crashed') {
          t.phase = 'failed';
          t.phaseError = info.error;
        }
        this.onServerChange(m.id, info);
      });
      await t.server.start();
    } catch (err) {
      if (!this.takes.has(m.id)) return;
      t.phase = 'failed';
      t.phaseError = err.message;
      this.log(`agent-${m.n}: setup failed`, err.message);
      this.notice('error', `agent-${m.n} couldn't be set up: ${clip(firstLine(err.message), 90)}`, { version: m.id });
      this.changed();
    }
  }

  installDeps(t) {
    const m = t.meta;
    const lockRel = path.relative(this.p.gitRoot, this.p.pm.root);
    let cmd;
    let args;
    let shell = false;
    let cwd;
    if (this.p.config.setup) {
      cmd = this.p.config.setup;
      args = [];
      shell = true;
      cwd = m.appDir;
    } else {
      [cmd, args] = installCommand(this.p.pm);
      shell = process.platform === 'win32';
      cwd = path.join(m.dir, lockRel);
    }
    this.log(`agent-${m.n}: installing dependencies (${shell && !args.length ? cmd : `${cmd} ${args.join(' ')}`})`);
    const log = fs.createWriteStream(this.logFile(m.id), { flags: 'a' });
    log.write(`\n--- setup: ${cmd} ${args.join(' ')} in ${cwd}\n`);
    const tail = new Tail(40);
    return new Promise((resolve, reject) => {
      const child = spawnGroup(cmd, args, { cwd, env: { ...process.env, NO_COLOR: '1' }, shell });
      let stopped = false;
      t.install = {
        stop: () => {
          stopped = true;
          return stopTree(child);
        },
      };
      const onData = (d) => {
        log.write(d);
        tail.push(stripAnsi(d));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => onData(`${err.message}\n`));
      child.on('close', (code) => {
        log.end();
        t.install = null;
        if (stopped) return reject(new Error('Setup was stopped.'));
        if (code === 0) resolve();
        else reject(new Error(`\`${cmd}${args.length ? ` ${args.join(' ')}` : ''}\` failed:\n${tail.text(15)}`));
      });
    });
  }

  runAgent(t, kind, text, promptText) {
    const m = t.meta;
    if (t.run) throw new UserError(`agent-${m.n} is still working. Wait for it, or stop it first.`);
    const { model, effort } = this.agentChoice();
    const run = new AgentRun({
      cwd: m.appDir,
      prompt: promptText,
      sessionId: m.sessionId,
      resume: m.hasSession,
      config: {
        ...(this.p.config.agent || {}),
        model,
        effort,
        args: [...(this.p.rel ? ['--add-dir', m.dir] : []), ...((this.p.config.agent && this.p.config.agent.args) || [])],
      },
      logFile: this.logFile(m.id),
    });
    const entry = { kind, text, at: Date.now() };
    m.runs.push(entry);
    t.run = run;
    t.agent = { status: 'running', step: kind === 'fix' ? 'Looking at the errors' : 'Reading the code', error: null, startedAt: Date.now() };
    t.errors.clear();
    this.resetFlows(t);
    this.save();
    this.changed();
    run.on('step', (s) => {
      t.agent.step = s;
      this.changed();
    });
    // Save the session as soon as it exists, so a follow-up resumes it even if this run fails.
    run.on('session', (sid) => {
      m.hasSession = true;
      m.sessionId = sid;
      this.save();
    });
    // Wait for the `claude --help` probe, so a run started right after launch still gets --effort.
    agentReady()
      .then(() => {
        // What this run really got: agent.args can name its own, and older Claude Codes have no --effort.
        const args = run.args();
        entry.model = m.model = flagValue(args, '--model');
        entry.effort = m.effort = flagValue(args, '--effort');
        this.save();
        this.changed();
        return run.start().done();
      })
      .then(async (res) => {
        t.run = null;
        if (run.sessionSeen) {
          m.hasSession = true;
          m.sessionId = run.sessionSeen;
        } else if (!m.hasSession) {
          // Claude Code refuses a --session-id it has seen before, so the next run gets a fresh one.
          m.sessionId = crypto.randomUUID();
        }
        entry.ok = res.ok;
        entry.cost = res.cost || 0;
        m.cost = Math.round(((m.cost || 0) + entry.cost) * 10000) / 10000;
        if (!this.takes.has(m.id)) return;
        if (res.ok) {
          entry.result = clip(res.result || '', 600);
          let sha = null;
          let commitError = null;
          try {
            sha = await G.commitAll(m.dir, commitMessage(m, kind, text), m.copied);
          } catch (err) {
            commitError = err.message;
            this.log(`agent-${m.n}: couldn't commit its work`, err.message);
          }
          entry.commit = sha;
          t.agent = { status: 'done', step: null, error: null, startedAt: null };
          t.errors.clear();
          this.log(`agent-${m.n}: done${sha || commitError ? '' : ', no changes'}`);
          if (commitError) {
            this.notice('error', `agent-${m.n} finished, but its work couldn't be committed. See the terminal.`, { version: m.id });
          } else if (sha) {
            this.notice('success', `agent-${m.n} is done`, { version: m.id, action: 'view' });
          } else {
            this.notice('warning', `agent-${m.n} finished without changing anything`, { version: m.id });
          }
          this.flowsAfterRun(t);
        } else {
          entry.error = res.error;
          entry.stopped = !!res.stopped;
          t.agent = { status: res.stopped ? 'stopped' : 'failed', step: null, error: res.error, startedAt: null };
          // Keep whatever it got done, so a follow-up can build on it.
          try {
            entry.commit = await G.commitAll(m.dir, `${commitMessage(m, kind, text)} (unfinished)`, m.copied);
          } catch {
            /* nothing to keep */
          }
          if (res.stopped) {
            this.log(`agent-${m.n}: stopped`);
            this.notice('info', `Stopped agent-${m.n}`, { version: m.id });
          } else {
            this.log(`agent-${m.n}: failed`, res.error);
            this.notice('error', `agent-${m.n} hit a problem: ${clip(firstLine(res.error), 90)}`, { version: m.id, action: 'details' });
          }
        }
        this.save();
        this.changed();
      });
  }

  takeOrThrow(id) {
    const t = this.takes.get(id);
    if (!t) throw new UserError("That take doesn't exist anymore.");
    return t;
  }

  followUp(id, text, element = null) {
    const t = this.takeOrThrow(id);
    if (typeof text !== 'string' || !text.trim()) throw new UserError('Describe the change you want.');
    if (text.length > 8000) throw new UserError('That prompt is too long. Keep it under 8,000 characters.');
    const prompt = t.meta.hasSession
      ? refinePrompt(text, element)
      : takePrompt({ request: `${t.meta.prompt}\n\nAlso: ${text}`, element: element || t.meta.element });
    this.runAgent(t, 'refine', text.trim(), prompt);
  }

  /** Run a take's last request again after it failed or was stopped. */
  retry(id) {
    const t = this.takeOrThrow(id);
    const m = t.meta;
    const last = m.runs[m.runs.length - 1];
    if (t.run) throw new UserError(`agent-${m.n} is still working.`);
    if (!last || last.ok) throw new UserError(`agent-${m.n} has nothing to retry.`);
    let prompt;
    if (m.hasSession) prompt = continuePrompt(last.kind === 'start' ? m.prompt : last.text);
    else if (last.kind === 'start') prompt = takePrompt({ request: m.prompt, element: m.element, take: m.attempt || 1 });
    else prompt = takePrompt({ request: `${m.prompt}\n\nAlso: ${last.text}`, element: m.element });
    this.runAgent(t, last.kind, last.text, prompt);
  }

  fix(id) {
    const t = this.takeOrThrow(id);
    const errors = [...t.errors.values()];
    const flows = this.brokenFlows(t);
    if (!errors.length && !flows.length) throw new UserError(`agent-${t.meta.n} has nothing to fix.`);
    const fixText = fixPrompt(errors, flows);
    const prompt = t.meta.hasSession ? fixText : `${takePrompt({ request: t.meta.prompt, element: t.meta.element })}\n\n${fixText}`;
    const what = [errors.length ? plural(errors.length, 'error') : '', flows.length ? plural(flows.length, 'broken flow') : ''].filter(Boolean).join(' and ');
    this.runAgent(t, 'fix', `Fix ${what}`, prompt);
  }

  async stopAgent(id) {
    const t = this.takeOrThrow(id);
    if (t.run) await t.run.stop();
  }

  async keep(id) {
    const t = this.takeOrThrow(id);
    const m = t.meta;
    if (t.run) throw new UserError(`agent-${m.n} is still working. Wait for it, or stop it first.`);
    await G.commitAll(m.dir, `agent-${m.n}: manual changes`, m.copied).catch(() => null);
    const ahead = await G.commitsAhead(this.p.gitRoot, 'HEAD', m.branch);
    if (!ahead) throw new UserError(`agent-${m.n} has nothing that isn't already in ${this.branch || 'your branch'}.`);
    const into = (await G.currentBranch(this.p.gitRoot)) || 'your checkout';
    try {
      await G.mergeBranch(this.p.gitRoot, m.branch, `Keep agent-${m.n}: ${clip(m.prompt, 60)}`);
    } catch (err) {
      throw new UserError(`Couldn't merge agent-${m.n} into ${into}. Nothing was changed.\n${clip(err.message, 600)}`);
    }
    this.log(`agent-${m.n}: kept, merged into ${into}`);
    await this.discard(id, { quiet: true });
    this.branch = into;
    this.notice('success', `Kept agent-${m.n}. It's merged into ${into}.`, { version: 'main' });
    return { into };
  }

  async discard(id, { quiet = false } = {}) {
    const t = this.takeOrThrow(id);
    const m = t.meta;
    this.takes.delete(id);
    this.save();
    this.changed();
    this.emit('removed', id);
    if (t.run) await t.run.stop();
    if (t.install) await t.install.stop().catch(() => {});
    if (t.server) await t.server.stop();
    try {
      await G.removeWorktree(this.p.gitRoot, m.dir, m.branch);
    } catch (err) {
      this.log(`agent-${m.n}: couldn't fully remove its worktree`, err.message);
    }
    if (!quiet) {
      this.log(`agent-${m.n}: discarded`);
      this.notice('info', `Discarded agent-${m.n}`);
    }
  }

  // ---------- recorded flows ----------

  /** Flows that fail on a take but pass on main: the ones the take broke. */
  brokenFlows(t) {
    const out = [];
    for (const f of this.flows) {
      const r = t.flows.get(f.id);
      if (!r || r.status !== 'fail' || r.alsoOnMain) continue;
      out.push({ name: f.name, start: f.start, steps: f.steps.map(describeStep), failedStep: r.failedStep, error: r.error, problems: r.problems || [] });
    }
    return out;
  }

  resetFlows(v) {
    v.flowsGen += 1;
    v.flows.clear();
    v.flowsPending = false;
  }

  /** After a take's agent finishes, replay every flow on it once its dev server is up. */
  flowsAfterRun(t) {
    t.flowsPending = false;
    if (!this.flows.length && !loadFlows(this.p.appDir).length) return;
    if (!t.server || t.server.status !== 'ready') {
      t.flowsPending = true;
      return;
    }
    const gen = t.flowsGen;
    setTimeout(() => {
      if (this.closed || t.flowsGen !== gen || t.run || !this.takes.has(t.meta.id)) return;
      try {
        this.runFlows(t.meta.id).catch((err) => this.log(`agent-${t.meta.n}: couldn't replay flows`, err.message));
      } catch (err) {
        this.log(`agent-${t.meta.n}: couldn't replay flows`, err.message);
      }
    }, FLOW_SETTLE_MS).unref();
  }

  saveFlow(raw, version) {
    const flow = saveFlow(this.p.appDir, raw);
    this.flows = loadFlows(this.p.appDir);
    for (const v of [this.main, ...this.takes.values()]) v.flows.delete(flow.id);
    this.log(`flows: saved "${flow.name}" (${flow.steps.length} steps) to .retakes/flows/${flow.id}.json`);
    this.changed();
    // Replay it right away on the version it was recorded on, so a bad recording shows up now.
    const on = version && this.version(version) && !this.version(version).run ? version : 'main';
    this.runFlows(on, { only: [flow.id], announce: true }).catch((err) => this.log('flows: replay failed', err.message));
    return { id: flow.id, name: flow.name, steps: flow.steps.length };
  }

  deleteFlow(id) {
    deleteFlow(this.p.appDir, id);
    this.flows = loadFlows(this.p.appDir);
    for (const v of [this.main, ...this.takes.values()]) v.flows.delete(id);
    this.changed();
  }

  /** Replay flows on one version. Failures on a take are checked against main before they count. */
  // Checks run before it returns, so the caller gets a UserError right away; the replays run after.
  runFlows(id, { only = null, announce = false } = {}) {
    const v = this.version(id);
    if (!v) throw new UserError("That version doesn't exist anymore.");
    if (id !== 'main' && v.run) throw new UserError(`${this.nameOf(id)} is still working. Its flows run when it's done.`);
    this.flows = loadFlows(this.p.appDir);
    const list = only ? this.flows.filter((f) => only.includes(f.id)) : this.flows;
    if (!list.length) throw new UserError(only ? "That flow doesn't exist anymore." : 'Record a flow first.');
    return this.replayFlows(id, v, list, announce);
  }

  async replayFlows(id, v, list, announce) {
    const gen = v.flowsGen;
    for (const f of list) v.flows.set(f.id, { status: 'queued' });
    this.changed();
    fs.mkdirSync(this.flowsShotDir, { recursive: true });
    const current = () => !this.closed && v.flowsGen === gen && this.version(id) === v;
    const broke = [];
    for (const f of list) {
      await this.flowRunner.enqueue(async () => {
        if (!current()) return;
        const target = this.target(id);
        if (!target) {
          v.flows.set(f.id, { status: 'fail', error: `${this.nameOf(id)}'s dev server isn't running.` });
          return;
        }
        v.flows.set(f.id, { status: 'running' });
        this.changed();
        const shot = path.join(this.flowsShotDir, `${id}-${f.id}.png`);
        fs.rmSync(shot, { force: true });
        const r = await this.flowRunner.replay(f, `http://${target.host}:${target.port}`, { screenshot: shot });
        if (!current()) return;
        const result = { status: r.ok ? 'pass' : 'fail', failedStep: r.failedStep, error: r.error, problems: r.problems, ms: r.ms, shot: fs.existsSync(shot) };
        if (!r.ok && id !== 'main') {
          // Only blame the take for what it broke: if main fails the same way, it was already broken.
          const mainTarget = this.target('main');
          if (mainTarget) {
            const m = await this.flowRunner.replay(f, `http://${mainTarget.host}:${mainTarget.port}`);
            if (this.main.flows.get(f.id)?.status !== 'running') this.main.flows.set(f.id, { status: m.ok ? 'pass' : 'fail', failedStep: m.failedStep, error: m.error, problems: m.problems, ms: m.ms });
            result.alsoOnMain = !m.ok;
          }
          if (!current()) return;
        }
        v.flows.set(f.id, result);
        this.log(`${this.nameOf(id)}: flow "${f.name}" ${r.ok ? 'passed' : `failed${result.alsoOnMain ? ' (fails on main too)' : ''}: ${clip(r.error, 120)}`}`);
        if (!r.ok && !result.alsoOnMain) broke.push({ f, r });
        this.changed();
      });
    }
    if (!current()) return;
    const name = this.nameOf(id);
    if (announce) {
      const f = list[0];
      const r = v.flows.get(f.id);
      if (r && r.status === 'pass') this.notice('success', `Saved "${f.name}". It passes on ${name}.`, { version: id });
      else if (r) this.notice('warning', `Saved "${f.name}", but it didn't pass on ${name}: ${clip(r.error, 80)}`, { version: id, action: 'details' });
    } else if (broke.length && id !== 'main') {
      const text = broke.length === 1 ? `${name} broke "${clip(broke[0].f.name, 40)}": ${clip(broke[0].r.error, 70)}` : `${name} broke ${broke.length} of your flows`;
      this.notice('warning', text, { version: id, action: 'fix' });
    }
  }

  flowShot(id, flow) {
    const v = this.version(id);
    const r = v && v.flows.get(flow);
    if (!r || !r.shot) return null;
    const file = path.join(this.flowsShotDir, `${id}-${flow}.png`);
    return fs.existsSync(file) ? file : null;
  }

  nameOf(id) {
    return id === 'main' ? 'main' : `agent-${this.takes.get(id)?.meta.n}`;
  }

  // ---------- errors from the browser ----------

  reportError(id, err) {
    const v = this.version(id);
    if (!v || !err || typeof err.message !== 'string') return;
    const t = id === 'main' ? null : v;
    // Half-finished edits often break the page for a moment. Only count errors once the agent is done.
    if (t && t.run) return;
    const message = clip(err.message, 500);
    if (!message) return;
    const existing = v.errors.get(message);
    if (existing) {
      existing.count += 1;
      existing.at = Date.now();
    } else {
      if (v.errors.size >= MAX_ERRORS) {
        const oldest = [...v.errors.values()].sort((a, b) => a.at - b.at)[0];
        v.errors.delete(oldest.message);
      }
      v.errors.set(message, { message, stack: clip(err.stack || '', 2000), kind: err.kind === 'build' ? 'build' : 'runtime', count: 1, at: Date.now() });
      const name = id === 'main' ? 'main' : `agent-${t.meta.n}`;
      this.log(`${name}: error in the browser: ${clip(message, 120)}`);
      if (v.errors.size === 1) {
        this.notice('warning', `${name} hit an error: ${clip(firstLine(message), 70)}`, {
          version: id,
          action: id === 'main' ? null : 'fix',
        });
      }
    }
    this.changed();
  }

  clearErrors(id) {
    const v = this.version(id);
    if (!v) return;
    v.errors.clear();
    this.changed();
  }

  readLog(id, maxBytes = 200_000) {
    if (id !== 'main' && !this.takes.has(id)) throw new UserError("That take doesn't exist anymore.");
    const file = this.logFile(id);
    if (!fs.existsSync(file)) return '';
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
}

function lastResult(m) {
  for (let i = m.runs.length - 1; i >= 0; i--) if (m.runs[i].result) return m.runs[i].result;
  return null;
}

function commitMessage(m, kind, text) {
  const head = kind === 'start' ? m.prompt : text;
  return `agent-${m.n}: ${clip(firstLine(head), 72)}\n\nMade with Retakes and Claude Code.`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function firstLine(s) {
  return String(s || '').split('\n').find((l) => l.trim()) || '';
}

function clip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The value given to a flag in an argument list (`--flag v` or `--flag=v`), or null. */
function flagValue(args, flag) {
  const i = args.findIndex((x) => x === flag || x.startsWith(`${flag}=`));
  if (i < 0) return null;
  return args[i].includes('=') ? args[i].slice(flag.length + 1) : args[i + 1] || null;
}
