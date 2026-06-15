#!/bin/bash
# Cursor sessionEnd hook — extract facts from session and store in Gaussian Memory
HOOK_INPUT=$(cat)
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // .conversation_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

# Cursor spawns hooks in a non-login shell that does not source the user's profile,
# so GAUSSIAN_WORKER_URL/GAUSSIAN_AUTH_TOKEN must be loaded explicitly here.
[ -f "$HOME/.gaussian-memory-env" ] && source "$HOME/.gaussian-memory-env"

WORKER="${GAUSSIAN_WORKER_URL}"
[ -z "$WORKER" ] && exit 0

STATE_DIR="$HOME/.cursor/gaussian-state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

LOCK_DIR="$STATE_DIR/lock_${SESSION_ID}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if find "$LOCK_DIR" -maxdepth 0 -mmin +2 2>/dev/null | grep -q .; then
    rmdir "$LOCK_DIR" 2>/dev/null
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

GIT_ROOT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_ROOT" ]; then
  PROJECT=$(basename "$GIT_ROOT" | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
else
  PROJECT="default"
fi

TRANSCRIPT_FILE=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
[ -z "$TRANSCRIPT_FILE" ] && exit 0
[ ! -f "$TRANSCRIPT_FILE" ] && exit 0

OFFSET_FILE="$STATE_DIR/offset_${SESSION_ID}"
FILE_SIZE=$(stat -f%z "$TRANSCRIPT_FILE" 2>/dev/null || stat -c%s "$TRANSCRIPT_FILE" 2>/dev/null || echo "0")
LAST_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo "0")
case "$LAST_OFFSET" in *[!0-9]*|'') LAST_OFFSET=0 ;; esac
[ "$LAST_OFFSET" -gt "$FILE_SIZE" ] && LAST_OFFSET=0
if [ "$FILE_SIZE" -lt $(( LAST_OFFSET + 8000 )) ]; then exit 0; fi

# Cursor transcript format: role is top-level (not inside .message)
FULL_LOG=$(python3 - "$TRANSCRIPT_FILE" "$LAST_OFFSET" << 'PYEOF'
import json, sys, re

transcript_path = sys.argv[1]
offset = int(sys.argv[2])

lines = []
try:
    with open(transcript_path) as f:
        f.seek(offset)
        for line in f:
            if len(lines) >= 300:
                break
            try:
                e = json.loads(line)
                # Detects both Cursor format (role at top-level) and Claude Code format (role inside .message)
                role = e.get('role', '') or (e.get('message') or {}).get('role', '')
                msg = e.get('message') or {}
                content = msg.get('content', '')
                if isinstance(content, str) and len(content) > 25 and content != '[REDACTED]':
                    lines.append(f"[{'User' if role=='user' else 'Assistant'}]: {content[:300]}")
                elif isinstance(content, list):
                    for c in content:
                        try:
                            if not isinstance(c, dict) or c.get('type') != 'text':
                                continue
                            text = c.get('text', '').strip()
                            if len(text) < 25 or text == '[REDACTED]':
                                continue
                            if re.match(r'^(SPAWNED|MERGED|SKIP|ERROR|Extracted \d)', text):
                                continue
                            if text.startswith('```') and text.count('\n') > 3:
                                continue
                            if re.fullmatch(r'/(?:Users|home)/\S*', text):
                                continue
                            if re.fullmatch(r'\S+\.(csv|jsonl|pdf|png|ts|py|sh|json)', text):
                                continue
                            lines.append(f"[{'User' if role=='user' else 'Assistant'}]: {text[:400]}")
                        except Exception:
                            continue
            except Exception:
                continue
except Exception:
    pass

print(' | '.join(lines))
PYEOF
)

[ -z "$FULL_LOG" ] && exit 0

LOG_LEN=${#FULL_LOG}
if [ "$LOG_LEN" -lt 2000 ]; then exit 0; fi

LOG=$(printf '%s' "$FULL_LOG" | tail -c 30000)
[ -z "$LOG" ] && exit 0

if curl -sf --max-time 10 -X POST "$WORKER" \
  -H 'Content-Type: application/json' \
  ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
  -d "$(jq -n --arg l "$LOG" --arg p "$PROJECT" \
    '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"memory_extract_and_store","arguments":{"log_text":$l,"project":$p}}}')" \
  > /dev/null 2>&1; then
  echo "$FILE_SIZE" > "$OFFSET_FILE"
fi
