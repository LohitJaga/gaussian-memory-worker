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

# Short-circuit: skip Python parse entirely if transcript hasn't grown enough
TRANSCRIPT_DIR="$HOME/.claude/projects/$(echo "$HOME" | sed 's|/|-|g')"
TRANSCRIPT_FILE="${TRANSCRIPT_DIR}/${SESSION_ID}.jsonl"
LOG_HASH_FILE="/tmp/gaussian_last_log_${SESSION_ID}"
FILE_SIZE=$(stat -f%z "$TRANSCRIPT_FILE" 2>/dev/null || stat -c%s "$TRANSCRIPT_FILE" 2>/dev/null || echo "0")
LAST_SIZE=$(cat "$LOG_HASH_FILE" 2>/dev/null || echo "0")
# ~8000 bytes of raw JSONL ≈ 2000 chars of parsed output; skip if file hasn't grown enough
if [ "$FILE_SIZE" -lt $(( LAST_SIZE + 8000 )) ]; then exit 0; fi

# Get full log from transcript file (includes assistant responses, not just user messages)
FULL_LOG=$(python3 - "$SESSION_ID" "$TRANSCRIPT_DIR" << 'PYEOF'
import json, sys, re

session_id = sys.argv[1]
transcript_path = f"{sys.argv[2]}/{session_id}.jsonl"

lines = []
try:
    with open(transcript_path) as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if len(lines) >= 300:
                break
            msg = e.get('message', {})
            role = msg.get('role', '')
            content = msg.get('content', '')
            if isinstance(content, str) and len(content) > 25:
                lines.append(f"[{'User' if role=='user' else 'Assistant'}]: {content[:300]}")
            elif isinstance(content, list):
                for c in content:
                    if c.get('type') != 'text': continue
                    text = c.get('text', '').strip()
                    if len(text) < 25: continue
                    if re.match(r'^(SPAWNED|MERGED|SKIP|ERROR|Extracted \d)', text): continue
                    if text.startswith('```') and text.count('\n') > 3: continue
                    # Strip file path lines and extension-only tokens (noise from tool output)
                    if re.match(r'^/(?:Users|home)/', text): continue
                    if re.search(r'\.(csv|jsonl|pdf|png|ts|py|sh|json)\s*$', text): continue
                    lines.append(f"[{'User' if role=='user' else 'Assistant'}]: {text[:400]}")
except Exception:
    pass

print(' | '.join(lines))
PYEOF
)

[ -z "$FULL_LOG" ] && exit 0

# Update gate file with current transcript size (after successful parse)
LOG_LEN=${#FULL_LOG}
LAST_LOG_FILE="/tmp/gaussian_last_parsed_${SESSION_ID}"
LAST_LOG_LEN=$(cat "$LAST_LOG_FILE" 2>/dev/null || echo "0")
if [ "$LOG_LEN" -lt $(( LAST_LOG_LEN + 2000 )) ]; then exit 0; fi
echo "$LOG_LEN" > "$LAST_LOG_FILE"
echo "$FILE_SIZE" > "$LOG_HASH_FILE"

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
