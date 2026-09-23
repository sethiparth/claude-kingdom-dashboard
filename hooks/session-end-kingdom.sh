#!/bin/bash
# SessionEnd hook - Retires King Bob and clears this session's island from agent-status.json.
#
# Counterpart to session-start-kingdom.sh: that hook upserts one king-bob per session on start;
# this one removes the whole island (the king-bob row PLUS any worker rows for the same session)
# when the session ends, so closed terminals don't linger as phantom islands for 24h.

STATUS_FILE="$HOME/.claude/agent-status.json"

# Nothing to clean if the file doesn't exist yet.
[ -f "$STATUS_FILE" ] || exit 0

# Read stdin to get session info
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# Bail out on a missing/unknown session id rather than nuking unrelated rows.
[ "$SESSION_ID" = "unknown" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0

CURRENT_STATUS=$(cat "$STATUS_FILE")

# Drop every agent belonging to this session (king-bob + workers).
NEW_STATUS=$(echo "$CURRENT_STATUS" | jq \
  --arg session "$SESSION_ID" \
  '.agents |= map(select(.session != $session))')

# Only overwrite if jq produced valid output (guard against a transient read/parse race).
if [ -n "$NEW_STATUS" ]; then
  echo "$NEW_STATUS" > "$STATUS_FILE"
fi

exit 0
