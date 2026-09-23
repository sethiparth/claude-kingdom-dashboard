# Kingdom Dashboard — Setup Guide for Claude

You are reading this because someone cloned the **Kingdom Dashboard** into their machine and wants
you to set it up. This file tells you what the kingdom is and exactly how to raise it. Follow it
top to bottom. Keep the user informed; ask before anything destructive.

## What this is

A real-time visualization of your Claude Code sessions as a top-down island kingdom (built with
[Phaser](https://phaser.io)). It reads a single status file that Claude Code hooks keep up to date,
so it works with sessions that are already running — no accounts, no telemetry, nothing leaves the
machine.

The metaphor:

- **The kingdom** — the whole world of islands, one per live Claude Code session.
- **King Bob** — the persona of the *main* agent in each session (i.e. you, in the top-level
  conversation). King Bob is "Chief Minion," resides on his island, and addresses the user as
  *"my lord."* Each session gets its own King Bob on its own island.
- **Villagers** — the subagents King Bob spawns (`Task`/`Agent` tool calls). They appear on the
  island and animate with whatever tool they're currently running, then leave when they finish.
- **Islands** — sessions. Start a session, an island rises; end it, the island sinks.

## How it works (the data seam)

```
Claude Code hook fires (session start/end, agent start/stop, any tool use)
        │
        ▼
hook script rewrites  ~/.claude/agent-status.json   ({ "agents": [ ... ] })
        │
        ▼
Express server (server/index.js) serves it at  GET /api/status
        │
        ▼
browser polls every 1s → Phaser adds / animates / removes islanders
```

King Bob's portrait is served from `~/.claude/minion-emojis/king-bob.png` via `/api/king-bob-image`.

## Setup steps

Run these in the repo root. Tell the user what each step does.

1. **Install the Claude-side wiring** (hooks + King Bob portrait + `settings.json` merge):

   ```bash
   ./setup.sh
   ```

   This is idempotent and makes a timestamped backup of `~/.claude/settings.json` before merging.
   It requires `jq` (`brew install jq` / `apt-get install jq`). It only adds the kingdom hooks; it
   leaves any existing hooks the user already has untouched.

2. **Install dependencies and run:**

   ```bash
   npm install
   npm run dev          # server on :3001, Vite dev server on :5173
   ```

   For a production-style run: `npm run build && npm run server`, then open http://localhost:3001.
   (Always build from the repo root, not from `client/`.)

3. **Load the hooks.** Hooks are read when a Claude Code session starts, so have the user start (or
   restart) a session after `./setup.sh`. King Bob should appear on a fresh island within ~1s. Spawn
   a subagent and a villager joins him.

## Optional: plugins that enrich the kingdom

The dashboard needs **none** of these — it runs on the hooks alone. But the King Bob experience is
nicer with a fuller Claude Code setup. These are all public/general-purpose; add via
`/plugin marketplace` in Claude Code, at the user's discretion:

- **everything-claude-code** — a broad agent/skill harness (many of the agent types the dashboard
  visualizes come from packs like this).
- **superpowers** — skill-driven workflows (brainstorming, systematic debugging, etc.).
- **playwright** / **context7** — browser automation and live library docs.

Do not assume any private or work-specific plugins; only suggest public ones.

## Customizing your kingdom

- **King Bob's persona** — edit the `additionalContext` block in `hooks/session-start-kingdom.sh`
  (then re-run `./setup.sh`). That single string is what makes the assistant play King Bob and
  address the user as "my lord." Change the name, the honorific, or delete it entirely.
- **King Bob's face** — replace `assets/king-bob.png` and re-run `./setup.sh`.
- **Look & feel** — island/agent rendering lives in `client/phaser/`; colors and fonts in
  `client/index.html`.

## Troubleshooting

- **No islands appear** — confirm `~/.claude/agent-status.json` exists and grows when you use tools
  (`cat` it), that the hooks are executable in `~/.claude/hooks/`, and that you started a *new*
  session after setup. Check `~/.claude/hooks/debug.log`.
- **Port 3001 busy** — `lsof -ti:3001 | xargs kill`, or set `PORT` in `.env`.
- **King Bob has no face** — make sure `assets/king-bob.png` was copied to
  `~/.claude/minion-emojis/king-bob.png` (re-run `./setup.sh`).
