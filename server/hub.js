import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- config ----------
const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  persistDir: '.data',
  historyLimit: 3000,
  maxWorkers: 16,
  staleMs: 12000,
  workerCommand: ['opencode', 'run', '{prompt}'],
};
let cfg = { ...DEFAULTS };
try {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'orchestra.config.json'), 'utf8'));
  cfg = { ...DEFAULTS, ...j };
} catch { /* defaults */ }

const BUS_PATH = '/bus';
const COLORS = ['#58e88a', '#4fd8ff', '#ff9de2', '#ffd166', '#b28dff', '#ff8f5e', '#7ef0c9', '#f4f4a6'];
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

// ---------- state ----------
const store = new Store(path.join(ROOT, cfg.persistDir), cfg.historyLimit);
await store.load();

/** @type {Map<string, any>} */
const agents = new Map();
const conns = new Set();
const children = new Map(); // agentId -> child process
let totalMsgs = 0;
const startedAt = Date.now();

const now = () => Date.now();
const rid = (p = 'x') => p + Math.random().toString(36).slice(2, 8);

function serializeAgent(a) {
  return {
    id: a.id, name: a.name, role: a.role, color: a.color,
    status: a.status, detail: a.detail || '', task: a.task || '',
    pid: a.pid || null, engine: a.engine || 'generic',
    cwd: a.cwd || '', joinedAt: a.joinedAt, lastSeen: a.lastSeen,
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.outbox.push(obj);
}

function broadcast(obj) {
  for (const ws of conns) send(ws, obj);
}

// frame coalescing: flush every client outbox on a 16ms tick
setInterval(() => {
  for (const ws of conns) {
    if (!ws.outbox.length || ws.readyState !== 1) continue;
    const items = ws.outbox;
    ws.outbox = [];
    try {
      if (items.length === 1) ws.send(JSON.stringify(items[0]));
      else ws.send(JSON.stringify({ t: 'batch', items }));
    } catch { /* dropped */ }
  }
}, 16);

function emit(kind, payload, from) {
  const ev = store.pushEvent({ kind, from: from || 'hub', ...payload });
  broadcast({ t: 'ev', e: ev });
  return ev;
}

function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

function uniqueId(base) {
  if (!agents.has(base)) return base;
  let i = 2;
  while (agents.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------- worker spawner ----------
function quote(s) { return '"' + String(s).replace(/"/g, '\\"') + '"'; }

function spawnWorker({ prompt, model, name }) {
  const id = uniqueId('w-' + rid());
  const display = name || `OPCODE-${id.slice(-4).toUpperCase()}`;
  const agent = {
    id, name: display, role: 'worker', color: colorFor(id),
    status: 'booting', detail: 'spawning opencode…', task: prompt,
    engine: 'opencode', joinedAt: now(), lastSeen: now(),
  };
  agents.set(id, agent);
  emit('spawn', { agent: serializeAgent(agent), prompt }, 'hub');

  // pop the worker's live terminal so its work is visible immediately
  if (process.platform === 'win32') {
    try { openAgentTerminal(id); } catch { /* board still shows the worker */ }
  }

  const tmpl = cfg.workerCommand;
  let cmdline;
  const base = tmpl.map((s) =>
    s.replaceAll('{prompt}', prompt).replaceAll('{model}', model || '')
  ).filter(Boolean);
  if (model && !tmpl.includes('{model}')) base.push('--model', model);
  cmdline = base.map(quote).join(' ');

  const child = spawn(cmdline, {
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      OCHRE_AGENT_ID: id,
      OCHRE_AGENT_NAME: display,
      OCHRE_URL: `ws://${cfg.host}:${cfg.port}${BUS_PATH}`,
      OCHRE_TASK: prompt,
    },
    windowsHide: true,
    // opencode blocks forever if stdin is an open pipe — keep it closed
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(id, child);
  agent.pid = child.pid;

  // synthetic heartbeat while the child lives so GC never reaps live workers
  const hbTimer = setInterval(() => { agent.lastSeen = now(); }, 3000);

  let firstOut = false;
  const onLine = (stream) => (line) => {
    const text = stripAnsi(line.toString('utf8')).trim();
    if (!text) return;
    if (!firstOut) { firstOut = true; agent.status = 'working'; agent.detail = 'executing'; emit('status', { status: 'working', agent: serializeAgent(agent) }, id); }
    emit('log', { level: stream === 'stderr' ? 'warn' : 'info', text: text.slice(0, 500), stream }, id);
    agent.lastSeen = now();
  };
  let bufOut = '', bufErr = '';
  child.stdout.on('data', (d) => {
    bufOut += d;
    let i;
    while ((i = bufOut.indexOf('\n')) >= 0) { onLine('stdout')(bufOut.slice(0, i)); bufOut = bufOut.slice(i + 1); }
    if (bufOut.length > 64000) bufOut = '';
  });
  child.stderr.on('data', (d) => {
    bufErr += d;
    let i;
    while ((i = bufErr.indexOf('\n')) >= 0) { onLine('stderr')(bufErr.slice(0, i)); bufErr = bufErr.slice(i + 1); }
    if (bufErr.length > 64000) bufErr = '';
  });

  child.on('exit', (code) => {
    clearInterval(hbTimer);
    children.delete(id);
    agent.status = code === 0 ? 'done' : 'error';
    agent.detail = code === 0 ? 'task complete' : `exited ${code}`;
    emit('exit', { code, status: agent.status, agent: serializeAgent(agent) }, id);
  });

  return serializeAgent(agent);
}

function killWorker(id) {
  const child = children.get(id);
  if (!child) return false;
  if (process.platform === 'win32') exec(`taskkill /PID ${child.pid} /T /F`);
  else child.kill('SIGTERM');
  return true;
}

// ---------- wired terminals ----------
function launchTerminalWindow({ title, batFile }) {
  const child = spawn('wt.exe', ['-w', '0', 'nt', '--title', title, '-d', ROOT, 'cmd', '/c', batFile], { detached: true, stdio: 'ignore' });
  child.on('error', () => { // wt.exe missing — fall back to plain cmd window
    try {
      exec(`start "${title}" cmd /c "${batFile}"`, () => {});
    } catch { /* headless host — ignore */ }
  });
  child.unref();
}

function openTerminal(count = 1) {
  const made = [];
  for (let i = 0; i < count; i++) {
    const tid = uniqueId('t-' + rid());
    const file = path.join(ROOT, cfg.persistDir, `term-${tid}.cmd`);
    const body = [
      '@echo off',
      `title OCHRE-${tid}`,
      'set OCHRE_AGENT_ID=' + tid,
      `set OCHRE_AGENT_NAME=TERMINAL-${tid.slice(-4).toUpperCase()}`,
      `set OCHRE_URL=ws://${cfg.host}:${cfg.port}${BUS_PATH}`,
      `cd /d ${ROOT}`,
      `echo [OCHRE] terminal wired to bus as ${tid}`,
      'echo [OCHRE] your opencode session can sync via the orchestra MCP tools.',
      'opencode',
    ].join('\r\n');
    fs.writeFileSync(file, body, 'utf8');
    launchTerminalWindow({ title: `OCHRE-${tid}`, batFile: file });
    made.push(tid);
  }
  return made;
}

// live view terminal for one agent: history replay + filtered realtime tail
function openAgentTerminal(id) {
  const a = agents.get(id);
  if (!a) throw new Error('unknown agent: ' + id);
  const tid = rid('t-');
  const file = path.join(ROOT, cfg.persistDir, `term-${tid}.cmd`);
  const safeName = String(a.name).replace(/[^\w.-]/g, '') || a.id;
  const body = [
    '@echo off',
    `title OCHRE-LIVE-${safeName}`,
    `set OCHRE_URL=ws://${cfg.host}:${cfg.port}${BUS_PATH}`,
    `cd /d ${ROOT}`,
    `echo [OCHRE] live feed of ${a.name} (${a.id})`,
    `echo [OCHRE] task: ${String(a.task || '(none)').slice(0, 120)}`,
    'echo.',
    `node cli/ochre.js tail --agent ${a.id}`,
    'echo.',
    'echo [OCHRE] agent exited — press any key to close',
    'pause >nul',
  ].join('\r\n');
  fs.writeFileSync(file, body, 'utf8');
  launchTerminalWindow({ title: `OCHRE-${safeName}`, batFile: file });
  return { tid, agent: serializeAgent(a) };
}

// ---------- websocket bus ----------
const wss = new WebSocketServer({ noServer: true });

function snapshot() {
  return {
    agents: [...agents.values()].map(serializeAgent),
    state: store.snapshotState(),
    recent: store.recent(150),
    stats: { totalMsgs, startedAt },
    cfg: { port: cfg.port, historyLimit: cfg.historyLimit, maxWorkers: cfg.maxWorkers },
  };
}

function handleCall(ws, m) {
  const reply = (data) => send(ws, { t: 'ret', cid: m.cid, ok: true, data });
  const fail = (err) => send(ws, { t: 'ret', cid: m.cid, ok: false, err: String(err) });
  try {
    switch (m.fn) {
      case 'board': return reply(snapshot());
      case 'state.get': return reply(store.getState(m.args?.key));
      case 'spawn': return reply((m.args?.prompts || [m.args?.prompt].filter(Boolean)).map((p) => spawnWorker(p)));
      case 'kill': return reply(killWorker(m.args?.id));
      case 'history': return reply(store.recent(Math.min(m.args?.limit || 100, 1000)));
      default: return fail('unknown fn ' + m.fn);
    }
  } catch (e) { fail(e.message); }
}

wss.on('connection', (ws) => {
  ws.outbox = [];
  ws.alive = true;
  conns.add(ws);
  ws.agentId = null;

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const agent = ws.agentId ? agents.get(ws.agentId) : null;
    if (agent) agent.lastSeen = now();

    switch (m.t) {
      case 'ping': return send(ws, { t: 'pong' });
      case 'hb': return;

      case 'hello': {
        let id = (typeof m.id === 'string' && m.id.trim()) ? m.id.trim().slice(0, 64) : rid('a-');
        // passive observers (cli tail etc.) ride the bus without becoming visible agents
        if (m.role === 'observer') {
          ws.agentId = null;
          send(ws, { t: 'welcome', you: id, ...snapshot() });
          return;
        }
        const existing = agents.get(id);
        if (existing && existing.conn && existing.conn !== ws) {
          try { existing.conn.close(4000, 'superseded'); } catch { /* */ }
        }
        if (existing) {
          // reconnecting identity: keep history
          existing.conn = ws;
          existing.lastSeen = now();
          existing.status = m.status || existing.status;
        } else {
          const used = [...agents.values()].map((a) => a.color);
          const color = COLORS.find((c) => !used.includes(c)) || colorFor(id);
          agents.set(id, {
            id,
            name: (m.name || id).toString().slice(0, 32),
            role: (m.role || 'agent').toString().slice(0, 24),
            color: m.color || color,
            status: m.status || 'idle',
            detail: '',
            task: '',
            pid: m.pid || null,
            engine: m.engine || 'generic',
            cwd: m.cwd || '',
            joinedAt: now(),
            lastSeen: now(),
            conn: ws,
          });
          emit('join', { agent: serializeAgent(agents.get(id)) }, id);
        }
        ws.agentId = id;
        send(ws, { t: 'welcome', you: id, ...snapshot() });
        return;
      }

      case 'status': {
        if (!agent) return;
        agent.status = String(m.status || 'idle').slice(0, 16);
        agent.detail = String(m.detail || '').slice(0, 120);
        return emit('status', { status: agent.status, detail: agent.detail, agent: serializeAgent(agent) }, agent.id);
      }

      case 'log': {
        if (!agent) return;
        return emit('log', {
          level: String(m.level || 'info').slice(0, 8),
          text: stripAnsi(String(m.text ?? '')).slice(0, 500),
          stream: m.stream === 'stderr' ? 'stderr' : 'stdout',
        }, agent.id);
      }

      case 'task': {
        if (!agent) return;
        if (m.prompt !== undefined) agent.task = String(m.prompt).slice(0, 300);
        if (m.status) agent.status = String(m.status).slice(0, 16);
        if (m.progress !== undefined) agent.progress = Number(m.progress) | 0;
        return emit('task', { agent: serializeAgent(agent), progress: agent.progress ?? null }, agent.id);
      }

      case 'msg': {
        if (!agent) return;
        totalMsgs++;
        const to = m.to || '*';
        const text = stripAnsi(String(m.text ?? '')).slice(0, 2000);
        emit('msg', { to, text }, agent.id);
        if (to !== '*') {
          const target = agents.get(to);
          if (target?.conn && target.conn.readyState === 1) send(target.conn, { t: 'dm', from: agent.id, fromName: agent.name, text });
          else send(ws, { t: 'ret-inline', ok: false, err: 'target offline: ' + to });
        }
        return;
      }

      case 'set': {
        if (!agent) return;
        const key = String(m.key || '').slice(0, 120);
        if (!key) return;
        const entry = store.setState(key, m.val, agent.name);
        return emit('state-set', { key, entry }, agent.id);
      }

      case 'del': {
        if (!agent) return;
        const key = String(m.key || '');
        store.delState(key, agent.name);
        return emit('state-del', { key }, agent.id);
      }

      case 'call': return handleCall(ws, m);
      default: return;
    }
  });

  ws.on('close', () => {
    conns.delete(ws);
    if (ws.agentId && agents.get(ws.agentId)?.conn === ws) {
      const a = agents.get(ws.agentId);
      a.conn = null;
      a.lastSeen = now() - (cfg.staleMs - 2000); // grace shortened; GC will reap unless reconnect
      if (!children.has(a.id)) emit('leave', { id: a.id, name: a.name, reason: 'disconnected' }, 'hub');
    }
  });
  ws.on('error', () => { /* handled by close */ });
});

// reap stale connections
setInterval(() => {
  const cutoff = now() - cfg.staleMs;
  for (const [id, a] of agents) {
    const hasLiveConn = a.conn && a.conn.readyState === 1;
    const isLiveChild = children.has(id);
    if (!hasLiveConn && !isLiveChild && a.lastSeen < cutoff) {
      agents.delete(id);
      emit('leave', { id, name: a.name, reason: 'timeout' }, 'hub');
    }
  }
}, 4000);

// ws-level keepalive
setInterval(() => {
  for (const ws of conns) {
    if (ws.readyState !== 1) continue;
    if (!ws.alive) { try { ws.terminate(); } catch { /* */ } continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* */ }
  }
}, 25000);

// ---------- REST + static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${cfg.host}:${cfg.port}`);
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, uptime: now() - startedAt, agents: agents.size });
      if (req.method === 'GET' && p === '/api/board') return json(res, 200, snapshot());
      if (req.method === 'GET' && p === '/api/events') {
        const since = Number(url.searchParams.get('since') || 0);
        const evs = store.recent(Number(url.searchParams.get('limit') || 500));
        return json(res, 200, evs.filter((e) => e.seq > since));
      }
      if (req.method === 'POST' && p === '/api/spawn') {
        const b = await readBody(req);
        const prompt = String(b.prompt || '').slice(0, 2000).trim();
        if (!prompt) return json(res, 400, { error: 'prompt required' });
        const count = Math.max(1, Math.min(Number(b.count) || 1, cfg.maxWorkers - children.size));
        const model = b.model ? String(b.model).replace(/[^A-Za-z0-9/._-]/g, '') : undefined;
        const made = [];
        for (let i = 0; i < count; i++) made.push(spawnWorker({ prompt, model }));
        return json(res, 200, { spawned: made });
      }
      if (req.method === 'POST' && p === '/api/send') {
        const b = await readBody(req);
        totalMsgs++;
        emit('msg', { to: b.to || '*', text: stripAnsi(String(b.text || '')).slice(0, 2000) }, String(b.from || 'http').slice(0, 64));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/state') {
        const b = await readBody(req);
        const entry = store.setState(String(b.key || ''), b.val, String(b.by || 'http'));
        emit('state-set', { key: b.key, entry }, 'http');
        return json(res, 200, entry);
      }
      if (req.method === 'POST' && p === '/api/terminals') {
        const b = await readBody(req);
        const count = Math.max(1, Math.min(Number(b.count) || 1, 6));
        return json(res, 200, { terminals: openTerminal(count) });
      }
      if (req.method === 'POST' && p === '/api/agent-terminal') {
        const b = await readBody(req);
        return json(res, 200, { terminal: openAgentTerminal(String(b.id || '')) });
      }
      return json(res, 404, { error: 'not found' });
    }

    // static files
    let rel = decodeURIComponent(p === '/' ? '/index.html' : p);
    if (rel.includes('..')) { res.writeHead(403); return res.end(); }
    const file = path.join(ROOT, 'public', rel);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://x`);
  if (pathname !== BUS_PATH) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// cloud hosts (Railway/Render/Fly) inject PORT and require binding 0.0.0.0
const listenPort = Number(process.env.PORT) || cfg.port;
const listenHost = process.env.HOST || (process.env.PORT ? '0.0.0.0' : cfg.host);

server.listen(listenPort, listenHost, () => {
  console.log(`[orchestra] hub online  ws://${listenHost}:${listenPort}${BUS_PATH}`);
  console.log(`[orchestra] board     http://${listenHost}:${listenPort}`);
  console.log(`[orchestra] state dir  ./${cfg.persistDir}/  (${store.events.length} events replayed, ${store.state.size} keys)`);
});

async function shutdown() {
  console.log('\n[orchestra] shutting down…');
  for (const id of [...children.keys()]) killWorker(id);
  await store.save().catch(() => {});
  await store.flushLog().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
