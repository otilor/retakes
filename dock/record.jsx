import { useEffect, useRef, useState } from 'react';
import { toast } from 'notch-toast';
import { api, CFG } from './lib.js';

// Recording a flow: what you click, type and choose on the page becomes a list of steps that
// Retakes replays with Playwright on every take. A recording survives page loads, so flows
// can cross pages.

const REC_KEY = '__retakes_rec';
const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time|color)$/;

export function savedRecording() {
  try {
    const r = JSON.parse(sessionStorage.getItem(REC_KEY) || 'null');
    if (r && Array.isArray(r.steps) && Date.now() - r.at < 30 * 60 * 1000) return r;
  } catch {
    /* storage blocked */
  }
  return null;
}

function store(rec) {
  try {
    if (rec) sessionStorage.setItem(REC_KEY, JSON.stringify({ ...rec, at: Date.now() }));
    else sessionStorage.removeItem(REC_KEY);
  } catch {
    /* storage blocked */
  }
}

export function startRecording() {
  store({ start: location.pathname + location.search, steps: [] });
}

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export function describeStep(s) {
  const what = s.label || s.target[0];
  if (s.do === 'click') return `Click ${what}`;
  if (s.do === 'fill') return `Type "${clip(s.value, 24)}" into ${what}`;
  if (s.do === 'press') return `Press ${s.key} in ${what}`;
  if (s.do === 'select') return `Choose "${clip(s.value, 24)}" in ${what}`;
  if (s.do === 'check') return `${s.checked ? 'Check' : 'Uncheck'} ${what}`;
  if (s.do === 'expectText') return `Check ${what} says "${clip(s.text, 30)}"`;
  return what;
}

// ---------- describing an element so Playwright can find it again ----------

function isTextField(el) {
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text');
}

export function roleOf(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(' ')[0];
  const tag = el.tagName;
  if (tag === 'BUTTON' || (tag === 'INPUT' && /^(button|submit|reset|image)$/.test(el.type))) return 'button';
  if (tag === 'A' && el.hasAttribute('href')) return 'link';
  if (tag === 'INPUT' && el.type === 'checkbox') return 'checkbox';
  if (tag === 'INPUT' && el.type === 'radio') return 'radio';
  if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|email|url|tel|password)$/.test(el.type || 'text'))) return 'textbox';
  if (tag === 'INPUT' && el.type === 'search') return 'searchbox';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  return null;
}

export function nameOf(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((n) => n.textContent)
      .join(' ');
    if (t.trim()) return t.trim().replace(/\s+/g, ' ');
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    const label = el.labels && el.labels[0];
    if (label && label.textContent.trim()) return label.textContent.trim().replace(/\s+/g, ' ');
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type) && el.value) return el.value;
    return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
  }
  return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const count = (sel) => {
  try {
    return document.querySelectorAll(sel).length;
  } catch {
    return 0;
  }
};

function nthPath(el) {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && node !== document.body && parts.length < 8; node = node.parentElement) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && count(`#${node.id}`) === 1) {
      parts.unshift(`#${node.id}`);
      return parts.join(' > ');
    }
    let s = node.tagName.toLowerCase();
    const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(node) + 1})`;
    parts.unshift(s);
  }
  return `body > ${parts.join(' > ')}`;
}

/** Selectors for an element, steadiest first. Replay uses the first one that matches. */
export function selectorsFor(el) {
  const out = [];
  const add = (s) => s && !out.includes(s) && out.push(s);
  for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const v = el.getAttribute(a);
    if (v) add(`[${a}="${q(v)}"]`);
  }
  // Generated ids (React's :r1:, Radix, Headless UI, long numbers) change between renders.
  if (el.id && !/^:|^radix-|^headlessui-|\d{4,}/.test(el.id) && count(`#${CSS.escape(el.id)}`) === 1) add(`#${CSS.escape(el.id)}`);
  const tag = el.tagName.toLowerCase();
  for (const a of ['name', 'aria-label', 'placeholder']) {
    const v = el.getAttribute(a);
    if (v && v.length <= 80) {
      const s = `${tag}[${a}="${q(v)}"]`;
      if (count(s) === 1) add(s);
    }
  }
  const role = roleOf(el);
  const name = nameOf(el);
  if (role && name && name.length <= 60) add(`role=${role}[name="${q(name)}"]`);
  else if (!role && name && name.length <= 40 && el.children.length === 0) add(`text="${q(name)}"`);
  add(nthPath(el));
  return out.slice(0, 6);
}

function labelFor(el, { forText = false } = {}) {
  if (forText) {
    // "Check span.none says …" reads better than repeating the text in the label.
    const cls = [...el.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 1);
    return `${el.tagName.toLowerCase()}${cls.length ? `.${cls[0]}` : ''}`;
  }
  const role = roleOf(el);
  const name = clip(nameOf(el), 40);
  const kind = role === 'textbox' || role === 'searchbox' ? 'field' : role === 'combobox' ? 'menu' : role || el.tagName.toLowerCase();
  return name ? `"${name}" ${kind}` : kind;
}

// The element a click means: the button or link around what was clicked, not the icon inside it.
const ACTIONABLE = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[onclick]';

// ---------- the recording bar ----------

export function Recorder({ host, hintAt, Picker, onStop }) {
  const [rec, setRec] = useState(() => savedRecording() || { start: location.pathname + location.search, steps: [] });
  const [stage, setStage] = useState('rec'); // rec | check | name
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const recRef = useRef(rec);
  const lastFill = useRef(null);
  const lastEnter = useRef(0);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const update = (fn) => {
    const next = fn(recRef.current);
    recRef.current = next;
    store(next);
    setRec(next);
  };
  const push = (step) => update((r) => ({ ...r, steps: [...r.steps, step].slice(0, 200) }));

  useEffect(() => {
    const own = (e) => e.composedPath().includes(host);
    const onClick = (e) => {
      if (own(e) || stageRef.current !== 'rec') return;
      const t = e.composedPath()[0];
      if (!t || t.nodeType !== 1) return;
      // Pressing Enter in a form "clicks" its submit button; the Enter step already covers that.
      if (e.detail === 0 && Date.now() - lastEnter.current < 120) return;
      const el = t.closest(ACTIONABLE) || t;
      if (isTextField(el) || el.tagName === 'SELECT') return;
      if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) return; // recorded on change
      if (el.tagName === 'LABEL' && el.control) return; // the control records its own change
      lastFill.current = null;
      push({ do: 'click', target: selectorsFor(el), label: labelFor(el) });
    };
    const onInput = (e) => {
      if (own(e) || stageRef.current !== 'rec') return;
      const el = e.composedPath()[0];
      if (!el || el.nodeType !== 1 || !isTextField(el)) return;
      const value = el.isContentEditable ? el.innerText : el.value;
      if (lastFill.current === el) {
        update((r) => {
          const steps = r.steps.slice();
          const last = steps[steps.length - 1];
          if (last && last.do === 'fill') steps[steps.length - 1] = { ...last, value };
          return { ...r, steps };
        });
      } else {
        lastFill.current = el;
        push({ do: 'fill', target: selectorsFor(el), label: labelFor(el), value });
      }
    };
    const onChange = (e) => {
      if (own(e) || stageRef.current !== 'rec') return;
      const el = e.composedPath()[0];
      if (!el || el.nodeType !== 1) return;
      if (el.tagName === 'SELECT') {
        lastFill.current = null;
        push({ do: 'select', target: selectorsFor(el), label: labelFor(el), value: el.value });
      } else if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) {
        lastFill.current = null;
        push({ do: 'check', target: selectorsFor(el), label: labelFor(el), checked: el.checked });
      }
    };
    const onKey = (e) => {
      if (own(e) || stageRef.current !== 'rec' || e.key !== 'Enter') return;
      const el = e.composedPath()[0];
      if (!el || el.nodeType !== 1 || el.tagName !== 'INPUT' || !isTextField(el)) return;
      lastEnter.current = Date.now();
      lastFill.current = null;
      push({ do: 'press', target: selectorsFor(el), label: labelFor(el), key: 'Enter' });
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [host]);

  useEffect(() => {
    if (stage !== 'check') return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setStage('rec');
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [stage]);

  const stop = () => {
    store(null);
    onStop();
  };
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api('flows', { flow: { name, start: rec.start, steps: rec.steps }, version: CFG.v });
      toast(`Saved "${clip(name, 40)}". Replaying it on ${CFG.v === 'main' ? 'main' : `agent-${String(CFG.v).slice(1)}`} to check it.`, { duration: 3500 });
      stop();
    } catch (err) {
      toast.error(err.message, { duration: 8000, dismissible: true });
      setBusy(false);
    }
  };

  const n = rec.steps.length;
  const last = n ? rec.steps[n - 1] : null;
  return (
    <>
      {stage === 'check' && (
        <Picker
          host={host}
          hintAt={hintAt === 'top' ? 'bottom' : 'top'}
          hint="Click the text that should be on the page"
          onPick={(info, el) => {
            const text = clip(el.innerText || el.value || '', 100);
            if (!text) {
              toast('That has no text to check. Pick something with words in it.', { duration: 3000 });
              return;
            }
            push({ do: 'expectText', target: selectorsFor(el), label: labelFor(el, { forText: true }), text });
            setStage('rec');
          }}
        />
      )}
      <div className="rec" style={hintAt === 'top' ? { top: 12 } : { bottom: 12 }} role="toolbar" aria-label="Recording a flow">
        {stage === 'name' ? (
          <>
            <input
              className="rec-name"
              autoFocus
              placeholder="Name this flow, like Search and open a stay"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setStage('rec');
              }}
            />
            <button type="button" className="pbtn primary" disabled={busy || !name.trim()} onClick={save}>
              {busy ? 'Saving…' : 'Save flow'}
            </button>
            <button type="button" className="pbtn" disabled={busy} onClick={() => setStage('rec')}>
              Back
            </button>
          </>
        ) : (
          <>
            <span className="rec-dot" aria-hidden="true" />
            <span className="rec-text">
              <b>{stage === 'check' ? 'Pick the text to check' : n ? `Recording · ${n} step${n === 1 ? '' : 's'}` : 'Recording'}</b>
              <small>{stage === 'check' ? 'Esc to go back' : last ? describeStep(last) : 'Use the page as you would to test it'}</small>
            </span>
            <button type="button" className="pbtn" disabled={stage === 'check'} onClick={() => setStage('check')} title="Add a step that checks some text is on the page">
              Add check
            </button>
            <button
              type="button"
              className="pbtn"
              disabled={!n || stage === 'check'}
              onClick={() => {
                lastFill.current = null;
                update((r) => ({ ...r, steps: r.steps.slice(0, -1) }));
              }}
            >
              Undo
            </button>
            <button type="button" className="pbtn primary" disabled={!n || stage === 'check'} onClick={() => setStage('name')}>
              Done
            </button>
            <button type="button" className="pbtn" onClick={stop}>
              Cancel
            </button>
          </>
        )}
      </div>
    </>
  );
}
