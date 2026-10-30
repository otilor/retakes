import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './proc.js';

// Retakes Pro keys are sold and checked through Polar (polar.sh). Fill in the
// organization id from Polar's settings page before publishing a release.
export const POLAR_ORG_ID = process.env.RETAKES_POLAR_ORG || '';
export const PRO_URL = 'https://github.com/otilor/retakes#pro';

const API = process.env.RETAKES_LICENSE_API || 'https://api.polar.sh/v1/customer-portal/license-keys';
const DAY = 24 * 60 * 60 * 1000;
// Pro keeps working this long without reaching Polar, so a flight or a flaky network doesn't lock anyone out.
const OFFLINE_GRACE = 7 * DAY;

export function retakesHome() {
  return process.env.RETAKES_HOME ? path.resolve(process.env.RETAKES_HOME) : path.join(os.homedir(), '.retakes');
}

/** The Pro license on this machine: stored in ~/.retakes/license.json, checked with Polar once a day. */
export class License {
  constructor({ home = retakesHome(), org = POLAR_ORG_ID, api = API, now = Date.now, fetch: fetchFn = globalThis.fetch } = {}) {
    this.file = path.join(home, 'license.json');
    this.org = org;
    this.api = api;
    this.now = now;
    this.fetch = fetchFn;
    this.data = this.read();
    this.listeners = new Set();
    this.wasActive = this.active;
  }

  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && typeof d.key === 'string' && d.key) return d;
    } catch {
      /* no license */
    }
    return null;
  }

  write(d) {
    this.data = d;
    if (!d) {
      fs.rmSync(this.file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 });
      // writeFileSync's mode only applies to new files.
      fs.chmodSync(this.file, 0o600);
    }
    this.changed();
  }

  changed() {
    this.wasActive = this.active;
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** True while the stored key was granted, hasn't expired, and was confirmed in the last week. */
  get active() {
    const d = this.data;
    if (!d || d.status !== 'granted') return false;
    const now = this.now();
    if (d.expiresAt && Date.parse(d.expiresAt) <= now) return false;
    return now - (d.checkedAt || 0) < OFFLINE_GRACE;
  }

  info() {
    const d = this.data;
    return {
      active: this.active,
      key: d ? maskKey(d.key) : null,
      status: d ? d.status : null,
      expiresAt: d ? d.expiresAt || null : null,
      url: PRO_URL,
    };
  }

  async call(action, body) {
    if (!this.org) throw new UserError('This build of Retakes has no Polar organization set, so keys can\'t be checked.');
    let res;
    try {
      res = await this.fetch(`${this.api}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: this.org, ...body }),
        signal: AbortSignal.timeout(10_000),
      });
      res = { status: res.status, text: await res.text() };
    } catch (err) {
      const e = new UserError(`Couldn't reach the license server (${err.message}). Check your connection and try again.`);
      e.offline = true;
      throw e;
    }
    let json = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  }

  /** Activate a key on this machine. Keys without an activation limit are validated instead. */
  async activate(key) {
    key = String(key || '').trim();
    if (!key) throw new UserError('Paste your license key: retakes activate <key>');
    const prev = this.read();
    // Activating the same key again reuses this machine's activation instead of taking another slot.
    if (prev && prev.key === key && prev.activationId) {
      const v = await this.call('validate', { key, activation_id: prev.activationId });
      if (v.status >= 200 && v.status < 300 && v.json && (v.json.status || 'granted') === 'granted') {
        this.write({ ...prev, status: 'granted', expiresAt: v.json.expires_at || null, checkedAt: this.now() });
        return this.info();
      }
    }
    let activationId = null;
    let lk;
    const act = await this.call('activate', { key, label: os.hostname().slice(0, 100) || 'retakes' });
    if (act.status >= 200 && act.status < 300 && act.json) {
      activationId = act.json.id || null;
      lk = act.json.license_key || null;
    } else if (act.status === 404) {
      throw new UserError("That license key wasn't found. Check it and try again.");
    } else if (act.status === 403 && /limit/i.test(detail(act.json))) {
      throw new UserError('That key is already active on its limit of machines. Run `retakes deactivate` on one of them first.');
    }
    if (!lk) {
      const v = await this.call('validate', { key, ...(activationId ? { activation_id: activationId } : {}) });
      if (v.status === 404) throw new UserError("That license key wasn't found. Check it and try again.");
      if (v.status < 200 || v.status >= 300 || !v.json) throw new UserError(`The license server said no: ${detail(v.json) || v.status}`);
      lk = v.json;
    }
    const status = lk.status || 'granted';
    if (status !== 'granted') throw new UserError(`That key is ${status}. If you think that's wrong, reply to your receipt email.`);
    // A different key replaces the old one, so free the old key's slot on this machine.
    if (prev && prev.activationId && (prev.key !== key || prev.activationId !== activationId)) {
      await this.call('deactivate', { key: prev.key, activation_id: prev.activationId }).catch(() => {});
    }
    this.write({ key, activationId, status, expiresAt: lk.expires_at || null, checkedAt: this.now() });
    return this.info();
  }

  /** Re-check the stored key. Offline keeps the cached answer; a revoked or unknown key turns Pro off. */
  async refresh({ force = false } = {}) {
    // `retakes activate` or `deactivate` may have run in another terminal since this process started.
    const d = (this.data = this.read());
    if (d && (force || this.now() - (d.checkedAt || 0) >= DAY)) {
      try {
        const v = await this.call('validate', { key: d.key, ...(d.activationId ? { activation_id: d.activationId } : {}) });
        const now = this.read();
        const same = now && now.key === d.key && now.activationId === d.activationId;
        if (!same) this.data = now;
        else if (v.status === 404) this.write({ ...now, status: 'revoked', checkedAt: this.now() });
        else if (v.status >= 200 && v.status < 300 && v.json) {
          this.write({ ...now, status: v.json.status || 'granted', expiresAt: v.json.expires_at || null, checkedAt: this.now() });
        }
        // Any other answer (a 5xx, a rate limit) is treated like being offline.
      } catch (err) {
        // Offline, or no organization in this build: keep the cached answer.
        if (!(err instanceof UserError)) throw err;
      }
    }
    // Pro can also end without a write, when the week offline runs out.
    if (this.active !== this.wasActive) this.changed();
    return this.info();
  }

  /** Free this machine's activation and forget the key. */
  async deactivate() {
    const d = this.data;
    if (!d) return false;
    if (d.activationId) {
      // Keep the key until Polar confirms, or this machine's slot stays taken with no way to free it.
      const r = await this.call('deactivate', { key: d.key, activation_id: d.activationId });
      if (r.status !== 404 && (r.status < 200 || r.status >= 300)) {
        throw new UserError(`The license server couldn't free this machine (${detail(r.json) || r.status}). Try again in a minute.`);
      }
    }
    this.write(null);
    return true;
  }
}

function detail(json) {
  if (!json) return '';
  if (typeof json.detail === 'string') return json.detail;
  if (Array.isArray(json.detail)) return json.detail.map((x) => x.msg || '').join(' ');
  return json.error || '';
}

export function maskKey(key) {
  const k = String(key || '');
  return k.length <= 8 ? '••••' : `${k.slice(0, 4)}…${k.slice(-4)}`;
}
