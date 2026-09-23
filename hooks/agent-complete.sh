#!/bin/bash
# PostToolUse Agent/Task hook - Removes an agent from agent-status.json ON REAL COMPLETION.
#
# IMPORTANT nuance for BACKGROUND (async) agents:
#   When an Agent/Task is launched in the background, the tool call RETURNS IMMEDIATELY with a
#   "launched successfully / working in the background / agentId" acknowledgement — so PostToolUse
#   fires ~2s after spawn even though the agent keeps running for minutes. Deleting the row here
#   would make background agents flash in and vanish. So: if tool_response looks like a background
#   launch, we KEEP the row (the agent is still alive). It is cleaned up later by the TTL janitor in
#   update-agent-tool.sh once its heartbeat goes stale, or by the SessionEnd cleanup.
#   For FOREGROUND agents, tool_response is the agent's real result → remove immediately as before.

STATUS_FILE="$HOME/.claude/agent-status.json"
DEBUG_LOG="$HOME/.claude/hooks/debug.log"

INPUT=$(cat)

if [ ! -f "$STATUS_FILE" ]; then
  echo '{"agents":[]}' > "$STATUS_FILE"
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "Agent"')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // "unknown"')

# Only handle Agent/Task tools.
if [ "$TOOL_NAME" != "Agent" ] && [ "$TOOL_NAME" != "Task" ]; then
  exit 0
fi

# A background/async Agent spawn returns a structured acknowledgement, NOT the agent's real result:
#   {"status":"teammate_spawned","agent_id":"...","teammate_id":"...", ...}
# In that case the agent is STILL RUNNING, so PostToolUse fired ~3s after spawn (not at completion).
# We must NOT remove the row — it is cleaned up later by the TTL janitor in update-agent-tool.sh
# once its heartbeat goes stale, or by the SessionEnd cleanup. A FOREGROUND (synchronous) agent's
# tool_response is its actual result (no such status), so it is removed immediately as before.
STATUS=$(echo "$INPUT" | jq -r '.tool_response.status // ""' 2>/dev/null)
RESP=$(echo "$INPUT" | jq -r '.tool_response | tostring' 2>/dev/null)

case "$STATUS" in
  *spawned*)
    echo "[$(date)] agent-complete.sh: background launch ($STATUS) for $TOOL_USE_ID — keeping row (still running)" >> "$DEBUG_LOG"
    exit 0
    ;;
esac
# Fallback for any harness wording that doesn't set a structured status field.
if echo "$RESP" | grep -qiE "teammate_spawned|working in the background|is now running"; then
  echo "[$(date)] agent-complete.sh: background launch (text-matched) for $TOOL_USE_ID — keeping row" >> "$DEBUG_LOG"
  exit 0
fi

echo "[$(date)] agent-complete.sh: foreground completion — removing agent (ID: $TOOL_USE_ID)" >> "$DEBUG_LOG"

CURRENT_STATUS=$(cat "$STATUS_FILE")
NEW_STATUS=$(echo "$CURRENT_STATUS" | jq \
  --arg id "$TOOL_USE_ID" \
  '.agents = [.agents[] | select(.id != $id)]')

echo "$NEW_STATUS" > "$STATUS_FILE"

echo "  Agent removed. Total agents: $(echo "$NEW_STATUS" | jq '.agents | length')" >> "$DEBUG_LOG"

exit 0
