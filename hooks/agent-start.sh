#!/bin/bash
# PreToolUse Agent/Task hook - Writes agent start to agent-status.json

STATUS_FILE="$HOME/.claude/agent-status.json"
DEBUG_LOG="$HOME/.claude/hooks/debug.log"

# Read input from stdin
INPUT=$(cat)

# Ensure status file exists
if [ ! -f "$STATUS_FILE" ]; then
  echo '{"agents":[]}' > "$STATUS_FILE"
fi

# Extract data from stdin JSON
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "Agent"')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Get agent type and description from tool_input
AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general-purpose"')
DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // .tool_input.prompt // "Working"' | head -c 200)
# The spawn NAME is how a subagent's own later tool calls identify themselves (they arrive with
# agent_type == this name), so store it to let update-agent-tool.sh match heartbeats to this row.
AGENT_NAME=$(echo "$INPUT" | jq -r '.tool_input.name // ""')

# Skip if this isn't an Agent or Task tool
if [ "$TOOL_NAME" != "Agent" ] && [ "$TOOL_NAME" != "Task" ]; then
  exit 0
fi

echo "[$(date)] agent-start.sh: Adding agent $AGENT_TYPE (ID: $TOOL_USE_ID)" >> "$DEBUG_LOG"

# Extract task info
TASK_NAME=$(echo "$DESCRIPTION" | cut -c1-30)
TASK_NAME_SANITIZED=$(echo "$TASK_NAME" | sed 's/[^a-zA-Z0-9 ]//g' | sed 's/ /_/g')
TASK_ID="${SESSION_ID}_${TASK_NAME_SANITIZED}"

# Create agent ID
AGENT_ID="${TOOL_USE_ID}"

# Read current status
CURRENT_STATUS=$(cat "$STATUS_FILE")

# Check if agent already exists
if echo "$CURRENT_STATUS" | grep -q "\"id\":\"$AGENT_ID\""; then
  # Agent already exists, update it
  NEW_STATUS=$(echo "$CURRENT_STATUS" | jq \
    --arg id "$AGENT_ID" \
    --arg status "working" \
    --arg tool "Starting" \
    --arg timestamp "$TIMESTAMP" \
    --arg task "$TASK_NAME" \
    --arg taskId "$TASK_ID" \
    '.agents = [.agents[] | if .id == $id then .status = $status | .tool = $tool | .lastUpdate = $timestamp | .task = $task | .taskId = $taskId else . end]')
else
  # Add new agent
  NEW_STATUS=$(echo "$CURRENT_STATUS" | jq \
    --arg id "$AGENT_ID" \
    --arg session "$SESSION_ID" \
    --arg type "$AGENT_TYPE" \
    --arg status "working" \
    --arg tool "Starting" \
    --arg description "$DESCRIPTION" \
    --arg task "$TASK_NAME" \
    --arg taskId "$TASK_ID" \
    --arg name "$AGENT_NAME" \
    --arg started "$TIMESTAMP" \
    --arg updated "$TIMESTAMP" \
    '.agents += [{
      "id": $id,
      "session": $session,
      "type": $type,
      "status": $status,
      "tool": $tool,
      "description": $description,
      "task": $task,
      "taskId": $taskId,
      "name": $name,
      "startedAt": $started,
      "lastUpdate": $updated
    }]')
fi

# Write back to file
echo "$NEW_STATUS" > "$STATUS_FILE"

echo "  Agent added successfully. Total agents: $(echo "$NEW_STATUS" | jq '.agents | length')" >> "$DEBUG_LOG"

exit 0
