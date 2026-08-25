#!/usr/bin/env node
// install-mcp.mjs — registers the orchestra MCP server into the user's global
// opencode config (~/.config/opencode/opencode.jsonc), preserving existing
// settings. JSONC-aware: strips comments/trailing commas for parsing and
// keeps a timestamped backup before rewriting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JS = path.join(ROOT, 'mcp', 'server.js');

const cfgDir = path.join(os.homedir(), '.config', 'opencode');
let cfgFile = null;
for (const cand of ['opencode.jsonc', 'opencode.json']) {
  const p = path.join(cfgDir, cand);
  if (fs.existsSync(p)) { cfgFile = p; break; }
}
fs.mkdirSync(cfgDir, { recursive: true });

function stripJsonc(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

let cfg = {};
if (!cfgFile) {
  cfgFile = path.join(cfgDir, 'opencode.jsonc');
} else {
  const raw = fs.readFileSync(cfgFile, 'utf8');
  const backup = cfgFile + '.bak-' + Date.now();
  fs.copyFileSync(cfgFile, backup);
  console.log(`backup saved → ${backup}`);
  try {
    cfg = JSON.parse(stripJsonc(raw));
  } catch (e) {
    console.error(`could not parse ${cfgFile}: ${e.message}`);
    console.error('\nAdd this block manually inside the top-level object:\n');
    console.error(JSON.stringify({ mcp: mcpBlock() }, null, 2));
    process.exit(1);
  }
}

cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
cfg.mcp = cfg.mcp || {};
cfg.mcp.orchestra = mcpBlock();

fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`orchestra MCP registered → ${cfgFile}`);
console.log(`server entry: node "${SERVER_JS}"`);
console.log('\nverify with:  opencode mcp list   (should show orchestra ✓)');
console.log('then any opencode session can call tools like ochre_board, ochre_send, ochre_spawn.');

function mcpBlock() {
  return {
    type: 'local',
    command: ['node', SERVER_JS],
    enabled: true,
    environment: {
      OCHRE_URL: 'ws://127.0.0.1:8787/bus',
      OCHRE_AGENT_NAME: 'OPENCODE-AGENT',
    },
  };
}
