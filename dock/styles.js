// Ink is the default dark glass; Paper is the light theme. Values come from the dock design spec.
export const css = `
:host { all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483000; }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }

.root {
  --bg: rgba(22,24,31,.9); --pop: #1c1f27; --fg: #f3f4f8; --muted: #a9afbd; --line: rgba(255,255,255,.12);
  --accent: #8c9cff; --press: rgba(255,255,255,.14); --hover: rgba(255,255,255,.08); --ring: #1a1c23; --num: #11131a;
  --ok: #4cc38a; --warn: #f2b14c; --fail: #ff7a70; --bwarn: #2a1c05; --bfail: #2a0d0a;
  --field: rgba(255,255,255,.06); --field-line: rgba(255,255,255,.14);
  --sh: 0 0 0 1px rgba(0,0,0,.3), 0 14px 34px -12px rgba(8,10,18,.55), inset 0 1px 0 rgba(255,255,255,.07);
  --sh-pop: 0 0 0 1px rgba(255,255,255,.08), 0 24px 48px -16px rgba(0,0,0,.6);
  --hm: #d5d8e1; --h1: #8fa2ff; --h2: #ff8fb8; --h3: #ffa25e; --h4: #c8d86a; --h5: #4fd1b8; --h6: #6cc8f5; --h7: #c99bff; --h8: #e3c28f;
  font: 500 13px/18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
.root.paper {
  --bg: rgba(255,255,255,.88); --pop: #ffffff; --fg: #121620; --muted: #4b5364; --line: rgba(18,22,32,.10);
  --accent: #2b45e0; --press: rgba(18,22,32,.07); --hover: rgba(18,22,32,.05); --ring: #ffffff; --num: #ffffff;
  --ok: #16794a; --warn: #965800; --fail: #b8322a; --bwarn: #ffffff; --bfail: #ffffff;
  --field: rgba(18,22,32,.03); --field-line: rgba(18,22,32,.16);
  --sh: 0 0 0 1px rgba(18,22,32,.1), 0 14px 34px -14px rgba(18,22,32,.32), inset 0 1px 0 #ffffff;
  --sh-pop: 0 0 0 1px rgba(18,22,32,.1), 0 24px 48px -16px rgba(18,22,32,.35);
  --hm: #5b6272; --h1: #4658d8; --h2: #c2366f; --h3: #b4501a; --h4: #66761a; --h5: #0f7d69; --h6: #1a6fa3; --h7: #8a4fd6; --h8: #8a6424;
}

/* ---------- the bar ---------- */
.dock {
  position: fixed; display: flex; align-items: center; gap: 2px; padding: 4px;
  border-radius: 16px; background: var(--bg);
  -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5);
  box-shadow: var(--sh); color: var(--fg); user-select: none; -webkit-user-select: none;
  transition: left .3s cubic-bezier(.2,.8,.2,1), top .3s cubic-bezier(.2,.8,.2,1);
  touch-action: none;
}
.dock[data-orient="v"] { flex-direction: column; }
.dock.closed { border-radius: 24px; }
.dock.dragging { transition: none; box-shadow: var(--sh), 0 26px 50px -12px rgba(8,10,18,.6); cursor: grabbing; }
.dock.measuring { visibility: hidden; transition: none; }

.btn-i {
  flex: none; position: relative; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 12px;
  background: none; display: grid; place-items: center; cursor: pointer; outline: none;
}
.btn-i:hover { background: var(--hover); }
.btn-i:focus-visible, .now:focus-visible, .pbtn:focus-visible, .field:focus-visible, .seg button:focus-visible {
  box-shadow: 0 0 0 2px var(--pop), 0 0 0 4px var(--accent);
}
.btn-i[disabled] { opacity: .38; cursor: default; background: none; }
.btn-i[aria-pressed="true"], .btn-i.on { background: var(--press); }
.handle { border-radius: 20px; cursor: grab; }
.dock.dragging .handle { cursor: grabbing; }
.mark { width: 20px; height: 20px; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.mark .wa { stroke: var(--accent); } .mark .wb { stroke: var(--fg); }
.offline .mark .wa { stroke: var(--warn); }

.now {
  flex: none; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 8px;
  border: 0; border-radius: 20px; background: none; white-space: nowrap; cursor: pointer; outline: none;
}
.now:hover { background: var(--hover); }
.now b { font-weight: 600; }
.ver { font: 500 12px/1 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; color: var(--muted); }
.st { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.st.warn { background: var(--warn); } .st.fail { background: var(--fail); } .st.busy { background: var(--accent); }
.sep { flex: none; width: 1px; height: 24px; margin: 0 4px; background: var(--line); }
.dock[data-orient="v"] .sep { width: 24px; height: 1px; margin: 4px 0; }

.tiles { display: flex; gap: 2px; align-items: center; }
.dock[data-orient="v"] .tiles { flex-direction: column; }
.tiles.scroll { overflow-x: auto; scrollbar-width: none; max-width: calc(100vw - 260px); }
.tile.viewing::after {
  content: ""; position: absolute; width: 4px; height: 4px; border-radius: 50%; background: var(--fg);
}
.dock[data-edge="bottom"] .tile.viewing::after { bottom: -3px; left: 18px; }
.dock[data-edge="top"] .tile.viewing::after { top: -3px; left: 18px; }
.dock[data-edge="left"] .tile.viewing::after { left: -3px; top: 18px; }
.dock[data-edge="right"] .tile.viewing::after { right: -3px; top: 18px; }
.tile.pending .av { opacity: .55; }

.av {
  position: relative; flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
  color: var(--num); font: 700 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.now .av, .ph .av { width: 22px; height: 22px; font-size: 11px; }
.av svg { width: 15px; height: 15px; fill: none; stroke: var(--num); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.now .av svg, .ph .av svg { width: 12px; height: 12px; }
.hm { background: var(--hm); } .h1 { background: var(--h1); } .h2 { background: var(--h2); } .h3 { background: var(--h3); }
.h4 { background: var(--h4); } .h5 { background: var(--h5); } .h6 { background: var(--h6); } .h7 { background: var(--h7); } .h8 { background: var(--h8); }
.badge {
  position: absolute; top: 2px; right: 2px; width: 13px; height: 13px; border-radius: 50%; display: grid; place-items: center;
  font: 800 9px/1 system-ui, sans-serif; box-shadow: 0 0 0 2px var(--ring);
}
.badge.fail { background: var(--fail); color: var(--bfail); }
.badge.warn { background: var(--warn); color: var(--bwarn); }
.spin {
  position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--accent);
  border-right-color: transparent; border-bottom-color: transparent; animation: orch-spin .9s linear infinite;
}
@keyframes orch-spin { to { transform: rotate(360deg); } }
.ic { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

/* tooltips open inward */
[data-tip]::before {
  content: attr(data-tip); position: absolute; z-index: 5; pointer-events: none; white-space: nowrap;
  padding: 6px 9px; border-radius: 9px; background: var(--pop); color: var(--fg); box-shadow: var(--sh-pop);
  font: 500 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif; opacity: 0; transition: opacity .12s; transition-delay: 0s;
}
[data-tip]:hover::before { opacity: 1; transition-delay: .25s; }
.dock.dragging [data-tip]::before, .dock.has-pop [data-tip]::before { display: none; }
.dock[data-edge="bottom"] [data-tip]::before { bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); }
.dock[data-edge="top"] [data-tip]::before { top: calc(100% + 10px); left: 50%; transform: translateX(-50%); }
.dock[data-edge="left"] [data-tip]::before { left: calc(100% + 10px); top: 50%; transform: translateY(-50%); }
.dock[data-edge="right"] [data-tip]::before { right: calc(100% + 10px); top: 50%; transform: translateY(-50%); }

/* ---------- popovers ---------- */
.pop {
  position: fixed; width: 360px; max-width: calc(100vw - 24px); max-height: calc(100vh - 96px); overflow: auto;
  padding: 14px; border-radius: 16px; background: var(--pop); color: var(--fg); box-shadow: var(--sh-pop);
  animation: orch-rise .18s ease-out; overscroll-behavior: contain;
}
@keyframes orch-rise { from { opacity: 0; translate: 0 6px; } to { opacity: 1; translate: 0 0; } }
.ph { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ph h2 { margin: 0; font: 600 14px/20px system-ui, -apple-system, "Segoe UI", sans-serif; }
.pill { margin-left: auto; padding: 3px 8px; border-radius: 999px; font: 600 11px/14px system-ui, sans-serif; background: var(--field); color: var(--muted); white-space: nowrap; }
.pill.ok { color: var(--ok); } .pill.busy { color: var(--accent); } .pill.fail { color: var(--fail); } .pill.warn { color: var(--warn); }
.quote { margin: 0 0 10px; padding: 8px 10px; border-radius: 10px; background: var(--field); color: var(--fg); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
.quote small { display: block; margin-top: 4px; color: var(--muted); font-size: 11.5px; }
.line { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; color: var(--muted); font-size: 12.5px; line-height: 18px; }
.line .mini-spin { flex: none; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--accent); border-right-color: transparent; animation: orch-spin .9s linear infinite; }
.said { margin: 0 0 10px; color: var(--muted); font-size: 12.5px; line-height: 18px; overflow-wrap: anywhere; }
.said b { color: var(--fg); font-weight: 600; }
.note { margin: 0 0 10px; padding: 9px 11px; border-radius: 10px; font-size: 12.5px; line-height: 18px; overflow-wrap: anywhere; }
.note.fail { background: rgba(255,122,112,.12); color: var(--fg); }
.paper .note.fail { background: rgba(184,50,42,.08); }
.note pre { margin: 6px 0 0; max-height: 140px; overflow: auto; white-space: pre-wrap; font: 11px/1.45 ui-monospace, Menlo, monospace; color: var(--muted); }
.errs { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.errs li { font: 11.5px/1.45 ui-monospace, Menlo, monospace; color: var(--fg); overflow-wrap: anywhere; }
.errs li span { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.row.end { justify-content: flex-end; }
.row + .row, .field + .row { margin-top: 8px; }
.pbtn {
  height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--field); color: var(--fg);
  font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; outline: none; white-space: nowrap;
  box-shadow: inset 0 0 0 1px var(--field-line);
}
.pbtn:hover { background: var(--press); }
.pbtn.primary { background: var(--accent); color: var(--num); box-shadow: none; }
.paper .pbtn.primary { color: #fff; }
.pbtn.danger { color: var(--fail); }
.pbtn.danger.armed { background: var(--fail); color: var(--bfail); box-shadow: none; }
.pbtn[disabled] { opacity: .45; cursor: default; }
.link { border: 0; padding: 0; background: none; color: var(--muted); font: 500 12px/1 system-ui, sans-serif; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.field {
  display: block; width: 100%; min-height: 64px; max-height: 180px; resize: vertical; padding: 9px 11px; border: 0; border-radius: 10px;
  background: var(--field); box-shadow: inset 0 0 0 1px var(--field-line); color: var(--fg); outline: none;
  font: 500 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
}
.field::placeholder { color: var(--muted); }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 11.5px; line-height: 16px; }
.chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; margin: 0 0 8px; padding: 4px 6px 4px 9px; border-radius: 8px; background: var(--field); box-shadow: inset 0 0 0 1px var(--field-line); font: 500 12px/16px ui-monospace, Menlo, monospace; }
.chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip button { flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--muted); cursor: pointer; }
.chip button:hover { background: var(--hover); color: var(--fg); }
.menu { width: 240px; padding: 6px; }
.mrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 8px 10px; border: 0; border-radius: 9px; background: none; text-align: left; cursor: pointer; }
.mrow:hover { background: var(--hover); }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--field); }
.seg button { padding: 4px 7px; border: 0; border-radius: 6px; background: none; font-size: 12px; color: var(--muted); cursor: pointer; outline: none; }
.seg button[aria-pressed="true"] { background: var(--press); color: var(--fg); }
.mhr { height: 1px; margin: 4px 6px; background: var(--line); }

/* ---------- picking ---------- */
.pick-layer { position: fixed; inset: 0; cursor: crosshair; background: transparent; }
.pick-box { position: fixed; pointer-events: none; border: 2px solid #2b45e0; border-radius: 4px; background: rgba(43,69,224,.10); transition: all .06s ease-out; }
.pick-tag { position: fixed; pointer-events: none; padding: 5px 8px; border-radius: 6px; background: #2b45e0; color: #fff; font: 600 11px/1 ui-monospace, Menlo, monospace; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
.pick-hint {
  position: fixed; left: 50%; transform: translateX(-50%); padding: 9px 14px; border-radius: 12px; background: var(--pop); color: var(--fg);
  box-shadow: var(--sh-pop); font-size: 13px; white-space: nowrap; pointer-events: none;
}
.pick-hint kbd { font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 3px 5px; border-radius: 5px; background: var(--field); box-shadow: inset 0 0 0 1px var(--field-line); }

/* ---------- compare ---------- */
.cmp { position: fixed; inset: 0; display: flex; flex-direction: column; background: #0e1016; }
.cmp-bar { flex: none; display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 12px; background: var(--pop); color: var(--fg); box-shadow: 0 1px 0 var(--line); }
.cmp-bar .title { font-weight: 600; margin-right: 6px; }
.sel { height: 32px; padding: 0 10px; border: 0; border-radius: 10px; background: var(--field); color: var(--fg); box-shadow: inset 0 0 0 1px var(--field-line); font: 500 13px/1 system-ui, sans-serif; }
.sel option { background: var(--pop); color: var(--fg); }
.cmp-bar .grow { flex: 1; }
.check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12.5px; cursor: pointer; }
.cmp-panes { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 2px; min-height: 0; }
.pane { position: relative; display: flex; flex-direction: column; min-width: 0; background: #fff; }
.pane-label { position: absolute; z-index: 1; bottom: 12px; left: 12px; display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 4px; border-radius: 999px; background: var(--pop); color: var(--fg); box-shadow: var(--sh-pop); font-weight: 600; font-size: 12px; pointer-events: none; }
.pane iframe { flex: 1; width: 100%; height: 100%; border: 0; background: #fff; }
.pane-wait { position: absolute; inset: 0; display: grid; place-items: center; color: #4b5364; font-size: 13px; }
@media (max-width: 640px) { .cmp-panes { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }

@media (prefers-reduced-motion: reduce) {
  .dock, .pop, .pick-box { transition: none !important; animation: none !important; }
  .spin, .mini-spin { animation: none !important; }
}
`;
