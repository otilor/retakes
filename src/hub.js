import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { UserError, findPort, releasePort } from './proc.js';

const COOKIE = '__retakes_v';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_BODY = 1024 * 1024;

/**
 * The one URL you open. It proxies every request to the dev server of the version
 * you're viewing (picked by a cookie, so the URL, cookies and storage stay the same
 * when you switch), adds the dock to HTML pages, and serves the dock's API.
 *
 * Compare panes get "pinned" ports that always serve one version.
 */
export class Hub {
  constructor(retakes, { port, host = '127.0.0.1', dockFile, log = () => {} }) {
    this.retakes = retakes;
    this.port = port;
    this.host = host;
    this.dockFile = dockFile;
    this.log = log;
    this.token = crypto.randomBytes(24).toString('hex');
    this.clients = new Set();
    this.pins = new Map();
    this.servers = [];
    retakes.on('state', (s) => this.broadcast('state', s));
    retakes.on('notice', (n) => this.broadcast('notice', n));
    retakes.on('removed', (id) => this.unpin(id));
  }

  listen() {
    return this.serve(this.port, null);
  }

  serve(port, pinned) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res, pinned).catch((err) => {
          this.log('Unexpected error', err.stack || err.message);
          if (!res.headersSent) sendJson(res, 500, { error: `Something went wrong: ${err.message}` });
          else res.destroy();
        });
      });
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, pinned));
      server.on('clientError', (err, socket) => socket.destroy());
      server.once('error', reject);
      server.listen({ port, host: this.host }, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => this.log('Server error', err.message));
        this.servers.push(server);
        resolve(server);
      });
    });
  }

  async close() {
    clearInterval(this.pingTimer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    for (const s of this.servers) {
      s.close();
      s.closeAllConnections?.();
    }
  }

  // ---------- routing ----------

  async handle(req, res, pinned) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/__retakes/')) {
      if (!this.hostAllowed(req)) return sendText(res, 403, 'Retakes only answers on localhost.');
      if (url.pathname === '/__retakes/dock.js') return this.sendDock(res);
      if (pinned) return sendText(res, 404, 'Not found');
      if (url.pathname === '/__retakes/events') return this.events(req, res, url);
      if (url.pathname.startsWith('/__retakes/api/')) return this.api(req, res, url);
      return sendText(res, 404, 'Not found');
    }
    return this.proxy(req, res, pinned);
  }

  hostAllowed(req) {
    const host = String(req.headers.host || '');
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (LOCAL_HOSTS.has(name.toLowerCase()) || name.toLowerCase().endsWith('.localhost')) return true;
    return this.host !== '127.0.0.1' && name === this.host;
  }

  sendDock(res) {
    let js;
    try {
      js = fs.readFileSync(this.dockFile);
    } catch {
      return sendText(res, 500, 'The dock bundle is missing. Run `npm run build` in the retakes package.');
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': js.length,
    });
    res.end(js);
  }

  // ---------- proxy ----------

  pick(req, pinned) {
    if (pinned) return { id: pinned, target: this.retakes.target(pinned) };
    const wanted = readCookie(req.headers.cookie, COOKIE) || 'main';
    const target = this.retakes.target(wanted);
    if (target) return { id: wanted, target };
    return { id: 'main', target: this.retakes.target('main') };
  }

  proxy(req, res, pinned) {
    const { id, target } = this.pick(req, pinned);
    if (!target) return this.notReady(req, res, pinned);
    const wantsHtml = /text\/html/.test(String(req.headers.accept || ''));
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    if (wantsHtml) {
      // The same URL serves different versions, so never let the browser reuse a cached page.
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    return new Promise((resolve) => {
      const up = http.request(
        { host: target.host, port: target.port, method: req.method, path: req.url, headers },
        (upRes) => {
          const type = String(upRes.headers['content-type'] || '');
          const inject = req.method === 'GET' && /text\/html/i.test(type) && upRes.statusCode !== 304;
          const outHeaders = { ...upRes.headers };
          delete outHeaders.connection;
          delete outHeaders['keep-alive'];
          if (!inject) {
            res.writeHead(upRes.statusCode, outHeaders);
            upRes.pipe(res);
            upRes.on('end', resolve);
            upRes.on('error', () => {
              res.destroy();
              resolve();
            });
            return;
          }
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const html = injectDock(Buffer.concat(chunks).toString('utf8'), {
              v: id,
              token: pinned ? null : this.token,
              pane: !!pinned,
            });
            const body = Buffer.from(html, 'utf8');
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            delete outHeaders['content-encoding'];
            delete outHeaders.etag;
            delete outHeaders['last-modified'];
            outHeaders['cache-control'] = 'no-store';
            outHeaders['content-length'] = body.length;
            res.writeHead(upRes.statusCode, outHeaders);
            res.end(body);
            resolve();
          });
          upRes.on('error', () => {
            res.destroy();
            resolve();
          });
        }
      );
      up.on('error', (err) => {
        if (!res.headersSent) {
          sendText(res, 502, `Retakes couldn't reach the dev server for ${id === 'main' ? 'main' : id}: ${err.message}`);
        } else res.destroy();
        resolve();
      });
      req.pipe(up);
    });
  }

  notReady(req, res, pinned) {
    const main = this.retakes.main.server;
    const wantsHtml = /text\/html/.test(String(req.headers.accept || ''));
    if (!wantsHtml) return sendText(res, 503, 'The dev server is starting.');
    const failed = !pinned && (main.status === 'failed' || main.status === 'crashed');
    const body = failed
      ? page(
          "Your dev server didn't start",
          `<p>Retakes ran your dev server, but it stopped. Here's the end of its output:</p><pre>${esc(main.error || '')}</pre><p>Fix the problem, then restart <code>retakes</code>.</p>`
        )
      : page('Starting…', '<p>Waiting for the dev server. This page reloads when it’s ready.</p>', true);
    res.writeHead(failed ? 502 : 503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  upgrade(req, socket, head, pinned) {
    socket.on('error', () => socket.destroy());
    const { target } = this.pick(req, pinned);
    if (!target || String(req.url).startsWith('/__retakes/')) return socket.destroy();
    const up = net.connect(target.port, target.host, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${raw}\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
  }

  // ---------- live events ----------

  events(req, res, url) {
    if (url.searchParams.get('t') !== this.token) return sendText(res, 403, 'Bad token');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(this.retakes.snapshot())}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        for (const c of this.clients) c.write(': ping\n\n');
      }, 15000);
      this.pingTimer.unref();
    }
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  // ---------- API ----------

  async api(req, res, url) {
    const token = req.headers['x-retakes-token'] || url.searchParams.get('t');
    if (token !== this.token) return sendJson(res, 403, { error: 'Reload the page: Retakes restarted.' });
    const parts = url.pathname.slice('/__retakes/api/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    const o = this.retakes;
    try {
      if (req.method === 'GET') {
        if (parts[0] === 'state') return sendJson(res, 200, o.snapshot());
        if (parts[0] === 'log' && parts[1]) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(o.readLog(parts[1]) || 'Nothing logged yet.');
        }
        if (parts[0] === 'flows' && parts[1]) {
          const flow = o.flows.find((f) => f.id === parts[1]);
          return flow ? sendJson(res, 200, { flow }) : sendJson(res, 404, { error: "That flow doesn't exist anymore." });
        }
        if (parts[0] === 'flowshot' && parts[1] && parts[2]) {
          const file = o.flowShot(parts[1], parts[2]);
          if (!file) return sendJson(res, 404, { error: 'No screenshot' });
          const img = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': img.length });
          return res.end(img);
        }
        return sendJson(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const body = await readJson(req);
      const [a, id, action] = parts;
      if (a === 'takes' && !id) {
        const takes = await o.createTakes({ prompt: body.prompt, element: cleanElement(body.element), count: body.count });
        return sendJson(res, 200, { take: takes[0], takes });
      }
      if (a === 'takes' && id) {
        switch (action) {
          case 'another':
            return sendJson(res, 200, { take: await o.createTake({ from: id }) });
          case 'followup':
            o.followUp(id, body.prompt, cleanElement(body.element));
            return sendJson(res, 200, { ok: true });
          case 'fix':
            o.fix(id);
            return sendJson(res, 200, { ok: true });
          case 'retry':
            o.retry(id);
            return sendJson(res, 200, { ok: true });
          case 'stop':
            await o.stopAgent(id);
            return sendJson(res, 200, { ok: true });
          case 'keep':
            return sendJson(res, 200, await o.keep(id));
          case 'discard':
            await o.discard(id);
            return sendJson(res, 200, { ok: true });
          default:
            return sendJson(res, 404, { error: 'Not found' });
        }
      }
      if (a === 'versions' && id && action === 'errors') {
        o.reportError(id, body);
        return sendJson(res, 200, { ok: true });
      }
      if (a === 'versions' && id && action === 'clear-errors') {
        o.clearErrors(id);
        return sendJson(res, 200, { ok: true });
      }
      if (a === 'flows' && !id) {
        return sendJson(res, 200, { flow: o.saveFlow(body.flow, typeof body.version === 'string' ? body.version : 'main') });
      }
      if (a === 'flows' && id && action === 'delete') {
        o.deleteFlow(id);
        return sendJson(res, 200, { ok: true });
      }
      if (a === 'versions' && id && action === 'run-flows') {
        o.runFlows(id, { only: Array.isArray(body.only) ? body.only.map(String) : null }).catch((err) => this.log('Flow replay failed', err.stack || err.message));
        return sendJson(res, 200, { ok: true });
      }
      if (a === 'agent' && !id) {
        return sendJson(res, 200, { agent: o.setAgent({ model: body.model, effort: body.effort }) });
      }
      if (a === 'pin') {
        return sendJson(res, 200, { port: await this.pin(String(body.version || '')) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
      this.log('API error', err.stack || err.message);
      return sendJson(res, 500, { error: `Something went wrong: ${err.message}` });
    }
  }

  pin(id) {
    if (!this.retakes.version(id)) return Promise.reject(new UserError("That version doesn't exist anymore."));
    if (!this.pins.has(id)) {
      const ready = (async () => {
        const port = await findPort(this.port + 100);
        const server = await this.serve(port, id);
        return { port, server };
      })();
      this.pins.set(id, ready);
      ready.catch(() => this.pins.delete(id));
    }
    return this.pins.get(id).then((p) => p.port);
  }

  unpin(id) {
    const ready = this.pins.get(id);
    if (!ready) return;
    this.pins.delete(id);
    ready
      .then((p) => {
        p.server.close();
        p.server.closeAllConnections?.();
        releasePort(p.port);
      })
      .catch(() => {});
  }
}

// ---------- helpers ----------

export function injectDock(html, cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const snippet =
    `<script data-retakes>window.__RETAKES__=${json};` +
    `(function(){var q=window.__RETAKES_ERRQ=[];function p(m,s,k){m=String(m||'');if(!m||m==='Script error.')return;q.push({message:m,stack:s?String(s):'',kind:k||'runtime'});if(window.__RETAKES_ONERR)window.__RETAKES_ONERR();}` +
    `window.addEventListener('error',function(e){p(e.message||(e.error&&e.error.message),e.error&&e.error.stack)});` +
    `window.addEventListener('unhandledrejection',function(e){var r=e.reason;p('Unhandled promise rejection: '+((r&&r.message)||r),r&&r.stack)});})();</script>` +
    `<script src="/__retakes/dock.js" defer data-retakes></script>`;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + snippet + html.slice(head);
  const body = html.match(/<body[^>]*>/i);
  if (body) return html.replace(body[0], body[0] + snippet);
  return snippet + html;
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[a-z0-9_-]{1,40}$/i.test(v) ? v : null;
    }
  }
  return null;
}

function cleanElement(el) {
  if (!el || typeof el !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  return {
    page: s(el.page, 300),
    selector: s(el.selector, 300),
    text: s(el.text, 300),
    component: s(el.component, 120),
    source: s(el.source, 300),
    components: Array.isArray(el.components) ? el.components.filter((c) => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 80)) : undefined,
    html: s(el.html, 1200),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new UserError('Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(text);
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function page(title, inner, refresh = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="1">' : ''
  }<title>${esc(title)} · Retakes</title><style>
:root{color-scheme:light dark;--bg:#f4f5f8;--fg:#121620;--muted:#4b5364;--card:#fff;--line:#dde0e8}
@media (prefers-color-scheme:dark){:root{--bg:#0e1016;--fg:#f3f4f8;--muted:#a9afbd;--card:#16181f;--line:#262a35}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:24px;padding:28px;border-radius:16px;background:var(--card);border:1px solid var(--line)}
h1{margin:0 0 8px;font-size:20px}p{color:var(--muted)}
pre{overflow:auto;max-height:50vh;padding:12px;border-radius:10px;background:#16181f;color:#f3f4f8;font:12px/1.5 ui-monospace,Menlo,monospace}
</style></head><body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`;
}
