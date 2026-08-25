#!/usr/bin/env node
// q — fast Orchestra dev helper. One node boot replaces slow PowerShell dances.
//   node scripts/q.mjs                              → health + agent list
//   node scripts/q.mjs term <n> ["cmd"] [--wait ms] → open terminals, optionally run cmd on first & print output
const HTTP = `http://127.0.0.1:${process.env.OCHRE_PORT || 8787}`;
const argv = process.argv.slice(2);
let waitMs = 6000;
const waitIdx = argv.indexOf('--wait');
if (waitIdx !== -1) { waitMs = Number(argv[waitIdx + 1]) || 6000; argv.splice(waitIdx, 2); }
const [cmd, ...rest] = argv;
const j = async (p, body) => {
  const r = await fetch(HTTP + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return r.json();
};

if (!cmd || cmd === 'h' || cmd === 'health') {
  const h = await j('/api/health');
  const b = await j('/api/board');
  console.log(`hub ok=${h.ok} uptime=${Math.round(h.uptime / 1000)}s agents=${b.agents.length}`);
  for (const a of b.agents) console.log(`  ${a.id.padEnd(12)} ${a.name.padEnd(14)} [${a.role}] ${a.status}${a.task ? ' · ' + String(a.task).slice(0, 60) : ''}`);
} else if (cmd === 'term') {
  const n = Number(rest[0]) || 2;
  const { terminals } = await j('/api/terminals', { count: n });
  console.log('terminals:', terminals.join(', '));
  const sayCmd = rest.slice(1).join(' ').trim();
  if (sayCmd && terminals.length) {
    const id = terminals[0];
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(HTTP.replace('http', 'ws') + '/bus');
    const lines = [];
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      for (const it of m.t === 'batch' ? m.items : [m]) {
        if (it.t === 'ev' && it.e.kind === 'log' && it.e.from === id) lines.push(it.e.text);
      }
    });
    await new Promise((res) => ws.on('open', res));
    ws.send(JSON.stringify({ t: 'hello', name: 'q', role: 'observer' }));
    setTimeout(() => j('/api/session-input', { id, data: sayCmd }), 400);
    await new Promise((r) => setTimeout(r, waitMs));
    console.log(`--- output of "${sayCmd}" on ${id} ---`);
    const shown = lines.length > 14 ? [...lines.slice(0, 14), `… (+${lines.length - 14} more frames)`] : lines;
    console.log(shown.length ? shown.join('\n') : '(no output captured)');
    ws.close();
    if (!argv.includes('--keep')) {
      for (const tid of terminals) { try { await j('/api/session-close', { id: tid }); } catch { /* */ } }
      console.log('(test terminal closed — use --keep to leave it open)');
    }
  }
} else {
  console.log('usage: node scripts/q.mjs [health|term <n> ["cmd"]]');
}
