#!/bin/bash
#
# Kingdom Dashboard — one-shot setup for the Claude Code side.
#
# This wires your Claude Code install into the dashboard:
#   1. Installs the kingdom hooks into ~/.claude/hooks/
#   2. Installs King Bob's portrait into ~/.claude/minion-emojis/
#   3. Merges the hook wiring into ~/.claude/settings.json (a timestamped backup is made first)
#
# It is idempotent — safe to run more than once. It never touches your existing non-kingdom hooks.
# It does NOT install npm deps or start the server; see the README for that (`npm install && npm run dev`).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "👑 Setting up the Kingdom..."

# --- Preconditions -----------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "❌ 'jq' is required (the hooks and this installer use it). Install it and re-run:"
  echo "     macOS:  brew install jq"
  echo "     Debian: sudo apt-get install jq"
  exit 1
fi

# --- 1. Install hooks --------------------------------------------------------
mkdir -p "$HOOKS_DIR"
for h in agent-start.sh agent-complete.sh update-agent-tool.sh \
         session-start-kingdom.sh session-end-kingdom.sh; do
  cp "$REPO_DIR/hooks/$h" "$HOOKS_DIR/$h"
  chmod +x "$HOOKS_DIR/$h"
done
echo "✅ Installed hooks into $HOOKS_DIR"

# --- 2. Install King Bob's portrait -----------------------------------------
mkdir -p "$CLAUDE_DIR/minion-emojis"
cp "$REPO_DIR/assets/king-bob.png" "$CLAUDE_DIR/minion-emojis/king-bob.png"
echo "✅ Installed King Bob portrait into $CLAUDE_DIR/minion-emojis/"

# --- 3. Merge hook wiring into settings.json ---------------------------------
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

BACKUP="$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
cp "$SETTINGS" "$BACKUP"

# strip: within an array of hook-groups, drop only OUR kingdom commands (leaving any co-located
# third-party commands intact), then drop groups left empty. This keeps the merge idempotent and
# non-destructive to hooks you already have.
MERGED=$(jq --arg h "$HOOKS_DIR" '
  def strip:
    (. // [])
    | map(.hooks |= map(select(.command
        | test("agent-start.sh|agent-complete.sh|update-agent-tool.sh|session-start-kingdom.sh|session-end-kingdom.sh")
        | not)))
    | map(select((.hooks | length) > 0));
  .hooks = (.hooks // {})
  | .hooks.PreToolUse = ((.hooks.PreToolUse | strip) + [
      {matcher:"Agent", hooks:[{type:"command", command:($h+"/agent-start.sh")}]},
      {matcher:"Task",  hooks:[{type:"command", command:($h+"/agent-start.sh")}]},
      {matcher:".*",    hooks:[{type:"command", command:($h+"/update-agent-tool.sh")}]}
    ])
  | .hooks.PostToolUse = ((.hooks.PostToolUse | strip) + [
      {matcher:"Task",  hooks:[{type:"command", command:($h+"/agent-complete.sh")}]},
      {matcher:"Agent", hooks:[{type:"command", command:($h+"/agent-complete.sh")}]}
    ])
  | .hooks.SessionStart = ((.hooks.SessionStart | strip) + [
      {matcher:"", hooks:[{type:"command", command:($h+"/session-start-kingdom.sh")}]}
    ])
  | .hooks.SessionEnd = ((.hooks.SessionEnd | strip) + [
      {hooks:[{type:"command", command:($h+"/session-end-kingdom.sh")}]}
    ])
' "$SETTINGS")

printf '%s\n' "$MERGED" > "$SETTINGS"
echo "✅ Merged hook wiring into $SETTINGS (backup: $BACKUP)"

echo ""
echo "🌳 Kingdom hooks are installed. Next:"
echo "     npm install"
echo "     npm run dev        # dashboard at http://localhost:3001"
echo ""
echo "   Start (or restart) a Claude Code session so the hooks load, then watch King Bob appear."
