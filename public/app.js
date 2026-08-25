import { Board } from './board.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmmss = (ts) => new Date(ts).toTimeString().slice(0, 8);

const wrap = $('#board-wrap');
const board = new Board(wrap, $('#bg'), $('#fx'), {
  onSelect: onChipSelect,
  onHover: (agent, x, y) => {
    const tt = $('#tooltip');
    if (!agent) { tt.hidden = true; return; }
    tt.innerHTML = `<b>${esc(agent.name)}</b> <span style="color:${esc(agent.color)}">●</span><br>` +
      `role: ${esc(agent.role)} · status: <b>${esc(agent.status)}</b><br>` +
      `<span class="tt-task">${esc((agent.task || agent.detail || '').slice(0, 140))}</span>`;
    tt.hidden = false;
    const r = wrap.getBoundingClientRect();
    tt.style.left = Math.min(x + 16, r.width - 330) + 'px';
    tt.style.top = Math.min(y + 14, r.height - 90) + 'px';
  },
  onStats: ({ fps, pkts }) => {
    $('#fps').textContent = fps + ' fps';
    $('#pkt-count').textContent = pkts + ' packets';
  },
});

// ---------- embedded terminals (windows on the PCB, wired to their chip) ----------
const terms = new Map();   // agentId -> { el, pre, statusEl }
let termCount = 0, zTop = 100;

function openTerm(id) {
  let t = terms.get(id);
  if (t) { t.el.style.zIndex = ++zTop; return t; }
  const a = agents.get(id) || {};
  const el = document.createElement('div');
  el.className = 'term-win';
  // panel sized relative to the chip footprint (chip = 148x84)
  const w = Math.round(148 * 2.6), h = Math.round(84 * 3.1);
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  const wr = wrap.getBoundingClientRect();
  const n = termCount++;
  el.style.left = Math.min(18 + (n % 3) * (w + 16), Math.max(18, wr.width - w - 14)) + 'px';
  el.style.top = Math.max(12, wr.height - h - 14 - Math.floor(n / 3) * (h * 0.35)) + 'px';
  el.innerHTML = `
    <div class="term-titlebar">
      <span class="tl-dots"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></span>
      <span class="tl-name">${esc(String(a.name || id).toUpperCase())} — OCHRE SHELL</span>
      <span class="tl-status">${esc(a.status || 'booting')}</span>
      <button class="tl-close" title="hide terminal">&times;</button>
    </div>
    <div class="term-body"></div>`;
  $('#term-layer').append(el);
  t = { el, pre: el.querySelector('.term-body'), statusEl: el.querySelector('.tl-status') };
  terms.set(id, t);
  el.querySelector('.tl-close').addEventListener('click', () => closeTerm(id));
  fetch('/api/events?limit=400').then((r) => r.json()).then((evs) => {
    if (!terms.has(id)) return;
    evs.filter((e) => e.from === id || e.agent?.id === id || e.id === id).forEach((e) => termLine(id, e));
  }).catch(() => {});
  requestAnimationFrame(() => measureTerm(id));
  return t;
}

function closeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  clearTimeout(t.closeTimer);
  t.el.classList.add('closing'); // CSS fade — wire fades on the board in sync
  setTimeout(() => t.el.remove(), 660);
  board.syncTermRect(id, null); // starts the 650ms wire dissolve
}

function measureTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  const wr = wrap.getBoundingClientRect();
  const pr = t.el.getBoundingClientRect();
  board.syncTermRect(id, { x: pr.left - wr.left, y: pr.top - wr.top, w: pr.width, h: pr.height });
}

function termLine(id, e) {
  const t = terms.get(id);
  if (!t) return;
  let text;
  switch (e.kind) {
    case 'log': text = e.text; break;
    case 'status':
      text = `status: ${e.status}${e.detail ? ' — ' + e.detail : ''}`;
      if (t.statusEl) t.statusEl.textContent = e.status;
      break;
    case 'task': text = `task: ${(e.agent?.task || '').slice(0, 100)}`; break;
    case 'spawn': text = `$ ochre run "${String(e.prompt || '').slice(0, 100)}"`; break;
    case 'exit':
      text = e.status === 'done' ? 'process finished — exit 0' : `process exited (${e.code ?? '?'})`;
      if (t.statusEl) t.statusEl.textContent = e.status;
      break;
    default: return;
  }
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">[${hhmmss(e.ts || Date.now())}]</span> ${esc(text)}`;
  t.pre.append(div);
  while (t.pre.childElementCount > 400) t.pre.firstChild.remove();
  t.pre.scrollTop = t.pre.scrollHeight;
}

function routeToTerms(e) {
  const id = e.from && terms.has(e.from) ? e.from
    : e.agent && terms.has(e.agent.id) ? e.agent.id
    : e.id && terms.has(e.id) ? e.id : null;
  if (!id) return;
  termLine(id, e);
  const t = terms.get(id);
  if (e.agent?.status) t.statusEl.textContent = e.agent.status;
  // worker finished — brief linger, then window and wire fade out together
  if (e.kind === 'exit' && !t.closeTimer) {
    t.closeTimer = setTimeout(() => closeTerm(id), 4000);
  }
}

// orphan audit: no wire may outlive its terminal window
setInterval(() => {
  for (const id of [...board.termRects.keys()]) {
    if (!terms.has(id)) board.syncTermRect(id, null);
  }
}, 2000);

async function onChipSelect(id) {
  if (!id) return;
  openTerm(id);
}

// ---------- bus connection ----------
let ws, backoff = 500, totalMsgs = 0;
const rateWin = [];

function connect() {
  ws = new WebSocket(`ws://${location.host}/bus`);
  ws.onopen = () => { backoff = 500; setConn(true, 'LINKED'); };
  ws.onclose = () => {
    setConn(false, 'BUS DOWN — retrying');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.6, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    for (const it of msg.t === 'batch' ? msg.items : [msg]) handle(it);
  };
}

function setConn(on, text) {
  const led = $('#conn-led');
  led.className = on ? 'on' : 'off';
  $('#conn-text').textContent = text;
}

function sendRaw(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }

function handle(m) {
  switch (m.t) {
    case 'welcome': onWelcome(m); break;
    case 'ev': onEvent(m.e); break;
    case 'dm': feedAdd('dm', m.fromName || m.from, m.text); break;
    default: break;
  }
}

function onWelcome(w) {
  agents.clear();
  board.syncAgents([]);
  board.syncAgents(w.agents);
  w.agents.forEach((a) => agents.set(a.id, a));
  renderRoster(); renderTasks(); renderState(Object.entries(w.state));
  totalMsgs = w.stats.totalMsgs;
  $('#st-total').textContent = totalMsgs.toLocaleString();
  $('#bus-url').textContent = `ws://${location.host}/bus`;
  const recent = w.recent.slice(-120);
  $('#feed').innerHTML = '';
  recent.forEach((e) => feedAdd(e.kind, e.from === 'hub' ? 'HUB' : e.from, e.text || e.key || '', e));
  scrollFeed();
  sysNote(`linked as ${w.you} · ${w.agents.length} agents online`);
}

// ---------- event handling ----------
const agents = new Map();

function onEvent(e) {
  rateWin.push(performance.now());
  totalMsgs++;
  board.handleEvent(e);
  routeToTerms(e);

  switch (e.kind) {
    case 'join':
      agents.set(e.agent.id, e.agent); board.syncAgents([...agents.values()]);
      renderRoster();
      feedAdd('join', 'HUB', `${e.agent.name} joined the bus`);
      break;
    case 'spawn':
      agents.set(e.agent.id, e.agent); board.syncAgents([...agents.values()]);
      renderRoster(); renderTasks();
      feedAdd('spawn', 'HUB', `${e.agent.name} spawned — task: ${(e.prompt || '').slice(0, 80)}`);
      openTerm(e.agent.id); // terminal window appears wired to its chip immediately
      break;
    case 'leave':
      agents.delete(e.id); board.syncAgents([...agents.values()]);
      renderRoster();
      feedAdd('leave', 'HUB', `${e.name} left (${e.reason})`);
      if (terms.has(e.id)) closeTerm(e.id);
      break;
    case 'exit': {
      const a = agents.get(e.agent?.id);
      if (a) { a.status = e.status; }
      renderTasks(); renderRoster();
      feedAdd(e.status === 'done' ? 'exit-done' : 'exit-error', e.agent?.name || '?', `finished (${e.status})`);
      break;
    }
    case 'status': {
      const a = agents.get(e.agent?.id);
      if (a) { a.status = e.status; a.detail = e.detail || ''; }
      renderTasks(); renderRoster();
      feedAdd('status', e.from, `→ ${e.status}${e.detail ? ' · ' + e.detail : ''}`);
      break;
    }
    case 'task': {
      if (e.agent) agents.set(e.agent.id, { ...agents.get(e.agent.id), ...e.agent });
      renderTasks(); renderRoster();
      feedAdd('task', e.from, `task → ${e.agent?.task?.slice(0, 70) || ''}`);
      break;
    }
    case 'log':
      feedAdd('log', e.from, e.text);
      break;
    case 'msg':
      feedAdd('msg', e.from, `→ ${e.to === '*' ? 'ALL' : e.to}: ${e.text}`);
      break;
    case 'dm':
      feedAdd('dm', e.from, e.text);
      break;
    case 'state-set':
      upsertState(e.key, e.entry);
      feedAdd('state-set', e.from, `${e.key} = ${JSON.stringify(e.entry.v).slice(0, 60)} (rev${e.entry.rev})`);
      break;
    case 'state-del':
      removeState(e.key);
      feedAdd('state-del', e.from, `deleted ${e.key}`);
      break;
  }
  $('#st-total').textContent = totalMsgs.toLocaleString();
}

function sysNote(text) { feedAdd('join', 'SYS', text); }

// ---------- feed ----------
const feedEl = $('#feed');
function feedAdd(kind, src, text, evObj) {
  const li = document.createElement('li');
  li.className = kind.startsWith('exit-') || kind.startsWith('state') ? kind : kind;
  li.innerHTML = `<span class="t">${hhmmss(evObj?.ts || Date.now())}</span><span class="src">${esc(src)}</span> ${esc(text)}`;
  const atTop = feedEl.scrollTop < 4;
  feedEl.prepend(li);
  while (feedEl.childElementCount > 400) feedEl.lastChild.remove();
  if (atTop) feedEl.scrollTop = 0;
}
function scrollFeed() { feedEl.scrollTop = 0; }

// ---------- state table ----------
function upsertState(key, entry) {
  const tb = $('#state-table tbody');
  let row = tb.querySelector(`tr[data-k="${CSS.escape(key)}"]`);
  if (!row) {
    row = document.createElement('tr');
    row.dataset.k = key;
    row.innerHTML = `<td class="k"></td><td class="v"></td><td></td><td class="r"></td>`;
    tb.prepend(row);
  }
  row.children[0].textContent = key;
  row.children[1].textContent = JSON.stringify(entry.v);
  row.children[2].textContent = entry.by;
  row.children[3].textContent = entry.rev;
}
function removeState(key) {
  $('#state-table tbody').querySelector(`tr[data-k="${CSS.escape(key)}"]`)?.remove();
}
function renderState(entries) {
  const tb = $('#state-table tbody');
  tb.innerHTML = '';
  entries.forEach(([k, e]) => upsertState(k, e));
}

// ---------- roster & tasks ----------
function pill(status) { return `<span class="pill ${esc(status)}">${esc(status.toUpperCase())}</span>`; }

function renderRoster() {
  const ul = $('#roster');
  ul.innerHTML = [...agents.values()].map((a) =>
    `<li class="roster-row">
       <span class="roster-dot" style="background:${esc(a.color)};box-shadow:0 0 8px ${esc(a.color)}"></span>
       <span class="roster-name">${esc(a.name)}</span>
       <span class="roster-meta">${esc(a.role)}<br>${esc(a.status)}</span>
     </li>`).join('');
  $('#st-agents').textContent = agents.size;
}

function renderTasks() {
  const withTasks = [...agents.values()].filter((a) => a.task);
  const ul = $('#tasks');
  ul.innerHTML = withTasks.length ? '' : '<li style="color:var(--ink-dim);padding:10px">no active tasks</li>';
  for (const a of withTasks) {
    const li = document.createElement('li');
    li.className = 'task-card';
    li.innerHTML = `<div class="tc-head"><span class="tc-name">${esc(a.name)}</span>${pill(a.status)}</div>
                    <div class="tc-prompt">${esc(a.task.slice(0, 180))}</div>`;
    ul.append(li);
  }
}

// ---------- header ----------
setInterval(() => {
  const now = performance.now();
  while (rateWin.length && rateWin[0] < now - 1000) rateWin.shift();
  $('#st-rate').textContent = rateWin.length;
}, 250);

setInterval(() => {
  // uptime from hub stats via /api/health is overkill; track locally since page load of welcome
}, 1 << 30);

let uptimeBase = null;
setInterval(() => {
  if (!uptimeBase) return;
  const s = Math.floor((Date.now() - uptimeBase) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  $('#st-uptime').textContent = `${h}:${mm}:${ss}`;
}, 1000);

fetch('/api/health').then((r) => r.json()).then(() => {}).catch(() => {});

// ---------- tabs ----------
for (const btn of document.querySelectorAll('#tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    $('#tab-' + btn.dataset.tab).classList.add('active');
  });
}

// ---------- spawn form ----------
const spawnForm = $('#spawn-form');
$('#btn-spawn').addEventListener('click', () => { helpPanel.hidden = true; spawnForm.hidden = !spawnForm.hidden; $('#spawn-prompt').focus(); });
$('#spawn-cancel').addEventListener('click', () => { spawnForm.hidden = true; });
$('#spawn-go').addEventListener('click', doSpawn);
$('#spawn-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSpawn(); });

async function doSpawn() {
  const prompt = $('#spawn-prompt').value.trim();
  if (!prompt) return;
  const count = Number($('#spawn-count').value) || 1;
  const model = $('#spawn-model').value.trim() || undefined;
  $('#spawn-go').disabled = true;
  try {
    const r = await fetch('/api/spawn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, count, model }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    sysNote(`launching ${j.spawned.length} worker(s)…`);
    spawnForm.hidden = true;
    $('#spawn-prompt').value = '';
  } catch (err) {
    alert('spawn failed: ' + err.message);
  } finally { $('#spawn-go').disabled = false; }
}

// ---------- terminals ----------
$('#btn-terminals').addEventListener('click', async () => {
  const n = prompt('How many wired opencode terminals to open?', '2');
  if (!n) return;
  try {
    await fetch('/api/terminals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: Number(n) }) });
    sysNote(`opening ${n} wired terminal(s) in Windows Terminal…`);
  } catch (err) { alert(err.message); }
});

// ---------- help ----------
const helpPanel = $('#help-panel');
$('#btn-help').addEventListener('click', () => { spawnForm.hidden = true; helpPanel.hidden = !helpPanel.hidden; });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') { spawnForm.hidden = true; helpPanel.hidden = true; }
    return;
  }
  if (e.key === 'Escape') { spawnForm.hidden = true; helpPanel.hidden = true; }
  if (e.key === 's' || e.key === 'S') $('#btn-spawn').click();
  if (e.key === 't' || e.key === 'T') $('#btn-terminals').click();
  if (e.key === 'h' || e.key === 'H') $('#btn-help').click();
});

// ---------- workspace gate (mandatory folder assignment) ----------
function applyWorkspace(j, quiet) {
  window.__wsInfo = j;
  document.body.classList.remove('gated');
  $('#gate').hidden = true;
  if (!quiet) sysNote(`workspace: ${j.root} · project: ${j.project}`);
}

function showGate() {
  document.body.classList.add('gated');
  $('#gate').hidden = false;
  setTimeout(() => $('#gate-path').focus(), 60);
}

async function assignFolder() {
  const err = $('#gate-err');
  err.hidden = true;
  const p = $('#gate-path').value.trim();
  if (!p) { err.textContent = 'enter a folder path to continue'; err.hidden = false; return; }
  const go = $('#gate-go');
  go.disabled = true; go.textContent = 'ASSIGNING…';
  try {
    const r = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    applyWorkspace(j);
    sysNote('workspace locked in — all worker files & HANDOFF.md land there');
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  } finally { go.disabled = false; go.textContent = 'ASSIGN & START ▸'; }
}
$('#gate-go').addEventListener('click', assignFolder);
$('#gate-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') assignFolder(); });

$('#btn-project').addEventListener('click', async () => {
  if (!window.__wsInfo?.configured) { showGate(); return; }
  const name = prompt('New project name (a subfolder is created in your workspace):', 'project-' + new Date().toISOString().slice(0, 10));
  if (!name) return;
  try {
    const r = await fetch('/api/workspace/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    applyWorkspace(j);
    sysNote(`switched to project "${j.project}" — new workers write into it`);
  } catch (e) { alert(e.message); }
});

(async () => {
  try {
    const j = await (await fetch('/api/workspace')).json();
    if (j.configured) applyWorkspace(j, true); // returning user — straight in
    else showGate();
  } catch { showGate(); }
})();

connect();

// debug/test introspection
window.__orchestra = { board, terms, agents };

