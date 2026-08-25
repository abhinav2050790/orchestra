#!/usr/bin/env node
// ochre — command-line access to the Orchestra sync bus.
import WebSocket from 'ws';
import { spawn as spawnProc } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BUS = process.env.OCHRE_URL || 'ws://127.0.0.1:8787/bus';
const HTTP = BUS.replace(/^ws/, 'http').replace(/\/bus$/, '');
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

const HELP = `
ochre — Orchestra bus client

  ochre board                 open the PCB dashboard in your browser
  ochre ps                    list agents on the bus
  ochre tail [--agent <id|name>]   live-stream bus events (optionally one agent)
  ochre send <text..>         broadcast a message            [--to <agent>]
  ochre state                 list shared blackboard
  ochre state set <k> <v..>   write a key
  ochre state get <k>         read a key
  ochre spawn "<prompt>"      launch opencode worker(s)     [--count N] [--model M]
  ochre pipe -- <command..>   wire ANY command's output onto the bus live
`;

function argFlag(name) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  process.argv.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1);
  return v;
}

class Client {
  constructor({ name = 'cli', role = 'cli', id } = {}) {
    this.name = name; this.role = role; this.id = id;
    this.pending = new Map();
    this.onEvent = null; this.onWelcome = null; this.onDm = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BUS);
      const to = setTimeout(() => reject(new Error(`hub unreachable at ${BUS} — run Start-Orchestra.ps1 first`)), 4000);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', id: this.id, name: this.name, role: this.role, pid: process.pid, cwd: process.cwd() }));
        this.hbTimer = setInterval(() => this.raw({ t: 'hb' }), 3000);
      });
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        for (const it of m.t === 'batch' ? m.items : [m]) {
          if (it.t === 'welcome') { clearTimeout(to); this.connected = true; this.you = it.you; this.onWelcome?.(it); resolve(it); }
          else if (it.t === 'ev') this.onEvent?.(it.e);
          else if (it.t === 'dm') this.onDm?.(it);
          else if (it.t === 'ret' && this.pending.has(it.cid)) {
            const p = this.pending.get(it.cid); this.pending.delete(it.cid);
            clearTimeout(p.timer); it.ok ? p.res(it.data) : p.rej(new Error(it.err));
          }
        }
      });
      this.ws.on('error', (e) => { clearTimeout(to); reject(e); });
      this.ws.on('close', () => clearInterval(this.hbTimer));
    });
  }
  raw(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  call(fn, args) {
    return new Promise((resolve, reject) => {
      const cid = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(cid); reject(new Error('bus timeout')); }, 45000);
      this.pending.set(cid, { res: resolve, rej: reject, timer });
      this.raw({ t: 'call', cid, fn, args });
    });
  }
  close() { clearInterval(this.hbTimer); try { this.ws.close(); } catch { /* */ } }
}

const C = { g: '\x1b[32m', c: '\x1b[36m', y: '\x1b[33m', r: '\x1b[31m', m: '\x1b[35m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const stamp = () => new Date().toTimeString().slice(0, 8);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const joined = rest.join(' ');

  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }

  if (cmd === 'board') {
    const url = HTTP;
    const { exec } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    // prefer Chrome in a fresh window (pops to front); fall back to default browser
    const chromePaths = process.platform === 'win32' ? [
      join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : [];
    const chrome = chromePaths.find((p2) => p2 && existsSync(p2));
    if (chrome) {
      spawnProc(chrome, ['--new-window', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      exec(`open -na "Google Chrome" "${url}"`);
    } else if (process.platform === 'linux') {
      exec(`google-chrome --new-window "${url}" || xdg-open "${url}"`, { shell: true });
    } else {
      exec(`start "" "${url}"`, { shell: true });
    }
    console.log(`${C.g}board →${C.x} ${url}`);
    return;
  }

  if (cmd === 'ps') {
    const r = await fetch(HTTP + '/api/board');
    const snap = await r.json();
    console.log(`${C.b}${snap.agents.length} agents on bus${C.x}   total events: ${snap.stats.totalMsgs}`);
    for (const a of snap.agents) {
      console.log(`  ${a.color === '#ff5470' ? C.r : C.c}${a.name.padEnd(18)}${C.x} ${a.role.padEnd(8)} ${a.status.padEnd(10)} ${C.d}${(a.task || a.detail || '').slice(0, 60)}${C.x}`);
    }
    return;
  }

  if (cmd === 'spawn') {
    const prompt = joined.replace(/--count\s+\S+|--model\s+\S+/g, '').trim().replace(/^"|"$/g, '');
    if (!prompt) { console.error('usage: ochre spawn "task prompt" [--count N] [--model provider/model]'); process.exitCode = 1; return; }
    const count = Number(argFlag('count')) || 1;
    const model = argFlag('model');
    const r = await fetch(HTTP + '/api/spawn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, count, model }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    console.log(`${C.g}spawned:${C.x} ${j.spawned.map((s) => `${s.name} [${s.id}]`).join(', ')}`);
    return;
  }

  if (cmd === 'send') {
    const to = argFlag('to') || '*';
    const name = argFlag('name') || 'cli-' + randomUUID().slice(0, 4);
    if (!joined.trim()) { console.error('usage: ochre send "text" [--to agent]'); process.exitCode = 1; return; }
    await fetch(HTTP + '/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: name, to, text: joined }) });
    console.log(`${C.g}sent →${C.x} ${to}: ${joined}`);
    return;
  }

  if (cmd === 'state') {
    const sub = rest[0] || 'list';
    if (sub === 'set') {
      const key = rest[1]; const val = rest.slice(2).join(' ');
      if (!key || val === '') { console.error('usage: ochre state set <key> <value>'); process.exitCode = 1; return; }
      let parsed = val; try { parsed = JSON.parse(val); } catch { /* keep string */ }
      await fetch(HTTP + '/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, val: parsed, by: 'cli' }) });
      console.log(`${C.m}set${C.x} ${key} = ${val}`);
      return;
    }
    if (sub === 'get') {
      const snap = await (await fetch(HTTP + '/api/board')).json();
      const e = snap.state[rest[1]];
      console.log(e ? `${JSON.stringify(e.v)}  ${C.d}(rev${e.rev}, by ${e.by})${C.x}` : '(not set)');
      return;
    }
    const snap = await (await fetch(HTTP + '/api/board')).json();
    const keys = Object.entries(snap.state);
    if (!keys.length) console.log('(blackboard empty)');
    for (const [k, e] of keys) console.log(`  ${C.m}${k}${C.x} = ${JSON.stringify(e.v).slice(0, 100)}  ${C.d}rev${e.rev} by ${e.by}${C.x}`);
    return;
  }

  if (cmd === 'tail') {
    const agentFilter = argFlag('agent');
    const c = new Client({ name: 'cli-tail', role: 'observer' });
    const w = await c.connect();
    const fmt = (e) => {
      const f = e.from || 'hub';
      switch (e.kind) {
        case 'log': return `${C.d}[${stamp()}]${C.x} ${C.c}${f.padEnd(14)}${C.x} ${e.level === 'warn' ? C.y : ''}${e.text}`;
        case 'msg': return `${C.d}[${stamp()}]${C.x} ${C.c}${f.padEnd(14)}${C.x} ${C.b}→ ${e.to}:${C.x} ${e.text}`;
        case 'status': return `${C.d}[${stamp()}]${C.x} ${C.c}${f.padEnd(14)}${C.x} status=${e.status}`;
        case 'state-set': return `${C.d}[${stamp()}]${C.x} ${C.m}${f.padEnd(14)}${C.x} set ${e.key}=${JSON.stringify(e.entry?.v).slice(0, 60)}`;
        case 'join': return `${C.d}[${stamp()}]${C.x} ${C.g}+ JOIN ${e.agent?.name}${C.x}`;
        case 'leave': return `${C.d}[${stamp()}]${C.x} ${C.r}- LEAVE ${e.name} (${e.reason})${C.x}`;
        case 'spawn': return `${C.d}[${stamp()}]${C.x} ${C.g}* SPAWN ${e.agent?.name}${C.x}`;
        case 'exit': return `${C.d}[${stamp()}]${C.x} ${e.status === 'done' ? C.g : C.r}= EXIT ${e.agent?.name} (${e.status})${C.x}`;
        default: return `${C.d}[${stamp()}]${C.x} ${f} ${e.kind}`;
      }
    };

    let target = null;
    if (agentFilter) {
      const q = String(agentFilter).toLowerCase();
      const hit = (w.agents || []).find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q);
      const id = hit ? hit.id : agentFilter;
      const name = hit ? hit.name.toLowerCase() : q;
      target = { id, name };
      const mine = (e) =>
        e.from === id || String(e.from || '').toLowerCase() === name ||
        e.agent?.id === id || e.id === id;
      try {
        const evs = await (await fetch(HTTP + '/api/events?limit=800')).json();
        console.log(`${C.d}--- history (${hit ? hit.name : agentFilter}) ---${C.x}`);
        for (const e of evs) if (mine(e)) console.log(fmt(e));
        console.log(`${C.d}--- live — Ctrl+C to stop ---${C.x}`);
      } catch { /* history optional */ }
      c.onEvent = (e) => { if (mine(e)) console.log(fmt(e)); };
    } else {
      console.log(`${C.d}tailing bus… Ctrl+C to stop${C.x}`);
      c.onEvent = (e) => console.log(fmt(e));
    }
    setInterval(() => { /* keepalive */ }, 1 << 30);
    return;
  }

  if (cmd === 'pipe') {
    const sep = process.argv.indexOf('--');
    const cmdArgs = sep >= 0 ? process.argv.slice(sep + 1) : [];
    if (!cmdArgs.length) { console.error('usage: ochre pipe -- <command...>'); process.exitCode = 1; return; }
    const label = cmdArgs[0].split(/[\\/]/).pop();
    const c = new Client({ name: `PIPE-${label.toUpperCase()}`, role: 'piped' });
    try { await c.connect(); } catch (e) { console.error(e.message); }

    const pump = (streamName) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = stripAnsi(buf.slice(0, i)).replace(/\r/g, '').trim();
          buf = buf.slice(i + 1);
          if (line.length) {
            if (c.ws?.readyState === 1) c.raw({ t: 'log', text: line.slice(0, 500), level: streamName === 'err' ? 'warn' : 'info' });
            console.log(line);
          }
        }
      };
    };

    if (c.ws?.readyState === 1) c.raw({ t: 'status', status: 'working', detail: cmdArgs.join(' ').slice(0, 100) });
    const child = spawnProc(cmdArgs.join(' '), { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', pump('out'));
    child.stderr.on('data', pump('err'));
    child.on('exit', (code) => {
      if (c.connected) {
        c.raw({ t: 'status', status: code === 0 ? 'done' : 'error' });
        c.close();
      }
      process.exit(code ?? 0);
    });
    process.on('SIGINT', () => { try { child.kill(); } catch { /* */ } });
    return;
  }

  console.error(`unknown command: ${cmd}\n` + HELP);
  process.exitCode = 1;
}

main().catch((e) => { console.error(C.r + e.message + C.x); process.exitCode = 1; });
