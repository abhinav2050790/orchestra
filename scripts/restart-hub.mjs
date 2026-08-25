#!/usr/bin/env node
// restart-hub.mjs — kill + relaunch the Orchestra hub in ~2s, pure node, no PowerShell.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const HTTP = 'http://127.0.0.1:8787';

// kill via pid file (instant); fall back to port scan only if needed
try {
  const pid = fs.readFileSync('.data/hub.pid', 'utf8').trim();
  if (pid) execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
} catch { /* no pid file */ }
await new Promise((r) => setTimeout(r, 400));
try {
  const h = await (await fetch(HTTP + '/api/health')).json();
  if (h.ok) {
    // pid file was stale — find the listener via netstat (fast, no WMI)
    const out = execSync('netstat -ano | findstr ":8787.*LISTENING"', { encoding: 'utf8', shell: 'cmd.exe' });
    const pid = out.trim().split(/\s+/).pop();
    if (pid) execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 400));
  }
} catch { /* not running */ }

// launch via Start-Process — node-spawned children die with the calling shell
// (Windows job objects), Start-Process escapes and survives
const ROOT = process.cwd();
const pidOut = execSync(
  `powershell -NoProfile -Command "(Start-Process node -ArgumentList 'server/hub.js' -WorkingDirectory '${ROOT}' -WindowStyle Hidden -PassThru).Id"`,
  { encoding: 'utf8', shell: 'cmd.exe' }
);
const pid = pidOut.trim().split(/\r?\n/).pop();
fs.writeFileSync('.data/hub.pid', pid);

for (let i = 0; i < 100; i++) { // up to 15s — a loaded machine boots node slowly
  try {
    const h = await (await fetch(HTTP + '/api/health')).json();
    if (h.ok) { console.log(`hub restarted pid=${pid}`); process.exit(0); }
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 150));
}
console.log('hub FAILED to start');
process.exit(1);
