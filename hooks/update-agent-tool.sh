#!/bin/bash
# PreToolUse (all tools) hook - best-effort update of each session agent's current tool.
# Best-effort by design: if the lock is busy we skip silently (the next tool call updates it).
# Never blocks the tool call for more than ~250ms.

STATUS_FILE="$HOME/.claude/agent-status.json"
LOCK_FILE="$HOME/.claude/agent-status.lock"

# Stale-lock recovery: a lock dir older than 3s means a previous holder died. Reclaim it.
if [ -d "$LOCK_FILE" ]; then
  NOW=$(date +%s)
  LOCK_MTIME=$(stat -f %m "$LOCK_FILE" 2>/dev/null || echo "$NOW")
  if [ $((NOW - LOCK_MTIME)) -ge 3 ]; then
    rmdir "$LOCK_FILE" 2>/dev/null
  fi
fi

# Try to acquire the lock quickly (5 x 50ms). If busy, skip — this update is best-effort.
LOCK_RETRIES=0
while ! mkdir "$LOCK_FILE" 2>/dev/null; do
  LOCK_RETRIES=$((LOCK_RETRIES + 1))
  [ $LOCK_RETRIES -gt 5 ] && exit 0
  sleep 0.05
done
trap "rmdir '$LOCK_FILE' 2>/dev/null" EXIT

INPUT=$(cat)

[ -f "$STATUS_FILE" ] || { echo '{"agents":[]}' > "$STATUS_FILE"; exit 0; }

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
# Subagent tool calls arrive under the PARENT session_id but carry an extra .agent_id; a call made
# directly by the parent (King Bob) has none. This lets us heartbeat the right rows:
#   parent call  -> refresh only the king-bob row (King Bob's own liveness / working animation)
#   subagent call-> refresh the worker rows (so a FINISHED worker stops being kept alive by the
#                   parent's activity and ages out via the TTL janitor once its own calls stop).
CALLER_AGENT=$(echo "$INPUT" | jq -r '.agent_id // ""')
# A subagent's own calls carry agent_type == the spawn name; use it to match/recreate its worker row.
CALLER_NAME=$(echo "$INPUT" | jq -r '.agent_type // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

[ "$SESSION_ID" = "unknown" ] && exit 0

# Atomic read-modify-write in one jq pass:
#   1. Heartbeat: refresh tool + lastUpdate for every agent in THIS session (this is what keeps
#      background workers alive — their rows share the parent session id, so any parent tool call
#      re-stamps them as long as the session is active).
#   2. TTL janitor: drop any worker (non king-bob) whose lastUpdate is older than TTL. A background
#      agent that has actually FINISHED stops being heartbeated, so it ages out here within TTL.
#      King-bob rows are exempt — an island lives until its session's SessionEnd hook removes it.
NEW_STATUS=$(jq \
  --arg session "$SESSION_ID" \
  --arg tool "$TOOL_NAME" \
  --arg timestamp "$TIMESTAMP" \
  --arg ttl "300" \
  --arg caller "$CALLER_AGENT" \
  --arg callername "$CALLER_NAME" \
  --arg cwd "$CWD" \
  '(now) as $now
   # Self-heal (King Bob): if this active session has no row at all (started before the kingdom
   # hooks existed, or its island was purged), (re)create its King Bob so the island reappears.
   # SessionEnd cleanup removes it again when the session closes, so idle sessions still age out.
   | (if ([.agents[] | select(.session == $session)] | length) == 0
        then .agents += [{
          "id": ($session + "_king-bob"),
          "session": $session,
          "type": "king-bob",
          "status": "working",
          "tool": $tool,
          "description": "Chief Minion - Main Agent",
          "task": "Session",
          "taskId": $session,
          "cwd": $cwd,
          "startedAt": $timestamp,
          "lastUpdate": $timestamp
        }]
        else . end)
   # Self-heal (worker): a subagent tool call (has agent_id) whose spawn row is missing — e.g. it
   # was resumed via SendMessage, or its row was lost — gets a worker row recreated from its name,
   # so an actively-working agent is never invisible on the dashboard.
   | (if ($caller != ""
          and ([.agents[] | select(.session == $session and ((.name == $callername) or (.id == $caller)))] | length) == 0)
        then .agents += [{
          "id": $caller,
          "session": $session,
          "type": (if $callername == "" then "general-purpose" else $callername end),
          "status": "working",
          "tool": $tool,
          "description": (if $callername == "" then "Working" else $callername end),
          "task": $callername,
          "taskId": ($session + "_" + $callername),
          "name": $callername,
          "startedAt": $timestamp,
          "lastUpdate": $timestamp
        }]
        else . end)
   # Heartbeat: a parent call (no agent_id) refreshes only King Bob; a subagent call refreshes just
   # its own worker row (matched by name or id), so each worker ages out independently when it stops.
   | .agents = [.agents[]
       | if (.session == $session
             and (((.type == "king-bob") and ($caller == ""))
                  or ((.type != "king-bob") and ($caller != "") and ((.name == $callername) or (.id == $caller)))))
         then .tool = $tool | .lastUpdate = $timestamp
         else . end]
   | .agents = [.agents[]
       | select(
           (.type == "king-bob")
           or ((try (.lastUpdate | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601) catch 0) > ($now - ($ttl | tonumber)))
         )]' \
  "$STATUS_FILE" 2>/dev/null) || exit 0

# Write atomically so the dashboard never reads a half-written file.
printf '%s' "$NEW_STATUS" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"

exit 0
