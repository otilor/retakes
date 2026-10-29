import test from 'node:test';
import assert from 'node:assert/strict';
import { injectDock, readCookie } from '../../src/hub.js';

const cfg = { v: 't1', token: 'abc', pane: false };

test('injectDock puts the config, error capture and dock script before </head>', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
  const out = injectDock(html, cfg);
  const at = out.indexOf('window.__RETAKES__=');
  assert.ok(at > 0 && at < out.indexOf('</head>'));
  assert.ok(out.includes('<script src="/__retakes/dock.js" defer data-retakes></script></head>'));
  assert.ok(out.includes("addEventListener('unhandledrejection'"));
  assert.ok(out.endsWith('<body><div id="root"></div></body></html>'));
});

test('injectDock falls back to <body>, then to the start', () => {
  assert.ok(/^<body class="a"><script data-retakes>/.test(injectDock('<body class="a"><p>hi</p></body>', cfg)));
  assert.ok(injectDock('<p>hi</p>', cfg).startsWith('<script data-retakes>'));
});

test('injectDock cannot be broken out of with </script> in the config', () => {
  const out = injectDock('<head></head>', { ...cfg, v: '</script><script>alert(1)</script>' });
  assert.equal(out.match(/<\/script>/g).length, 2);
  assert.ok(out.includes('\\u003c/script>'));
});

test('readCookie reads a safe value and ignores the rest', () => {
  assert.equal(readCookie('a=1; __retakes_v=t3; b=2', '__retakes_v'), 't3');
  assert.equal(readCookie('x__retakes_v=t9', '__retakes_v'), null);
  assert.equal(readCookie('__retakes_v=../../etc', '__retakes_v'), null);
  assert.equal(readCookie('__retakes_v=', '__retakes_v'), null);
  assert.equal(readCookie(undefined, '__retakes_v'), null);
});
