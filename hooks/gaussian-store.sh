#!/bin/bash
# Stop hook — extracts facts from session and stores in Gaussian Memory
# Also pushes CLAUDE.md to KV for cross-device sync.
# Set GAUSSIAN_WORKER_URL and GAUSSIAN_AUTH_TOKEN in your environment before use.

SESSION_ID=$(jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

WORKER="${GAUSSIAN_WORKER_URL}"
[ -z "$WORKER" ] && exit 0

CLAUDE_MD="$HOME/.claude/CLAUDE.md"

PROJECT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null | xargs basename 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
[ -z "$PROJECT" ] && PROJECT="default"

FULL_LOG=$(jq -r --arg sid "$SESSION_ID" \
  'select(.sessionId == $sid) | .display // ""' \
  ~/.claude/history.jsonl 2>/dev/null \
  | awk 'length > 25 && !/^\/Users/ && !/^\/home/ && !/https?:\/\// && !/\.(csv|jsonl|pdf|png|ts|py|sh|json)/ && !/^\{"text":/ && !/^\[.*\]$/ && !/^Extracted [0-9]/ && !/^SPAWNED:|^MERGED:|^ERROR:/' \
  | tr '\n' ' | ')

[ -z "$FULL_LOG" ] && exit 0

LOG=$(echo "$FULL_LOG" | cut -c1-30000)
[ -z "$LOG" ] && exit 0

curl -sf -X POST "$WORKER" \
  -H 'Content-Type: application/json' \
  ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
  -d "$(jq -n --arg l "$LOG" --arg p "$PROJECT" \
    '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"memory_extract_and_store","arguments":{"log_text":$l,"project":$p}}}')" \
  > /dev/null 2>&1

if [ -s "$CLAUDE_MD" ]; then
  CONTENT=$(cat "$CLAUDE_MD")
  curl -sf -X POST "$WORKER" \
    -H 'Content-Type: application/json' \
    ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
    -d "$(jq -n --arg c "$CONTENT" \
      '{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"identity_profile_set","arguments":{"content":$c}}}')" \
    > /dev/null 2>&1
fi
