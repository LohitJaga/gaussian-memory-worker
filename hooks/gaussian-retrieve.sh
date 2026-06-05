#!/bin/bash
# UserPromptSubmit hook — parallel multi-query contextual retrieval + CLAUDE.md bootstrap
# Identity/working-style is handled by CLAUDE.md; this injects dynamic episodic context only
PROMPT=$(jq -r '.prompt // empty' 2>/dev/null)
[ -z "$PROMPT" ] && exit 0

WORKER="${GAUSSIAN_WORKER_URL}"
[ -z "$WORKER" ] && exit 0
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# Detect project from git root basename, normalized to lowercase-hyphenated
PROJECT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null | xargs basename 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
[ -z "$PROJECT" ] && PROJECT="default"

# Bootstrap CLAUDE.md from KV if missing on this device (runs once per new device)
if [ ! -s "$CLAUDE_MD" ]; then
  PROFILE=$(curl -sf -X POST "$WORKER" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"identity_profile_get","arguments":{}}}' \
    2>/dev/null | jq -r '.result.content[0].text // ""' 2>/dev/null)
  if [ -n "$PROFILE" ]; then
    echo "$PROFILE" > "$CLAUDE_MD"
  fi
fi

query_memory() {
  local query="$1" outfile="$2" context="$3"
  local args
  if [ -n "$context" ]; then
    args=$(jq -n --arg q "$query" --arg p "$PROJECT" --arg c "$context" \
      '{"query":$q,"top_k":10,"project":$p,"context":$c}')
  else
    args=$(jq -n --arg q "$query" --arg p "$PROJECT" \
      '{"query":$q,"top_k":10,"project":$p}')
  fi
  curl -sf --max-time 5 -X POST "$WORKER" \
    -H 'Content-Type: application/json' \
    ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
    -d "$(jq -n --argjson a "$args" \
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_retrieve","arguments":$a}}')" \
    2>/dev/null | jq -r '.result.content[0].text // ""' 2>/dev/null > "$outfile"
}

# Query routing: project-anchored when in a git repo, prompt-word-based otherwise.
# "default" means no git context — "default recent decisions" is a useless query.
PROMPT_LEN=${#PROMPT}
TOPIC="$PROJECT"
PROMPT_WORDS=$(echo "$PROMPT" | tr ' ' '\n' | awk 'length>3' | tail -6 | tr '\n' ' ')

if [ "$PROJECT" = "default" ]; then
  # No git repo — user is just speaking, use prompt words as anchor
  Q2="${PROMPT_WORDS}recent context decisions"
  Q3="${PROMPT_WORDS}outcomes preferences"
else
  # In a git project — anchor all queries to the project
  Q2="$PROJECT recent decisions outcomes"
  Q3="$PROJECT architecture work completed"
fi

TMP=$(mktemp -d)
RECEIPT_FILE="$HOME/.claude/gaussian-receipts.jsonl"
START=$(date +%s)

# Q1: raw prompt if meaningful length, else project/prompt anchor
if [ "$PROMPT_LEN" -lt 25 ]; then
  if [ "$PROJECT" = "default" ]; then
    query_memory "${PROMPT_WORDS}context decisions" "$TMP/q1" "$PROMPT" &
  else
    query_memory "$PROJECT recent work decisions" "$TMP/q1" "$PROMPT" &
  fi
else
  query_memory "$PROMPT" "$TMP/q1" "$PROMPT" &
fi
query_memory "$Q2" "$TMP/q2" &
query_memory "$Q3" "$TMP/q3" &
wait

END=$(date +%s)
LATENCY_MS=$(( (END - START) * 1000 ))

# Merge, filter identity domain (CLAUDE.md handles those), deduplicate, raise threshold to 0.90
MERGED=$(cat "$TMP"/q1 "$TMP"/q2 "$TMP"/q3 2>/dev/null \
  | grep -v '(identity/' \
  | sort -u \
  | grep -E '^\[1\.[0-9]|^\[0\.9[0-9]' \
  | head -15)

rm -rf "$TMP"

# Receipt logging — privacy-safe metadata only, no memory text
{
  QUERY_HASH=$(echo "$PROMPT" | md5 2>/dev/null || echo "$PROMPT" | md5sum 2>/dev/null | cut -c1-8)
  QUERY_HASH=$(echo "$QUERY_HASH" | cut -c1-8)
  INJECTED=$([ -n "$MERGED" ] && echo "true" || echo "false")
  # grep -c always outputs a number even on no-match (exits 1 but outputs "0")
  # do NOT add || fallback — it would append a second "0" making the var invalid JSON
  TOTAL=$(echo "$MERGED" | grep -c '^\[' 2>/dev/null); TOTAL=${TOTAL:-0}
  HIGH=$(echo "$MERGED" | grep -cE '^\[1\.[1-9]' 2>/dev/null); HIGH=${HIGH:-0}
  MID=$(echo "$MERGED" | grep -cE '^\[1\.0|^\[0\.9[5-9]' 2>/dev/null); MID=${MID:-0}
  LOW=$(echo "$MERGED" | grep -cE '^\[0\.9[0-4]' 2>/dev/null); LOW=${LOW:-0}
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)

  MEMORIES_JSON=$(echo "$MERGED" | grep '^\[' | while IFS= read -r line; do
    score=$(echo "$line" | grep -oE '^\[[0-9.]+\]' | tr -d '[]')
    domain=$(echo "$line" | grep -oE '\([^)]+\)' | head -1 | tr -d '()\n\r')
    text=$(echo "$line" | sed 's/^\[[0-9.]*\] ([^)]*) . //' | LC_ALL=C tr -cd '[:print:]' | sed 's/\\/\//g' | cut -c1-200)
    jq -cn --arg s "$score" --arg d "$domain" --arg t "$text" '{score:$s,domain:$d,text:$t}'
  done | jq -s '.')
  MEMORIES_JSON=${MEMORIES_JSON:-[]}

  jq -cn \
    --arg ts "$TS" \
    --arg project "$PROJECT" \
    --arg qhash "$QUERY_HASH" \
    --arg topic "$TOPIC" \
    --argjson latency "$LATENCY_MS" \
    --argjson injected "$INJECTED" \
    --argjson total "$TOTAL" \
    --argjson high "$HIGH" \
    --argjson mid "$MID" \
    --argjson low "$LOW" \
    --argjson memories "$MEMORIES_JSON" \
    '{ts:$ts,project:$project,query_hash:$qhash,topic:$topic,latency_ms:$latency,injected:$injected,results:$total,score_buckets:{high:$high,mid:$mid,low:$low},memories:$memories}' \
    >> "$RECEIPT_FILE" 2>/dev/null

  # Rotate: keep last 500 receipts (~150KB)
  if [ -f "$RECEIPT_FILE" ] && [ "$(wc -l < "$RECEIPT_FILE")" -gt 500 ]; then
    tail -500 "$RECEIPT_FILE" > "${RECEIPT_FILE}.tmp" && mv "${RECEIPT_FILE}.tmp" "$RECEIPT_FILE" 2>/dev/null
  fi
} &  # async — never blocks injection

[ -z "$MERGED" ] && exit 0

jq -n --arg ctx "Relevant session context (use as ground truth for recent work and decisions):\n$MERGED" \
  '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
