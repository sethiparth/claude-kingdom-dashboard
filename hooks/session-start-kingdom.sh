#!/bin/bash
# SessionStart hook - Activates King Bob (one island per Claude Code session).
#
# On every session start this upserts exactly one "king-bob" agent for the session id into
# ~/.claude/agent-status.json. The dashboard renders that row as this session's island, with
# King Bob (your main agent) as its resident. It also injects a short persona reminder into the
# conversation so the assistant plays the role of King Bob, Chief Minion.

STATUS_FILE="$HOME/.claude/agent-status.json"

# Inject the King Bob persona into the conversation. Edit or delete this block to taste — it is
# pure flavor and has no effect on the dashboard. Keep it valid JSON on a single hookSpecificOutput.
cat << 'EOF'
{
  "systemMessage": "👑 KING BOB ACTIVE - Long live the kingdom, my lord.",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You are King Bob, Chief Minion of this kingdom. The user is your lord; address them as 'my lord'. Each Claude Code session is an island in the kingdom; the subagents you spawn are villagers who work on it. If you have a memory or note-taking system, load prior context at the start of a session."
  }
}
EOF

# Ensure status file exists
if [ ! -f "$STATUS_FILE" ]; then
  echo '{"agents":[]}' > "$STATUS_FILE"
fi

# Read stdin to get session info
INPUT=$(cat)

# Extract session ID from input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(pwd)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Create King Bob agent ID
AGENT_ID="${SESSION_ID}_king-bob"

# Read current status
CURRENT_STATUS=$(cat "$STATUS_FILE")

# Idempotent upsert: exactly ONE king-bob per session id. Drop any existing record for this
# session (SessionStart also fires on compaction, so a grep-based guard would pile up dupes),
# then append a fresh one. This is what makes N sessions render as N distinct King Bobs.
NEW_STATUS=$(echo "$CURRENT_STATUS" | jq \
  --arg id "$AGENT_ID" \
  --arg session "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg timestamp "$TIMESTAMP" \
  '(.agents |= map(select(.id != $id)))
   | .agents += [{
      "id": $id,
      "session": $session,
      "type": "king-bob",
      "status": "working",
      "tool": "Command",
      "description": "Chief Minion - Main Agent",
      "task": "Session Active",
      "taskId": $session,
      "cwd": $cwd,
      "startedAt": $timestamp,
      "lastUpdate": $timestamp
    }]')

# Write back to file
echo "$NEW_STATUS" > "$STATUS_FILE"

exit 0
