import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NotchToaster, toast } from 'notch-toast';
import { api, CFG, switchTo, hueClass, describeElement, shortLabel } from './lib.js';
import { Mark, Branch, CompareIcon, PromptIcon, KeepIcon, CloseIcon, FlowIcon } from './icons.jsx';
import { Recorder, savedRecording, startRecording } from './record.jsx';

const PREFS_KEY = '__orch_ui';
const GAP = 12;
const DEFAULT_PREFS = { edge: 'bottom', align: 'center', open: true, theme: 'ink' };

function loadPrefs() {
  try {
    const p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
    if (!['top', 'bottom', 'left', 'right'].includes(p.edge)) p.edge = 'bottom';
    if (!['start', 'center', 'end'].includes(p.align)) p.align = 'center';
    if (!['ink', 'paper', 'auto'].includes(p.theme)) p.theme = 'ink';
    return p;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function viewport() {
  const d = document.documentElement;
  return { w: d.clientWidth || innerWidth, h: d.clientHeight || innerHeight };
}

function place(edge, align, w, h, vw, vh) {
  const along = (len, total) => {
    const v = align === 'start' ? GAP : align === 'end' ? total - len - GAP : (total - len) / 2;
    return Math.max(GAP, Math.min(v, total - len - GAP));
  };
  if (edge === 'top') return { left: along(w, vw), top: GAP };
  if (edge === 'bottom') return { left: along(w, vw), top: vh - h - GAP };
  if (edge === 'left') return { left: GAP, top: along(h, vh) };
  return { left: vw - w - GAP, top: along(h, vh) };
}

/** Where a popover goes: always toward the middle of the page from the dock. */
function popStyle(edge, pos, size, vp, width = 360) {
  const s = {};
  const maxW = Math.min(width, vp.w - 24);
  if (edge === 'bottom' || edge === 'top') {
    const left = Math.max(12, Math.min(pos.left + size.w / 2 - maxW / 2, vp.w - maxW - 12));
    s.left = left;
    if (edge === 'bottom') {
      s.bottom = vp.h - pos.top + 10;
      s.maxHeight = pos.top - 22;
    } else {
      s.top = pos.top + size.h + 10;
      s.maxHeight = vp.h - (pos.top + size.h) - 22;
    }
  } else {
    s.top = Math.max(12, Math.min(pos.top, vp.h - 200));
    s.maxHeight = vp.h - s.top - 12;
    if (edge === 'left') s.left = pos.left + size.w + 10;
    else s.right = vp.w - pos.left + 10;
  }
  s.width = maxW;
  return s;
}

function takeStatus(v) {
  if (v.kind === 'main') {
    if (v.server.status === 'starting') return { key: 'busy', label: 'Starting the dev server' };
    if (v.server.status === 'failed' || v.server.status === 'crashed') return { key: 'fail', label: 'Dev server stopped' };
    if (v.errors.length) return { key: 'fail', label: plural(v.errors.length, 'error') };
    return { key: 'ok', label: 'Your checkout' };
  }
  if (v.phase === 'failed') return { key: 'fail', label: v.server.status === 'crashed' ? 'Dev server stopped' : 'Setup failed' };
  if (v.agent.status === 'running') return { key: 'busy', label: v.agent.step || 'Working' };
  if (v.phase === 'setup') return { key: 'busy', label: 'Making its copy' };
  if (v.phase === 'installing') return { key: 'busy', label: 'Installing dependencies' };
  if (v.phase === 'starting') return { key: 'busy', label: 'Starting its dev server' };
  if (v.agent.status === 'failed') return { key: 'fail', label: 'Agent hit a problem' };
  if (v.errors.length) return { key: 'fail', label: plural(v.errors.length, 'error') };
  const broken = brokenFlows(v).length;
  if (broken) return { key: 'fail', label: `${plural(broken, 'flow')} broken` };
  if ((v.flows || []).some((f) => f.status === 'running' || f.status === 'queued')) return { key: 'busy', label: 'Checking your flows' };
  if (v.agent.status === 'stopped') return { key: 'warn', label: 'Stopped' };
  return { key: 'ok', label: 'Ready' };
}

// Flows that fail on a take but pass on main: the ones the take broke.
function brokenFlows(v) {
  return (v.flows || []).filter((f) => f.status === 'fail' && (v.kind === 'main' || !f.alsoOnMain));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function labelFor(id) {
  return id === 'main' ? 'main' : `agent-${String(id).replace(/^t/, '')}`;
}

function Avatar({ v, spin }) {
  if (v.kind === 'main') {
    return (
      <span className="av hm">
        <Branch />
        {spin && <span className="spin" />}
      </span>
    );
  }
  return (
    <span className={`av ${hueClass(v.n)}`}>
      {v.n}
      {spin && <span className="spin" />}
    </span>
  );
}

export default function App({ host, restored, watcher }) {
  const [snap, setSnap] = useState(null);
  const [conn, setConn] = useState('connecting');
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [hidden, setHidden] = useState(false);
  const [pop, setPop] = useState(null);
  const keysRef = useRef({});
  const [mode, setMode] = useState(() => (CFG.token && savedRecording() ? 'record' : null));
  const [picked, setPicked] = useState(null);
  const [drag, setDrag] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState(viewport);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const barRef = useRef(null);
  const dragRef = useRef(null);
  const snapRef = useRef(null);
  snapRef.current = snap;

  const setPrefs = useCallback((fn) => {
    setPrefsState((p) => {
      const next = typeof fn === 'function' ? fn(p) : { ...p, ...fn };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);

  const versions = snap ? snap.versions : [];
  const served = versions.find((v) => v.id === CFG.v) || null;
  const servedTake = served && served.kind === 'take' ? served : null;
  const narrow = vp.w < 640;
  const edge = narrow && (prefs.edge === 'left' || prefs.edge === 'right') ? 'bottom' : prefs.edge;
  const orient = edge === 'left' || edge === 'right' ? 'v' : 'h';
  const theme = prefs.theme === 'auto' ? (systemDark ? 'ink' : 'paper') : prefs.theme;

  // ---------- live connection to the hub ----------
  const noticeRef = useRef(null);
  noticeRef.current = (n) => {
    const opts = { duration: n.kind === 'error' || n.kind === 'warning' ? 10000 : 4000, dismissible: true };
    if (n.action === 'view' && n.version && n.version !== CFG.v) {
      opts.action = { label: 'View', onClick: () => switchTo(n.version, { from: CFG.v }) };
    } else if (n.action === 'details' && n.version) {
      opts.action = { label: 'Details', onClick: () => setPop({ kind: 'version', id: n.version }) };
    } else if (n.action === 'fix' && n.version && n.version !== 'main') {
      opts.action = {
        label: 'Fix it',
        onClick: () => api(`takes/${n.version}/fix`, {}).catch((e) => toast.error(e.message)),
      };
    }
    const fn = { success: toast.success, error: toast.error, warning: toast.warning, info: toast }[n.kind] || toast;
    fn(n.text, opts);
  };

  useEffect(() => {
    let es = null;
    let timer = null;
    let dead = false;
    const connect = () => {
      if (dead) return;
      es = new EventSource(`/__orch/events?t=${encodeURIComponent(CFG.token)}`);
      es.addEventListener('state', (e) => {
        setSnap(JSON.parse(e.data));
        setConn('live');
      });
      es.addEventListener('notice', (e) => noticeRef.current(JSON.parse(e.data)));
      es.onerror = () => {
        setConn((c) => (c === 'stale' ? c : 'lost'));
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          timer = setTimeout(check, 1500);
        }
      };
    };
    const check = async () => {
      if (dead) return;
      try {
        await api('state');
        connect();
      } catch (err) {
        if (/restarted/i.test(err.message)) {
          setConn('stale');
          toast.warning('Orchestrator restarted. Reload the page to reconnect.', {
            duration: 0,
            dismissible: true,
            action: { label: 'Reload', onClick: () => location.reload() },
          });
        } else timer = setTimeout(check, 2000);
      }
    };
    connect();
    return () => {
      dead = true;
      if (es) es.close();
      clearTimeout(timer);
    };
  }, []);

  // After switching, say where you are.
  useEffect(() => {
    if (restored && restored.to === CFG.v) toast(`Viewing ${labelFor(CFG.v)}`, { duration: 1800 });
  }, [restored]);

  // If the version on screen disappears (kept or discarded), go back to main.
  const leaving = useRef(false);
  useEffect(() => {
    if (!snap || leaving.current || CFG.v === 'main') return;
    if (!snap.versions.some((v) => v.id === CFG.v)) {
      leaving.current = true;
      switchTo('main', { from: CFG.v });
    }
  }, [snap]);

  // When the agent on screen finishes, look again for a Vite error overlay left from its edits.
  const prevAgent = useRef(null);
  useEffect(() => {
    const status = servedTake ? servedTake.agent.status : null;
    if (prevAgent.current === 'running' && status !== 'running') setTimeout(() => watcher && watcher.recheck(), 600);
    prevAgent.current = status;
  }, [servedTake && servedTake.agent.status]);

  // ---------- layout ----------
  useEffect(() => {
    const onResize = () => setVp(viewport());
    addEventListener('resize', onResize);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = (e) => setSystemDark(e.matches);
    mq.addEventListener('change', onScheme);
    return () => {
      removeEventListener('resize', onResize);
      mq.removeEventListener('change', onScheme);
    };
  }, []);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  const pos = drag
    ? { left: drag.x - drag.dx, top: drag.y - drag.dy }
    : place(edge, prefs.align, size.w, size.h, vp.w, vp.h);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      const t = e.composedPath()[0];
      const typing = t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (mode === 'record') return;
      if (e.key === 'Escape') {
        if (mode) {
          setMode(null);
          setPicked(null);
          e.stopPropagation();
          e.preventDefault();
        } else if (pop) {
          setPop(null);
          e.stopPropagation();
          e.preventDefault();
        }
        return;
      }
      if (mode === 'pick' && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        setMode(null);
        setPicked(null);
        setPop({ kind: 'compose' });
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '.') {
        e.preventDefault();
        if (hidden) setHidden(false);
        else {
          setPop(null);
          setPrefs((p) => ({ ...p, open: !p.open }));
        }
        return;
      }
      if (hidden || mode === 'compare') return;
      const key = e.key.toLowerCase();
      if (key === 'p' && mode !== 'pick') {
        e.preventDefault();
        keysRef.current.onPrompt();
      } else if (key === 'c') {
        e.preventDefault();
        keysRef.current.onCompare();
      } else if (key === 'f') {
        e.preventDefault();
        setMode(null);
        setPop((p) => (p && p.kind === 'flows' ? null : { kind: 'flows' }));
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [mode, pop, hidden, setPrefs]);

  // ---------- dragging the handle ----------
  const onHandleDown = (e) => {
    if (e.button !== 0) return;
    const rect = barRef.current.getBoundingClientRect();
    dragRef.current = { x: e.clientX, y: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (!d.moved) setPop(null);
    d.moved = true;
    setDrag({ x: e.clientX, y: e.clientY, dx: d.dx, dy: d.dy });
  };
  const onHandleUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      setPop(null);
      setPrefs((p) => ({ ...p, open: !p.open }));
      return;
    }
    const x = Math.max(0, Math.min(e.clientX, vp.w));
    const y = Math.max(0, Math.min(e.clientY, vp.h));
    const dist = { left: x, right: vp.w - x, top: y, bottom: vp.h - y };
    let next = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
    if (vp.w < 640 && (next === 'left' || next === 'right')) next = y < vp.h / 2 ? 'top' : 'bottom';
    const along = next === 'top' || next === 'bottom' ? x / vp.w : y / vp.h;
    const align = along < 0.34 ? 'start' : along > 0.66 ? 'end' : 'center';
    setPrefs((p) => ({ ...p, edge: next, align }));
    setDrag(null);
  };
  const onHandleCancel = () => {
    dragRef.current = null;
    setDrag(null);
  };
  const onHandleClick = (e) => {
    // Pointer clicks are handled on pointerup; this is Enter or Space on the focused handle.
    if (e.detail === 0) {
      setPop(null);
      setPrefs((p) => ({ ...p, open: !p.open }));
    }
  };

  const onBarKey = (e) => {
    const keys = orient === 'h' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const i = keys.indexOf(e.key);
    if (i < 0) return;
    const btns = [...barRef.current.querySelectorAll('button:not([disabled])')];
    const at = btns.indexOf(e.target);
    if (at < 0) return;
    e.preventDefault();
    btns[(at + (i ? 1 : -1) + btns.length) % btns.length].focus();
  };

  // ---------- actions ----------
  const onTile = (v) => {
    if (v.id === CFG.v) {
      setPop((p) => (p && p.kind === 'version' && p.id === v.id ? null : { kind: 'version', id: v.id }));
    } else if (v.switchable) {
      switchTo(v.id, { from: CFG.v });
    } else {
      setPop({ kind: 'version', id: v.id });
    }
  };

  const others = versions.filter((v) => v.switchable && v.id !== CFG.v);
  const onCompare = () => {
    setPop(null);
    if (!others.length) {
      toast('Nothing to compare yet. Prompt a change first.', { duration: 3000 });
      return;
    }
    setMode('compare');
  };
  const onPrompt = () => {
    setPop(null);
    setPicked(null);
    setMode('pick');
  };

  const onRecord = () => {
    setPop(null);
    setPicked(null);
    startRecording();
    setMode('record');
  };

  keysRef.current = { onPrompt, onCompare };

  if (!CFG.token) return null;

  const busyAny = versions.some((v) => takeStatus(v).key === 'busy');
  const toasterPos = edge === 'top' ? 'bottom-center' : 'top-center';
  const now = served || { id: CFG.v, kind: CFG.v === 'main' ? 'main' : 'take', n: Number(String(CFG.v).slice(1)) || 1, label: labelFor(CFG.v), errors: [], server: { status: 'ready' }, agent: { status: 'idle' }, phase: 'live' };
  const nowStatus = takeStatus(now);
  const nowBroken = brokenFlows(now).length;
  const stCls = nowStatus.key === 'ok' ? '' : nowStatus.key;
  const handleTip = conn === 'lost' ? 'Lost touch with orch. Is it still running?' : conn === 'stale' ? 'Orchestrator restarted: reload the page' : prefs.open ? 'Drag to move · click to collapse' : 'Drag to move · click to open';

  return (
    <div className={`root ${theme}`}>
      <NotchToaster position={toasterPos} mode="floating" animation="smooth" />

      {!hidden && mode !== 'compare' && mode !== 'record' && (
        <div
          ref={barRef}
          className={`dock${prefs.open ? '' : ' closed'}${drag ? ' dragging' : ''}${pop ? ' has-pop' : ''}${conn === 'live' ? '' : ' offline'}${size.w ? '' : ' measuring'}`}
          style={{ left: pos.left, top: pos.top }}
          data-edge={edge}
          data-orient={orient}
          role="toolbar"
          aria-label="Orchestrator"
          aria-orientation={orient === 'h' ? 'horizontal' : 'vertical'}
          onKeyDown={onBarKey}
        >
          <button
            type="button"
            className="btn-i handle"
            aria-label={prefs.open ? 'Collapse the dock' : 'Open the dock'}
            aria-expanded={prefs.open}
            data-tip={handleTip}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleCancel}
            onClick={onHandleClick}
            onContextMenu={(e) => {
              e.preventDefault();
              setPop((p) => (p && p.kind === 'settings' ? null : { kind: 'settings' }));
            }}
          >
            <Mark />
            {!prefs.open && busyAny && <span className="badge" style={{ background: 'var(--accent)' }} />}
          </button>

          {(orient === 'h' || !prefs.open) && (
            orient === 'h' ? (
              <button
                type="button"
                className="now"
                aria-label={`Viewing ${now.label}, ${nowStatus.label}. Show details`}
                onClick={() => setPop((p) => (p && p.kind === 'version' && p.id === now.id ? null : { kind: 'version', id: now.id }))}
              >
                <Avatar v={now} />
                <b>{now.label}</b>
                {now.kind === 'take' && now.runs > 1 && <span className="ver">v{now.runs}</span>}
                <span className={`st ${stCls}`} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="btn-i tile" aria-label={`Viewing ${now.label}`} onClick={() => setPop({ kind: 'version', id: now.id })}>
                <Avatar v={now} spin={nowStatus.key === 'busy'} />
              </button>
            )
          )}

          {prefs.open && (
            <>
              <span className="sep" aria-hidden="true" />
              <div className={`tiles${versions.length > 9 ? ' scroll' : ''}`}>
                {versions.map((v) => {
                  const st = takeStatus(v);
                  const viewing = v.id === CFG.v;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className={`btn-i tile${viewing ? ' viewing' : ''}${v.switchable ? '' : ' pending'}`}
                      aria-pressed={viewing}
                      aria-label={`${v.label}, ${st.label}${viewing ? ', viewing' : ''}`}
                      data-tip={`${v.label} · ${st.label}`}
                      onClick={() => onTile(v)}
                    >
                      <Avatar v={v} spin={st.key === 'busy'} />
                      {st.key === 'fail' && (
                        <span className="badge fail" aria-hidden="true">
                          ×
                        </span>
                      )}
                      {st.key === 'warn' && (
                        <span className="badge warn" aria-hidden="true">
                          !
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <span className="sep" aria-hidden="true" />
              <button type="button" className="btn-i" aria-label="Compare side by side" data-tip="Compare side by side · C" onClick={onCompare}>
                <CompareIcon />
              </button>
              <button
                type="button"
                className={`btn-i${pop && pop.kind === 'flows' ? ' on' : ''}`}
                aria-label={nowBroken ? `Flows: ${nowBroken} broken` : 'Flows'}
                data-tip={nowBroken ? `${plural(nowBroken, 'flow')} broken · F` : 'Flows · F'}
                onClick={() => setPop((p) => (p && p.kind === 'flows' ? null : { kind: 'flows' }))}
              >
                <FlowIcon />
                {nowBroken > 0 && (
                  <span className="badge fail" aria-hidden="true">
                    {nowBroken}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`btn-i${mode === 'pick' || (pop && pop.kind === 'compose') ? ' on' : ''}`}
                aria-label="Prompt a change"
                data-tip="Point and prompt · P"
                onClick={onPrompt}
              >
                <PromptIcon />
              </button>
              <button
                type="button"
                className="btn-i"
                aria-label={servedTake ? `Keep ${servedTake.label}` : 'Keep: switch to a take first'}
                data-tip={servedTake ? `Keep ${servedTake.label}` : 'Switch to a take to keep it'}
                disabled={!servedTake}
                onClick={() => setPop({ kind: 'keep', id: servedTake.id })}
              >
                <KeepIcon />
              </button>
            </>
          )}
        </div>
      )}

      {pop && !hidden && mode !== 'compare' && mode !== 'record' && (
        <div className={`pop${pop.kind === 'settings' ? ' menu' : ''}`} style={popStyle(edge, pos, size, vp, pop.kind === 'settings' ? 240 : 360)} role="dialog" aria-label="Orchestrator">
          {pop.kind === 'version' && <VersionPanel v={versions.find((x) => x.id === pop.id)} project={snap && snap.project} onClose={() => setPop(null)} setPop={setPop} />}
          {pop.kind === 'compose' && (
            <Composer servedTake={servedTake} picked={picked} setPicked={setPicked} onRepick={onPrompt} onDone={() => setPop(null)} />
          )}
          {pop.kind === 'flows' && <FlowsPanel v={now} flows={(snap && snap.flows) || []} onRecord={onRecord} />}
          {pop.kind === 'keep' && <KeepPanel v={versions.find((x) => x.id === pop.id)} branch={snap && snap.project.branch} onClose={() => setPop(null)} />}
          {pop.kind === 'settings' && (
            <Settings
              prefs={prefs}
              setPrefs={setPrefs}
              onHide={() => {
                setPop(null);
                setHidden(true);
                toast('Dock hidden. Press . to bring it back.', { duration: 3000 });
              }}
              onClose={() => setPop(null)}
            />
          )}
        </div>
      )}

      {mode === 'pick' && (
        <Picker
          host={host}
          hintAt={edge === 'top' ? 'bottom' : 'top'}
          onPick={(info) => {
            setPicked(info);
            setMode(null);
            setPop({ kind: 'compose' });
          }}
        />
      )}

      {mode === 'record' && <Recorder host={host} hintAt={edge === 'top' ? 'top' : 'bottom'} Picker={Picker} onStop={() => setMode(null)} />}

      {mode === 'compare' && <Compare versions={versions} onClose={() => setMode(null)} />}
    </div>
  );
}

// ---------- panels ----------

function VersionPanel({ v, project, onClose, setPop }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!v) {
    return <p className="said">This take is gone.</p>;
  }
  const st = takeStatus(v);
  const viewing = v.id === CFG.v;
  const running = v.kind === 'take' && v.agent.status === 'running';
  const act = async (fn, after) => {
    setBusy(true);
    try {
      const r = await fn();
      if (after) after(r);
    } catch (err) {
      toast.error(err.message, { duration: 8000, dismissible: true });
    } finally {
      setBusy(false);
    }
  };
  const logUrl = `/__orch/api/log/${encodeURIComponent(v.id)}?t=${encodeURIComponent(CFG.token)}`;

  if (v.kind === 'main') {
    return (
      <>
        <div className="ph">
          <Avatar v={v} />
          <h2>main</h2>
          <span className={`pill ${st.key}`}>{st.label}</span>
        </div>
        <p className="said">
          Your own checkout{project && project.branch ? (
            <>
              {' '}on <b>{project.branch}</b>
            </>
          ) : null}
          . New takes start from its last commit.
        </p>
        {(v.server.status === 'failed' || v.server.status === 'crashed') && (
          <div className="note fail">
            Your dev server stopped.
            <pre>{v.server.error}</pre>
          </div>
        )}
        <Errors v={v} />
        <BrokenFlows v={v} />
        <div className="row end">
          {!viewing && v.switchable && (
            <button type="button" className="pbtn primary" onClick={() => switchTo('main', { from: CFG.v })}>
              View main
            </button>
          )}
          <a className="link" href={logUrl} target="_blank" rel="noreferrer">
            Dev server log
          </a>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="ph">
        <Avatar v={v} />
        <h2>{v.label}</h2>
        <span className={`pill ${st.key}`}>{st.key === 'busy' ? 'Working' : st.label}</span>
      </div>
      <p className="quote">
        {v.prompt}
        {(v.attempt > 1 || v.element) && (
          <small>
            {v.attempt > 1 ? `Take ${v.attempt} of this prompt` : ''}
            {v.attempt > 1 && v.element ? ' · ' : ''}
            {v.element ? `Pointed at ${v.element.component || v.element.selector || 'an element'}` : ''}
          </small>
        )}
      </p>
      {st.key === 'busy' && (
        <p className="line">
          <span className="mini-spin" aria-hidden="true" />
          {st.label}
        </p>
      )}
      {v.phase === 'failed' && (
        <div className="note fail">
          {v.server.status === 'crashed' ? 'Its dev server stopped.' : "Its copy couldn't be set up."}
          <pre>{v.phaseError}</pre>
        </div>
      )}
      {v.agent.status === 'failed' && v.agent.error && (
        <div className="note fail">
          {v.agent.error.split('\n')[0]}
          {v.agent.error.includes('\n') && <pre>{v.agent.error.slice(v.agent.error.indexOf('\n') + 1)}</pre>}
        </div>
      )}
      {!running && v.lastResult && (
        <p className="said">
          <b>Claude:</b> {v.lastResult}
        </p>
      )}
      <Errors v={v} onFix={!running ? () => act(() => api(`takes/${v.id}/fix`, {})) : null} />
      <BrokenFlows v={v} onFix={!running && !v.errors.length ? () => act(() => api(`takes/${v.id}/fix`, {})) : null} />

      {!running && (
        <>
          <textarea
            className="field"
            placeholder={`Ask ${v.label} for a change…`}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault();
                act(() => api(`takes/${v.id}/followup`, { prompt: text }), () => setText(''));
              }
            }}
            style={{ minHeight: 52 }}
          />
          <div className="row end">
            <button
              type="button"
              className="pbtn"
              disabled={busy || !text.trim()}
              onClick={() => act(() => api(`takes/${v.id}/followup`, { prompt: text }), () => setText(''))}
            >
              Send
            </button>
          </div>
        </>
      )}

      <div className="row end">
        {running && (
          <button type="button" className="pbtn" disabled={busy} onClick={() => act(() => api(`takes/${v.id}/stop`, {}))}>
            Stop
          </button>
        )}
        {v.canRetry && (
          <button type="button" className="pbtn primary" disabled={busy} onClick={() => act(() => api(`takes/${v.id}/retry`, {}))}>
            Retry
          </button>
        )}
        {!viewing && v.switchable && (
          <button type="button" className="pbtn primary" onClick={() => switchTo(v.id, { from: CFG.v })}>
            View
          </button>
        )}
        <button
          type="button"
          className="pbtn"
          disabled={busy}
          onClick={() =>
            act(
              () => api(`takes/${v.id}/another`, {}),
              (r) => {
                toast.success(`${r.take.label} is on it`, { duration: 3000 });
                onClose();
              }
            )
          }
        >
          Try another
        </button>
        <button type="button" className="pbtn" disabled={busy || running} onClick={() => setPop({ kind: 'keep', id: v.id })}>
          Keep
        </button>
        <button
          type="button"
          className={`pbtn danger${armed ? ' armed' : ''}`}
          disabled={busy}
          onClick={() => {
            if (!armed) return setArmed(true);
            act(
              () => api(`takes/${v.id}/discard`, {}),
              () => {
                onClose();
                if (viewing) switchTo('main', { from: v.id });
              }
            );
          }}
        >
          {armed ? 'Click again to discard' : 'Discard'}
        </button>
      </div>
      <div className="row end">
        <a className="link" href={logUrl} target="_blank" rel="noreferrer">
          Log
        </a>
      </div>
    </>
  );
}

function Errors({ v, onFix }) {
  if (!v.errors.length) return null;
  return (
    <div className="note fail">
      {plural(v.errors.length, 'error')} in the browser
      <ul className="errs" style={{ marginTop: 6 }}>
        {v.errors.slice(0, 3).map((e) => (
          <li key={e.message}>
            {e.message}
            {e.count > 1 && <span> ×{e.count}</span>}
          </li>
        ))}
      </ul>
      <div className="row">
        {onFix && (
          <button type="button" className="pbtn primary" onClick={onFix}>
            Ask {v.label} to fix
          </button>
        )}
        <button type="button" className="link" onClick={() => api(`versions/${v.id}/clear-errors`, {}).catch(() => {})}>
          Clear
        </button>
      </div>
    </div>
  );
}

function BrokenFlows({ v, onFix }) {
  const broken = brokenFlows(v);
  if (!broken.length) return null;
  return (
    <div className="note fail">
      {broken.length === 1 ? `Your flow "${broken[0].name}" fails here` : `${broken.length} of your flows fail here`}
      {v.kind === 'take' ? ' but passes on main' : ''}
      <ul className="errs" style={{ marginTop: 6 }}>
        {broken.slice(0, 3).map((f) => (
          <li key={f.id}>{f.error}</li>
        ))}
      </ul>
      {onFix && (
        <div className="row">
          <button type="button" className="pbtn primary" onClick={onFix}>
            Ask {v.label} to fix
          </button>
        </div>
      )}
    </div>
  );
}

const FLOW_MARK = { pass: '✓', fail: '×', running: '', queued: '', none: '·' };

function FlowsPanel({ v, flows, onRecord }) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const results = new Map((v.flows || []).map((f) => [f.id, f]));
  const running = v.kind === 'take' && v.agent && v.agent.status === 'running';
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err.message, { duration: 8000, dismissible: true });
    } finally {
      setBusy(false);
    }
  };
  const shotUrl = (f) => `/__orch/api/flowshot/${encodeURIComponent(v.id)}/${encodeURIComponent(f)}?t=${encodeURIComponent(CFG.token)}`;
  return (
    <>
      <div className="ph">
        <h2>Flows</h2>
        <span className="pill">on {v.label}</span>
      </div>
      {!flows.length ? (
        <p className="said">
          Record what you'd check by hand, like searching and opening a result. Orchestrator replays it on every take when its agent finishes, and
          tells you when a take breaks it.
        </p>
      ) : (
        <ul className="flows">
          {flows.map((f) => {
            const r = results.get(f.id) || { status: 'none' };
            const st = r.status === 'fail' && r.alsoOnMain ? 'warn' : r.status;
            return (
              <li key={f.id} className={`flow ${st}`}>
                <button type="button" className="flow-row" aria-expanded={open === f.id} onClick={() => setOpen((o) => (o === f.id ? null : f.id))}>
                  <span className={`fmark ${st}`} aria-hidden="true">
                    {r.status === 'running' || r.status === 'queued' ? <span className="mini-spin" /> : FLOW_MARK[r.status] || '·'}
                  </span>
                  <span className="fname">{f.name}</span>
                  <span className="fmeta">
                    {r.status === 'pass'
                      ? 'Passes'
                      : r.status === 'fail'
                        ? r.alsoOnMain
                          ? 'Fails on main too'
                          : 'Broken'
                        : r.status === 'running'
                          ? 'Replaying'
                          : r.status === 'queued'
                            ? 'Waiting'
                            : plural(f.steps, 'step')}
                  </span>
                </button>
                {open === f.id && (
                  <div className="flow-more">
                    {r.error && <p className="ferr">{r.error}</p>}
                    {(r.problems || [])
                      .filter((p) => p !== r.error)
                      .slice(0, 3)
                      .map((p) => (
                        <p key={p} className="ferr">
                          {p}
                        </p>
                      ))}
                    <div className="row">
                      <button type="button" className="pbtn" disabled={busy || running} onClick={() => act(() => api(`versions/${v.id}/run-flows`, { only: [f.id] }))}>
                        Run on {v.label}
                      </button>
                      {r.shot && (
                        <a className="link" href={shotUrl(f.id)} target="_blank" rel="noreferrer">
                          Screenshot
                        </a>
                      )}
                      <span className="grow" />
                      <button
                        type="button"
                        className={`pbtn danger${armed === f.id ? ' armed' : ''}`}
                        disabled={busy}
                        onClick={() => {
                          if (armed !== f.id) return setArmed(f.id);
                          act(() => api(`flows/${encodeURIComponent(f.id)}/delete`, {}));
                        }}
                      >
                        {armed === f.id ? 'Click again to delete' : 'Delete'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="row end">
        {flows.length > 0 && (
          <button type="button" className="pbtn" disabled={busy || running} onClick={() => act(() => api(`versions/${v.id}/run-flows`, {}))}>
            Run all on {v.label}
          </button>
        )}
        <button type="button" className="pbtn primary" onClick={onRecord}>
          Record a flow
        </button>
      </div>
      <p className="hint">Flows are saved in .orch/flows in your app, with a Playwright test for each. Commit them to share.</p>
    </>
  );
}

function KeepPanel({ v, branch, onClose }) {
  const [busy, setBusy] = useState(false);
  if (!v) return <p className="said">This take is gone.</p>;
  const running = v.agent.status === 'running';
  return (
    <>
      <div className="ph">
        <Avatar v={v} />
        <h2>Keep {v.label}?</h2>
      </div>
      <p className="said">
        Its changes are merged into <b>{branch || 'your branch'}</b> as a commit, and the take is removed. Your other takes stay.
      </p>
      {running && <p className="said">It's still working. Wait for it or stop it first.</p>}
      <div className="row end">
        <button type="button" className="pbtn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="pbtn primary"
          disabled={busy || running}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`takes/${v.id}/keep`, {});
              onClose();
              if (CFG.v === v.id) switchTo('main', { from: v.id });
            } catch (err) {
              toast.error(err.message, { duration: 10000, dismissible: true });
              setBusy(false);
            }
          }}
        >
          {busy ? 'Keeping…' : `Keep ${v.label}`}
        </button>
      </div>
    </>
  );
}

function Composer({ servedTake, picked, setPicked, onRepick, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current && ref.current.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  const running = servedTake && servedTake.agent.status === 'running';
  const submit = async (kind) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      if (kind === 'refine') {
        await api(`takes/${servedTake.id}/followup`, { prompt: text, element: picked });
        toast.success(`${servedTake.label} is on it`, { duration: 3000 });
      } else {
        const r = await api('takes', { prompt: text, element: picked });
        toast.success(`${r.take.label} is on it. Its tile shows progress.`, { duration: 3500 });
      }
      setPicked(null);
      onDone();
    } catch (err) {
      toast.error(err.message, { duration: 8000, dismissible: true });
      setBusy(false);
    }
  };
  const primary = servedTake && !running ? 'refine' : 'new';
  return (
    <>
      <div className="ph">
        <h2>{servedTake ? 'Ask for a change' : 'New take'}</h2>
      </div>
      {picked ? (
        <div className="chip" title={picked.selector}>
          <span>
            {picked.component ? `${picked.component} · ` : ''}
            {(picked.selector || '').split(' > ').pop()}
          </span>
          <button type="button" aria-label="Forget the element" onClick={() => setPicked(null)}>
            <CloseIcon />
          </button>
        </div>
      ) : (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          No element picked.{' '}
          <button type="button" className="link" onClick={onRepick}>
            Point at one
          </button>
        </p>
      )}
      <textarea
        ref={ref}
        className="field"
        placeholder="Make the search bar larger"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit(primary);
          }
        }}
      />
      <div className="row end">
        {servedTake && (
          <button type="button" className={`pbtn${primary === 'new' ? ' primary' : ''}`} disabled={busy || !text.trim()} onClick={() => submit('new')}>
            New take
          </button>
        )}
        {servedTake ? (
          <button type="button" className={`pbtn${primary === 'refine' ? ' primary' : ''}`} disabled={busy || running || !text.trim()} onClick={() => submit('refine')}>
            Ask {servedTake.label}
          </button>
        ) : (
          <button type="button" className="pbtn primary" disabled={busy || !text.trim()} onClick={() => submit('new')}>
            {busy ? 'Starting…' : 'Start agent'}
          </button>
        )}
      </div>
      <p className="hint">
        {servedTake
          ? running
            ? `${servedTake.label} is still working, so this can only start a new take.`
            : `${servedTake.label} builds on its own work. New take starts fresh from your last commit.`
          : 'Claude Code works on a copy of your last commit, and you can watch it land live.'}
      </p>
    </>
  );
}

function Settings({ prefs, setPrefs, onHide, onClose }) {
  return (
    <>
      <div className="mrow" style={{ cursor: 'default' }}>
        <span>Theme</span>
        <span className="seg">
          {['ink', 'paper', 'auto'].map((t) => (
            <button key={t} type="button" aria-pressed={prefs.theme === t} onClick={() => setPrefs((p) => ({ ...p, theme: t }))}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </span>
      </div>
      <div className="mhr" />
      <button
        type="button"
        className="mrow"
        onClick={() => {
          setPrefs((p) => ({ ...p, edge: 'bottom', align: 'center' }));
          onClose();
        }}
      >
        Reset position
      </button>
      <button type="button" className="mrow" onClick={onHide}>
        Hide until reload
      </button>
    </>
  );
}

// ---------- picking an element ----------

function Picker({ host, hintAt, onPick, hint }) {
  const [box, setBox] = useState(null);
  const target = useRef(null);
  const find = (x, y) => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host || el === document.documentElement || el === document.body) continue;
      return el;
    }
    return null;
  };
  const show = (el) => {
    target.current = el;
    if (!el) return setBox(null);
    const r = el.getBoundingClientRect();
    setBox({ x: r.left, y: r.top, w: r.width, h: r.height, label: shortLabel(el) });
  };
  useEffect(() => {
    const onScroll = () => target.current && show(target.current);
    addEventListener('scroll', onScroll, true);
    return () => removeEventListener('scroll', onScroll, true);
  }, []);
  return (
    <>
      <div
        className="pick-layer"
        onPointerMove={(e) => {
          const el = find(e.clientX, e.clientY);
          if (el !== target.current) show(el);
        }}
        onClick={(e) => {
          e.preventDefault();
          const el = target.current || find(e.clientX, e.clientY);
          if (el) onPick(describeElement(el), el);
        }}
      />
      {box && (
        <>
          <div className="pick-box" style={{ left: box.x - 2, top: box.y - 2, width: box.w + 4, height: box.h + 4 }} />
          <div className="pick-tag" style={{ left: Math.max(4, box.x - 2), top: box.y > 28 ? box.y - 26 : box.y + box.h + 6 }}>
            {box.label}
          </div>
        </>
      )}
      <div className="pick-hint" style={hintAt === 'top' ? { top: 16 } : { bottom: 16 }}>
        {hint || (
          <>
            Click the part you want to change · <kbd>Enter</kbd> to skip · <kbd>Esc</kbd> to cancel
          </>
        )}
      </div>
    </>
  );
}

// ---------- compare ----------

function Compare({ versions, onClose }) {
  const switchable = versions.filter((v) => v.switchable);
  const latestTake = [...switchable].reverse().find((v) => v.kind === 'take' && v.id !== CFG.v);
  const [left, setLeft] = useState(CFG.v);
  const [right, setRight] = useState(CFG.v === 'main' ? (latestTake ? latestTake.id : 'main') : 'main');
  const [ports, setPorts] = useState({});
  const [sync, setSync] = useState(true);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const path = location.pathname + location.search + location.hash;

  useEffect(() => {
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    for (const id of [left, right]) {
      if (ports[id]) continue;
      api('pin', { version: id })
        .then((r) => setPorts((p) => ({ ...p, [id]: r.port })))
        .catch((err) => toast.error(err.message, { duration: 6000, dismissible: true }));
    }
  }, [left, right]);

  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data;
      if (!sync || !d || d.__orch !== 'scroll') return;
      const l = leftRef.current && leftRef.current.contentWindow;
      const r = rightRef.current && rightRef.current.contentWindow;
      const other = e.source === l ? r : e.source === r ? l : null;
      if (other) other.postMessage({ __orch: 'scrollTo', x: d.x, y: d.y }, '*');
    };
    addEventListener('message', onMsg);
    return () => removeEventListener('message', onMsg);
  }, [sync]);

  const src = (id) => (ports[id] ? `${location.protocol}//${location.hostname}:${ports[id]}${path}` : null);
  const pane = (id, ref) => {
    const v = versions.find((x) => x.id === id);
    const s = src(id);
    return (
      <div className="pane">
        {v && (
          <span className="pane-label">
            <Avatar v={v} />
            {v.label}
          </span>
        )}
        {s ? <iframe key={s} ref={ref} src={s} title={v ? v.label : id} /> : <div className="pane-wait">Loading…</div>}
      </div>
    );
  };
  const select = (value, set, label) => (
    <select className="sel" aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      {switchable.map((v) => (
        <option key={v.id} value={v.id}>
          {v.label}
        </option>
      ))}
    </select>
  );
  return (
    <div className="cmp" role="dialog" aria-label="Compare versions">
      <div className="cmp-bar">
        <span className="title">Compare</span>
        {select(left, setLeft, 'Left side')}
        <span style={{ color: 'var(--muted)' }}>and</span>
        {select(right, setRight, 'Right side')}
        <span className="grow" />
        <label className="check">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />
          Scroll together
        </label>
        <button type="button" className="btn-i" aria-label="Close compare" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="cmp-panes">
        {pane(left, leftRef)}
        {pane(right, rightRef)}
      </div>
    </div>
  );
}
