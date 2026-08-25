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
  const wr = wrap.getBoundingClientRect();
  // compact panels — sized and arranged so 5+ fit on the full-width board
  const cols = Math.max(2, Math.floor(wr.width / 400));
  const w = Math.min(420, Math.max(320, Math.floor((wr.width - (cols + 1) * 12) / cols)));
  const h = Math.min(280, Math.max(200, Math.floor((wr.height - 40) / 2)));
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  const n = termCount++;
  const col = n % cols, row = Math.floor(n / cols);
  el.style.left = (12 + col * (w + 12)) + 'px';
  el.style.top = (10 + row * (h + 10)) + 'px';
  el.innerHTML = `
    <div class="term-titlebar">
      <span class="tl-dots"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></span>
      <span class="tl-name">${esc(String(a.name || id).toUpperCase())} — OCHRE SHELL</span>
      <span class="tl-status">${esc(a.status || 'booting')}</span>
      <button class="tl-close" title="hide terminal">&times;</button>
    </div>
    <div class="term-body"></div>
    <div class="term-xterm" hidden></div>
    <div class="term-input-row"><span class="term-ps1">❯</span><input class="term-in" spellcheck="false" autocomplete="off" placeholder="type a command…"></div>`;
  $('#term-layer').append(el);
  t = {
    el,
    pre: el.querySelector('.term-body'),
    statusEl: el.querySelector('.tl-status'),
    xt: el.querySelector('.term-xterm'),
    inpRow: el.querySelector('.term-input-row'),
    inp: el.querySelector('.term-in'),
    mode: 'lines',
  };
  terms.set(id, t);
  el.querySelector('.tl-close').addEventListener('click', () => closeTerm(id));
  // double-click titlebar → maximize / restore
  const titlebar = el.querySelector('.term-titlebar');
  titlebar.addEventListener('dblclick', () => {
    if (t.restore) {
      Object.assign(el.style, t.restore);
      t.restore = null;
    } else {
      t.restore = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
      Object.assign(el.style, { left: '10px', top: '10px', width: (wr.width - 20) + 'px', height: (wr.height - 20) + 'px' });
    }
    requestAnimationFrame(() => measureTerm(id));
  });
  // click anywhere on the terminal to type into it
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tl-close')) return;
    setTimeout(() => { if (t.mode === 'xterm') t.term?.focus(); else t.inp?.focus(); }, 0);
  });
  t.inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const cmd = t.inp.value.trim();
    if (!cmd) return;
    t.inp.value = '';
    const div = document.createElement('div');
    div.innerHTML = `<span class="t">[${hhmmss(Date.now())}]</span> <span class="term-echo">❯ ${esc(cmd)}</span>`;
    t.pre.append(div);
    while (t.pre.childElementCount > 400) t.pre.firstChild.remove();
    t.pre.scrollTop = t.pre.scrollHeight;
    sendTermInput(id, cmd, true);
  });
  requestAnimationFrame(() => measureTerm(id));
  return t;
}

// ---------- send keystrokes to a terminal's backing shell ----------
function sendTermInput(id, data, isLine = false) {
  fetch('/api/session-input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, data, line: isLine })
  })
    .then((r) => r.json())
    .then((j) => { if (j.error) termNote(id, j.error); })
    .catch(() => termNote(id, 'bus unreachable'));
}

// ---------- upgrade a line-mode panel into a real xterm emulator ----------
// Per-terminal lock: each terminal upgrades independently so multiple workers
// never block each other (fixes the "page unresponsive" freeze).
async function upgradeToXterm(id) {
  const t = terms.get(id);
  if (!t || t.mode === 'xterm') return;
  if (t.upgradingPromise) return t.upgradingPromise;

  t.upgradingPromise = (async () => {
    try {
      t.mode = 'xterm';
      t.pre.hidden = true;
      t.inpRow.hidden = true;
      t.xt.hidden = false;

      const term = new window.Terminal({
        fontFamily: "Consolas, 'Cascadia Mono', monospace",
        fontSize: 11,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 1000,
        theme: {
          background: '#050d08',
          foreground: '#b9dcc5',
          cursor: '#58e88a',
          cursorAccent: '#050d08',
          selectionBackground: '#1c5c37',
          black: '#0b1c12', red: '#ff5470', green: '#58e88a', yellow: '#ffd166',
          blue: '#7ef0c9', magenta: '#ff9de2', cyan: '#4fd8ff', white: '#d9efdf',
        },
      });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(t.xt);
      try { fit.fit(); } catch { /* zero-size race */ }

      // Set t.term immediately so incoming raw chunks write directly
      t.term = term;
      t.fit = fit;

      // Flush any raw lines accumulated before xterm was ready
      if (t.pendingRaw) {
        const pending = t.pendingRaw;
        t.pendingRaw = null;
        for (const c of pending) term.write(c);
      }

      term.onData((data) => sendTermInput(id, data, false));
      t.ro = new ResizeObserver(() => {
        clearTimeout(t.fitT);
        t.fitT = setTimeout(() => {
          try {
            fit.fit();
            const dims = fit.proposeDimensions();
            if (dims?.cols && dims?.rows) {
              fetch('/api/session-input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, cols: dims.cols, rows: dims.rows }) }).catch(() => {});
            }
          } catch { /* mid-layout */ }
        }, 120);
      });
      t.ro.observe(t.el);

      try {
        const res = await fetch(`/api/term-backlog?id=${encodeURIComponent(id)}`);
        if (res.ok) {
          const j = await res.json();
          if (j.backlog) term.write(j.backlog);
          else if (j.error) term.writeln(`\x1b[33m${j.error}\x1b[0m`);
        }
      } catch { /* backlog optional */ }

      term.focus();
    } catch (err) {
      console.error(`[xterm] Failed to upgrade terminal ${id}:`, err);
      // Roll back to line mode so the panel is still usable
      t.mode = 'lines';
      t.pre.hidden = false;
      t.inpRow.hidden = false;
      t.xt.hidden = true;
      t.pendingRaw = null;
    } finally {
      t.upgradingPromise = null;
    }
  })();

  return t.upgradingPromise;
}

function closeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  clearTimeout(t.closeTimer);
  clearTimeout(t.fitT);
  t.ro?.disconnect();
  try { t.term?.dispose(); } catch { /* already gone */ }
  fetch('/api/session-close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {});
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
    case 'spawn': text = `$ ${String(e.prompt || '').slice(0, 100)}`; break;
    case 'exit':
      text = e.status === 'done' ? 'process finished — exit 0 · terminal stays, type below' : `process exited (${e.code ?? '?'}) · terminal stays, type below`;
      if (t.statusEl) t.statusEl.textContent = e.status === 'done' ? 'idle' : 'exited';
      break;
    default: return;
  }
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">[${hhmmss(e.ts || Date.now())}]</span> ${esc(text)}`;
  t.pre.append(div);
  while (t.pre.childElementCount > 400) t.pre.firstChild.remove();
  t.pre.scrollTop = t.pre.scrollHeight;
}

function termNote(id, text) {
  const t = terms.get(id);
  if (!t) return;
  const div = document.createElement('div');
  div.className = 'term-note';
  div.textContent = text;
  t.pre.append(div);
  t.pre.scrollTop = t.pre.scrollHeight;
}

function routeToTerms(e) {
  const id = e.from && terms.has(e.from) ? e.from
    : e.agent && terms.has(e.agent.id) ? e.agent.id
    : e.id && terms.has(e.id) ? e.id : null;
  if (!id) return;
  const t = terms.get(id);
  // raw ConPTY chunks → real terminal emulator (auto-upgrades the panel)
  if (e.kind === 'log' && e.raw) {
    if (!t.term || t.pendingRaw) {
      if (!t.pendingRaw) { t.pendingRaw = []; upgradeToXterm(id); }
      t.pendingRaw.push(e.text);
      return;
    }
    t.term.write(e.text);
    return;
  }
  termLine(id, e);
  if (e.agent?.status) t.statusEl.textContent = e.agent.status;
  // terminals are persistent: a finished task never closes the window —
  // typing in it spawns a live ConPTY console right in the same panel
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
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'; // HTTPS pages must use wss — ws is blocked as mixed content
  ws = new WebSocket(`${proto}://${location.host}/bus`);
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
  renderRosterSoon(); renderTasksSoon(); renderState(Object.entries(w.state));
  updateCommanderTargets();
  totalMsgs = w.stats.totalMsgs;
  $('#st-total').textContent = totalMsgs.toLocaleString();
  $('#bus-url').textContent = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bus`;
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
      renderRosterSoon();
      updateCommanderTargets();
      feedAdd('join', 'HUB', `${e.agent.name} joined the bus`);
      break;
    case 'spawn':
      agents.set(e.agent.id, e.agent); board.syncAgents([...agents.values()]);
      renderRosterSoon(); renderTasksSoon();
      updateCommanderTargets();
      feedAdd('spawn', 'HUB', `${e.agent.name} spawned — task: ${(e.prompt || '').slice(0, 80)}`);
      openTerm(e.agent.id); // terminal window appears wired to its chip immediately
      break;
    case 'leave':
      agents.delete(e.id); board.syncAgents([...agents.values()]);
      renderRosterSoon();
      updateCommanderTargets();
      feedAdd('leave', 'HUB', `${e.name} left (${e.reason})`);
      // the chip is gone but its terminal window stays on the board —
      // it keeps the scrollback and typing in it opens a live shell
      if (terms.has(e.id)) {
        const t = terms.get(e.id);
        t.statusEl.textContent = 'offline';
        termNote(e.id, `${e.name} left the bus — terminal kept; type a command to work here`);
      }
      break;
    case 'exit': {
      const a = agents.get(e.agent?.id);
      if (a) { a.status = e.status; }
      renderTasksSoon(); renderRosterSoon();
      feedAdd(e.status === 'done' ? 'exit-done' : 'exit-error', e.agent?.name || '?', `finished (${e.status})`);
      break;
    }
    case 'status': {
      const a = agents.get(e.agent?.id);
      if (a) { a.status = e.status; a.detail = e.detail || ''; }
      renderTasksSoon(); renderRosterSoon();
      feedAdd('status', e.from, `→ ${e.status}${e.detail ? ' · ' + e.detail : ''}`);
      break;
    }
    case 'task': {
      if (e.agent) agents.set(e.agent.id, { ...agents.get(e.agent.id), ...e.agent });
      renderTasksSoon(); renderRosterSoon();
      feedAdd('task', e.from, `task → ${e.agent?.task?.slice(0, 70) || ''}`);
      break;
    }
    case 'log':
      if (!e.raw) feedAdd('log', e.from, e.text); // raw ConPTY frames go to terminals only, never the side feed
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

function sysNote() {}

// ---------- feed / state / roster / tasks — sidebar removed, stubs only ----------
function feedAdd() {}
function scrollFeed() {}
function upsertState() {}
function removeState() {}
function renderState() {}
function renderRoster() {}
function renderTasks() {}
function renderRosterSoon() {}
function renderTasksSoon() {}

// ---------- spawn form ----------
const spawnForm = $('#spawn-form');
$('#btn-spawn').addEventListener('click', () => {
  if (!window.__wsInfo?.configured) { showGate(); return; }
  helpPanel.hidden = true; spawnForm.hidden = !spawnForm.hidden; $('#spawn-prompt').focus();
});
$('#spawn-cancel').addEventListener('click', () => { spawnForm.hidden = true; });
$('#spawn-go').addEventListener('click', doSpawn);
$('#spawn-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSpawn(); });

async function doSpawn() {
  if (!window.__wsInfo?.configured) { showGate(); return; }
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
  if (!window.__wsInfo?.configured) { showGate(); return; }
  const n = prompt('How many wired opencode terminals to open?', '2');
  if (!n) return;
    try {
      const r = await fetch('/api/terminals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: Number(n) }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      sysNote(`opened ${n} in-app terminal(s) — click one and type a command`);
    } catch (err) { alert(err.message); }
});

// ---------- missions (intelligent project decomposer & swarm launcher) ----------
const missionForm = $('#mission-form');
let currentPlanTasks = [];

function renderRosterCards(tasks) {
  const container = $('#mission-prompts');
  container.innerHTML = '';
  currentPlanTasks = tasks;

  tasks.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'mission-card';
    card.innerHTML = `
      <div class="mission-card-head">
        <span class="mission-card-title">⌬ ${esc(t.name || `AGENT-${i + 1}`)}</span>
        <span class="mission-card-role">${esc(t.role || 'Specialist')}</span>
        <button type="button" class="mission-card-del" title="Remove agent">&times;</button>
      </div>
      <div class="mission-card-scope"><b>Scope:</b> ${esc(t.scope || '')}</div>
      ${t.files ? `<div class="mission-card-scope"><b>Target Files:</b> <code>${esc(t.files)}</code></div>` : ''}
      <textarea class="mission-prompt" rows="3" placeholder="Task instructions for this agent…">${esc(t.prompt || '')}</textarea>
    `;

    card.querySelector('.mission-card-del').addEventListener('click', () => {
      card.remove();
    });

    container.append(card);
  });

  $('#mission-roster-section').hidden = false;
}

function addCustomAgentRow() {
  const idx = $('#mission-prompts').children.length + 1;
  const t = {
    name: `CUSTOM-AGENT-${idx}`,
    role: 'Specialist',
    scope: 'Custom assigned scope',
    files: '',
    prompt: '',
  };
  const container = $('#mission-prompts');
  const card = document.createElement('div');
  card.className = 'mission-card';
  card.innerHTML = `
    <div class="mission-card-head">
      <span class="mission-card-title">⌬ ${esc(t.name)}</span>
      <span class="mission-card-role">Custom Role</span>
      <button type="button" class="mission-card-del" title="Remove agent">&times;</button>
    </div>
    <textarea class="mission-prompt" rows="3" placeholder="Task prompt for this agent…"></textarea>
  `;
  card.querySelector('.mission-card-del').addEventListener('click', () => card.remove());
  container.append(card);
  $('#mission-roster-section').hidden = false;
  card.querySelector('textarea').focus();
}

$('#btn-mission').addEventListener('click', () => {
  if (!window.__wsInfo?.configured) { showGate(); return; }
  spawnForm.hidden = true; helpPanel.hidden = true;
  missionForm.hidden = !missionForm.hidden;
  if (!missionForm.hidden) $('#mission-master-prompt').focus();
});

$('#mission-add').addEventListener('click', () => addCustomAgentRow());
$('#mission-cancel').addEventListener('click', () => { missionForm.hidden = true; });

async function getProjectPlan() {
  const prompt = $('#mission-master-prompt').value.trim();
  if (!prompt) {
    alert('Please enter your project plan / specification prompt first.');
    $('#mission-master-prompt').focus();
    return null;
  }
  const teamSize = $('#mission-team-size').value;
  const style = $('#mission-style').value;

  const btn = $('#mission-preview-btn');
  btn.disabled = true;
  btn.textContent = 'ANALYZING & DECOMPOSING…';

  try {
    const r = await fetch('/api/mission/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, teamSize, style })
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    renderRosterCards(j.tasks || []);
    return j;
  } catch (err) {
    alert('Plan generation failed: ' + err.message);
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 PREVIEW & EDIT PLAN';
  }
}

$('#mission-preview-btn').addEventListener('click', getProjectPlan);

async function launchMissionSwarm(isQuick) {
  const prompt = $('#mission-master-prompt').value.trim();
  if (!prompt) {
    alert('Please enter your project plan / specification prompt.');
    $('#mission-master-prompt').focus();
    return;
  }
  const teamSize = $('#mission-team-size').value;
  const style = $('#mission-style').value;

  const goBtn = $('#mission-quick-launch');
  goBtn.disabled = true;
  goBtn.textContent = 'LAUNCHING SWARM…';

  try {
    let payload = { prompt, teamSize, style };

    // If preview cards are open and edited, collect them
    const cards = document.querySelectorAll('#mission-prompts .mission-card');
    if (!isQuick && cards.length > 0) {
      const customTasks = [];
      cards.forEach((c) => {
        const name = c.querySelector('.mission-card-title').textContent.replace('⌬', '').trim();
        const role = c.querySelector('.mission-card-role').textContent.trim();
        const p = c.querySelector('.mission-prompt').value.trim();
        if (p) customTasks.push({ name, role, prompt: p });
      });
      if (customTasks.length) payload.tasks = customTasks;
    }

    const r = await fetch('/api/mission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    missionForm.hidden = true;
    $('#mission-master-prompt').value = '';
    $('#mission-roster-section').hidden = true;
    $('#mission-prompts').innerHTML = '';
  } catch (err) {
    alert('Mission launch failed: ' + err.message);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = '⚡ AUTO-DECOMPOSE & LAUNCH ▸';
  }
}

// ---------- autonomous swarm commander chatbox controller (tap to open) ----------
function updateCommanderTargets() {
  const select = $('#commander-target');
  const badge = $('#commander-agent-badge');
  const count = agents.size;
  if (badge) badge.textContent = `${count} AGENT${count === 1 ? '' : 'S'}`;

  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = `
    <option value="auto">⚡ AUTO-ROUTE (Smart AI)</option>
    <option value="all">📢 @ALL (Broadcast to All)</option>
  `;
  for (const a of agents.values()) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `⌬ ${a.name} (${a.role || 'Agent'})`;
    select.append(opt);
  }
  if ([...select.options].some((o) => o.value === currentVal)) {
    select.value = currentVal;
  }
}

function openCommander() {
  const trigger = $('#commander-pill-trigger');
  const panel = $('#commander-panel');
  if (trigger) trigger.hidden = true;
  if (panel) {
    panel.hidden = false;
    setTimeout(() => $('#commander-input')?.focus(), 40);
  }
}

function closeCommander() {
  const trigger = $('#commander-pill-trigger');
  const panel = $('#commander-panel');
  const drawer = $('#commander-log-drawer');
  if (panel) panel.hidden = true;
  if (drawer) drawer.hidden = true;
  if (trigger) trigger.hidden = false;
}

$('#commander-pill-trigger')?.addEventListener('click', openCommander);
$('#commander-collapse-btn')?.addEventListener('click', closeCommander);

function appendCommanderLog(entry) {
  const list = $('#commander-log-list');
  if (!list) return;
  const li = document.createElement('li');
  const targetPill = (entry.targets || []).map((t) => `<span class="log-target">→ ${esc(t.name)}</span>`).join(' ');
  li.innerHTML = `
    <span class="log-time">[${hhmmss(Date.now())}]</span>
    ${targetPill}
    <span class="log-text">${esc(entry.message)}</span>
  `;
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

async function sendCommanderInstruction() {
  const input = $('#commander-input');
  const msg = input.value.trim();
  if (!msg) return;

  const target = $('#commander-target').value;
  const sendBtn = $('#commander-send-btn');
  sendBtn.disabled = true;

  try {
    const r = await fetch('/api/chat-command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: msg, target })
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    input.value = '';
    appendCommanderLog({ targets: j.routedTo || [], message: msg });

    // Highlight and focus target terminals on the board
    if (Array.isArray(j.routedTo)) {
      for (const t of j.routedTo) {
        const termObj = openTerm(t.id);
        if (termObj?.el) {
          termObj.el.style.borderColor = '#58e88a';
          termObj.el.style.boxShadow = '0 0 24px rgba(88, 232, 138, 0.6)';
          setTimeout(() => {
            if (termObj?.el) {
              termObj.el.style.borderColor = '';
              termObj.el.style.boxShadow = '';
            }
          }, 2200);
        }
      }
    }
  } catch (err) {
    alert('Dispatch failed: ' + err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

$('#commander-send-btn')?.addEventListener('click', sendCommanderInstruction);
$('#commander-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendCommanderInstruction();
  if (e.key === 'Escape') closeCommander();
});
$('#commander-log-toggle')?.addEventListener('click', () => {
  const d = $('#commander-log-drawer');
  if (d) d.hidden = !d.hidden;
});
$('#btn-close-commander-log')?.addEventListener('click', () => {
  const d = $('#commander-log-drawer');
  if (d) d.hidden = true;
});
$('#btn-clear-commander-log')?.addEventListener('click', () => {
  const l = $('#commander-log-list');
  if (l) l.innerHTML = '';
});

// ---------- help ----------
const helpPanel = $('#help-panel');
$('#btn-help').addEventListener('click', () => { spawnForm.hidden = true; helpPanel.hidden = !helpPanel.hidden; });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') {
      spawnForm.hidden = true;
      helpPanel.hidden = true;
      closeCommander();
    }
    return;
  }
  if (e.key === 'Escape') {
    spawnForm.hidden = true;
    helpPanel.hidden = true;
    closeCommander();
  }
  if (e.key === 's' || e.key === 'S') $('#btn-spawn').click();
  if (e.key === 't' || e.key === 'T') $('#btn-terminals').click();
  if (e.key === 'h' || e.key === 'H') $('#btn-help').click();
  if (e.key === 'c' || e.key === 'C' || e.key === '/') {
    e.preventDefault();
    openCommander();
  }
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
  let p = $('#gate-path').value.trim();
  if (!p) { err.textContent = 'enter a folder path to continue'; err.hidden = false; return; }
  // cloud board: the folder lives on YOUR machine, not the server — accept any name/path,
  // including brand-new or empty folders that file pickers cannot represent
  if (!isLocalHub && !p.startsWith('browser://')) {
    const base = p.split(/[\\/]/).filter(Boolean).pop() || p;
    p = 'browser://' + sanitizeFolderName(base);
  }
  const go = $('#gate-go');
  go.disabled = true; go.textContent = 'ASSIGNING…';
  try {
    const r = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    applyWorkspace(j);
    updateSaveBtn();
    sysNote(isLocalHub
      ? 'workspace locked in — all worker files & HANDOFF.md land there'
      : `folder "${j.root.replace('browser://', '')}" linked — use ⬇ SAVE FILES to pull HANDOFF.md & progress into it`);
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  } finally { go.disabled = false; go.textContent = 'ASSIGN & START ▸'; }
}
const isLocalHub = ['127.0.0.1', 'localhost'].includes(location.hostname);

// tiny IndexedDB for the folder handle (cloud boards)
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('orchestra-ws', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async set(k, v) { const d = await this.open(); return new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async get(k) { const d = await this.open(); return new Promise((res, rej) => { const q = d.transaction('kv', 'readonly').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
};

$('#gate-go').addEventListener('click', assignFolder);
$('#gate-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') assignFolder(); });

async function writeToFolder(handle, name, text) {
  const fh = await handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

async function syncCloudFiles() {
  try {
    const h = await idb.get('wsHandle');
    if (!h || !window.__wsInfo?.configured) return;
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;
    const md = await (await fetch('/api/handoff')).text();
    await writeToFolder(h, 'HANDOFF.md', md);
    await writeToFolder(h, `${window.__wsInfo.project || 'main'}-PROGRESS.md`, md);
  } catch { /* permission pending or tab hidden — retry next tick */ }
}
setInterval(syncCloudFiles, 60000);

async function registerBrowserWorkspace(name) {
  const r = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'browser://' + name }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  applyWorkspace(j);
  updateSaveBtn();
  return j;
}

function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// browsers without File System Access (Brave/Firefox/Safari) get one-click downloads instead of disk writes
$('#btn-save-files').addEventListener('click', async () => {
  try {
    const md = await (await fetch('/api/handoff')).text();
    const proj = window.__wsInfo?.project || 'main';
    downloadText('HANDOFF.md', md);
    setTimeout(() => downloadText(`${proj}-PROGRESS.md`, md), 400);
  } catch (e) { alert(e.message); }
});

async function updateSaveBtn() {
  const btn = $('#btn-save-files');
  const ws = window.__wsInfo;
  if (!isLocalHub && ws?.configured && String(ws.root || '').startsWith('browser://')) {
    let hasHandle = false;
    try { hasHandle = !!(await idb.get('wsHandle')); } catch {}
    btn.hidden = hasHandle; // handle → auto-writes; none → manual downloads
  } else btn.hidden = true;
}

async function cloudPick() {
  if (window.showDirectoryPicker) {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idb.set('wsHandle', handle);
    await registerBrowserWorkspace(handle.name);
    sysNote(`folder "${handle.name}" linked — HANDOFF.md & progress will be written there`);
    syncCloudFiles();
    return;
  }
  // Brave (blocks File System Access by default), Firefox & Safari: directory input fallback
  $('#dir-fallback').click();
}

function sanitizeFolderName(s) {
  const clean = String(s).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || 'workspace';
}

$('#dir-fallback').addEventListener('change', async (e) => {
  const files = e.target.files;
  e.target.value = '';
  const rel = files?.[0]?.webkitRelativePath || '';
  let name = rel.split('/')[0];
  if (!name) {
    // empty/new folder: browsers return zero files (sometimes no change event at all),
    // so there is no path to read — ask for the folder name instead
    name = prompt('That folder is empty, so the browser could not read its name.\nType the folder name to link it:', 'my-project');
    if (!name) return;
  }
  try {
    await registerBrowserWorkspace(sanitizeFolderName(name));
    sysNote(`folder "${sanitizeFolderName(name)}" linked (download mode) — use ⬇ SAVE FILES to pull HANDOFF.md & progress into it`);
  } catch (err) { alert(err.message); }
});

let browsing = false;
$('#gate-browse')?.addEventListener('click', async () => {
  const b = $('#gate-browse');
  b.disabled = true;
  setTimeout(() => { b.disabled = false; }, 1500);

  // 1. Trigger local OS Explorer Dialog
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const j = await (await fetch('/api/workspace/browse', { signal: ctrl.signal })).json();
    clearTimeout(timer);
    if (j?.path) {
      $('#gate-path').value = j.path;
      $('#gate-err').hidden = true;
      sysNote(`selected workspace folder: ${j.path}`);
      return;
    }
  } catch { /* try web fallback */ }

  // 2. Browser File System Access API (Chrome/Edge)
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (handle) {
        await idb.set('wsHandle', handle);
        $('#gate-path').value = handle.name;
        $('#gate-err').hidden = true;
        if (!isLocalHub) {
          await registerBrowserWorkspace(handle.name);
          sysNote(`folder "${handle.name}" linked`);
          syncCloudFiles();
        }
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  // 3. Directory input fallback
  $('#dir-fallback').click();
});

let browsingFile = false;
$('#gate-browse-file')?.addEventListener('click', async () => {
  const b = $('#gate-browse-file');
  b.disabled = true;
  setTimeout(() => { b.disabled = false; }, 1500);

  // 1. Trigger local OS File Dialog
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const j = await (await fetch('/api/workspace/browse-file', { signal: ctrl.signal })).json();
    clearTimeout(timer);
    if (j?.path) {
      $('#gate-path').value = j.path;
      $('#gate-err').hidden = true;
      sysNote(`file attached → workspace folder set to ${j.path}`);
      return;
    }
  } catch { /* try web fallback */ }

  // 2. Browser File System Access API
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker();
      if (handle) {
        $('#gate-path').value = handle.name;
        $('#gate-err').hidden = true;
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  // 3. File input fallback
  $('#file-fallback').click();
});

$('#file-fallback')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) {
    $('#gate-path').value = file.name;
    $('#gate-err').hidden = true;
    sysNote(`selected file "${file.name}"`);
  }
});

$('#btn-folder').addEventListener('click', () => showGate());

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
    if (j.configured) {
      applyWorkspace(j, true); // returning user — straight in
      if (!isLocalHub && String(j.root || '').startsWith('browser://')) { syncCloudFiles(); updateSaveBtn(); }
    } else showGate();
  } catch { showGate(); }
})();

connect();

// debug/test introspection
window.__orchestra = { board, terms, agents };
