import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { run, spawnGroup, stopTree, Tail, stripAnsi } from './proc.js';
import { splitArgs } from './project.js';

const isWin = process.platform === 'win32';

let agentHelp = null;

/** Read `claude --help` once, so runs only pass flags this Claude Code version supports. */
export async function probeAgent(command = 'claude') {
  const [cmd, ...pre] = splitArgs(command);
  agentHelp = await run(cmd, [...pre, '--help'], { timeout: 15000 }).catch((err) => err.stdout || '');
  return agentHelp;
}

/** For tests: pretend `claude --help` printed this. */
export function setAgentHelp(text) {
  agentHelp = text;
}

/**
 * One headless Claude Code run in a take's worktree.
 * Emits 'step' with a short description of what the agent is doing.
 * done() resolves with { ok, result, cost, error, stopped }.
 */
export class AgentRun extends EventEmitter {
  constructor({ cwd, prompt, sessionId, resume, config = {}, logFile }) {
    super();
    this.cwd = cwd;
    this.prompt = prompt;
    this.sessionId = sessionId;
    this.resume = resume;
    this.config = config;
    this.logFile = logFile;
    this.child = null;
    this.stopped = false;
    this.lastText = '';
    this.result = null;
    this.sessionSeen = null;
    this.stderr = new Tail(60);
  }

  args() {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.config.permissionMode || 'acceptEdits',
    ];
    if (this.resume) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);
    const extra = this.config.args || [];
    const has = (flag) => extra.some((a) => a === flag || a.startsWith(`${flag}=`));
    // Sonnet by default: good UI work at a fraction of Opus's cost. Set agent.model to change it.
    if (!has('--model')) args.push('--model', this.config.model || 'sonnet');
    // Faster runs for small UI edits: less thinking, no MCP servers to start, no subagents or web
    // lookups. Only flags this Claude Code version knows (see probeAgent); agent.effort overrides.
    const known = (flag) => !!(agentHelp && agentHelp.includes(flag));
    if (!has('--effort') && known('--effort')) args.push('--effort', this.config.effort || 'low');
    if (!has('--mcp-config') && !has('--strict-mcp-config') && known('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (!has('--disallowedTools') && !has('--disallowed-tools') && known('--disallowedTools')) {
      args.push('--disallowedTools', 'Task', 'Agent', 'WebSearch', 'WebFetch');
    }
    args.push(...extra);
    return args;
  }

  start() {
    const [cmd, ...pre] = splitArgs(this.config.command || 'claude');
    const args = [...pre, ...this.args()];
    const log = this.logFile ? fs.createWriteStream(this.logFile, { flags: 'a' }) : null;
    log?.write(`\n--- agent: ${cmd} ${args.join(' ')}\n--- prompt:\n${this.prompt}\n---\n`);
    const env = { ...process.env };
    // A session id inherited from a parent Claude Code session would make the child reuse it.
    delete env.CLAUDE_CODE_SESSION_ID;

    this.promise = new Promise((resolve) => {
      let child;
      try {
        child = spawnGroup(cmd, args, { cwd: this.cwd, env, shell: isWin, stdin: 'pipe' });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      this.child = child;
      let buf = '';
      child.stdout.on('data', (d) => {
        log?.write(d);
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.onLine(line);
        }
      });
      child.stderr.on('data', (d) => {
        log?.write(d);
        this.stderr.push(stripAnsi(d));
      });
      let spawnError = null;
      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('close', (code, signal) => {
        if (buf.trim()) this.onLine(buf.trim());
        log?.end(`\n--- agent exited (${signal || code})\n`);
        this.child = null;
        if (this.stopped) return resolve({ ok: false, stopped: true, error: 'Stopped.' });
        if (spawnError) {
          const missing = spawnError.code === 'ENOENT';
          return resolve({
            ok: false,
            error: missing
              ? `Couldn't find \`${cmd}\`. Install Claude Code (npm i -g @anthropic-ai/claude-code), run \`claude\` once to sign in, then try again.`
              : spawnError.message,
          });
        }
        const r = this.result;
        if (r && !r.is_error && (r.subtype === 'success' || r.subtype === undefined) && code === 0) {
          return resolve({ ok: true, result: r.result || this.lastText, cost: Number(r.total_cost_usd) || 0 });
        }
        const why =
          (r && (r.result || (Array.isArray(r.errors) && r.errors.join('\n')) || r.subtype)) ||
          this.stderr.text(12) ||
          `Claude Code exited with code ${code}.`;
        resolve({ ok: false, error: explainError(why, r), cost: r ? Number(r.total_cost_usd) || 0 : 0 });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(this.prompt);
    });
    return this;
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg.session_id === 'string' && ((msg.type === 'system' && msg.subtype === 'init') || msg.type === 'result')) {
      const first = !this.sessionSeen;
      this.sessionSeen = msg.session_id;
      if (first) this.emit('session', msg.session_id);
    }
    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const c of msg.message.content) {
        if (c.type === 'tool_use') this.emit('step', describeTool(c.name, c.input || {}, this.cwd));
        else if (c.type === 'text' && c.text && c.text.trim()) this.lastText = c.text.trim();
      }
    } else if (msg.type === 'result') {
      this.result = msg;
    }
  }

  done() {
    return this.promise;
  }

  async stop() {
    this.stopped = true;
    if (this.child) await stopTree(this.child, 2000);
  }
}

/**
 * Claude Code's errors that only the user can fix (signing in, limits) become plain
 * instructions, with the original message kept underneath.
 */
export function explainError(text, result) {
  const s = String(text || '').trim();
  const status = Number(result && result.api_error_status) || 0;
  const say = (what, then) => `${what}\n${then}${s ? `\n(${s})` : ''}`;
  if (status === 401 || /oauth|failed to authenticate|not logged in|please run \/login|invalid api key/i.test(s)) {
    return say('Claude Code needs you to sign in again.', 'Run `claude` in a terminal, type /login, then press Retry.');
  }
  if (/credit balance/i.test(s)) {
    return say('Your Anthropic credit balance is too low.', 'Add credit, or sign in with a Claude plan (`claude`, then /login), then press Retry.');
  }
  if (status === 429 || /usage limit|limit reached|rate limit/i.test(s)) {
    return say("You've hit a Claude usage limit.", 'Wait until it resets, then press Retry.');
  }
  if (status >= 500 || /overloaded/i.test(s)) {
    return say('Claude is having trouble on its side.', 'Wait a minute, then press Retry.');
  }
  return s;
}

export function describeTool(name, input, cwd) {
  const file = (p) => {
    if (!p || typeof p !== 'string') return 'a file';
    const rel = cwd && path.isAbsolute(p) ? path.relative(cwd, p) : p;
    return rel.startsWith('..') ? path.basename(p) : rel;
  };
  switch (name) {
    case 'Read':
      return `Reading ${file(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file(input.file_path || input.notebook_path)}`;
    case 'Write':
      return `Writing ${file(input.file_path)}`;
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'Looking through the code';
    case 'Bash':
      return input.description ? String(input.description).slice(0, 80) : 'Running a command';
    case 'TodoWrite':
      return 'Planning the change';
    case 'Task':
    case 'Agent':
      return 'Working on a subtask';
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up';
    default:
      return 'Working';
  }
}
