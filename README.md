# 👑 Kingdom Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Phaser](https://img.shields.io/badge/phaser-3.90-orange.svg)](https://phaser.io)

A real-time, top-down **island kingdom** that visualizes your live Claude Code sessions. Every
session is an island; the main agent is **King Bob**, and the subagents he spawns are villagers who
appear, work, and leave. It runs entirely on your machine off a single status file that Claude Code
hooks keep up to date — no accounts, no network calls, nothing leaves your laptop.

## The kingdom

- **King Bob** — the persona of the main agent in each session ("Chief Minion"). He resides on his
  island and calls you *"my lord."*
- **Islands** — one per live Claude Code session. Start a session and an island rises from the sea;
  end it and the island sinks.
- **Villagers** — the subagents (`Task`/`Agent`) King Bob spawns. They animate with the tool
  they're currently running and depart when the task completes.

Sessions are laid out as a scattered archipelago with autotiled sand/grass coastlines, curved cobble
roads linking the workspace houses, and wooden bridges between neighbouring islands.

## How it works

```
Claude Code hook fires (session start/end, agent start/stop, any tool use)
        │
        ▼
hook rewrites  ~/.claude/agent-status.json   ({ "agents": [ ... ] })
        │
        ▼
Express (server/index.js) serves it at  GET /api/status
        │
        ▼
browser polls every 1s → Phaser adds / animates / removes islanders
```

Simple polling — no websockets, no file watchers, no race conditions. You can inspect
`~/.claude/agent-status.json` directly at any time.

## Prerequisites

- Node.js ≥ 18
- [Claude Code](https://claude.ai/code) installed
- `jq` (used by the hooks and installer) — `brew install jq` / `apt-get install jq`
- macOS or Linux (Windows untested)

## Quick start

```bash
git clone <your-fork-url> claude-kingdom-dashboard
cd claude-kingdom-dashboard

./setup.sh          # installs hooks + King Bob into ~/.claude, merges settings.json (backup made)
npm install
npm run dev         # server on :3001, Vite dev server on :5173
```

Then **start (or restart) a Claude Code session** so the hooks load. King Bob appears on a fresh
island within ~1 second; spawn a subagent and a villager joins him.

Production-style run:

```bash
npm run build       # always from the repo root, not client/
npm run server      # http://localhost:3001
```

> Setting up with Claude? Point it at [`CLAUDE.md`](./CLAUDE.md) — it's a step-by-step setup guide
> written for the assistant.

## What `setup.sh` does

1. Copies the hooks in [`hooks/`](./hooks) into `~/.claude/hooks/` and marks them executable.
2. Copies [`assets/king-bob.png`](./assets) into `~/.claude/minion-emojis/`.
3. Merges the hook wiring into `~/.claude/settings.json`, after saving a timestamped `.bak`.

It is **idempotent** (safe to re-run) and **non-destructive** — it never removes hooks you already
have. The hooks it installs:

| Event | Matcher | Hook | Effect |
|-------|---------|------|--------|
| SessionStart | `""` | `session-start-kingdom.sh` | raises King Bob's island + sets the persona |
| SessionEnd | — | `session-end-kingdom.sh` | sinks the island |
| PreToolUse | `Agent`, `Task` | `agent-start.sh` | a villager arrives |
| PreToolUse | `.*` | `update-agent-tool.sh` | heartbeat + current-tool animation |
| PostToolUse | `Agent`, `Task` | `agent-complete.sh` | a villager departs |

## Configuration

Copy `.env.example` to `.env` to override defaults:

- `PORT` (default `3001`)
- `AGENT_STATUS_FILE` (default `~/.claude/agent-status.json`)
- `CORS_ORIGIN` (default `*`)

## Customizing

- **Persona** — edit the `additionalContext` string in `hooks/session-start-kingdom.sh`, then
  re-run `./setup.sh`. Change the name, the honorific, or remove it entirely.
- **King Bob's face** — swap `assets/king-bob.png` and re-run `./setup.sh`.
- **Look & feel** — rendering is in `client/phaser/`; palette and fonts in `client/index.html`.

## Project structure

```
claude-kingdom-dashboard/
├── CLAUDE.md               # setup guide for the assistant
├── setup.sh                # installs hooks + King Bob, merges settings.json
├── hooks/                  # the Claude Code hooks that drive the dashboard
├── assets/king-bob.png     # King Bob's portrait
├── server/index.js         # Express: serves the build + GET /api/status
├── client/
│   ├── index.html
│   ├── main.js
│   └── phaser/             # scenes, entities, managers, island tile generator
├── public/                 # generated terrain tiles, sprites, building art
├── scripts/generate-tiles.mjs
└── vite.config.js
```

## Troubleshooting

- **No islands** — check `~/.claude/agent-status.json` exists and grows as you use tools, that the
  hooks in `~/.claude/hooks/` are executable, and that you started a *new* session after setup. See
  `~/.claude/hooks/debug.log`.
- **Port in use** — `lsof -ti:3001 | xargs kill`, or set `PORT` in `.env`.
- **Build errors** — `rm -rf node_modules package-lock.json && npm install`; ensure Node ≥ 18.

## License

MIT — see [LICENSE](LICENSE).
