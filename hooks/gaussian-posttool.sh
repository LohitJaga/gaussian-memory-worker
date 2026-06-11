#!/bin/bash
# PostToolUse hook — semantic diff storage via memory_store_diff
# Set GAUSSIAN_WORKER_URL and GAUSSIAN_AUTH_TOKEN in your environment before use.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

WORKER="${GAUSSIAN_WORKER_URL}"
[ -z "$WORKER" ] && exit 0

# Detect project from git root basename. No xargs — it word-splits paths
# containing spaces (S11-class bug, same fix as gaussian-store.sh/-retrieve.sh).
GIT_ROOT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_ROOT" ]; then
  PROJECT=$(basename "$GIT_ROOT" | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
else
  PROJECT="default"
fi

store_diff() {
  local payload="$1"
  curl -sf --max-time 4 -X POST "$WORKER" \
    -H 'Content-Type: application/json' \
    ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
    -d "$payload" \
    > /dev/null 2>&1 &
}

case "$TOOL_NAME" in

  Edit)
    # Edit decisions captured more accurately by Stop hook session extraction.
    # Skipping here avoids double-storing low-quality diff fragments.
    exit 0
    ;;

  Write)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // ""' | head -6 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-200)
    [ -z "$FILE_PATH" ] && exit 0
    PAYLOAD=$(jq -n \
      --arg fp "$FILE_PATH" \
      --arg new "$CONTENT" \
      --arg p "$PROJECT" \
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_store_diff","arguments":{"file_path":$fp,"old_string":"","new_string":$new,"project":$p}}}')
    store_diff "$PAYLOAD"
    ;;

  Bash)
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
    echo "$CMD" | grep -qE '^\s*(ls|cat|head|tail|echo|pwd|cd|grep|find|sort|cut|wc|sed|awk|jq|which|type|diff|less|more|man|open|pbcopy|pbpaste)' && exit 0
    echo "$CMD" | grep -qE 'memory_retrieve|memory_list|memory_stats|memory_decay|gaussian-memory' && exit 0
    echo "$CMD" | grep -qE '^\s*(git add|git commit|git status|git diff|git log|git push|git pull|git checkout|git stash|npm install|pip install|mkdir|touch|chmod|rm |mv |cp )' && exit 0
    echo "$CMD" | grep -qE '^\s*(sleep|wait|true|false|exit)' && exit 0
    echo "$CMD" | grep -qE 'wrangler deploy|npx wrangler' && exit 0
    # tool_response for Bash is an object ({stdout, stderr, ...}), not a string —
    # extracting it raw stored pretty-printed JSON braces instead of the output.
    OUTPUT=$(echo "$INPUT" | jq -r 'if (.tool_response|type) == "object" then (.tool_response.stdout // "") else (.tool_response // "") end' | head -5 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-200)
    CMD_SHORT=$(echo "$CMD" | head -2 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-200)
    [ ${#OUTPUT} -lt 15 ] && exit 0
    PAYLOAD=$(jq -n \
      --arg cmd "$CMD_SHORT" \
      --arg out "$OUTPUT" \
      --arg p "$PROJECT" \
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_store_diff","arguments":{"command":$cmd,"output":$out,"project":$p}}}')
    store_diff "$PAYLOAD"
    ;;

  *)
    exit 0
    ;;
esac

exit 0
