#!/bin/bash
# Called by Stop hook — extracts facts from this session and stores them in Gaussian memory
# Also pushes CLAUDE.md to KV for cross-device sync
SESSION_ID=$(jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

WORKER="${GAUSSIAN_WORKER_URL:-https://gaussian-memory.lohit-cloudflare-pm-assesment.workers.dev}"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# Detect project from git root basename, normalized to lowercase-hyphenated
PROJECT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null | xargs basename 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
[ -z "$PROJECT" ] && PROJECT="default"

# Get full filtered log for this session
FULL_LOG=$(jq -r --arg sid "$SESSION_ID" \
  'select(.sessionId == $sid) | .display // ""' \
  ~/.claude/history.jsonl 2>/dev/null \
  | awk 'length > 25 && !/^\/Users/ && !/^\/home/ && !/https?:\/\// && !/\.(csv|jsonl|pdf|png|ts|py|sh|json)/ && !/^\{"text":/ && !/^\[.*\]$/ && !/^Extracted [0-9]/ && !/^SPAWNED:|^MERGED:|^ERROR:/' \
  | tr '\n' ' | ')

[ -z "$FULL_LOG" ] && exit 0

# GLM-4.7-flash has 131K context — pass full log up to 30K chars (covers even long sessions)
LOG=$(echo "$FULL_LOG" | cut -c1-30000)

[ -z "$LOG" ] && exit 0

# Store session memories
curl -sf -X POST "$WORKER" \
  -H 'Content-Type: application/json' \
  ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
  -d "$(jq -n --arg l "$LOG" --arg p "$PROJECT" \
    '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"memory_extract_and_store","arguments":{"log_text":$l,"project":$p}}}')" \
  > /dev/null 2>&1

# Sync CLAUDE.md to KV if it exists (cross-device bootstrap source)
if [ -s "$CLAUDE_MD" ]; then
  CONTENT=$(cat "$CLAUDE_MD")
  curl -sf -X POST "$WORKER" \
    -H 'Content-Type: application/json' \
    ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
    -d "$(jq -n --arg c "$CONTENT" \
      '{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"identity_profile_set","arguments":{"content":$c}}}')" \
    > /dev/null 2>&1
fi
