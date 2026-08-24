# ⌬ OCHRESTRA

A native, synced orchestration environment for your machine: run **multiple opencode terminals working on different tasks at the same time**, all sharing **live realtime data** over one event bus — visualized as a living circuit board.

```
 ┌──────────────┐   copper    ┌──────────────┐
 │  opencode    │═════════════▶   opencode   │
 │  worker #1   │◀═══╮  ╔══════│   worker #2  │
 └──────────────┘    ║  ║      └──────────────┘
        ║            ║  ║               ║
        ▼            ▼  ▼               ▼
     ╔══════════════════════════════════╗
     ║   HUB  ·  ws://127.0.0.1:8787/bus ║   shared blackboard + history + roster
     ╚══════════════════════════════════╝
        ▲            ▲       ▲        ▲
   PCB dashboard   ochre CLI   MCP tools in   wired Windows
   (localhost UI)  (any shell) every agent   terminals
```

## Quickstart

```powershell
cd D:\ochrestra
.\Start-Ochrestra.ps1              # hub + dashboard in browser
.\Start-Ochrestra.ps1 -Demo        # + 5 synthetic agents (no LLM cost)
.\Start-Ochrestra.ps1 -Workers 3   # + spawn 3 real opencode workers with a task
.\Start-Ochrestra.ps1 -Terminals 2 # + open 2 wired opencode terminal tabs
.\Start-Ochrestra.ps1 -InstallMcp  # register bus tools into every opencode session
```

Stop everything: `.\Stop-Ochrestra.ps1`

## The four integration surfaces

| Surface | What it does |
|---|---|
| **PCB Dashboard** (`http://127.0.0.1:8787`) | Live board: chips = agents, glowing packets = realtime events, LED status, feed/state/tasks/roster panels. `S` spawn worker · `T` open terminal · `H` help. |
| **ochre CLI** (`node cli/ochre.js`) | `ps` · `tail` · `send "…" --to X` · `state set/get/list` · `spawn "<task>" --count N` · `pipe -- anycommand` (wire ANY command's output onto the bus). |
| **MCP server** (`mcp/server.js`) | After `-InstallMcp`, *every* opencode session gets native tools: `ochre_board`, `ochre_send`, `ochre_state_set/get`, `ochre_spawn`, `ochre_history`. Agents coordinate without being told how. |
| **Wired terminals** | `+ TERMINAL` button opens real Windows Terminal tabs running opencode with `OCHRE_*` env pre-set and the MCP attached. |

## How sync works

- Every participant connects to `ws://127.0.0.1:8787/bus`, identifies via `hello`, then streams events (`log`, `status`, `task`, `msg`, `set/del`).
- **Shared blackboard**: last-write-wins key/value store with revision counters — visible instantly to all agents and the dashboard. Persisted to `.data/state.json`.
- **History**: ring buffer (3000 events) persisted as NDJSON, replayed on reconnect/boot so nobody starts blind.
- **Presence**: heartbeats + stale reaping; identity survives refreshes.
- Spawned workers are headless `opencode run "<prompt>"` whose stdout/stderr is streamed onto the bus line-by-line.

## Performance notes

- Server coalesces outbound WS frames on a single 16 ms tick (one frame per client per tick under load).
- Dashboard uses a two-canvas split: static substrate/traces redraw only on topology change; dynamic layer is a single rAF loop with pooled particles and hard caps (520 packets) + load shedding on fan-out.
- ANSI stripping happens once, server-side. Ring buffers bound memory. Localhost-only bind by default.

## Config

`ochestra.config.json` — port, host, history limit, max workers, and the worker command template:

```json
{ "workerCommand": ["opencode", "run", "{prompt}"] }
```

Add `"--model", "{model}"` handling automatically when spawning with a model, or edit the template freely.

## Files

```
server/hub.js        WS+REST hub, spawner, persistence
server/store.js      state store + event log (NDJSON)
cli/ochre.js         human/terminal client
mcp/server.js        stdio MCP bridge for opencode agents
public/              PCB dashboard (zero framework, zero build)
scripts/             demo traffic generator, MCP installer
.data/               runtime state (auto-created)
```
