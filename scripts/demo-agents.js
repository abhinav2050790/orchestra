#!/usr/bin/env node
// demo-agents.js — synthetic traffic generator: N fake agents doing realistic
// work (logs, statuses, state writes, peer messages). Great for testing the
// board without burning LLM tokens.
import WebSocket from 'ws';

const URL = process.env.OCHRE_URL || 'ws://127.0.0.1:8787/bus';
const N = Number(process.argv[2]) || 4;
const NAMES = ['ALU-CTRL', 'DMA-FEED', 'ROM-WRITER', 'CLK-SYNC', 'IO-BRIDGE', 'CACHE-OPS', 'PWM-GEN', 'UART-LINK'];
const TASKS = [
  'refactor auth middleware',
  'write unit tests for store.js',
  'optimize WS frame batching',
  'draft PCB trace router v2',
  'audit dependency tree',
  'generate API docs from routes',
];
const LOGS = [
  'compiling module graph… {n}% done',
  'resolved {n} imports in {n}ms',
  'cache hit ratio {n}%',
  'worker pool scaled to {n}',
  'patched hot path, {n}µs saved/op',
  'lint pass clean ({n} files)',
];

const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const ri = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

class DemoAgent {
  constructor(i) {
    this.id = 'demo-' + i + '-' + Math.random().toString(36).slice(2, 6);
    this.name = NAMES[i % NAMES.length] + '-' + (i + 1);
    this.ws = new WebSocket(URL);
    this.peers = [];
    this.task = TASKS[i % TASKS.length];
    this.ws.on('open', () => {
      this.send({ t: 'hello', id: this.id, name: this.name, role: 'demo', engine: 'synthetic' });
      this.send({ t: 'task', prompt: this.task, status: 'booting' });
      setTimeout(() => this.cycle('working'), 1200);
      this.schedule();
    });
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      for (const it of m.t === 'batch' ? m.items : [m]) {
        if (it.t === 'welcome') this.peers = it.agents.filter((a) => a.id !== this.id).map((a) => a.id);
        if (it.t === 'ev' && it.e.kind === 'join') this.peers.push(it.e.agent.id);
        if (it.t === 'ev' && it.e.kind === 'msg' && it.e.to === this.id) {
          this.log(`recv ← ${it.e.from}: ${it.e.text.slice(0, 40)} … ack`);
        }
      }
    });
    setInterval(() => this.send({ t: 'hb' }), 3000);
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  log(text) { this.send({ t: 'log', text }); }
  cycle(s) { this.send({ t: 'status', status: s, detail: s === 'working' ? this.task : '' }); }
  schedule() {
    const tick = () => {
      const roll = Math.random();
      if (roll < 0.45) this.log(rnd(LOGS).replaceAll('{n}', String(ri(3, 98))));
      else if (roll < 0.6 && this.peers.length) this.send({ t: 'msg', to: rnd(this.peers), text: rnd(['handing off results', 'need review on diff #', 'shared artifact at key ', 'sync point reached']) + ri(10, 99) });
      else if (roll < 0.7) this.send({ t: 'set', key: rnd(['build.progress', 'test.coverage', 'queue.depth']), val: ri(1, 100) });
      else if (roll < 0.78) this.cycle(Math.random() < 0.5 ? 'idle' : 'working');
      setTimeout(tick, ri(900, 2600));
    };
    setTimeout(tick, ri(400, 1500));
  }
}

for (let i = 0; i < N; i++) new DemoAgent(i);
console.log(`[demo] ${N} synthetic agents → ${URL} (Ctrl+C to stop)`);
setInterval(() => { /* keep alive */ }, 1 << 30);
