#!/bin/bash
# Called by Stop hook — extracts facts from this session and stores them in Gaussian memory
# Also pushes CLAUDE.md to KV for cross-device sync
HOOK_INPUT=$(cat)
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

WORKER="${GAUSSIAN_WORKER_URL}"
[ -z "$WORKER" ] && exit 0
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# S10: state lives in ~/.claude (persistent), not /tmp (cleared on reboot, which
# made every post-reboot run re-send the whole transcript from offset 0)
STATE_DIR="$HOME/.claude/gaussian-state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# S9: per-session lock so concurrent hook invocations can't race on offset state.
# mkdir is atomic and portable (macOS has no flock binary).
LOCK_DIR="$STATE_DIR/lock_${SESSION_ID}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Stale-lock recovery: a killed run can strand the lock; reclaim after 2 minutes
  if find "$LOCK_DIR" -maxdepth 0 -mmin +2 2>/dev/null | grep -q .; then
    rmdir "$LOCK_DIR" 2>/dev/null
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# S11: detect project from git root basename. No xargs — it word-splits paths
# containing spaces, so "My Project" became project "project".
GIT_ROOT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_ROOT" ]; then
  PROJECT=$(basename "$GIT_ROOT" | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
else
  PROJECT="default"
fi

# S1: trust transcript_path from the hook input only. The old fallback rebuilt a
# path from a sed-encoding of $HOME (not the project cwd), which never matched the
# real per-project transcript directories — it silently parsed nothing. If the hook
# doesn't provide a path, there is nothing useful to parse.
TRANSCRIPT_FILE=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
[ -z "$TRANSCRIPT_FILE" ] && exit 0
[ ! -f "$TRANSCRIPT_FILE" ] && exit 0

# S2: byte-offset delta — only parse and send content appended since the last
# *successful* POST. The old approach re-parsed the whole file and kept the FIRST
# 30K chars, so long sessions repeatedly re-sent stale early content and never
# reached recent turns.
OFFSET_FILE="$STATE_DIR/offset_${SESSION_ID}"
FILE_SIZE=$(stat -f%z "$TRANSCRIPT_FILE" 2>/dev/null || stat -c%s "$TRANSCRIPT_FILE" 2>/dev/null || echo "0")
LAST_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo "0")
case "$LAST_OFFSET" in *[!0-9]*|'') LAST_OFFSET=0 ;; esac
# Transcript shrank (replaced/rotated file at same path) — start over from 0
[ "$LAST_OFFSET" -gt "$FILE_SIZE" ] && LAST_OFFSET=0
# ~8000 bytes of raw JSONL ~= 2000 chars of parsed output; skip if not enough new content
if [ "$FILE_SIZE" -lt $(( LAST_OFFSET + 8000 )) ]; then exit 0; fi

# Parse only the new tail of the transcript (includes assistant responses)
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
            # S5: per-entry guard — one malformed entry (truncated JSON, unexpected
            # shape, non-dict content item) must not abort the rest of the batch.
            try:
                e = json.loads(line)
                msg = e.get('message') or {}
                role = msg.get('role', '')
                content = msg.get('content', '')
                if isinstance(content, str) and len(content) > 25:
                    lines.append(f"[{'User' if role=='user' else 'Assistant'}]: {content[:300]}")
                elif isinstance(content, list):
                    for c in content:
                        try:
                            if not isinstance(c, dict) or c.get('type') != 'text':
                                continue
                            text = c.get('text', '').strip()
                            if len(text) < 25:
                                continue
                            if re.match(r'^(SPAWNED|MERGED|SKIP|ERROR|Extracted \d)', text):
                                continue
                            if text.startswith('```') and text.count('\n') > 3:
                                continue
                            # S6: only skip entries that are NOTHING BUT a bare path or
                            # filename. The old suffix match dropped any sentence that
                            # happened to end in a filename (e.g. "fixed the bug in app.py").
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

# Require enough new parsed content to justify an extraction call. State is NOT
# committed on skip, so the pending content is picked up by a later run.
LOG_LEN=${#FULL_LOG}
if [ "$LOG_LEN" -lt 2000 ]; then exit 0; fi

# S3: cap on TOTAL size keeping the newest content. The old `cut -c1-30000`
# truncated per-line (wrong tool for a total cap) and kept the oldest content.
LOG=$(printf '%s' "$FULL_LOG" | tail -c 30000)
[ -z "$LOG" ] && exit 0

# Store session memories. S8: --max-time so a hung Worker can't stall the hook.
# S4: the offset is committed only AFTER a successful POST — a failed batch stays
# pending and is retried on the next run instead of being silently skipped.
if curl -sf --max-time 10 -X POST "$WORKER" \
  -H 'Content-Type: application/json' \
  ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
  -d "$(jq -n --arg l "$LOG" --arg p "$PROJECT" \
    '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"memory_extract_and_store","arguments":{"log_text":$l,"project":$p}}}')" \
  > /dev/null 2>&1; then
  echo "$FILE_SIZE" > "$OFFSET_FILE"
fi

# Sync CLAUDE.md to KV if it exists (cross-device bootstrap source)
if [ -s "$CLAUDE_MD" ]; then
  CONTENT=$(cat "$CLAUDE_MD")
  curl -sf --max-time 10 -X POST "$WORKER" \
    -H 'Content-Type: application/json' \
    ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
    -d "$(jq -n --arg c "$CONTENT" \
      '{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"identity_profile_set","arguments":{"content":$c}}}')" \
    > /dev/null 2>&1
fi
