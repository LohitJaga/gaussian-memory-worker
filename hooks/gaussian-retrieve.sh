#!/bin/bash
# UserPromptSubmit hook — parallel multi-query contextual retrieval + CLAUDE.md bootstrap
# Identity/working-style is handled by CLAUDE.md; this injects dynamic episodic context only
PROMPT=$(jq -r '.prompt // empty' 2>/dev/null)
[ -z "$PROMPT" ] && exit 0

WORKER="${GAUSSIAN_WORKER_URL}"
[ -z "$WORKER" ] && exit 0
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# Detect project from git root basename, normalized to lowercase-hyphenated.
# No xargs — it word-splits paths containing spaces (S11-class bug).
GIT_ROOT=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_ROOT" ]; then
  PROJECT=$(basename "$GIT_ROOT" | tr '[:upper:]' '[:lower:]' | tr ' _' '-')
else
  PROJECT="default"
fi

# Bootstrap CLAUDE.md from KV if missing on this device (runs once per new device)
# R2: bounded with --max-time, and the response is validated before overwriting
# CLAUDE.md — a "null", error string, or implausibly short payload is rejected so
# a bad fetch can't clobber the profile target.
if [ ! -s "$CLAUDE_MD" ]; then
  PROFILE=$(curl -sf --max-time 10 -X POST "$WORKER" \
    ${GAUSSIAN_AUTH_TOKEN:+-H "Authorization: Bearer $GAUSSIAN_AUTH_TOKEN"} \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"identity_profile_get","arguments":{}}}' \
    2>/dev/null | jq -r 'if .error then "" else (.result.content[0].text // "") end' 2>/dev/null)
  if [ -n "$PROFILE" ] && [ "$PROFILE" != "null" ] && [ "${#PROFILE}" -ge 50 ]; then
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
  # In a git project — anchor queries to the project, but diversify the channels:
  # Q2 pulls recent decisions/outcomes, Q3 deliberately targets durable procedural/
  # preference facts so they get their own retrieval lane instead of losing every slot
  # to recent session summaries (which Q2 already surfaces).
  Q2="$PROJECT recent decisions outcomes"
  Q3="$PROJECT conventions preferences procedural how to work"
fi

TMP=$(mktemp -d)
RECEIPT_FILE="$HOME/.claude/gaussian-receipts.jsonl"

# R4: latency must be measured in milliseconds. `date +%s` has 1-second granularity,
# so (END-START)*1000 reported 0ms for almost every retrieval. macOS date lacks %N
# and the system bash (3.2) lacks EPOCHREALTIME, so use perl's Time::HiRes.
now_ms() {
  perl -MTime::HiRes=time -e 'printf("%d", time()*1000)' 2>/dev/null \
    || echo $(( $(date +%s) * 1000 ))
}
START=$(now_ms)

# Q1: raw prompt if meaningful length. Short prompts anchor on their REAL content
# words (plus project when available) — never a synthetic query that drops the
# user's topic ("check the loreal repo" must query "loreal repo", not
# "<project> recent work decisions").
if [ "$PROMPT_LEN" -lt 25 ]; then
  CONTENT_WORDS=$(echo "$PROMPT_WORDS" | sed 's/ *$//')
  if [ -n "$CONTENT_WORDS" ]; then
    if [ "$PROJECT" = "default" ]; then
      query_memory "$CONTENT_WORDS" "$TMP/q1" "$PROMPT" &
    else
      query_memory "$PROJECT $CONTENT_WORDS" "$TMP/q1" "$PROMPT" &
    fi
  else
    # Prompt has no content words at all (e.g. "hi", "ok go") — generic anchor is
    # the only option left
    if [ "$PROJECT" = "default" ]; then
      query_memory "recent context decisions" "$TMP/q1" "$PROMPT" &
    else
      query_memory "$PROJECT recent work decisions" "$TMP/q1" "$PROMPT" &
    fi
  fi
else
  query_memory "$PROMPT" "$TMP/q1" "$PROMPT" &
fi
query_memory "$Q2" "$TMP/q2" &
query_memory "$Q3" "$TMP/q3" &
wait

END=$(now_ms)
LATENCY_MS=$(( END - START ))

# Merge, filter identity domain (CLAUDE.md handles those), threshold >= 0.70, sort
# high-to-low, cap at 12. The old 0.90 gate selected on score (which rewards recent
# high-sigma memories) and let low-relevance items flood the context; 0.70 + top-12
# keeps relevant mid-score hits while bounding injection size.
# Pipeline: filter identity → keep scored lines → score gate → sort high→low → exact-line
# dedup → near-dup dedup on the memory text (first 80 chars, so the same memory pulled by
# two queries at different scores collapses to its best instance) → cap session-type lines
# at 3 so they can't monopolise the budget → top 12. The worker now does semantic MMR, but
# the 3 overlapping queries can still return the same memory text with different score
# prefixes, which only this text-level dedup catches.
MERGED=$(cat "$TMP"/q1 "$TMP"/q2 "$TMP"/q3 2>/dev/null \
  | grep -v '(identity/' \
  | grep -E '^\[[0-9]' \
  | awk -F'[][]' '$2+0 >= 0.70' \
  | sort -t'[' -k2 -rn \
  | awk '!seen[$0]++' \
  | awk -F'● ' '{k=substr($2,1,80); if(!(k in s2)){s2[k]=1; print}}' \
  | awk '/\/session\)/{c++; if(c>3) next} {print}' \
  | head -12)

rm -rf "$TMP"

# Receipt logging — metadata + 200-char memory text snippets for debugging
{
  QUERY_HASH=$(echo "$PROMPT" | md5 2>/dev/null || echo "$PROMPT" | md5sum 2>/dev/null | cut -c1-8)
  QUERY_HASH=$(echo "$QUERY_HASH" | cut -c1-8)
  INJECTED=$([ -n "$MERGED" ] && echo "true" || echo "false")
  # grep -c always outputs a number even on no-match (exits 1 but outputs "0")
  # do NOT add || fallback — it would append a second "0" making the var invalid JSON
  TOTAL=$(echo "$MERGED" | grep -c '^\[' 2>/dev/null); TOTAL=${TOTAL:-0}
  HIGH=$(echo "$MERGED" | awk -F'[][]' '$2+0 >= 1.10' | wc -l | tr -d ' '); HIGH=${HIGH:-0}
  MID=$(echo "$MERGED" | awk -F'[][]' '$2+0 >= 0.95 && $2+0 < 1.10' | wc -l | tr -d ' '); MID=${MID:-0}
  LOW=$(echo "$MERGED" | awk -F'[][]' '$2+0 >= 0.70 && $2+0 < 0.95' | wc -l | tr -d ' '); LOW=${LOW:-0}
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

  # Rotate: keep last 500 receipts (~150KB).
  # R5: rotation runs only under an atomic mkdir lock so two concurrent hooks can't
  # both run the tail+mv dance and clobber each other's writes. If the lock is held,
  # rotation is simply skipped this round — it will happen on a later invocation.
  ROTATE_LOCK="${RECEIPT_FILE}.lock"
  if mkdir "$ROTATE_LOCK" 2>/dev/null; then
    if [ -f "$RECEIPT_FILE" ] && [ "$(wc -l < "$RECEIPT_FILE")" -gt 500 ]; then
      tail -500 "$RECEIPT_FILE" > "${RECEIPT_FILE}.tmp" && mv "${RECEIPT_FILE}.tmp" "$RECEIPT_FILE" 2>/dev/null
    fi
    rmdir "$ROTATE_LOCK" 2>/dev/null
  fi
} &  # async — never blocks injection

[ -z "$MERGED" ] && exit 0

# R1: jq --arg takes values literally, so "\n" inside the bash string injected a
# literal backslash-n into the context. Use a real newline instead.
NL=$'\n'
jq -n --arg ctx "Relevant session context (use as ground truth for recent work and decisions):${NL}${MERGED}" \
  '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
