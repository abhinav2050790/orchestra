import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(dir, historyLimit = 3000) {
    this.dir = dir;
    this.historyLimit = historyLimit;
    this.events = [];
    this.state = new Map();
    this.seq = 0;
    this.agentsSnapshot = [];
    this._saveTimer = null;
    this._logBuf = [];
    this._logTimer = null;
    this.dirty = false;
  }

  get stateFile() { return path.join(this.dir, 'state.json'); }
  get eventsFile() { return path.join(this.dir, 'events.ndjson'); }

  async load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf8');
      const j = JSON.parse(raw);
      for (const [k, v] of Object.entries(j.state || {})) this.state.set(k, v);
      this.agentsSnapshot = j.agents || [];
    } catch { /* fresh boot */ }
    try {
      const stat = await fsp.stat(this.eventsFile);
      if (stat.size > 8 * 1024 * 1024) {
        await fsp.rename(this.eventsFile, this.eventsFile + '.old').catch(() => {});
      }
    } catch { /* no file yet */ }
    try {
      const txt = await fsp.readFile(this.eventsFile, 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      for (const l of lines.slice(-this.historyLimit)) {
        try {
          const ev = JSON.parse(l);
          this.events.push(ev);
          if ((ev.seq || 0) > this.seq) this.seq = ev.seq;
        } catch { /* skip corrupt line */ }
      }
    } catch { /* no history */ }
  }

  snapshotState() {
    const o = {};
    for (const [k, v] of this.state) o[k] = v;
    return o;
  }

  setState(key, val, by) {
    const prev = this.state.get(key);
    const entry = { v: val, rev: (prev ? prev.rev : 0) + 1, by, ts: Date.now() };
    this.state.set(key, entry);
    this.scheduleSave();
    return entry;
  }

  delState(key, by) {
    const prev = this.state.get(key);
    this.state.delete(key);
    this.scheduleSave();
    return prev ? { ...prev, deletedBy: by, deletedAt: Date.now() } : null;
  }

  getState(key) { return this.state.get(key) || null; }

  pushEvent(ev) {
    ev.ts = ev.ts || Date.now();
    ev.seq = ++this.seq;
    this.events.push(ev);
    if (this.events.length > this.historyLimit) this.events.splice(0, this.events.length - this.historyLimit);
    this._logBuf.push(JSON.stringify(ev));
    if (!this._logTimer) {
      this._logTimer = setTimeout(() => this.flushLog(), 800);
    }
    return ev;
  }

  async flushLog() {
    clearTimeout(this._logTimer);
    this._logTimer = null;
    if (!this._logBuf.length) return;
    const chunk = this._logBuf.join('\n') + '\n';
    this._logBuf = [];
    try { await fsp.appendFile(this.eventsFile, chunk, 'utf8'); } catch { /* best effort */ }
  }

  recent(n = 200) { return n >= this.events.length ? this.events.slice() : this.events.slice(-n); }

  scheduleSave() {
    this.dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.save(), 1000);
  }

  async save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = this.stateFile + '.tmp';
    const payload = JSON.stringify({
      savedAt: new Date().toISOString(),
      agents: this.agentsSnapshot,
      state: this.snapshotState(),
    });
    try {
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.stateFile);
    } catch { /* best effort */ }
  }
}
