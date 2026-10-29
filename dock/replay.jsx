import { useEffect, useRef, useState } from 'react';
import { describeStep, roleOf, nameOf } from './record.jsx';

// Watching a flow: the same steps Playwright replays in the background, played on the page
// you're looking at, slowly, with each element highlighted. It starts from a fresh load of the
// flow's first page and carries on across page loads.

const WATCH_KEY = '__orch_watch';
const STEP_TIMEOUT = 6000;
const PAUSE = 650;

export function savedWatch() {
  try {
    const w = JSON.parse(sessionStorage.getItem(WATCH_KEY) || 'null');
    if (w && w.flow && Array.isArray(w.flow.steps) && Date.now() - w.at < 5 * 60 * 1000) return w;
  } catch {
    /* storage blocked */
  }
  return null;
}

function store(w) {
  try {
    if (w) sessionStorage.setItem(WATCH_KEY, JSON.stringify({ ...w, at: Date.now() }));
    else sessionStorage.removeItem(WATCH_KEY);
  } catch {
    /* storage blocked */
  }
}

/** Start watching: load the flow's first page fresh, then the dock picks up from there. */
export function startWatch(flow) {
  store({ flow, i: 0 });
  location.assign(flow.start);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\(["\\])/g, '$1');

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** Find an element the way replay does: the first selector that matches anything wins. */
function findOne(sel, host) {
  const all = (s) => [...document.querySelectorAll(s)].filter((el) => el !== host && !host.contains(el));
  let m = sel.match(/^role=([\w-]+)\[name="(.*)"\]$/);
  if (m) {
    const name = unq(m[2]).toLowerCase();
    return all('*').find((el) => roleOf(el) === m[1] && norm(nameOf(el)).toLowerCase() === name && visible(el)) || null;
  }
  m = sel.match(/^text="(.*)"$/);
  if (m) {
    const text = unq(m[1]);
    const hits = all('body *').filter((el) => norm(el.textContent) === text && visible(el));
    // The innermost match, like Playwright.
    return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) || null;
  }
  try {
    return all(sel)[0] || null;
  } catch {
    return null;
  }
}

async function locate(step, host, alive) {
  const deadline = Date.now() + STEP_TIMEOUT;
  while (alive()) {
    for (const sel of step.target) {
      const el = findOne(sel, host);
      if (el) return el;
    }
    if (Date.now() > deadline) throw new Error(`Couldn't find ${step.label || step.target[0]}`);
    await sleep(150);
  }
  return null;
}

function setValue(el, value) {
  // Go through the native setter so React and other frameworks see the change.
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
}

async function act(el, step, alive) {
  el.focus({ preventScroll: true });
  switch (step.do) {
    case 'click':
      el.click();
      break;
    case 'fill':
      if (el.isContentEditable) {
        el.textContent = step.value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        break;
      }
      setValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      for (let n = 1; n <= step.value.length && alive(); n++) {
        setValue(el, step.value.slice(0, n));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: step.value[n - 1], inputType: 'insertText' }));
        await sleep(step.value.length > 40 ? 10 : 45);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    case 'press': {
      const init = { key: step.key, code: step.key, bubbles: true, cancelable: true };
      const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      // A real Enter in a form field submits the form; a synthetic one doesn't, so do it here.
      if (go && step.key === 'Enter' && el.form) el.form.requestSubmit();
      break;
    }
    case 'select':
      setValue(el, step.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    case 'check':
      if (el.checked !== step.checked) el.click();
      break;
    case 'expectText': {
      const deadline = Date.now() + STEP_TIMEOUT;
      let text = '';
      while (alive()) {
        text = norm(el.innerText);
        if (text.toLowerCase().includes(step.text.toLowerCase())) return;
        if (Date.now() > deadline) break;
        await sleep(150);
      }
      if (alive()) throw new Error(`Expected it to say "${step.text}", but it says "${text.slice(0, 80)}"`);
      break;
    }
    default:
      break;
  }
}

export function Watcher({ host, hintAt, onStop }) {
  const [w] = useState(() => savedWatch());
  const [at, setAt] = useState(w ? w.i : 0);
  const [box, setBox] = useState(null);
  const [result, setResult] = useState(null); // { ok } or { ok: false, error }
  const target = useRef(null);
  const flow = w && w.flow;

  useEffect(() => {
    if (!flow) {
      onStop();
      return;
    }
    let dead = false;
    const alive = () => !dead;
    const track = () => {
      const el = target.current;
      if (!el || !el.isConnected) return setBox(null);
      const r = el.getBoundingClientRect();
      setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    const timer = setInterval(track, 100);
    (async () => {
      await sleep(400);
      for (let i = w.i; i < flow.steps.length && alive(); i++) {
        const step = flow.steps[i];
        setAt(i);
        // Remember where we are first: a step can load another page.
        store({ flow, i: i + 1 });
        try {
          const el = await locate(step, host, alive);
          if (!el) return;
          target.current = el;
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          await sleep(PAUSE);
          track();
          await act(el, step, alive);
          await sleep(step.do === 'expectText' ? 350 : PAUSE / 2);
        } catch (err) {
          if (!alive()) return;
          store(null);
          setResult({ ok: false, error: err.message, step: i });
          return;
        }
      }
      if (!alive()) return;
      store(null);
      target.current = null;
      setBox(null);
      setResult({ ok: true });
    })();
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      stop();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);

  const stop = () => {
    store(null);
    onStop();
  };

  if (!flow) return null;
  const n = flow.steps.length;
  const step = flow.steps[Math.min(at, n - 1)];
  const failed = result && !result.ok;
  return (
    <>
      {box && <div className={`pick-box watch-box${failed ? ' bad' : ''}`} style={{ left: box.x - 3, top: box.y - 3, width: box.w + 6, height: box.h + 6 }} />}
      <div className="rec watch" style={hintAt === 'top' ? { top: 12 } : { bottom: 12 }} role="status" aria-live="polite" aria-label="Watching a flow">
        <span className={`fmark ${result ? (result.ok ? 'pass' : 'fail') : ''}`} aria-hidden="true">
          {result ? (result.ok ? '✓' : '×') : <span className="mini-spin" />}
        </span>
        <span className="rec-text">
          <b>
            {result
              ? result.ok
                ? `"${flow.name}" passed`
                : `"${flow.name}" failed at step ${result.step + 1}`
              : `${flow.name} · step ${at + 1} of ${n}`}
          </b>
          <small className={failed ? 'bad' : ''}>{result ? (result.ok ? `All ${n} steps worked on this version.` : result.error) : describeStep(step)}</small>
        </span>
        <button type="button" className={`pbtn${result ? ' primary' : ''}`} onClick={stop}>
          {result ? 'Close' : 'Stop'}
        </button>
      </div>
    </>
  );
}
