import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { css } from './styles.js';
import { CFG, takeRestore, readCookie, setCookie } from './lib.js';
import { watchErrors, runPane } from './watch.js';

function boot() {
  if (window.__RETAKES_BOOTED__) return;
  window.__RETAKES_BOOTED__ = true;
  if (CFG.pane) {
    runPane();
    return;
  }
  if (!CFG.token || !CFG.v) return;
  // Keep the cookie in step with what the hub actually served (a removed take falls back to main).
  if (readCookie() !== CFG.v) setCookie(CFG.v);
  const restored = takeRestore();
  const watcher = watchErrors();

  const mount = () => {
    const host = document.createElement('retakes-dock');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
    const container = document.createElement('div');
    shadow.appendChild(container);
    // Typing in the dock shouldn't trigger the app's own keyboard shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      shadow.addEventListener(type, (e) => {
        const t = e.composedPath()[0];
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) e.stopPropagation();
      });
    }
    document.documentElement.appendChild(host);
    createRoot(container).render(<App host={host} restored={restored} watcher={watcher} />);
    // Some apps rewrite the whole document; put the dock back if that happens.
    new MutationObserver(() => {
      if (!host.isConnected) document.documentElement.appendChild(host);
    }).observe(document.documentElement, { childList: true });
  };
  if (document.body) mount();
  else addEventListener('DOMContentLoaded', mount, { once: true });
}

boot();
