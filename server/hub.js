import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { Store } from './store.js';

const require = createRequire(import.meta.url);
// ConPTY — makes board terminals true replicas of a real console.
let pty = null;
try { pty = require('node-pty'); } catch { /* pipe-mode fallback */ }

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
  if (['spawn', 'exit', 'status', 'task', 'msg', 'state-set', 'state-del'].includes(kind)) wsDirty = true;
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

// zen (opencode) credential — workers need it when builds run through opencode zen/go.
// Prefer the env var; fall back to the local `opencode auth login` store.
let zenKeyCache;
function zenApiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (zenKeyCache !== undefined) return zenKeyCache;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8'));
    zenKeyCache = j.opencode?.key || null;
  } catch { zenKeyCache = null; }
  return zenKeyCache;
}

function spawnWorker({ prompt, model, name }) {
  if (!workspace || !workspace.root) {
    throw new Error('Please attach a workspace folder first before starting a project or spawning workers.');
  }
  const id = uniqueId('w-' + rid());
  const display = name || `OPCODE-${id.slice(-4).toUpperCase()}`;
  const agent = {
    id, name: display, role: 'worker', color: colorFor(id),
    status: 'booting', detail: 'booting opencode…', task: prompt,
    engine: 'opencode-tui', joinedAt: now(), lastSeen: now(),
  };
  agents.set(id, agent);
  emit('spawn', { agent: serializeAgent(agent), prompt }, 'hub');

  // worker = a real opencode session in its board terminal.
  // Save prompt to a file and read via Get-Content -Raw so multi-line text, quotes, and symbols are parsed cleanly.
  const promptsDir = path.join(ROOT, cfg.persistDir, 'prompts');
  try { fs.mkdirSync(promptsDir, { recursive: true }); } catch { /* */ }
  const promptFile = path.join(promptsDir, `${id}.txt`);
  try { fs.writeFileSync(promptFile, String(prompt || ''), 'utf8'); } catch { /* */ }

  staggerBoot(() => {
    try {
      const { s } = ensureShellSession(id);
      const modelFlag = cfg.workerModel ? ` -m "${cfg.workerModel}"` : '';
      const safePath = promptFile.replace(/\\/g, '/');
      const isWin = process.platform === 'win32';
      const promptCmd = isWin ? `$taskPrompt = Get-Content "${safePath}" -Raw\r` : `taskPrompt=$(cat "${safePath}")\n`;
      const runCmd = isWin ? `opencode run $taskPrompt${modelFlag}\r` : `opencode run "$taskPrompt"${modelFlag}\n`;
      if (s.proc.write) {
        s.proc.write(promptCmd);
        s.proc.write(runCmd);
      } else if (s.proc.stdin) {
        s.proc.stdin.write(promptCmd);
        s.proc.stdin.write(runCmd);
      }
      agent.status = 'working';
      agent.detail = 'running task in opencode';
      emit('status', { status: agent.status, detail: agent.detail, agent: serializeAgent(agent) }, id);
    } catch { /* panel still shows; typing retries */ }
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

// ---------- missions (coordinated multi-agent launches) ----------
const missions = new Map(); // id -> { goal, tasks: [{ agentId, prompt, name, role, scope, files }], startedAt }

function decomposeProjectPlan({ goal = '', prompt = '', teamSize = 0, style = 'auto' }) {
  const text = String(prompt || goal || '').trim();
  if (!text) throw new Error('project plan or prompt description is required');

  const lower = text.toLowerCase();
  let detectedStyle = style;
  if (!detectedStyle || detectedStyle === 'auto') {
    if (lower.includes('cli') || lower.includes('command line') || lower.includes('terminal tool')) {
      detectedStyle = 'cli';
    } else if ((lower.includes('api') || lower.includes('microservice') || lower.includes('backend')) && !lower.includes('frontend') && !lower.includes('react') && !lower.includes('vue') && !lower.includes('ui')) {
      detectedStyle = 'backend';
    } else if ((lower.includes('ui') || lower.includes('landing') || lower.includes('frontend') || lower.includes('component')) && !lower.includes('database') && !lower.includes('server') && !lower.includes('api') && !lower.includes('backend') && !lower.includes('rest')) {
      detectedStyle = 'frontend';
    } else {
      detectedStyle = 'fullstack';
    }
  }

  let count = Number(teamSize) || 0;
  if (count < 2 || count > 8) {
    if (detectedStyle === 'fullstack') count = 4;
    else if (detectedStyle === 'cli') count = 3;
    else if (detectedStyle === 'backend') count = 4;
    else count = 4;
  }

  const hasAuth = lower.includes('auth') || lower.includes('login') || lower.includes('jwt') || lower.includes('oauth') || lower.includes('user');
  const hasStripe = lower.includes('stripe') || lower.includes('payment') || lower.includes('checkout') || lower.includes('billing') || lower.includes('subscription');
  const tasks = [];

  if (detectedStyle === 'fullstack') {
    if (count >= 5) {
      tasks.push({
        name: 'ARCHITECT-CORE',
        role: 'System Architect & Schema',
        scope: 'Project structure, database models/migrations, environment configurations, and shared TypeScript domain types.',
        files: 'schema.prisma, src/types/*, src/config/*, .env.example, package.json',
        prompt: `You are ARCHITECT-CORE for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Establish clean directory layout, dependency setup in package.json, and environment config (.env.example).\n2. Design database models/schemas and shared domain types.\n3. Write initial schema & interface contracts in BLACKBOARD.md under ## ARCHITECT-CORE.\n4. Keep definitions pure and reusable for backend and frontend teammates.`,
      });

      tasks.push({
        name: 'BACKEND-API',
        role: 'Backend API & Controllers',
        scope: 'REST/tRPC API endpoints, service handlers, business logic controllers, database queries, and input validation.',
        files: 'src/routes/*, src/controllers/*, src/services/*, server.js',
        prompt: `You are BACKEND-API for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Build API routing and endpoint handlers.\n2. Implement business logic services, database queries, and input validation.\n3. Check BLACKBOARD.md for shared types/schemas defined by ARCHITECT-CORE.\n4. Document completed endpoints and payload contracts in BLACKBOARD.md.`,
      });

      tasks.push({
        name: 'AUTH-INTEGRATIONS',
        role: 'Auth, Security & Services',
        scope: `${hasAuth ? 'User auth (JWT/OAuth/sessions)' : 'Security middleware'}, ${hasStripe ? 'Stripe payments/webhooks' : 'External integrations, storage, and notifications'}.`,
        files: 'src/auth/*, src/middleware/*, src/integrations/*, src/webhooks/*',
        prompt: `You are AUTH-INTEGRATIONS for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Implement secure authentication, session handling, token validation, and permission middleware.\n2. Implement third-party integrations (payments, webhooks, file uploads, notifications).\n3. Document auth headers, webhook endpoints, and API keys in BLACKBOARD.md.`,
      });

      tasks.push({
        name: 'FRONTEND-UI',
        role: 'UI Components & Pages',
        scope: 'Modern responsive UI layouts, interactive components, client state management, styling, and API integration.',
        files: 'src/components/*, src/pages/*, src/styles/*, public/*',
        prompt: `You are FRONTEND-UI for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Build clean, responsive UI layouts, dashboards, and interactive components.\n2. Connect UI components to backend endpoints documented in BLACKBOARD.md.\n3. Handle loading states, form validation, notifications, and user error feedback.`,
      });

      tasks.push({
        name: 'QA-VERIFICATION',
        role: 'QA, Testing & Verification',
        scope: 'Unit tests, API integration tests, mock seed fixtures, smoke tests, and build/lint validation.',
        files: 'tests/*, src/**/*.test.js, scripts/verify.js',
        prompt: `You are QA-VERIFICATION for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Write unit tests for business logic and integration tests for API endpoints.\n2. Set up test runner scripts, mock seed data, and edge case assertions.\n3. Validate project builds cleanly and append test results in BLACKBOARD.md.`,
      });
    } else if (count === 3) {
      tasks.push({
        name: 'BACKEND-LEAD',
        role: 'Backend API & Database',
        scope: 'Architecture, database schemas, API routes, authentication, and business logic.',
        files: 'server/*, src/api/*, src/models/*, package.json',
        prompt: `You are BACKEND-LEAD for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Set up project structure, database models, and environment configuration.\n2. Build REST/tRPC API endpoints, controllers, and auth/business logic.\n3. Document API specifications and schemas in BLACKBOARD.md so frontend can hook in immediately.`,
      });
      tasks.push({
        name: 'FRONTEND-UI',
        role: 'Frontend UI & Client State',
        scope: 'User interface pages, components, client API integration, and styling.',
        files: 'src/components/*, src/views/*, public/*',
        prompt: `You are FRONTEND-UI for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Implement modern, responsive UI views, components, and layout.\n2. Connect views to backend endpoints defined in BLACKBOARD.md.\n3. Handle UI state, form submissions, and user interactions smoothly.`,
      });
      tasks.push({
        name: 'QA-TOOLING',
        role: 'Testing & Build Verification',
        scope: 'Unit/integration test suites, fixtures, build automation, and documentation.',
        files: 'tests/*, scripts/*, README.md',
        prompt: `You are QA-TOOLING for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Create test suites for core logic and API endpoints.\n2. Verify build/test execution, write setup guides, and log results in BLACKBOARD.md.`,
      });
    } else {
      // 4 agents (default balanced)
      tasks.push({
        name: 'ARCHITECT-DATA',
        role: 'Architecture & Database',
        scope: 'System models, database schema, data access layer, migrations, and shared types.',
        files: 'src/models/*, src/db/*, src/types/*, package.json',
        prompt: `You are ARCHITECT-DATA for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Set up data models, database connection, schema definitions, and shared types.\n2. Document data structures and interfaces in BLACKBOARD.md for teammates.`,
      });
      tasks.push({
        name: 'BACKEND-API',
        role: 'API Services & Routes',
        scope: 'API routes, controllers, middleware, business logic, and third-party integrations.',
        files: 'src/routes/*, src/controllers/*, src/services/*, server.js',
        prompt: `You are BACKEND-API for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Build API endpoints, business logic controllers, and service handlers.\n2. Implement validation and connect endpoints to database models.\n3. Document endpoint contracts in BLACKBOARD.md.`,
      });
      tasks.push({
        name: 'FRONTEND-UI',
        role: 'Frontend UI & Client',
        scope: 'UI layouts, pages, interactive components, client API calls, and styling.',
        files: 'src/components/*, src/pages/*, public/*',
        prompt: `You are FRONTEND-UI for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Create modern UI layouts, components, and responsive pages.\n2. Connect components to backend endpoints documented in BLACKBOARD.md.\n3. Ensure polished user experience with loading and error states.`,
      });
      tasks.push({
        name: 'QA-TESTS',
        role: 'Testing, Quality & Verification',
        scope: 'Test suites, mocks, API validation, and build/run scripts.',
        files: 'tests/*, scripts/test.js',
        prompt: `You are QA-TESTS for this project.\nGoal: ${text}\n\nYour Responsibilities:\n1. Write unit and integration tests covering the core features.\n2. Validate end-to-end functionality and report test results in BLACKBOARD.md.`,
      });
    }
  } else if (detectedStyle === 'cli') {
    tasks.push({
      name: 'CLI-CORE',
      role: 'CLI Architecture & Command Engine',
      scope: 'Argument parsing, command dispatch, config loading, and main binary entrypoint.',
      files: 'bin/*, src/cli.js, src/config.js, package.json',
      prompt: `You are CLI-CORE for this tool.\nGoal: ${text}\n\nYour Responsibilities:\n1. Implement command-line argument parsing (options, flags, commands, help).\n2. Set up configuration loading, environment handling, and entrypoint binary.\n3. Document command specs in BLACKBOARD.md.`,
    });
    tasks.push({
      name: 'ENGINE-LOGIC',
      role: 'Core Engine & Processing',
      scope: 'Core business algorithms, data processing, file manipulation, and worker logic.',
      files: 'src/engine/*, src/lib/*',
      prompt: `You are ENGINE-LOGIC for this tool.\nGoal: ${text}\n\nYour Responsibilities:\n1. Implement the core processing engine, file/data operations, and execution logic.\n2. Provide clean programmatic APIs for CLI-CORE to execute.`,
    });
    tasks.push({
      name: 'UI-OUTPUT-TESTS',
      role: 'Terminal UI & Test Suite',
      scope: 'Terminal formatting (colors, spinners, tables), logging, and comprehensive test suite.',
      files: 'src/ui/*, tests/*, README.md',
      prompt: `You are UI-OUTPUT-TESTS for this tool.\nGoal: ${text}\n\nYour Responsibilities:\n1. Implement beautiful terminal output (spinners, progress bars, tables, formatted logs).\n2. Write integration tests and documentation in README.md.`,
    });
  } else {
    // Custom / Generic decomposition
    const steps = [
      { name: 'ARCHITECT-LEAD', role: 'Architecture & Core Engine', scope: 'Core structure, models, configuration, and contracts.' },
      { name: 'SERVICE-DEV', role: 'Services & Implementation', scope: 'Core functional logic, API/data handling, and features.' },
      { name: 'UI-CLIENT', role: 'Interface & Presentation', scope: 'User interface, client layer, and interactions.' },
      { name: 'QA-VALIDATION', role: 'Quality & Verification', scope: 'Testing, verification, fixtures, and documentation.' },
    ];
    for (let i = 0; i < Math.min(count, steps.length); i++) {
      const s = steps[i];
      tasks.push({
        name: s.name,
        role: s.role,
        scope: s.scope,
        files: `src/${s.name.toLowerCase()}/*`,
        prompt: `You are ${s.name} (${s.role}).\nGoal: ${text}\nYour scope: ${s.scope}\n1. Coordinate with team via BLACKBOARD.md.\n2. Build your assigned scope cleanly.\n3. Mark STATUS: DONE when complete.`,
      });
    }
  }

  return {
    goal: goal || text.slice(0, 100),
    planSummary: text,
    detectedStyle,
    teamSize: tasks.length,
    tasks,
  };
}

function seedBlackboard(missionId, goal, tasks) {
  if (!workspace || workspace.browserManaged || !workspace.projectDir) return null;
  const file = path.join(workspace.projectDir, 'BLACKBOARD.md');
  const body = [
    `# ⌬ ORCHESTRA MISSION BLACKBOARD — ${missionId}`,
    '',
    `> **Project Goal:** ${goal}`,
    `> **Team Size:** ${tasks.length} specialized agents`,
    `> **Initiated:** ${new Date().toLocaleString()}`,
    '',
    '---',
    '',
    '## 🎯 Architectural Contract & Coordination Rules',
    '1. **Scope Isolation:** Only write to files in your assigned scope. Never overwrite teammates\' files.',
    '2. **Contract First:** Before implementing, write your exported interfaces, endpoints, and schemas under your section.',
    '3. **Cross-Agent Dependencies:** Read your teammates\' sections below to consume their APIs/types.',
    '4. **Live Bus Updates:** Broadcast milestones over the Orchestra event bus (e.g. `[AGENT-NAME]: endpoints ready`).',
    '5. **Completion:** When your deliverables are complete and verified, change your status to `STATUS: DONE`.',
    '',
    '---',
    '',
    '## 🗺️ File Ownership Matrix',
    '| Agent | Role | Assigned Files / Scope | Status |',
    '|---|---|---|---|',
    ...tasks.map((t) => `| **${t.name}** | ${t.role || 'Specialist'} | \`${t.files || t.scope || 'Assigned Scope'}\` | ⏳ IN_PROGRESS |`),
    '',
    '---',
    '',
    ...tasks.map((t) => [
      `## ${t.name} (${t.role || 'Agent'})`,
      `- **Scope:** ${t.scope || t.prompt}`,
      `- **Assigned Files:** \`${t.files || 'src/' + t.name.toLowerCase() + '/*'}\``,
      '- **Decisions & API Specs:**',
      '  _(Document exported functions, schemas, endpoints here)_',
      '',
      '`STATUS: IN_PROGRESS`',
      '',
    ].join('\n')),
  ].join('\n');
  try {
    fs.mkdirSync(workspace.projectDir, { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    return file;
  } catch { return null; }
}

function launchMission({ goal, prompt, teamSize, style, tasks, prompts }) {
  let plannedTasks = [];

  if (Array.isArray(tasks) && tasks.length > 0) {
    plannedTasks = tasks.map((t, i) => ({
      name: t.name || `AGENT-${i + 1}`,
      role: t.role || 'Specialist',
      scope: t.scope || t.prompt || '',
      files: t.files || '',
      prompt: t.prompt || t.scope || '',
    }));
  } else if (Array.isArray(prompts) && prompts.length > 0) {
    plannedTasks = prompts.map((p, i) => ({
      name: `AGENT-${i + 1}`,
      role: 'Specialist',
      scope: String(p || '').slice(0, 100),
      files: '',
      prompt: String(p || '').trim(),
    })).filter((t) => t.prompt);
  } else if (prompt || goal) {
    const plan = decomposeProjectPlan({ goal, prompt, teamSize, style });
    plannedTasks = plan.tasks;
    if (!goal) goal = plan.goal;
  }

  if (!workspace || !workspace.root) {
    throw new Error('Please attach a workspace folder first before starting a project or launching a mission.');
  }

  if (!plannedTasks.length) throw new Error('at least one agent task or project prompt is required');

  const mid = 'M-' + rid();
  const boardFile = seedBlackboard(mid, goal || 'Autonomous Project Mission', plannedTasks);
  const roster = plannedTasks.map((t) => `- **${t.name}** (${t.role || 'Specialist'}): ${t.scope || t.prompt.slice(0, 90)}`).join('\n');

  // Seed mission state on the shared blackboard
  store.setState('mission.active', mid, 'hub');
  store.setState('mission.goal', goal || 'Multi-Agent Project', 'hub');
  store.setState('mission.teamSize', plannedTasks.length, 'hub');

  const spawned = plannedTasks.map((t, i) => {
    const composed = [
      `[ORCHESTRA MISSION ${i + 1}/${plannedTasks.length}${goal ? ' :: ' + goal : ''}]`,
      `ROLE: ${t.name} (${t.role || 'Specialist'})`,
      `ASSIGNED FILES: ${t.files || 'See scope below'}`,
      '',
      'TEAM ROSTER — split work cleanly along these lines; never duplicate a teammate\'s scope:',
      roster,
      '',
      'SHARED BOARD: ' + (boardFile || 'BLACKBOARD.md in project directory'),
      'Your section in BLACKBOARD.md: "## ' + t.name + '"',
      '',
      'COORDINATION WORKFLOW:',
      '1. Read BLACKBOARD.md to check schemas, types, and teammate ownership.',
      '2. Update your section in BLACKBOARD.md with your API designs, interfaces, and progress.',
      '3. Implement clean, robust code for your assigned scope.',
      '4. Broadcast major milestones on the bus (e.g. send "' + t.name + ': API ready" to *).',
      '5. When finished and verified, update your section with `STATUS: DONE`.',
      '',
      'YOUR ASSIGNED TASK:',
      t.prompt,
    ].join('\n');

    const a = spawnWorker({ prompt: composed, name: t.name });
    t.agentId = a.id;
    return a;
  });

  missions.set(mid, { goal: goal || '', tasks: plannedTasks, startedAt: now(), boardFile });
  emit('msg', { to: '*', text: `🚀 Mission ${mid} launched — ${plannedTasks.length} agents coordinating live on ${goal || 'project'}` }, 'hub');
  return { mission: mid, boardFile, tasks: plannedTasks, spawned };
}

// ---------- in-app shell terminals ----------
// Every terminal on the board is backed by a lazily-spawned persistent shell
// (powershell reading commands from stdin). Nothing ever opens an external
// window — all I/O rides the event bus into the embedded term-win panels.
const stickyAgents = new Set(); // board terminals survive GC while the page exists
const sessions = new Map();     // agentId -> { proc, hbTimer, scroll }
const SCROLL_CAP = 160000;      // per-terminal scrollback bytes kept for replay

// opencode boot = multi-second CPU spike; two at once freezes the machine.
// Stagger boots so only one agent initializes at a time.
let lastBootAt = 0;
function staggerBoot(fn) {
  const wait = Math.max(0, lastBootAt + 1800 - Date.now());
  lastBootAt = Math.max(lastBootAt, Date.now()) + wait + 1800;
  setTimeout(fn, wait);
}

function ensureShellSession(id) {
  const a = agents.get(id);
  if (!a) throw new Error('unknown terminal: ' + id);
  let s = sessions.get(id);
  if (s && (pty ? s.proc.pid : (s.proc.exitCode === null && !s.proc.killed))) return { s, fresh: false };
  if (s) clearInterval(s.hbTimer);
  const shellEnv = {
    ...process.env,
    OCHRE_AGENT_ID: id,
    OCHRE_AGENT_NAME: a.name,
    OCHRE_URL: `ws://${cfg.host}:${cfg.port}${BUS_PATH}`,
  };
  const shellCwd = (workspace && workspace.projectDir) || ROOT;
  s = { scroll: [], hbTimer: setInterval(() => { const ag = agents.get(id); if (ag) ag.lastSeen = now(); }, 3000) };

  const isWin = process.platform === 'win32';
  const defaultShell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const defaultArgs = isWin ? ['-NoProfile', '-NoLogo'] : [];

  if (pty) {
    // true ConPTY / PTY console — prompts, colors, echo, interactive apps all work
    const shell = pty.spawn(defaultShell, defaultArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: shellCwd,
      env: shellEnv,
    });
    s.proc = shell;
    sessions.set(id, s);
    children.set(id, shell); // GC exemption + taskkill support
    // batch ConPTY frames (~35ms) — raw per-chunk emits make TUIs stutter
    let buf = '';
    s.flush = () => {
      if (!buf) { s.flushT = null; return; }
      const d = buf;
      buf = '';
      s.flushT = null;
      s.scroll.push(d);
      while (s.scroll.length > 2 || s.scroll.reduce((n, c) => n + c.length, 0) > SCROLL_CAP) s.scroll.shift();
      emit('log', { level: 'info', text: d.slice(0, 12000), stream: 'stdout', raw: true }, id);
    };
    shell.onData((d) => {
      buf += d;
      if (!s.flushT) s.flushT = setTimeout(s.flush, 35);
    });
    shell.onExit(({ exitCode }) => finishSession(id, exitCode));
    a.status = 'shell';
    a.detail = 'interactive console';
    emit('status', { status: a.status, detail: a.detail, agent: serializeAgent(a) }, id);
    return { s, fresh: true };
  }

  // fallback: piped shell reading commands from stdin (no PTY available)
  const shell = isWin
    ? spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        cwd: shellCwd,
        env: shellEnv,
        windowsHide: true, // never a visible window — the board IS the window
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    : spawn(defaultShell, ['-i'], {
        cwd: shellCwd,
        env: shellEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
  s.proc = shell;
  sessions.set(id, s);
  children.set(id, shell);
  a.status = 'shell';
  a.detail = 'interactive shell';
  emit('status', { status: a.status, detail: a.detail, agent: serializeAgent(a) }, id);

  const pipeOut = (stream) => {
    let buf = '';
    return (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const text = stripAnsi(buf.slice(0, i).replace(/\r/g, '')).trim();
        buf = buf.slice(i + 1);
        if (!text) continue;
        emit('log', { level: stream === 'stderr' ? 'warn' : 'info', text: text.slice(0, 500), stream }, id);
      }
      if (buf.length > 64000) buf = '';
    };
  };
  shell.stdout.on('data', pipeOut('stdout'));
  shell.stderr.on('data', pipeOut('stderr'));

  shell.on('exit', (code) => finishSession(id, code));
  return { s, fresh: true };
}

function finishSession(id, code) {
  const s = sessions.get(id);
  if (s) {
    clearInterval(s.hbTimer);
    if (s.injectT) clearTimeout(s.injectT);
    if (s.flushT) { clearTimeout(s.flushT); s.flushT = null; try { s.flush(); } catch { /* */ } }
  }
  sessions.delete(id);
  children.delete(id);
  const ag = agents.get(id);
  if (ag) {
    ag.status = code === 0 ? 'idle' : 'error';
    ag.detail = code === 0 ? 'shell closed — type to reopen' : `shell exited ${code}`;
    emit('status', { status: ag.status, detail: ag.detail, agent: serializeAgent(ag) }, id);
  }
}

function feedTerminalInput(id, data, isLineMode = false) {
  const a = agents.get(id);
  if (!a) throw new Error('unknown terminal: ' + id);
  if (children.has(id) && !sessions.has(id)) throw new Error('worker is still running — its output streams below; input unlocks when it finishes');
  const { s } = ensureShellSession(id);
  if (s.proc.stdin) {
    s.proc.stdin.write(String(data).replace(/[\r\n]+/g, ' ').slice(0, 2000) + '\n');
  } else {
    if (isLineMode) {
      s.proc.write(String(data).replace(/[\r\n]+/g, ' ').slice(0, 4000) + '\r');
    } else {
      s.proc.write(String(data));
    }
  }
  return true;
}

function resizeSession(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || !s.proc.resize) return false;
  try { s.proc.resize(Math.max(20, Math.min(Number(cols) | 0, 500)), Math.max(6, Math.min(Number(rows) | 0, 200))); } catch { /* racing exit */ }
  return true;
}

function sessionBacklog(id) {
  const s = sessions.get(id);
  if (!s) return '';
  return s.scroll.join('');
}

// ---------- intelligent terminal instruction router ----------
function routeInstructionToTerminals({ message, target = 'auto' }) {
  const text = String(message || '').trim();
  if (!text) throw new Error('instruction message is required');

  const onlineAgents = [...agents.values()];
  if (!onlineAgents.length) throw new Error('no active terminal agents connected');

  // 1. Direct target or broadcast
  if (target === 'all' || target === '*') {
    const routed = [];
    for (const a of onlineAgents) {
      try {
        feedTerminalInput(a.id, text, true);
        routed.push({ id: a.id, name: a.name, role: a.role });
      } catch { /* skip if shell closed */ }
    }
    emit('msg', { to: '*', text: `📢 [BROADCAST INSTRUCTION]: ${text}` }, 'commander');
    return { routedTo: routed, message: text, mode: 'broadcast', reason: 'Broadcast to all terminals' };
  }

  // 2. Target by specific ID or Name
  if (target && target !== 'auto') {
    const directAgent = onlineAgents.find((a) => a.id === target || a.name.toLowerCase() === target.toLowerCase());
    if (directAgent) {
      feedTerminalInput(directAgent.id, text, true);
      emit('msg', { to: directAgent.name, text: `⚡ [INSTRUCTION]: ${text}` }, 'commander');
      return { routedTo: [{ id: directAgent.id, name: directAgent.name, role: directAgent.role }], message: text, mode: 'direct', reason: `Directly addressed to ${directAgent.name}` };
    }
  }

  // 3. Intelligent Domain & Keyword Analysis Auto-Router
  const lower = text.toLowerCase();

  const domainKeywords = {
    frontend: ['ui', 'frontend', 'component', 'page', 'css', 'tailwind', 'style', 'react', 'html', 'form', 'button', 'color', 'theme', 'layout', 'modal', 'view', 'nav', 'canvas', 'visual', 'chart', 'header', 'footer'],
    backend: ['api', 'backend', 'route', 'endpoint', 'controller', 'service', 'express', 'fastify', 'server', 'rest', 'graphql', 'trpc', 'handler', 'payload', 'status code', 'middleware'],
    database: ['database', 'schema', 'prisma', 'postgres', 'sql', 'sqlite', 'model', 'migration', 'type', 'interface', 'env', 'package.json', 'config', 'architect', 'table', 'column', 'data layer'],
    auth: ['auth', 'login', 'jwt', 'token', 'session', 'oauth', 'stripe', 'payment', 'checkout', 'webhook', 'email', 's3', 'storage', 'security', 'role', 'permission'],
    qa: ['test', 'tests', 'jest', 'vitest', 'cypress', 'playwright', 'unit', 'integration', 'e2e', 'coverage', 'assert', 'qa', 'verify', 'failing', 'fix test', 'pass', 'mock', 'fixture'],
    cli: ['cli', 'command', 'flag', 'arg', 'parser', 'binary', 'script', 'spinner', 'terminal output'],
  };

  const domainMatches = {};
  for (const [dom, words] of Object.entries(domainKeywords)) {
    domainMatches[dom] = words.filter((w) => lower.includes(w)).length;
  }

  const scores = new Map();
  for (const a of onlineAgents) {
    const aName = (a.name || '').toLowerCase();
    const aRole = (a.role || '').toLowerCase();
    let score = 0;

    if (aName.includes('frontend') || aName.includes('ui') || aRole.includes('frontend') || aRole.includes('ui') || aRole.includes('client')) {
      score += domainMatches.frontend * 5;
    }
    if (aName.includes('backend') || aName.includes('api') || aRole.includes('backend') || aRole.includes('api') || aRole.includes('controller')) {
      score += domainMatches.backend * 5;
    }
    if (aName.includes('architect') || aName.includes('data') || aName.includes('schema') || aRole.includes('architect') || aRole.includes('schema')) {
      score += domainMatches.database * 5;
    }
    if (aName.includes('auth') || aName.includes('integration') || aRole.includes('auth') || aRole.includes('security')) {
      score += domainMatches.auth * 5;
    }
    if (aName.includes('qa') || aName.includes('test') || aRole.includes('qa') || aRole.includes('testing') || aRole.includes('verification')) {
      score += domainMatches.qa * 5;
    }
    if (aName.includes('cli') || aRole.includes('cli') || aName.includes('engine')) {
      score += domainMatches.cli * 5;
    }

    if (lower.includes(aName)) score += 50;

    scores.set(a.id, score);
  }

  let bestAgent = onlineAgents[0];
  let maxScore = -1;
  for (const a of onlineAgents) {
    const s = scores.get(a.id) || 0;
    if (s > maxScore) {
      maxScore = s;
      bestAgent = a;
    }
  }

  feedTerminalInput(bestAgent.id, text, true);
  emit('msg', { to: bestAgent.name, text: `⚡ [AUTO-ROUTED]: ${text}` }, 'commander');

  return {
    routedTo: [{ id: bestAgent.id, name: bestAgent.name, role: bestAgent.role }],
    message: text,
    mode: 'auto-routed',
    reason: maxScore > 0 ? `Matched domain to ${bestAgent.name} (${bestAgent.role})` : `Routed to active terminal ${bestAgent.name}`,
  };
}

// × on a terminal window: kill its shell; board-owned terminals also leave the bus
function killSession(id) {
  const s = sessions.get(id);
  if (s) {
    try { if (s.proc.kill) s.proc.kill(); } catch { /* racing exit */ }
    if (process.platform === 'win32' && s.proc.pid) exec(`taskkill /PID ${s.proc.pid} /T /F`);
    else if (s.proc.pid) exec(`kill -9 ${s.proc.pid}`);
  }
  const a = agents.get(id);
  if (a?.role === 'terminal' || a?.engine === 'opencode-tui') {
    stickyAgents.delete(id);
    agents.delete(id);
    emit('leave', { id, name: a.name, reason: 'closed' }, 'hub');
  }
}

function openTerminal(count = 1) {
  if (!workspace || !workspace.root) {
    throw new Error('Please attach a workspace folder first before opening terminals.');
  }
  const made = [];
  for (let i = 0; i < count; i++) {
    const tid = uniqueId('t-' + rid());
    const used = [...agents.values()].map((a) => a.color);
    const color = COLORS.find((c) => !used.includes(c)) || colorFor(tid);
    agents.set(tid, {
      id: tid,
      name: `TERMINAL-${tid.slice(-4).toUpperCase()}`,
      role: 'terminal',
      color,
      status: 'idle',
      detail: '',
      task: '',
      pid: null,
      engine: 'shell',
      joinedAt: now(),
      lastSeen: now(),
    });
    stickyAgents.add(tid); // never GC'd — the board owns its lifecycle
    emit('spawn', { agent: serializeAgent(agents.get(tid)), prompt: 'opencode agent session' }, 'hub');
    made.push(tid);
    // boot straight into a live opencode agent inside this terminal's console
    staggerBoot(() => {
      try {
        const { s } = ensureShellSession(tid);
        const modelFlag = cfg.workerModel ? ` -m "${cfg.workerModel}"` : '';
        const opencodeCmd = process.platform === 'win32' ? `opencode${modelFlag}\r` : `opencode${modelFlag}\n`;
        if (s.proc.write) s.proc.write(opencodeCmd);
        else s.proc.stdin.write(opencodeCmd);
      } catch { /* panel still opens — typing retries */ }
    });
  }
  return made;
}

// ---------- workspace (assigned folder, projects, handoff file) ----------
const wsFile = () => path.join(ROOT, cfg.persistDir, 'workspace.json');
let workspace = null;
try { workspace = JSON.parse(fs.readFileSync(wsFile(), 'utf8')); } catch { /* not assigned yet */ }
let wsDirty = !!workspace;

const saveWorkspace = () => { try { fs.writeFileSync(wsFile(), JSON.stringify(workspace, null, 2)); } catch { /* */ } };

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'; }

function ensureProject(name) {
  const base = slugify(name);
  if (workspace.browserManaged) return base; // folder lives on the visitor's machine
  let dir = path.join(workspace.root, base), i = 2;
  while (fs.existsSync(dir)) dir = path.join(workspace.root, `${base}-${i++}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.basename(dir);
}

function renderHandoff() {
  const L = ['# ORCHESTRA — SESSION HANDOFF', '', `> generated ${new Date().toLocaleString()} · project: **${workspace.project}**`, '', '## Agents'];
  if (!agents.size) L.push('_none online_');
  for (const a of agents.values()) {
    L.push(`- **${a.name}** (${a.role}) — ${a.status}${a.task ? ` · task: ${String(a.task).slice(0, 140)}` : ''}${a.pid ? ` · pid ${a.pid}` : ''}`);
  }
  L.push('', '## Shared blackboard');
  const st = store.snapshotState();
  if (!Object.keys(st).length) L.push('_empty_');
  for (const [k, e] of Object.entries(st)) L.push(`- \`${k}\` = ${JSON.stringify(e.v)} (rev${e.rev}, by ${e.by})`);
  L.push('', '## Recent activity');
  for (const e of store.recent(30).reverse()) {
    const txt = e.text || e.key || e.prompt || '';
    L.push(`- ${new Date(e.ts).toLocaleTimeString()} \`${e.from}\` ${e.kind}${txt ? `: ${String(txt).slice(0, 120)}` : ''}`);
  }
  return L.join('\n') + '\n';
}

function writeHandoff() {
  if (!workspace || workspace.browserManaged) return; // browser writes its own copies
  try {
    fs.writeFileSync(path.join(workspace.root, 'HANDOFF.md'), renderHandoff());
    if (workspace.projectDir) fs.writeFileSync(path.join(workspace.projectDir, 'PROGRESS.md'), renderHandoff());
    wsDirty = false;
  } catch { /* folder may be transient */ }
}
setInterval(() => { if (wsDirty) writeHandoff(); }, 60000);

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
    if (stickyAgents.has(id)) continue; // board terminals live until closed in the UI
    const hasLiveConn = a.conn && a.conn.readyState === 1;
    const isLiveChild = children.has(id);
    if (!hasLiveConn && !isLiveChild && a.lastSeen < cutoff) {
      stickyAgents.delete(id);
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
      if (req.method === 'GET' && p === '/api/config') return json(res, 200, { workerModel: cfg.workerModel || null });
      if (req.method === 'GET' && p === '/api/board') return json(res, 200, snapshot());
      if (req.method === 'GET' && p === '/api/events') {
        const since = Number(url.searchParams.get('since') || 0);
        const evs = store.recent(Number(url.searchParams.get('limit') || 500));
        return json(res, 200, evs.filter((e) => e.seq > since));
      }
      if (req.method === 'POST' && p === '/api/mission/plan') {
        const b = await readBody(req);
        const plan = decomposeProjectPlan({
          goal: String(b.goal || '').slice(0, 500),
          prompt: String(b.prompt || b.goal || '').slice(0, 6000),
          teamSize: Number(b.teamSize) || 0,
          style: String(b.style || 'auto'),
        });
        return json(res, 200, plan);
      }
      if (req.method === 'POST' && p === '/api/mission') {
        const b = await readBody(req);
        const out = launchMission({
          goal: String(b.goal || '').slice(0, 500),
          prompt: String(b.prompt || '').slice(0, 6000),
          teamSize: Number(b.teamSize) || 0,
          style: String(b.style || 'auto'),
          tasks: Array.isArray(b.tasks) ? b.tasks : undefined,
          prompts: Array.isArray(b.prompts) ? b.prompts : undefined,
        });
        return json(res, 200, out);
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
      if (req.method === 'POST' && p === '/api/chat-command') {
        const b = await readBody(req);
        const out = routeInstructionToTerminals({
          message: String(b.message || '').slice(0, 4000),
          target: String(b.target || 'auto'),
        });
        return json(res, 200, out);
      }
      if (req.method === 'POST' && p === '/api/state') {
        const b = await readBody(req);
        const entry = store.setState(String(b.key || ''), b.val, String(b.by || 'http'));
        emit('state-set', { key: b.key, entry }, 'http');
        return json(res, 200, entry);
      }
      if (req.method === 'GET' && p === '/api/workspace') {
        return json(res, 200, workspace
          ? { configured: true, root: workspace.root, project: workspace.project, projectDir: workspace.projectDir, projects: workspace.projects }
          : { configured: false });
      }
      if (req.method === 'POST' && p === '/api/workspace') {
        const b = await readBody(req);
        let root = String(b.path || '').trim().replace(/^"|"$/g, '');
        if (!root) return json(res, 400, { error: 'folder path required' });
        // browser-managed workspace: the visitor's own folder, written by their browser
        if (root.startsWith('browser://')) {
          workspace = { root, project: null, projectDir: null, projects: [], createdAt: now(), browserManaged: true };
          const name0 = ensureProject('main');
          workspace.project = name0;
          workspace.projects.push(name0);
          saveWorkspace(); wsDirty = true;
          emit('msg', { to: '*', text: `workspace linked (browser-managed) → ${root}` }, 'hub');
          return json(res, 200, { configured: true, root, project: name0, projectDir: null, projects: workspace.projects });
        }
        try {
          root = fs.realpathSync.native(path.resolve(root));
        } catch {
          const parent = path.dirname(path.resolve(root));
          if (!fs.existsSync(parent)) return json(res, 400, { error: `parent folder does not exist: ${parent}` });
        }
        try { fs.mkdirSync(root, { recursive: true }); } catch (e) { return json(res, 400, { error: 'cannot use folder: ' + e.message }); }
        workspace = { root, project: null, projectDir: null, projects: [], createdAt: now() };
        const name = ensureProject(String(b.project || 'main'));
        workspace.project = name;
        workspace.projectDir = path.join(root, name);
        workspace.projects.push(name);
        saveWorkspace(); wsDirty = true; writeHandoff();
        emit('msg', { to: '*', text: `workspace assigned → ${root} · project: ${name}` }, 'hub');
        return json(res, 200, { configured: true, root, project: name, projectDir: workspace.projectDir, projects: workspace.projects });
      }
      if (req.method === 'DELETE' && p === '/api/workspace') {
        workspace = null;
        saveWorkspace(); wsDirty = true;
        emit('msg', { to: '*', text: 'workspace cleared — assign a folder to continue' }, 'hub');
        return json(res, 200, { configured: false });
      }
      if (req.method === 'GET' && p === '/api/handoff') {
        if (!workspace) return json(res, 400, { error: 'workspace not assigned' });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderHandoff());
      }
      if (req.method === 'GET' && p === '/api/workspace/browse') {
        if (process.platform !== 'win32') return json(res, 501, { error: 'native folder picker only exists on the local hub' });
        const script = path.join(ROOT, 'scripts', 'browse-folder.ps1');
        const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script]);
        let out = '';
        const timer = setTimeout(() => {
          try { ps.kill(); } catch { /* */ }
          if (!res.headersSent) json(res, 200, { path: null });
        }, 120000);
        ps.stdout.on('data', (d) => { out += d; });
        ps.on('error', () => {
          clearTimeout(timer);
          if (!res.headersSent) json(res, 200, { path: null });
        });
        ps.on('close', () => {
          clearTimeout(timer);
          const sel = out.trim();
          if (!res.headersSent) json(res, 200, sel ? { path: sel } : { path: null });
        });
        return;
      }
      if (req.method === 'GET' && p === '/api/workspace/browse-file') {
        if (process.platform !== 'win32') return json(res, 501, { error: 'native file picker only exists on the local hub' });
        const script = path.join(ROOT, 'scripts', 'browse-file.ps1');
        const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script]);
        let out = '';
        const timer = setTimeout(() => {
          try { ps.kill(); } catch { /* */ }
          if (!res.headersSent) json(res, 200, { path: null });
        }, 120000);
        ps.stdout.on('data', (d) => { out += d; });
        ps.on('error', () => {
          clearTimeout(timer);
          if (!res.headersSent) json(res, 200, { path: null });
        });
        ps.on('close', () => {
          clearTimeout(timer);
          const sel = out.trim();
          if (!res.headersSent) {
            if (sel) {
              const folder = path.dirname(sel);
              json(res, 200, { path: folder, file: sel });
            } else {
              json(res, 200, { path: null });
            }
          }
        });
        return;
      }
      if (req.method === 'POST' && p === '/api/workspace/project') {
        if (!workspace) return json(res, 400, { error: 'assign a workspace folder first' });
        const b = await readBody(req);
        if (!String(b.name || '').trim()) return json(res, 400, { error: 'project name required' });
        const name = ensureProject(b.name);
        workspace.project = name;
        workspace.projectDir = path.join(workspace.root, name);
        if (!workspace.projects.includes(name)) workspace.projects.push(name);
        saveWorkspace(); wsDirty = true; writeHandoff();
        emit('msg', { to: '*', text: `switched project → ${name}` }, 'hub');
        return json(res, 200, { configured: true, root: workspace.root, project: name, projectDir: workspace.projectDir, projects: workspace.projects });
      }
      if (req.method === 'POST' && p === '/api/terminals') {
        const b = await readBody(req);
        const count = Math.max(1, Math.min(Number(b.count) || 1, 6));
        return json(res, 200, { terminals: openTerminal(count) });
      }
      if (req.method === 'POST' && p === '/api/session-input') {
        const b = await readBody(req);
        const id = String(b.id || '');
        if (b.cols && b.rows) resizeSession(id, b.cols, b.rows);
        if (b.data !== undefined) feedTerminalInput(id, String(b.data), !!b.line);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/term-backlog') {
        const id = String(url.searchParams.get('id') || '');
        return json(res, 200, { backlog: sessionBacklog(id) });
      }
      if (req.method === 'POST' && p === '/api/session-close') {
        const b = await readBody(req);
        killSession(String(b.id || ''));
        return json(res, 200, { ok: true });
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
