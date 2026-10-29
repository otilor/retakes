const RULES = `How to work:
- You're in a git worktree: a private copy of the user's project made for this change. The app's dev server is already running from this folder with hot reload, so the user is watching your edits land live. Don't start a dev server and don't commit; Orchestrator commits your work when you finish.
- Keep the change focused on the request. Don't refactor unrelated code. Don't add dependencies; if a new package is truly needed, say so in your final message instead.
- When you're done, reply with one or two plain sentences on what you changed.`;

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function describeElement(el) {
  if (!el || typeof el !== 'object') return '';
  const lines = [];
  if (el.page) lines.push(`Page: ${clip(el.page, 200)}`);
  if (el.selector) lines.push(`Element: ${clip(el.selector, 200)}`);
  if (el.text) lines.push(`Its text: "${clip(el.text, 160)}"`);
  if (el.component) {
    const where = el.source ? ` (around ${clip(el.source, 200)})` : '';
    lines.push(`React component: ${clip(el.component, 80)}${where}`);
  }
  if (Array.isArray(el.components) && el.components.length) {
    lines.push(`Inside: ${el.components.slice(0, 6).map((c) => clip(c, 60)).join(' › ')}`);
  }
  if (el.html) lines.push(`HTML: ${clip(el.html, 700)}`);
  return lines.join('\n');
}

export function takePrompt({ request, element, take = 1 }) {
  const parts = [`Make this change to the app's UI:\n"${request.trim()}"`];
  const el = describeElement(element);
  if (el) parts.push(`The user pointed at this part of the running app:\n${el}`);
  if (take > 1) {
    parts.push(
      `This is take ${take} of the same request. The user will flip between takes to pick one, so make a noticeably different choice from the most obvious one.`
    );
  }
  parts.push(RULES);
  return parts.join('\n\n');
}

export function refinePrompt(request, element) {
  const el = describeElement(element);
  return `The user wants a follow-up change, building on your previous work:\n"${request.trim()}"${
    el ? `\n\nThey pointed at this part of the running app:\n${el}` : ''
  }\n\nSame rules as before: keep it focused, don't start servers, don't commit, and end with one or two sentences on what you changed.`;
}

export function fixPrompt(errors) {
  const list = errors
    .slice(0, 8)
    .map((e) => {
      const stack = String(e.stack || '')
        .split('\n')
        .slice(0, 6)
        .map((l) => `    ${l.trim()}`)
        .join('\n');
      return `- ${clip(e.message, 400)}${e.count > 1 ? ` (seen ${e.count} times)` : ''}${stack ? `\n${stack}` : ''}`;
    })
    .join('\n');
  return `The app now shows these errors in the browser:\n${list}\n\nFind the cause and fix it, keeping the change the user asked for. Same rules as before: don't start servers, don't commit, and end with one or two sentences on what you fixed.`;
}

export function continuePrompt(request) {
  return `Your previous run stopped before it finished. Pick up where you left off and finish this request:\n"${request.trim()}"\n\nSame rules as before: keep it focused, don't start servers, don't commit, and end with one or two sentences on what you changed.`;
}
