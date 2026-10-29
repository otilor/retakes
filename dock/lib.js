// Small helpers shared by the dock: the hub API, switching versions, and describing elements.

export const CFG = window.__ORCH__ || {};
const COOKIE = '__orch_v';
const RESTORE = '__orch_restore';

export async function api(path, body) {
  const res = await fetch(`/__orch/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-orch-token': CFG.token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(data.error || `Orchestrator answered ${res.status}.`);
  return data;
}

export function readCookie() {
  const m = document.cookie.match(/(?:^|;\s*)__orch_v=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function setCookie(id) {
  document.cookie = `${COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; SameSite=Lax`;
}

/** Switch the page to another version: same URL, same scroll, then reload through the hub. */
export function switchTo(id, { from } = {}) {
  try {
    sessionStorage.setItem(
      RESTORE,
      JSON.stringify({ to: id, from, path: location.pathname + location.search + location.hash, x: scrollX, y: scrollY, at: Date.now() })
    );
  } catch {
    /* private mode */
  }
  setCookie(id);
  location.reload();
}

/** After a switch, put the scroll position back once the app has rendered enough to reach it. */
export function takeRestore() {
  let r = null;
  try {
    r = JSON.parse(sessionStorage.getItem(RESTORE) || 'null');
    sessionStorage.removeItem(RESTORE);
  } catch {
    return null;
  }
  if (!r || Date.now() - r.at > 30000) return null;
  if (r.path !== location.pathname + location.search + location.hash) return r;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const started = Date.now();
  let userScrolled = false;
  const stopOnUser = () => (userScrolled = true);
  addEventListener('wheel', stopOnUser, { once: true, passive: true });
  addEventListener('touchstart', stopOnUser, { once: true, passive: true });
  addEventListener('keydown', stopOnUser, { once: true });
  const tick = () => {
    if (userScrolled) return;
    const maxY = document.documentElement.scrollHeight - innerHeight;
    if (maxY >= r.y - 2 || Date.now() - started > 3000) {
      scrollTo(r.x, Math.min(r.y, Math.max(0, maxY)));
      if (Math.abs(scrollY - r.y) < 3 || Date.now() - started > 3000) return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return r;
}

export function hueClass(n) {
  return `h${((n - 1) % 8) + 1}`;
}

/** What the agent needs to find the element in the code: selector, text, React component and file. */
export function describeElement(el) {
  const out = {
    page: location.pathname + location.search,
    selector: cssPath(el),
    text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    html: shortHtml(el),
  };
  const react = reactInfo(el);
  if (react) Object.assign(out, react);
  return out;
}

export function shortLabel(el) {
  const info = reactInfo(el);
  const tag = el.tagName.toLowerCase();
  const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
  return `${info && info.component ? `${info.component} · ` : ''}${tag}${cls}`;
}

function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 4 && node !== document.body && node !== document.documentElement) {
    let s = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`${s}#${node.id}`);
      break;
    }
    const cls = [...node.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 2);
    if (cls.length) s += `.${cls.join('.')}`;
    parts.unshift(s);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function shortHtml(el) {
  const clone = el.cloneNode(true);
  const trim = (n) => {
    if (n.nodeType !== 1) return;
    for (const a of [...n.attributes]) {
      if (a.value.length > 80) n.setAttribute(a.name, `${a.value.slice(0, 77)}...`);
      if (a.name === 'style' && a.value.length > 40) n.setAttribute('style', `${a.value.slice(0, 37)}...`);
    }
    for (const c of n.children) trim(c);
  };
  trim(clone);
  const html = clone.outerHTML.replace(/\s+/g, ' ');
  return html.length > 1200 ? `${html.slice(0, 1197)}...` : html;
}

function reactInfo(el) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (!key) return null;
  let fiber = el[key];
  const names = [];
  let source = null;
  if (fiber && fiber._debugSource) source = fmtSource(fiber._debugSource);
  if (!source && fiber && fiber._debugStack) source = fromStack(fiber._debugStack);
  for (let f = fiber; f && names.length < 8; f = f.return) {
    // The owner is the component that rendered this element; for a server component it's a plain
    // { name, env } object. Framework wrappers (Next's routers and boundaries) are skipped.
    const owner = f._debugOwner;
    const ownerName = owner ? (typeof owner.name === 'string' ? owner.name : componentName(owner.type)) : null;
    for (const name of [ownerName, componentName(f.type)]) {
      if (name && !FRAMEWORK.test(name) && !names.includes(name)) names.push(name);
    }
    if (!source && f._debugSource && names.length) source = fmtSource(f._debugSource);
  }
  if (!names.length && !source) return null;
  return { component: names[0] || null, components: names, source };
}

const FRAMEWORK =
  /^(SegmentViewNode|SegmentStateProvider|LayoutRouterContext|InnerLayoutRouter|OuterLayoutRouter|RenderFromTemplateContext|ScrollAndFocusHandler|InnerScrollAndFocusHandler|LoadingBoundary|ErrorBoundary|ErrorBoundaryHandler|RedirectBoundary|RedirectErrorBoundary|HTTPAccessFallbackBoundary|HTTPAccessFallbackErrorBoundary|DevRootHTTPAccessFallbackBoundary|AppRouter|Router|HotReload|ServerRoot|Root|AppDevOverlay|ReplaySsrOnlyErrors|MetadataBoundary|ViewportBoundary|OutletBoundary|__next_[\w]+|Suspense|Fragment)$/;

function componentName(type) {
  if (!type || typeof type === 'string') return null;
  if (typeof type === 'function') return type.displayName || type.name || null;
  if (typeof type === 'object') {
    if (type.displayName) return type.displayName;
    if (type.render) return type.render.displayName || type.render.name || null;
    if (type.type) return componentName(type.type);
  }
  return null;
}

function fmtSource(s) {
  if (!s || !s.fileName) return null;
  return `${s.fileName.replace(/^.*?\/(src|app|components|pages)\//, '$1/')}${s.lineNumber ? `:${s.lineNumber}` : ''}`;
}

function fromStack(err) {
  const stack = String((err && err.stack) || '');
  for (const line of stack.split('\n').slice(1)) {
    // Server components (Next.js): "at Home (about://React/Server/file:///…/app/page.tsx:12:9)"
    const server = line.match(/about:\/\/React\/[^/]+\/file:\/\/([^\s)?]+?):(\d+):\d+/);
    if (server && !/\/(node_modules|\.next)\//.test(server[1])) {
      return `${decodeURIComponent(server[1]).replace(/^.*?\/(src|app|components|pages|lib)\//, '$1/')}:${server[2]}`;
    }
    const m = line.match(/(https?:\/\/[^\s)]+?):(\d+):\d+/);
    if (!m) continue;
    let url;
    try {
      url = new URL(m[1]);
    } catch {
      continue;
    }
    const p = url.pathname;
    if (p.includes('/node_modules/') || p.startsWith('/@') || p.includes('/.vite/') || p.startsWith('/_next/')) continue;
    return `${p.replace(/^\//, '')}:${m[2]}`;
  }
  return null;
}
