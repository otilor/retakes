import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRun, describeTool, explainError, setAgentHelp, agentKnows } from '../../src/agent.js';
import { takePrompt, refinePrompt, fixPrompt, describeElement, continuePrompt } from '../../src/prompt.js';

const argsOf = (opts) => new AgentRun({ cwd: '/tmp', prompt: 'x', sessionId: 'sid', ...opts }).args();
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('a first run starts a named session on Sonnet with edits allowed', () => {
  const args = argsOf({});
  assert.deepEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.equal(valueAfter(args, '--permission-mode'), 'acceptEdits');
  assert.equal(valueAfter(args, '--session-id'), 'sid');
  assert.equal(valueAfter(args, '--model'), 'sonnet');
  assert.ok(!args.includes('--resume'));
});

test('agentKnows matches whole flags, not lookalikes', () => {
  setAgentHelp('  --effort <level>  How hard to think\n  --strict-mcp-config');
  assert.equal(agentKnows('--effort'), true);
  assert.equal(agentKnows('--strict-mcp-config'), true);
  setAgentHelp('  --effort-mode <m>\n  Use --effortless to relax');
  assert.equal(agentKnows('--effort'), false);
  setAgentHelp(null);
});

test('a follow-up resumes the same session', () => {
  const args = argsOf({ resume: true });
  assert.equal(valueAfter(args, '--resume'), 'sid');
  assert.ok(!args.includes('--session-id'));
});

test('the configured model wins, and a --model in extra args is not doubled', () => {
  assert.equal(valueAfter(argsOf({ config: { model: 'haiku' } }), '--model'), 'haiku');
  const a = argsOf({ config: { args: ['--model', 'opus'] } });
  assert.equal(a.filter((x) => x === '--model').length, 1);
  assert.equal(valueAfter(a, '--model'), 'opus');
  const b = argsOf({ config: { args: ['--model=opus'] } });
  assert.ok(!b.includes('--model'));
});

test('describeTool turns tool calls into short steps', () => {
  assert.equal(describeTool('Edit', { file_path: '/w/src/App.jsx' }, '/w'), 'Editing src/App.jsx');
  assert.equal(describeTool('Read', { file_path: '/elsewhere/x.js' }, '/w'), 'Reading x.js');
  assert.equal(describeTool('Write', {}, '/w'), 'Writing a file');
  assert.equal(describeTool('Bash', { description: 'Run tests' }, '/w'), 'Run tests');
  assert.equal(describeTool('Grep', {}, '/w'), 'Looking through the code');
  assert.equal(describeTool('Mystery', {}, '/w'), 'Working');
});

test('prompts carry the request, the picked element and the rules', () => {
  const element = { selector: 'form > button', text: 'Search', component: 'SearchBar', source: 'src/SearchBar.jsx:12' };
  const first = takePrompt({ request: '  make it bigger ', element });
  assert.ok(first.includes('"make it bigger"'));
  assert.ok(first.includes('React component: SearchBar (around src/SearchBar.jsx:12)'));
  assert.ok(first.includes("don't commit"));
  assert.ok(!first.includes('This is take'));
  assert.ok(takePrompt({ request: 'x', take: 2 }).includes('This is take 2'));
  assert.ok(refinePrompt('now blue', null).includes('"now blue"'));
  assert.equal(describeElement(null), '');
});

test('fixPrompt lists errors with a short stack and repeat count', () => {
  const p = fixPrompt([{ message: 'boom', stack: 'Error: boom\n at a\n at b', count: 3 }]);
  assert.ok(p.includes('- boom (seen 3 times)'));
  assert.ok(p.includes('    at a'));
});

test('explainError turns sign-in and limit errors into instructions', () => {
  const expired = explainError('Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.ok(expired.startsWith('Claude Code needs you to sign in again.\n'));
  assert.ok(expired.includes('/login'));
  assert.ok(expired.endsWith('(Failed to authenticate: OAuth session expired and could not be refreshed)'));
  assert.ok(explainError('Invalid API key · Fix external API key', { api_error_status: 401 }).startsWith('Claude Code needs you'));
  assert.ok(explainError('Credit balance is too low').startsWith('Your Anthropic credit balance'));
  assert.ok(explainError('Claude AI usage limit reached').startsWith("You've hit a Claude usage limit."));
  assert.ok(explainError('API Error: 529 Overloaded').startsWith('Claude is having trouble'));
  assert.equal(explainError('Mock failure on purpose.'), 'Mock failure on purpose.');
});

test('continuePrompt asks to finish the same request', () => {
  const p = continuePrompt(' widen it ');
  assert.ok(p.includes('"widen it"') && p.includes('Pick up where you left off'));
});

test('speed flags are passed only when this Claude Code version knows them', () => {
  setAgentHelp('  --model <m>');
  const old = argsOf({});
  assert.ok(!old.includes('--effort') && !old.includes('--strict-mcp-config') && !old.includes('--disallowedTools'));
  setAgentHelp('  --effort <level>\n  --strict-mcp-config\n  --disallowedTools <tools...>');
  const now = argsOf({});
  assert.equal(valueAfter(now, '--effort'), 'low');
  assert.ok(now.includes('--strict-mcp-config'));
  assert.deepEqual(now.slice(now.indexOf('--disallowedTools') + 1, now.indexOf('--disallowedTools') + 5), ['Task', 'Agent', 'WebSearch', 'WebFetch']);
  assert.equal(valueAfter(argsOf({ config: { effort: 'high' } }), '--effort'), 'high');
  const own = argsOf({ config: { args: ['--effort=medium', '--mcp-config', 'm.json'] } });
  assert.equal(own.filter((a) => a.startsWith('--effort')).length, 1);
  assert.ok(!own.includes('--strict-mcp-config'));
  setAgentHelp(null);
});
