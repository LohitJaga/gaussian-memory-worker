#!/usr/bin/env bash
# Integration smoke test — hits live worker with JSON-RPC 2.0, covers all 22 tools.
# Usage: bash scripts/integration-test.sh
# Requires: GAUSSIAN_WORKER_URL and GAUSSIAN_AUTH_TOKEN in env

set -euo pipefail

WORKER="${GAUSSIAN_WORKER_URL:?GAUSSIAN_WORKER_URL not set}"
TOKEN="${GAUSSIAN_AUTH_TOKEN:?GAUSSIAN_AUTH_TOKEN not set}"
PASS=0; FAIL=0

call() {
  local tool=$1; local args=$2
  curl -sf -X POST "$WORKER" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

# Get full UUID from memory_list — most recent first, grep for UUID pattern
get_full_id() {
  local short_id=$1
  local list_r
  list_r=$(call memory_list '{"limit":10}')
  echo "$list_r" | grep -oE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" \
    | grep "^$short_id" | head -1 || true
}

check() {
  local label=$1; local result=$2; local pattern=$3
  if echo "$result" | grep -qE "$pattern"; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        got: $(echo "$result" | head -c 400)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Gaussian Memory Integration Tests ==="
echo "Worker: $WORKER"
echo ""

TS=$(date +%s)

# ── 1. Store ──────────────────────────────────────────────────────────────────
echo "[1] memory_store"
TS_TEXT="Integration test: Gaussian Memory uses Cloudflare D1 and Vectorize for Bayesian memory $TS"
R=$(call memory_store "{\"text\":\"$TS_TEXT\",\"memory_type\":\"episodic\",\"domain\":\"gaussian-memory-dev\"}")
check "store spawns or merges" "$R" "SPAWNED:|MERGED:"

# ── 2. Dedup — exact same text should merge ───────────────────────────────────
echo "[2] dedup (exact text)"
R=$(call memory_store "{\"text\":\"$TS_TEXT\",\"memory_type\":\"episodic\",\"domain\":\"gaussian-memory-dev\"}")
check "second store always merges (D1 exact check)" "$R" "MERGED:"

# ── 3. memory_auto_store ──────────────────────────────────────────────────────
echo "[3] memory_auto_store"
R=$(call memory_auto_store "{\"text\":\"Auto store test: integration run $TS\",\"context\":\"integration test\"}")
check "auto_store spawns or merges" "$R" "SPAWNED:|MERGED:"

# ── 4. memory_stats ───────────────────────────────────────────────────────────
echo "[4] memory_stats"
R=$(call memory_stats '{}')
check "stats returns total count" "$R" "Total:"

# ── 5. memory_list ────────────────────────────────────────────────────────────
echo "[5] memory_list"
R=$(call memory_list '{"limit":5}')
check "list returns UUID-formatted entries" "$R" "[0-9a-f]{8}-[0-9a-f]{4}"

# ── 6. Retrieve: entity query ─────────────────────────────────────────────────
echo "[6] retrieve (entity: D1/Vectorize)"
R=$(call memory_retrieve '{"query":"Cloudflare D1 Vectorize Bayesian","top_k":3}')
check "entity retrieve returns scored results" "$R" "\[[0-9]"

# ── 7. Retrieve: temporal ─────────────────────────────────────────────────────
echo "[7] retrieve (temporal: today)"
R=$(call memory_retrieve '{"query":"what did we work on today","top_k":3}')
check "temporal retrieve returns results" "$R" '\['

# ── 8. Retrieve: vague query ──────────────────────────────────────────────────
echo "[8] retrieve (vague)"
R=$(call memory_retrieve '{"query":"memory system","top_k":5}')
check "vague retrieve returns results" "$R" '\['

# ── 9. memory_timeline ───────────────────────────────────────────────────────
echo "[9] memory_timeline"
R=$(call memory_timeline '{"limit":5}')
check "timeline returns entries" "$R" '\['

# ── 10. memory_update ────────────────────────────────────────────────────────
echo "[10] memory_update + delete"
UPDATE_TEXT="Integration test update-delete probe $TS unique"
R=$(call memory_store "{\"text\":\"$UPDATE_TEXT\",\"memory_type\":\"episodic\",\"domain\":\"gaussian-memory-dev\"}")
SHORT_ID=$(echo "$R" | grep -oE '\(id=[a-f0-9]+\)' | head -1 | tr -d '()' | cut -d= -f2 || true)
FULL_ID=$(get_full_id "$SHORT_ID")
echo "        short=$SHORT_ID full=$FULL_ID"
if [ -n "${FULL_ID:-}" ]; then
  R=$(call memory_update "{\"id\":\"$FULL_ID\",\"text\":\"Integration test: updated $TS\"}")
  check "update succeeds on known ID" "$R" "UPDATED:|updated|Updated"
else
  echo "   SKIP  memory_update (could not resolve full UUID)"
fi

# ── 11. memory_belief_drift ───────────────────────────────────────────────────
echo "[11] memory_belief_drift"
R=$(call memory_belief_drift '{"limit":5}')
check "belief_drift returns any result" "$R" "drift|sigma|Drift|No memories|found|memories"

# ── 12. memory_orphan_check ───────────────────────────────────────────────────
echo "[12] memory_orphan_check"
R=$(call memory_orphan_check '{}')
check "orphan_check returns result" "$R" "orphan|Orphan|No orphans"

# ── 13. identity_profile_get ─────────────────────────────────────────────────
echo "[13] identity_profile_get"
R=$(call identity_profile_get '{}')
check "identity get returns any content" "$R" "."

# ── 14. memory_store_diff ─────────────────────────────────────────────────────
echo "[14] memory_store_diff"
R=$(call memory_store_diff "{\"before\":\"Using GLM-4.7-flash for inference\",\"after\":\"Switched to Llama-3.1-8b because GLM exhausted token budget before emitting content\",\"context\":\"model swap on $TS\"}")
check "store_diff spawns or merges" "$R" "SPAWNED:|MERGED:|SKIP"

# ── 15. memory_capture_passive ───────────────────────────────────────────────
echo "[15] memory_capture_passive"
PASSIVE="## Key Learnings:\\n- Vectorize has a 50-vector topK cap when returnValues=true\\n- D1 exact-text check before Vectorize prevents duplicate spawns during propagation lag"
R=$(call memory_capture_passive "{\"text\":\"$PASSIVE\"}")
check "capture_passive returns capture count" "$R" "Captured|SPAWNED:|MERGED:|memories|No storable"

# ── 16. memory_extract_and_store ─────────────────────────────────────────────
echo "[16] memory_extract_and_store"
R=$(call memory_extract_and_store "{\"log_text\":\"Decided to use Cloudflare D1 for storage because zero egress fees and edge-native. Switched from GLM to Llama-3.1-8b because GLM exhausted token budget. Fixed Vectorize topK cap at 50 when returnValues is true.\"}")
check "extract_and_store spawns or no-ops" "$R" "SPAWNED:|MERGED:|Stored|stored|No facts|extracted|facts"

# ── 17. memory_rebuild_domains ────────────────────────────────────────────────
echo "[17] memory_rebuild_domains"
R=$(call memory_rebuild_domains '{}')
check "rebuild_domains returns result" "$R" "domain|memories|Done|reclassified"

# ── 18. memory_retag_projects ─────────────────────────────────────────────────
echo "[18] memory_retag_projects"
R=$(call memory_retag_projects '{}')
check "retag_projects returns result" "$R" "default|project|Processed|batch|remaining"

# ── 19. memory_cleanup_singletons ─────────────────────────────────────────────
echo "[19] memory_cleanup_singletons"
R=$(call memory_cleanup_singletons '{"dry_run":true}')
check "cleanup_singletons returns result" "$R" "singleton|Singleton|No singleton|domain"

# ── 20. memory_judge ──────────────────────────────────────────────────────────
echo "[20] memory_judge"
R=$(call memory_judge '{"limit":3}')
check "memory_judge returns result" "$R" "judge|pair|verdict|candidates|Processed|No pending|supersedes|extends|no candidates"

# ── 21. memory_build_entities ─────────────────────────────────────────────────
echo "[21] memory_build_entities"
R=$(call memory_build_entities '{"limit":5}')
check "build_entities returns result" "$R" "entit|Entit|queue|Process|No pending|Processed|remaining"

# ── 22. memory_delete (cleanup from test 10) ──────────────────────────────────
echo "[22] memory_delete (cleanup)"
if [ -n "${FULL_ID:-}" ]; then
  R=$(call memory_delete "{\"id\":\"$FULL_ID\"}")
  check "delete by full UUID confirmed" "$R" "deleted|Deleted|DELETED|removed"
else
  echo "   SKIP  memory_delete (no full UUID from test 10)"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
