#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json` in tests. It speaks the same
// stream-json lines, edits the fixture app based on keywords in the prompt, and records
// every call so tests can check the flags Retakes passed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag('--resume') || flag('--session-id') || crypto.randomUUID();
const prompt = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...o })}\n`);

if (process.env.RETAKES_MOCK_LOG) {
  fs.appendFileSync(process.env.RETAKES_MOCK_LOG, `${JSON.stringify({ cwd, args, prompt, at: Date.now() })}\n`);
}

const edit = async (rel, from, to) => {
  const file = path.join(cwd, rel);
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } });
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) throw new Error(`mock: "${from}" not found in ${rel}`);
  fs.writeFileSync(file, src.replace(from, to));
  await sleep(Number(process.env.RETAKES_MOCK_STEP_MS || 700));
};

out({ type: 'system', subtype: 'init', cwd, model: flag('--model') || 'default', permissionMode: flag('--permission-mode') });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'src/App.jsx') } }] } });
await sleep(300);

const request = (prompt.match(/"([^"]+)"/) || [])[1] || prompt;
try {
  if (/signin/i.test(request)) {
    if (flag('--session-id')) {
      // Like Claude Code when its sign-in has expired: a synthetic reply, then an error result.
      const msg = 'Failed to authenticate: OAuth session expired and could not be refreshed';
      out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: msg }] } });
      out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: msg, total_cost_usd: 0 });
      process.exit(1);
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Signed in now, so I finished it.' }] } });
  } else if (/errors in the browser|recorded these flows/.test(prompt)) {
    await edit('src/Filters.jsx', 'setFilters(undefined)', 'setFilters([])');
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed: clearing filters now sets an empty list.' }] } });
  } else if (/fail/i.test(request)) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Mock failure on purpose.', total_cost_usd: 0.002 });
    process.exit(1);
  } else if (/slow/i.test(request)) {
    await sleep(60000);
  } else if (/nothing/i.test(request)) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing needed changing.' }] } });
  } else if (/break/i.test(request)) {
    await edit('src/Filters.jsx', 'setFilters([])', 'setFilters(undefined)');
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Changed how clearing works.' }] } });
  } else if (/blue/i.test(request)) {
    await edit('src/App.css', 'background: #d9512f; color: #fff;', 'background: #2b45e0; color: #fff;');
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Made the search button blue.' }] } });
  } else {
    const n = (prompt.match(/This is take (\d+)/) || [])[1] || '1';
    await edit('src/SearchBar.jsx', 'placeholder="Where to?"', `placeholder="Where to? take ${n}"`);
    await edit('src/SearchBar.jsx', '>Search</button>', `>Search big ${n}</button>`);
    out({ type: 'assistant', message: { content: [{ type: 'text', text: `Made the search bar larger (take ${n}).` }] } });
  }
} catch (err) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: err.message });
  process.exit(1);
}
out({ type: 'result', subtype: 'success', is_error: false, result: 'Done. Made the change.', total_cost_usd: 0.0123, num_turns: 3 });
