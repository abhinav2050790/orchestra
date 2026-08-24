#!/usr/bin/env node
// Ochrestra MCP server — stdio JSON-RPC bridge that gives every opencode
// session native tools for talking on the sync bus.
import WebSocket from 'ws';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const BUS = process.env.OCHRE_URL || 'ws://127.0.0.1:8787/bus';
const SELF_ID = process.env.OCHRE_AGENT_ID || null;
const SELF_NAME = process.env.OCHRE_AGENT_NAME || 'mcp-bridge';

// ---------- bus client ----------
class BusClient {
  constructor() {
    this.pending = new Map();
    this.connected = false;
    this.agentsCache = [];
  }
  connect() {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(BUS);
      const to = setTimeout(() => { this.connecting = null; reject(new Error(`hub unreachable at ${BUS}`)); }, 4000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          t: 'hello',
          id: SELF_ID || undefined,
          name: SELF_NAME,
          role: SELF_ID ? 'agent' : 'mcp',
          engine: 'opencode-mcp',
          pid: process.pid,
          cwd: process.cwd(),
        }));
      });
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        for (const it of m.t === 'batch' ? m.items : [m]) {
          if (it.t === 'welcome') {
            clearTimeout(to); this.connected = true; this.ws = ws;
            this.agentsCache = it.agents || [];
            resolve(true);
          } else if (it.t === 'ret' && this.pending.has(it.cid)) {
            const p = this.pending.get(it.cid);
            this.pending.delete(it.cid);
            clearTimeout(p.timer);
            it.ok ? p.res(it.data) : p.rej(new Error(it.err));
          } else if (it.t === 'ev') {
            // track roster changes cheaply
            if (it.e?.kind === 'join') this.agentsCache.push(it.e.agent);
            if (it.e?.kind === 'leave') this.agentsCache = this.agentsCache.filter((a) => a.id !== it.e.id);
          }
        }
      });
      ws.on('close', () => { this.connected = false; this.connecting = null; });
      ws.on('error', () => {});
      ws.on('error', (e) => { clearTimeout(to); this.connecting = null; reject(e); });
    });
    return this.connecting;
  }
  async ensure() { if (!this.connected) await this.connect(); setInterval(() => this.raw({ t: 'hb' }), 25000); return true; }
  raw(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  async call(fn, args) {
    await this.ensure();
    return new Promise((resolve, reject) => {
      const cid = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(cid); reject(new Error('bus timeout')); }, 45000);
      this.pending.set(cid, { res: resolve, rej: reject, timer });
      this.raw({ t: 'call', cid, fn, args });
    });
  }
}
const bus = new BusClient();

// ---------- tools ----------
const TOOLS = [
  {
    name: 'ochre_board',
    description: 'See all agents currently connected to the shared Ochrestra bus, their status/current tasks, plus shared blackboard keys and recent activity. Call this first to coordinate with other agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ochre_send',
    description: 'Send a message on the Ochrestra bus. Broadcasts to ALL agents by default, or direct-message one agent by id/name. Use this to coordinate, hand off work, share findings.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message content' },
        to: { type: 'string', description: 'Target agent id or name. Omit to broadcast.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ochre_state_set',
    description: 'Write a key-value pair to the shared blackboard visible to ALL agents in realtime (last-write-wins with revision tracking). Use for sharing decisions, file paths, API contracts, progress.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { description: 'Any JSON value' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'ochre_state_get',
    description: 'Read from the shared blackboard. Omit key to list every entry.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
  },
  {
    name: 'ochre_spawn',
    description: 'Spawn one or more NEW opencode worker terminals on the host machine, each given a task prompt. They join the bus immediately as new agents.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task prompt for the worker' },
        count: { type: 'number', description: 'How many workers (default 1)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'ochre_history',
    description: 'Read recent bus activity (logs, messages, state changes, joins/exits). Useful after connecting to catch up on what other agents did.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
];

async function toolCall(name, args) {
  switch (name) {
    case 'ochre_board': {
      const snap = await bus.call('board');
      const lines = [
        `AGENTS ON BUS (${snap.agents.length}):`,
        ...snap.agents.map((a) => `  ${a.name} [${a.id}] role=${a.role} status=${a.status}${a.task ? ` task="${a.task.slice(0, 80)}"` : ''}`),
        '',
        `SHARED BLACKBOARD (${Object.keys(snap.state).length} keys):`,
        ...Object.entries(snap.state).map(([k, e]) => `  ${k} = ${JSON.stringify(e.v).slice(0, 120)} (rev${e.rev}, by ${e.by})`),
      ];
      return lines.join('\n');
    }
    case 'ochre_send': {
      const snap = await bus.call('board');
      let to = args.to || '*';
      if (to !== '*') {
        const match = snap.agents.find((a) => a.id === to || a.name.toLowerCase() === String(to).toLowerCase());
        if (!match) throw new Error(`no agent "${to}". online: ${snap.agents.map((a) => a.name).join(', ') || 'none'}`);
        to = match.id;
      }
      bus.raw({ t: 'msg', to, text: String(args.text) });
      return to === '*' ? `broadcast to ${snap.agents.length - 1} peer(s): "${String(args.text).slice(0, 60)}"` : `delivered to ${to}`;
    }
    case 'ochre_state_set': {
      bus.raw({ t: 'set', key: String(args.key), val: args.value });
      return `blackboard["${args.key}"] updated`;
    }
    case 'ochre_state_get': {
      if (!args.key) {
        const snap = await bus.call('board');
        const entries = Object.entries(snap.state);
        return entries.length
          ? entries.map(([k, e]) => `${k} = ${JSON.stringify(e.v)} (rev${e.rev}, by ${e.by})`).join('\n')
          : '(blackboard empty)';
      }
      const e = await bus.call('state.get', { key: args.key });
      return e ? JSON.stringify({ value: e.v, rev: e.rev, by: e.by }) : '(not set)';
    }
    case 'ochre_spawn': {
      const made = await bus.call('spawn', { prompt: String(args.prompt), count: Number(args.count) || 1 });
      return `spawned: ${made.map((s) => `${s.name}(${s.id})`).join(', ')} — they are now on the bus`;
    }
    case 'ochre_history': {
      const evs = await bus.call('history', { limit: Number(args.limit) || 40 });
      return evs.map((e) => {
        const t = new Date(e.ts).toTimeString().slice(0, 8);
        const base = `[${t}] ${e.from}`;
        if (e.kind === 'log') return `${base} log: ${e.text.slice(0, 120)}`;
        if (e.kind === 'msg') return `${base} → ${e.to}: ${e.text.slice(0, 120)}`;
        if (e.kind === 'state-set') return `${base} set ${e.key}`;
        if (e.kind === 'join') return `${base} JOIN ${e.agent?.name}`;
        if (e.kind === 'leave') return `${base} LEAVE ${e.name} (${e.reason})`;
        if (e.kind === 'status') return `${base} status=${e.status}`;
        if (e.kind === 'spawn') return `${base} SPAWN ${e.agent?.name}`;
        if (e.kind === 'exit') return `${base} EXIT ${e.agent?.name} (${e.status})`;
        return `${base} ${e.kind}`;
      }).join('\n') || '(no history)';
    }
    default:
      throw new Error('unknown tool ' + name);
  }
}

// ---------- JSON-RPC stdio loop ----------
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return write({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ochestra', version: '1.0.0' },
      },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    try {
      const text = await toolCall(params.name, params.arguments || {});
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true } });
    }
  }
  if (method && id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

process.stderr.write(`[ochestra-mcp] bridging ${SELF_NAME} → ${BUS}\n`);
