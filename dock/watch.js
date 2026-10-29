import { api, CFG } from './lib.js';

/**
 * Send the page's uncaught errors, and Vite's and Next.js's build errors, to the hub so the version's
 * tile can show them and the agent can be asked to fix them.
 */
export function watchErrors() {
  const q = window.__ORCH_ERRQ || (window.__ORCH_ERRQ = []);
  const recent = new Map();
  const send = (e) => {
    const key = e.message;
    const now = Date.now();
    if (recent.has(key) && now - recent.get(key) < 2000) return;
    recent.set(key, now);
    api(`versions/${encodeURIComponent(CFG.v)}/errors`, e).catch(() => {});
  };
  const drain = () => {
    while (q.length) send(q.shift());
  };
  window.__ORCH_ONERR = drain;
  drain();

  const checkOverlay = () => {
    const el = document.querySelector('vite-error-overlay');
    if (!el) return;
    const root = el.shadowRoot;
    const msg = (root && (root.querySelector('.message-body') || root.querySelector('.message'))) || null;
    const text = ((msg && msg.textContent) || (root && root.textContent) || 'Vite reported a build error.').trim();
    const file = root && root.querySelector('.file');
    q.push({ message: text.slice(0, 500), stack: file ? file.textContent.trim() : '', kind: 'build' });
    drain();
  };
  // Next.js shows build errors in its own dev overlay. Runtime errors already reach us as
  // window errors, so only build errors are read from here.
  let lastNext = '';
  const checkNext = () => {
    const root = document.querySelector('nextjs-portal')?.shadowRoot;
    const dialog = root && root.querySelector('[data-nextjs-dialog]');
    const read = (sel) => ((root && root.querySelector(sel)) || {}).innerText || '';
    const label = dialog ? read('#nextjs__container_errors_label').trim() : '';
    if (!/build|compil/i.test(label)) {
      lastNext = '';
      return;
    }
    const message = `${label}: ${read('#nextjs__container_errors_desc').trim() || 'see the overlay'}`.slice(0, 500);
    if (message === lastNext) return;
    lastNext = message;
    q.push({ message, stack: read('[data-nextjs-codeframe]').trim().slice(0, 2000), kind: 'build' });
    drain();
  };
  const start = () => {
    checkOverlay();
    if (window.next || document.querySelector('script[src*="/_next/"]')) setInterval(checkNext, 1000);
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeName === 'VITE-ERROR-OVERLAY') return setTimeout(checkOverlay, 50);
    }).observe(document.body, { childList: true });
  };
  if (document.body) start();
  else addEventListener('DOMContentLoaded', start, { once: true });
  return { recheck: checkOverlay };
}

/** Inside a compare pane: keep scrolling in step with the other pane. */
export function runPane() {
  if (window.parent === window) return;
  let quietUntil = 0;
  addEventListener(
    'scroll',
    () => {
      if (Date.now() < quietUntil) return;
      parent.postMessage({ __orch: 'scroll', x: scrollX, y: scrollY }, '*');
    },
    { passive: true }
  );
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.__orch !== 'scrollTo') return;
    quietUntil = Date.now() + 120;
    scrollTo(e.data.x, e.data.y);
  });
  parent.postMessage({ __orch: 'ready' }, '*');
}
