import type { Env } from './types';
import { embed, batchEmbed, dotProduct } from './embed';
import { hotTierGet, hotTierAddMany } from './storage';
import {
  deserializeSigma, serializeSigma, meanSigma, sharpenSigma, distributionalScore,
} from './gaussian';

const DOMAIN_SIZE_CACHE_KEY = 'cache:domain_sizes';
const DOMAIN_SIZE_CACHE_TTL = 60; // seconds — only feeds sharpenSigma's floor, tolerant of staleness

// Cache-aside: domain sizes only inform a confidence-floor threshold (>=15 vs <5 memories),
// not the actual ranking, so a short-TTL KV cache is safe. Without this, retrieve() ran an
// unconditional `GROUP BY domain` full-table scan on every single call regardless of corpus
// size — the single most expensive query in the function relative to the value it provides.
async function getDomainSizeMap(env: Env): Promise<Map<string, number>> {
  const raw = await env.KV.get(DOMAIN_SIZE_CACHE_KEY).catch(() => null);
  if (raw) {
    try { return new Map(Object.entries(JSON.parse(raw) as Record<string, number>)); } catch {}
  }

  const rows = await env.DB.prepare('SELECT domain, COUNT(*) as cnt FROM memories GROUP BY domain')
    .all<{ domain: string; cnt: number }>().catch(() => ({ results: [] as { domain: string; cnt: number }[] }));
  const map: Record<string, number> = {};
  for (const r of rows.results) map[r.domain] = r.cnt;
  await env.KV.put(DOMAIN_SIZE_CACHE_KEY, JSON.stringify(map), { expirationTtl: DOMAIN_SIZE_CACHE_TTL }).catch(() => {});
  return new Map(Object.entries(map));
}

export const RRF_K = 60;

// Reciprocal-rank fusion: merges any number of ranked ID lists into one score map.
// Extracted so the fusion math is testable without live Vectorize/FTS5 calls.
export function rrfMerge(rankedLists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

// Min-max normalization within a batch — spreads a raw score component across [0,1].
// A constant array (all-equal values) normalizes to all-1s, not all-0s or NaN.
export function minMaxNormalize(arr: number[]): number[] {
  const mn = Math.min(...arr), mx = Math.max(...arr);
  return mx === mn ? arr.map(() => 1) : arr.map(v => (v - mn) / (mx - mn));
}

// Cosine normalization with injected-candidate exemption (2026-07-09, audit finding #3).
// Candidates injected by non-cosine sources (temporal window, cluster routing, access
// frequency) carry a SYNTHETIC placeholder cosine, not a real query similarity. Running
// those through the same min-max as real cosine hits crushed them to ~0 — real hits
// cluster in a narrow high band (≈0.55–0.70), so a synthetic 0.35–0.5 was always the
// batch minimum and normalized to 0 before the score floor could ever let it surface,
// making the cluster-routing and access-frequency experiments structurally unable to
// move any result. Fix: min-max only the real-cosine candidates against each other;
// injected candidates receive their synthetic value directly as the POST-normalization
// score (0.5 temporal > 0.45 cluster > 0.35 access — mid-pack by design: they should
// compete on their own boosts, not win or lose on a fake cosine).
export function normalizeCosineBatch(items: { cosineWeighted: number; syntheticCos: number | null }[]): number[] {
  const realIdx: number[] = [];
  for (let i = 0; i < items.length; i++) if (items[i].syntheticCos === null) realIdx.push(i);
  const realNorm = minMaxNormalize(realIdx.map(i => items[i].cosineWeighted));
  const out = new Array<number>(items.length).fill(0);
  realIdx.forEach((i, j) => { out[i] = realNorm[j]; });
  for (let i = 0; i < items.length; i++) {
    const s = items[i].syntheticCos;
    if (s !== null) out[i] = s;
  }
  return out;
}

export const DEDUP_COS = 0.85, DEDUP_TEXT = 0.72;

export function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/).filter(w => w.length > 3)
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// Near-duplicate suppression (MMR-style): keeps the highest-scored instance of each
// near-identical item, dropping later ones — embedding cosine when both have vectors,
// token-Jaccard fallback otherwise. Input must already be sorted desc by score.
export function dedupBySimilarity<T extends { text: string; vector: number[] }>(
  list: T[], cosThreshold = DEDUP_COS, textThreshold = DEDUP_TEXT
): T[] {
  const out: T[] = []; const outTok: Set<string>[] = [];
  for (const c of list) {
    const ct = tokenize(c.text); let dup = false;
    for (let k = 0; k < out.length; k++) {
      const same = (c.vector.length && out[k].vector.length)
        ? dotProduct(c.vector, out[k].vector) > cosThreshold
        : jaccardSimilarity(ct, outTok[k]) > textThreshold;
      if (same) { dup = true; break; }
    }
    if (!dup) { out.push(c); outTok.push(ct); }
  }
  return out;
}

// σ hard gate: specific queries only surface memories whose confidence meets the
// query's specificity requirement. Ceiling scales with querySigmaVal so vague queries
// stay permissive. Always keeps at least a minimum number of results (never empty).
export function sigmaGate<T extends { sigma: Float32Array }>(
  items: T[], querySigmaVal: number, minResults = 2, floor = 0.65, multiplier = 1.8
): T[] {
  const sigmaCeiling = Math.max(floor, querySigmaVal * multiplier);
  const gated = items.filter(m => meanSigma(m.sigma) <= sigmaCeiling);
  return gated.length >= minResults ? gated : items.slice(0, Math.max(minResults, Math.ceil(items.length / 2)));
}

// Diversity cap: caps how many results of the same memory_type or micro-cluster can
// appear together, so one session's worth of near-identical summaries (or one tight
// cluster) can't flood the result set. Memories without a cluster_id are exempt.
export function applyDiversityCap<T extends { type: string; cluster_id: string | null }>(
  items: T[], sessionLimit = 2, otherTypeLimit = 4, clusterLimit = 3
): T[] {
  const out: T[] = [];
  const typeCounts = new Map<string, number>();
  const clusterCounts = new Map<string, number>();
  for (const m of items) {
    const tc = typeCounts.get(m.type) ?? 0;
    const cc = m.cluster_id ? (clusterCounts.get(m.cluster_id) ?? 0) : 0;
    const typeLimit = m.type === 'session' ? sessionLimit : otherTypeLimit;
    if (tc >= typeLimit || (m.cluster_id && cc >= clusterLimit)) continue;
    out.push(m);
    typeCounts.set(m.type, tc + 1);
    if (m.cluster_id) clusterCounts.set(m.cluster_id, cc + 1);
  }
  return out;
}

// project='default' means no project context (direct MCP call) — searches all projects, no clause.
// Otherwise, real callers usually want project-scoped results to still surface general/default
// facts (identity, preferences) alongside project-specific ones — hence the OR-default fallback,
// which is genuinely useful and stays the default. strictProject opts a specific call out of that
// fallback for true project-only isolation (e.g. tests that must not see production data).
// Shared by all 3 project-scoped queries in retrieve() so strict-mode support can't land in only
// some of them.
export function projectScopeClause(project: string, strictProject = false): { clause: string; param: string | null } {
  if (project === 'default') return { clause: '', param: null };
  const clause = strictProject ? 'AND project = ?' : `AND (project = ? OR project = 'default')`;
  return { clause, param: project };
}

// Stage B ablation baseline — deliberately dumb top-k cosine retrieval, mirroring what a
// naive vector-store competitor (fat-context, no confidence model) would return: no BM25
// fusion, no entity graph, no temporal boost, no cluster cohesion, no threshold expansion,
// no diversity cap. Kept fully separate from retrieve() rather than threaded in as a bypass
// flag — that function's signals are too interleaved to safely branch mid-pipeline, and this
// only needs to exist for the benchmark harness's baseline-vs-Gaussian comparison.
export async function baselineRetrieve(
  query: string, topK: number, env: Env, project: string = 'default', strictProject = false
): Promise<{ id: string; score: number; text: string; domain: string; type: string }[]> {
  if (!query?.trim()) return [];

  const qvec = await embed(query, env);
  const matches = (await env.VECTORIZE.query(Array.from(qvec), {
    topK, returnValues: false, returnMetadata: 'none',
  })).matches ?? [];
  if (!matches.length) return [];

  const ids = matches.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const { clause: projectClause, param: projectParam } = projectScopeClause(project, strictProject);
  const binds = projectParam ? [...ids, projectParam] : [...ids];
  const rows = await env.DB.prepare(
    `SELECT id, text, domain, memory_type FROM memories WHERE id IN (${placeholders}) ${projectClause}`
  ).bind(...binds).all<{ id: string; text: string; domain: string; memory_type: string }>();

  const rowMap = new Map((rows.results ?? []).map(r => [r.id, r]));
  const scoreMap = new Map(matches.map(m => [m.id, m.score]));
  return ids
    .filter(id => rowMap.has(id))
    .map(id => {
      const r = rowMap.get(id)!;
      return { id, score: scoreMap.get(id) ?? 0, text: r.text, domain: r.domain, type: r.memory_type };
    })
    .sort((a, b) => b.score - a.score);
}

export async function retrieve(
  query: string, domain: string | null, topK: number, env: Env, project: string = 'default',
  strictProject = false,
  // frozen: read-only trial — skips the sigma-sharpen / access_count / hot-tier write-backs
  // at the end of the pipeline. Live agent calls keep the default (false): reinforcement on
  // access is the product behavior. The bench endpoint sets true so repeated benchmark runs
  // are clean trials instead of training the ranker toward whatever the benchmark touched
  // (confirmed contamination, BENCHMARKING.md 2026-07-08 audit finding #5).
  opts: { frozen?: boolean } = {}
): Promise<{ id: string; score: number; text: string; domain: string; type: string; activated?: boolean; sigma?: number }[]> {
  // Empty/whitespace query: embedding it is meaningless and may throw — return no results.
  if (!query?.trim()) return [];

  // Pure semantic retrieval — no LLM query rewriting.
  // Memories are stored with context-enriched text (via memory_auto_store context param),
  // so retrieval is pure vector math. No blocking LLM call.
  const searchQuery = query;
  const qvec = await embed(searchQuery, env);

  // Extract capitalized entity tokens from the query for entity graph traversal.
  const capPattern = /\b([A-Z][a-zA-Z0-9._-]{2,}|@cf\/[^\s]+|CW[0-9]+[A-Z]?)\b/g;
  const entityTokens = [...new Set(query.match(capPattern) ?? [])].slice(0, 3);

  // Infer query sigma: length alone was a bad proxy for vagueness — a short casual
  // query ("that db thing again") scored as PRECISE under pure length, when it's
  // actually the vague case the sigma-widening mechanism exists for. Blend in a
  // specificity signal from the entity tokens above: named/capitalized terms present
  // → more precise (lower σ); none → more vague (higher σ), independent of length.
  // Confirmed via bench/gold/retrieval_gold.vague.json (2026-07-08): recall was tied
  // with a naive baseline on short casual queries, consistent with this never firing.
  const lengthSigma = 0.5 * Math.min(query.length / 300, 1.0);
  const specificityAdj = entityTokens.length > 0 ? -0.1 * Math.min(entityTokens.length, 2) : 0.05;
  const querySigmaVal = Math.max(0.2, Math.min(0.8, 0.3 + lengthSigma + specificityAdj));

  // Temporal cue parsing — "yesterday", "this week" etc. → timestamp window boost at score time.
  const temporalDaysMap: Record<string, number> = {
    'today': 0, 'this session': 0, 'just now': 0,
    'yesterday': 1,
    'this week': 5, 'last week': 12,
    'this month': 25, 'last month': 55,
    'recently': 2,
  };
  const temporalCueMatch = query.match(/\b(today|this session|just now|yesterday|this week|last week|this month|last month|recently)\b/i);
  const temporalWindowDays = temporalCueMatch ? (temporalDaysMap[temporalCueMatch[1].toLowerCase()] ?? -1) : -1;

  // Domain sizes — used to set adaptive sigma floor in sharpenSigma.
  // Large domains (>=15) use floor=0.15; small (<5) use floor=0.35 to prevent premature certainty.
  const domainSizeMap = await getDomainSizeMap(env);

  // Vector search + FTS5 keyword search in parallel (hybrid retrieval, global scope)
  // Vectorize cap: returnValues=true hard-limits topK to 50. FTS5 handles overflow.
  // Pool multiplier scales with querySigmaVal (4x precise -> 8x vague, capped at 50
  // regardless): sigma-based gating downstream can only filter candidates that were
  // actually fetched here — a vague query with a wide sigma gate still recalls nothing
  // extra if the raw cosine search never pulled the right memory into the pool at all.
  // Widening the initial fetch for vague queries is the fix that actually reaches the
  // real bottleneck (confirmed via bench/gold/retrieval_gold.vague.json, 2026-07-08:
  // the querySigmaVal specificity fix alone moved tokens but not recall, since it only
  // touches post-fetch filtering).
  const poolMultiplier = 4 + Math.round(4 * Math.max(0, Math.min(1, (querySigmaVal - 0.2) / 0.6)));
  const queryOpts: any = { topK: Math.min(topK * poolMultiplier, 50), returnValues: true, returnMetadata: 'indexed' };

  // Build FTS5 query — sanitize to valid FTS5 syntax (remove special chars)
  const ftsQuery = searchQuery.replace(/['"*()]/g, ' ').trim();

  // EXPERIMENTAL (2026-07-08): neighborhood routing for vague queries only. Proven via
  // bench/gold/retrieval_gold.vague.json that a casual/vague query can rank the true
  // answer beyond even a 50-candidate cosine window against the full ~4,700-memory
  // corpus (register mismatch — casual phrasing embeds closer to other casual-toned
  // memories than to the formally-worded fact that answers it). MICRO_VECTORIZE holds
  // ~2,500-2,900 fine-grained cluster centroids, previously write-time-only (assignMicroCluster)
  // and never consulted during search. Route the query to its nearest few centroids and
  // pull in their member memories as ADDITIONAL candidates — additive, not a replacement,
  // so precise queries (which already work well) are untouched.
  // entityTokens.length === 0 is the gate signal: no recognized specific/named term in
  // the query is exactly the profile this routing exists for. (Initially gated on
  // querySigmaVal > 0.5, which never fired — short casual queries only ever compute
  // ~0.4-0.45 under the current formula, confirmed against all 12 vague gold queries.)
  const useClusterRouting = querySigmaVal > 0.35 || entityTokens.length === 0;

  // EXPERIMENTAL (2026-07-08), 4th candidate source: pure access-frequency ranking,
  // zero embeddings involved. Cluster-routing (above) still operates inside cosine
  // space via MICRO_VECTORIZE centroids, so it inherits the same register-mismatch
  // risk as raw cosine — this one sidesteps embeddings entirely. Heavily-reinforced
  // memories (high access_count) are pulled in directly for vague queries, on the
  // premise that a vague reference is more likely pointing at something you've
  // actually discussed a lot, independent of whether the query's WORDING embeds
  // anywhere near it.
  const [vecFinal, ftsResults, clusterMemberRows, hotAccessRows] = await Promise.all([
    env.VECTORIZE.query(Array.from(qvec), queryOpts),
    ftsQuery.length >= 3
      ? env.DB.prepare(
          `SELECT id, -bm25(memories_fts) as bm25_score FROM memories_fts WHERE memories_fts MATCH ? AND (project = ? OR project = 'default') ORDER BY rank LIMIT ?`
        ).bind(ftsQuery, project, topK * 4).all<{ id: string; bm25_score: number }>().catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] as { id: string; bm25_score: number }[] }),
    useClusterRouting
      ? env.MICRO_VECTORIZE.query(Array.from(qvec), { topK: 3, returnMetadata: 'none' })
          .then(async (r: any) => {
            const clusterIds = (r.matches ?? []).map((m: any) => m.id);
            if (!clusterIds.length) return { results: [] as { id: string }[] };
            const placeholders = clusterIds.map(() => '?').join(',');
            return env.DB.prepare(`SELECT id FROM memories WHERE cluster_id IN (${placeholders}) LIMIT 30`)
              .bind(...clusterIds).all<{ id: string }>().catch(() => ({ results: [] }));
          })
      : Promise.resolve({ results: [] as { id: string }[] }),
    useClusterRouting
      ? env.DB.prepare(`SELECT id FROM memories ORDER BY access_count DESC LIMIT 20`)
          .all<{ id: string }>().catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] as { id: string }[] }),
  ]);
  const clusterRoutedIds = (clusterMemberRows.results ?? []).map(r => r.id);
  const hotAccessIds = (hotAccessRows.results ?? []).map(r => r.id);

  // BM25 score map — negated so higher = better match (FTS5 rank is negative)
  const bm25Map = new Map<string, number>();
  for (const r of (ftsResults.results ?? [])) bm25Map.set(r.id, r.bm25_score ?? 0);

  // RRF fusion (k=60): combine vector ranks + FTS5 ranks for candidate set ordering
  const rrfScores = rrfMerge([
    (vecFinal.matches ?? []).map(m => m.id),
    (ftsResults.results ?? []).map(r => r.id),
  ]);

  // Build merged ID set sorted by RRF score, preserve vector metadata for top vector hits
  const mergedIds = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK * 4)
    .map(([id]) => id);

  const results = vecFinal;
  // Inject RRF-only IDs (from FTS5) that weren't in vector results
  const vecIds = new Set((vecFinal.matches ?? []).map(m => m.id));
  const ftsOnlyIds = mergedIds.filter(id => !vecIds.has(id));

  // Temporal query — fetch memories by timestamp range directly from D1.
  // Cosine search misses temporal matches if the text doesn't embed close to the query.
  // "yesterday" should surface session summaries even without semantic overlap.
  const nowSecEarly = Math.floor(Date.now() / 1000);
  let temporalOnlyIds: string[] = [];   // IDs not in vector/FTS pool — need to be force-added
  let allTemporalIds = new Set<string>(); // ALL IDs in the window — for guarantee logic
  if (temporalWindowDays >= 0) {
    const windowStart = nowSecEarly - (temporalWindowDays + 2) * 86400;
    const windowEnd = nowSecEarly - Math.max(0, temporalWindowDays - 1) * 86400;
    const { clause: tProjectClause, param: tProjectParam } = projectScopeClause(project, strictProject);
    const tBinds: any[] = [windowStart, windowEnd, ...(tProjectParam ? [tProjectParam] : [])];
    // Two passes: general candidates (LIMIT 20) + session-only (no LIMIT) for guarantee
    const [tRows, tSessionRows] = await Promise.all([
      env.DB.prepare(
        `SELECT id FROM memories WHERE timestamp BETWEEN ? AND ? ${tProjectClause} ORDER BY timestamp DESC LIMIT 20`
      ).bind(...tBinds).all<{ id: string }>().catch(() => ({ results: [] })),
      env.DB.prepare(
        `SELECT id FROM memories WHERE timestamp BETWEEN ? AND ? AND memory_type = 'session' ${tProjectClause} ORDER BY timestamp DESC LIMIT 10`
      ).bind(...tBinds).all<{ id: string }>().catch(() => ({ results: [] })),
    ]);
    const allTempIds = [...new Set([
      ...(tRows.results ?? []).map(r => r.id),
      ...(tSessionRows.results ?? []).map(r => r.id),
    ])];
    allTemporalIds = new Set(allTempIds);
    const mergedSet = new Set(mergedIds);
    temporalOnlyIds = allTempIds.filter(id => !mergedSet.has(id));
  }

  // Hot tier — inject recently stored/accessed memory IDs into candidate pool
  const hotIds = await hotTierGet(env);
  const mergedSet = new Set(mergedIds);
  const hotOnlyIds = hotIds.filter(id => !mergedSet.has(id));

  if (!results.matches.length && !ftsOnlyIds.length && !hotOnlyIds.length && !temporalOnlyIds.length) return [];

  // Entity boost — Mem0-style: embed each entity, query Vectorize, boost memories that appear
  // Attenuated by spread (more entity hits = lower individual boost, same as Mem0)
  const entityBoostMap = new Map<string, number>();

  // 1-hop entity graph traversal: lookup entity_nodes by name, pull connected memory IDs
  if (entityTokens.length > 0) {
    const entityNamePlaceholders = entityTokens.map(() => '?').join(',');
    const graphRows = await env.DB.prepare(
      `SELECT me.memory_id, COUNT(*) as shared_entities
       FROM entity_nodes en
       JOIN memory_entities me ON en.id = me.entity_id
       WHERE en.canonical_name IN (${entityNamePlaceholders})
       GROUP BY me.memory_id`
    ).bind(...entityTokens).all<{ memory_id: string; shared_entities: number }>().catch(() => ({ results: [] }));
    for (const r of (graphRows.results ?? [])) {
      const graphBoost = Math.min(0.2, 0.1 * r.shared_entities);
      entityBoostMap.set(r.memory_id, (entityBoostMap.get(r.memory_id) ?? 0) + graphBoost);
    }
  }

  if (entityTokens.length > 0) {
    const entityVecs = await batchEmbed(entityTokens, env);
    const entityQueries = entityVecs.map(ev =>
      env.VECTORIZE.query(Array.from(ev), { topK: 10, returnValues: false, returnMetadata: 'none' })
    );
    const entityResults = await Promise.all(entityQueries);
    for (const er of entityResults) {
      const matches = er.matches ?? [];
      const boost = Math.min(0.25, 0.5 / Math.max(1, matches.length)); // attenuate by spread
      for (const m of matches) {
        entityBoostMap.set(m.id, (entityBoostMap.get(m.id) ?? 0) + boost);
      }
    }
  }

  // Merge IDs for D1 fetch — hot tier first, then temporal candidates, then vector/fts,
  // then cluster-routed candidates (vague queries only — see useClusterRouting above).
  const clusterOnlyIds = clusterRoutedIds.filter(id => !results.matches.some(m => m.id === id));
  const hotAccessOnlyIds = hotAccessIds.filter(id => !results.matches.some(m => m.id === id));
  const allIds = [...new Set([...hotOnlyIds.slice(0, 10), ...temporalOnlyIds.slice(0, 15), ...results.matches.map(m => m.id), ...ftsOnlyIds, ...clusterOnlyIds, ...hotAccessOnlyIds])].slice(0, 120);
  const placeholders = allIds.map(() => '?').join(',');
  const { clause: projectClause, param: projectParam } = projectScopeClause(project, strictProject);
  const nowSec = Math.floor(Date.now() / 1000);
  const binds = projectParam ? [...allIds, projectParam, nowSec] : [...allIds, nowSec];
  const rows = await env.DB.prepare(
    `SELECT id, text, domain, cluster_id, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp, last_accessed
     FROM memories WHERE id IN (${placeholders}) ${projectClause} AND (valid_to IS NULL OR valid_to > ?)`
  ).bind(...binds).all<{
    id: string; text: string; domain: string; cluster_id: string | null; memory_type: string;
    sigma_diagonal: string; access_count: number; contradiction_flag: number; timestamp: number; last_accessed: number;
  }>();

  const cosineMap = new Map(results.matches.map(m => [m.id, m.score]));
  // Injected candidates (no real query cosine) get a SYNTHETIC score, kept in a separate
  // map so normalization can exempt them (see normalizeCosineBatch — running these through
  // min-max alongside real hits crushed them to ~0 and made the injection sources no-ops).
  // Temporal 0.5 > cluster-routed 0.45 (membership is weaker evidence than a date cue) >
  // access-frequency 0.35 (zero embedding relation by construction — wins on its boosts).
  const syntheticCosMap = new Map<string, number>();
  for (const id of temporalOnlyIds) { if (!cosineMap.has(id)) syntheticCosMap.set(id, 0.5); }
  for (const id of clusterOnlyIds) { if (!cosineMap.has(id) && !syntheticCosMap.has(id)) syntheticCosMap.set(id, 0.45); }
  for (const id of hotAccessOnlyIds) { if (!cosineMap.has(id) && !syntheticCosMap.has(id)) syntheticCosMap.set(id, 0.35); }
  const vectorMap = new Map(results.matches.map(m => [m.id, m.values as number[] ?? []]));

  // Cluster cohesion: batch-fetch entity links for all candidates in one D1 query.
  // Memories that co-occur in the same retrieval set and share entities form a belief cluster.
  // Cluster bonus rewards coherent knowledge clusters over isolated matching facts.
  const clusterCohesionMap = new Map<string, number>(); // memory_id → cohesion bonus
  if (allIds.length > 0) {
    const entPlaceholders = allIds.map(() => '?').join(',');
    const entRows = await env.DB.prepare(
      `SELECT memory_id, entity_id FROM memory_entities WHERE memory_id IN (${entPlaceholders})`
    ).bind(...allIds).all<{ memory_id: string; entity_id: string }>().catch(() => ({ results: [] }));

    // Build bidirectional maps: entity→members, memory→entities
    const entityToMembers = new Map<string, Set<string>>();
    const memToEntities = new Map<string, Set<string>>();
    for (const r of entRows.results ?? []) {
      if (!entityToMembers.has(r.entity_id)) entityToMembers.set(r.entity_id, new Set());
      entityToMembers.get(r.entity_id)?.add(r.memory_id);
      if (!memToEntities.has(r.memory_id)) memToEntities.set(r.memory_id, new Set());
      memToEntities.get(r.memory_id)?.add(r.entity_id);
    }

    // For each memory: count how many OTHER candidates in this retrieval share its entities
    for (const id of allIds) {
      const myEntities = memToEntities.get(id) ?? new Set<string>();
      let clusterSize = 0;
      for (const eid of myEntities) {
        const members = entityToMembers.get(eid) ?? new Set<string>();
        // Weight rare entities more — common entity (large cluster) = weaker signal
        const weight = 1 / Math.log2(Math.max(2, members.size));
        clusterSize += (members.size - 1) * weight;
      }
      if (clusterSize > 0) {
        // Capped lower (was 0.18 / 0.04·size): a tight cluster of near-duplicate session
        // summaries shares all entities and was being *rewarded* for it — the opposite of
        // what we want. MMR suppression handles the dups; cohesion stays a mild signal.
        clusterCohesionMap.set(id, Math.min(0.10, 0.03 * clusterSize));
      }
    }
  }

  // Build candidates — compute raw components first, then normalize within batch
  const NINETY_DAYS = 90 * 24 * 3600;

  // Quality gate: filter out bare strings, URLs, and sub-30-char fragments before scoring.
  // These get entity-boosted into top results despite having zero semantic value.
  const qualityRows = (rows.results ?? []).filter(row => {
    const t = (row.text ?? '').trim();
    if (t.length < 30) return false;                        // bare strings, IDs, names
    if (/^https?:\/\//.test(t)) return false;              // raw URLs
    if (/^[a-zA-Z0-9_.-]+$/.test(t)) return false;         // single token (file/package name)
    if ((t.match(/\s/g) ?? []).length < 3) return false;   // fewer than 4 words
    return true;
  });

  // Pass 1: compute raw scores
  const rawCandidates = qualityRows.map(row => {
    const memSigma = deserializeSigma(row.sigma_diagonal);
    const cosineSim = cosineMap.get(row.id) ?? 0;
    const syntheticCos = syntheticCosMap.get(row.id) ?? null;
    const lastAccessed = row.last_accessed ?? row.timestamp ?? 0;
    const recency = Math.max(0, 1 - (nowSec - lastAccessed) / NINETY_DAYS);
    const accessFreq = Math.min(1, Math.log1p(row.access_count ?? 0) / Math.log1p(50));
    const sigExcess = Math.max(0, meanSigma(memSigma) - querySigmaVal);
    const cosineWeighted = cosineSim * Math.max(0.75, 1.0 - 0.25 * sigExcess);
    const bm25Raw = bm25Map.get(row.id) ?? 0;
    return { row, memSigma, cosineWeighted, syntheticCos, recency, accessFreq, bm25Raw };
  });

  // Min-max normalization within batch — spreads scores across [0,1] per component.
  // Cosine: real hits min-max against each other; injected candidates keep their
  // synthetic value as the post-normalization score (see normalizeCosineBatch).
  const normCosine = normalizeCosineBatch(rawCandidates);
  const normRecency = minMaxNormalize(rawCandidates.map(c => c.recency));
  const normAccess = minMaxNormalize(rawCandidates.map(c => c.accessFreq));
  // BM25: if all candidates have zero score (no FTS5 hits), return zeros — not ones.
  // minMax's constant-array fallback of 1 is correct for cosine/recency but wrong for BM25:
  // zero signal should mean zero weight, not uniform +0.15 across all candidates.
  const bm25Vals = rawCandidates.map(c => c.bm25Raw);
  const normBm25 = bm25Vals.every(v => v === 0) ? bm25Vals.map(() => 0) : minMaxNormalize(bm25Vals);

  // Pass 2: build scored candidates using normalized components
  const candidates = rawCandidates.map(({ row, memSigma }, i) => {
    const entityBoost = Math.min(0.25, entityBoostMap.get(row.id) ?? 0);
    const rrfBoost = Math.min(0.1, (rrfScores.get(row.id) ?? 0) * 6); // reduced — BM25 now first-class
    const cohesionBonus = normCosine[i] >= 0.4 ? (clusterCohesionMap.get(row.id) ?? 0) : 0;
    // Temporal boost — memories whose timestamp falls within the cue window score higher.
    // "yesterday" → peak at 24h ago, falls off over a 2-day window (max +0.35).
    let temporalBoost = 0;
    if (temporalWindowDays >= 0) {
      const targetSec = nowSec - temporalWindowDays * 86400;
      const windowSec = 2 * 86400;
      const dist = Math.abs((row.timestamp ?? 0) - targetSec);
      if (dist <= windowSec) temporalBoost = 0.35 * (1 - dist / windowSec);
    }
    // Bhattacharyya distribution overlap: measures how well query and memory uncertainty match.
    const currentSigma = meanSigma(memSigma);
    const bhattScore = distributionalScore(normCosine[i], querySigmaVal, currentSigma);
    const bhattMultiplier = 0.70 + 0.70 * bhattScore;
    // BM25 as first-class rerank signal: keyword-matching memories surface even with mediocre cosine.
    // Weights: cosine (semantic) 50%, BM25 (keyword) 15%, recency 27%, access 8%. Recency raised /
    // access lowered from 22/13 (2026-07-07) — access_count was letting stale memories that got
    // surfaced repeatedly outrank newer, corrected ones (rich-get-richer); see isContradiction's
    // UNRESOLVED/RESOLVED class for the complementary fix at the retrieval-eligibility level.
    const baseScore = 0.50 * normCosine[i] + 0.15 * normBm25[i] + 0.27 * normRecency[i] + 0.08 * normAccess[i] + entityBoost + rrfBoost + cohesionBonus + temporalBoost;
    const primaryScore = baseScore * Math.min(1.40, Math.max(0.70, bhattMultiplier));
    const ageSeconds = nowSec - (row.timestamp ?? 0);
    return {
      id: row.id,
      text: row.text,
      domain: row.domain,
      cluster_id: row.cluster_id,
      type: row.memory_type,
      sigma: memSigma,
      primaryScore,
      normCosine: normCosine[i],
      vector: vectorMap.get(row.id) ?? [],
      contradiction: row.contradiction_flag === 1,
      // Decaying freshness: max boost (+0.10) at store time, fades to 0 over 48h.
      // Halved from +0.20 — recency is already counted in baseScore (0.22) and via the
      // hot tier, so the old value triple-counted recency and let fresh sessions run away.
      freshnessBoost: Math.min(0.10, Math.max(0, 0.10 * (1 - ageSeconds / (48 * 3600)))),
      isFileEdit: /^(Edited:|Worked on .+edited|Ran:)/i.test(row.text),
    };
  });

  // Top-3 primary hits become activation anchors
  const sorted = [...candidates].sort((a, b) => b.primaryScore - a.primaryScore);
  const anchors = sorted.slice(0, 3).filter(c => c.vector.length > 0);

  // Spreading activation: each candidate scores by proximity to anchors
  const scored = candidates.map(c => {
    // Neighborhood signal: how close is this memory to the activation anchors?
    let neighborScore = 0;
    if (anchors.length > 0 && c.vector.length > 0) {
      const sims = anchors
        .filter(a => a.id !== c.id)
        .map(a => dotProduct(a.vector, c.vector));
      if (sims.length) neighborScore = sims.reduce((s, v) => s + v, 0) / sims.length;
    }

    // Sigma weight: sharp memories (low sigma) radiate stronger activation
    const sigmaWeight = Math.max(0, 1 - meanSigma(c.sigma));

    // Contradiction penalty: contested memories are less trustworthy
    const contradictionFactor = c.contradiction ? 0.3 : 1.0;

    // Domain alignment boost
    const domainBoost = (domain && c.domain === domain) ? 0.05 : 0;

    // Session boost — relevance-scaled. Was a flat +0.20 on every session, which structurally
    // buried procedural/preference facts under recent session summaries on every query. Now
    // scaled by cosine (off-topic sessions get ~0) and only meaningfully lifted for temporal
    // or vague ("what were we working on") queries where sessions are the right target.
    const sessionRelevant = temporalWindowDays >= 0 || querySigmaVal > 0.6;
    const sessionBoost = c.type === 'session'
      ? (sessionRelevant ? 0.10 : 0.04) * c.normCosine
      : 0;

    const recencyBoost = c.freshnessBoost;

    // File-edit penalty: "Edited: foo.ts" memories have short generic embeddings
    // that falsely match almost any query — suppress unless no better candidates
    const fileEditPenalty = c.isFileEdit ? 0.55 : 1.0;

    const activation = (c.primaryScore
      + 0.4 * neighborScore * sigmaWeight * contradictionFactor
      + domainBoost
      + sessionBoost
      + recencyBoost) * fileEditPenalty;

    return { ...c, score: activation };
  });

  // σ tiebreaker: when two memories score within 0.05 of each other,
  // prefer the sharper one (lower σ = more reinforced, higher confidence).
  // This makes σ load-bearing without filtering — can't return empty results.
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 0.05) return diff;
    return meanSigma(a.sigma) - meanSigma(b.sigma); // lower σ wins ties
  });

  // Multi-hop BFS spreading activation (depth=2).
  // Hop 1: neighbours of top-3 direct hits. Hop 2: neighbours of hop-1 results.
  // returnValues: true so each hop's vectors feed the next frontier.
  // Score decays 0.6× per hop; 0.65 cosine threshold filters weak links.
  const BFS_DEPTH = 2;
  const seenIds = new Set(candidates.map(c => c.id));
  const activatedExtras: typeof scored = [];
  let frontier = scored.slice(0, 3)
    .filter(c => c.vector.length > 0)
    .map(c => ({ id: c.id, vector: c.vector }));

  for (let hop = 0; hop < BFS_DEPTH && frontier.length > 0; hop++) {
    const decay = 0.6 ** (hop + 1);
    // Only request vectors when there's a next hop to feed; final hop vectors are unused.
    const needValues = hop < BFS_DEPTH - 1;
    const neighborQueries = frontier.map(node =>
      env.VECTORIZE.query(node.vector, { topK: 3, returnValues: needValues, returnMetadata: 'indexed' })
    );
    const neighborResults = await Promise.all(neighborQueries);

    const newMatches = new Map<string, { score: number; values: number[] }>();
    for (const result of neighborResults) {
      for (const m of result.matches ?? []) {
        // Don't add to seenIds here — process all frontier results first so the
        // best score across all frontier nodes wins, not whichever fires first.
        if (!seenIds.has(m.id) && (m.score ?? 0) >= 0.65) {
          const activatedScore = (m.score ?? 0) * decay;
          // biome-ignore lint/style/noNonNullAssertion: guarded by the !has() short-circuit before the ||
          if (!newMatches.has(m.id) || newMatches.get(m.id)!.score < activatedScore) {
            newMatches.set(m.id, { score: activatedScore, values: (m.values as number[]) ?? [] });
          }
        }
      }
    }
    // Seal all matched IDs after processing the full hop so cross-frontier best-score wins.
    for (const id of newMatches.keys()) seenIds.add(id);

    if (newMatches.size === 0) break;

    const newIds = [...newMatches.keys()];
    // Mirror the main fetch's project scoping.
    const { clause: bfsProjectClause, param: bfsProjectParam } = projectScopeClause(project, strictProject);
    const bfsBinds = bfsProjectParam ? [...newIds, bfsProjectParam, nowSec] : [...newIds, nowSec];
    const newRows = await env.DB.prepare(
      `SELECT id, text, domain, cluster_id, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp, last_accessed
       FROM memories WHERE id IN (${newIds.map(() => '?').join(',')}) ${bfsProjectClause} AND (valid_to IS NULL OR valid_to > ?)`
    ).bind(...bfsBinds).all<{
      id: string; text: string; domain: string; cluster_id: string | null; memory_type: string;
      sigma_diagonal: string; access_count: number; contradiction_flag: number; timestamp: number; last_accessed: number;
    }>();

    frontier = [];
    for (const row of newRows.results ?? []) {
      const isFileEdit = /^(Edited:|Worked on .+edited|Ran:)/i.test(row.text);
      if (isFileEdit) continue;
      // Apply the same quality gate as the primary candidate path so BFS can't
      // re-surface items that were already rejected by quality filtering.
      const t = (row.text ?? '').trim();
      if (t.length < 30 || /^https?:\/\//.test(t) || /^[a-zA-Z0-9_.-]+$/.test(t) || (t.match(/\s/g) ?? []).length < 3) continue;
      const memSigma = deserializeSigma(row.sigma_diagonal);
      // biome-ignore lint/style/noNonNullAssertion: row.id comes from newIds, which is newMatches.keys()
      const match = newMatches.get(row.id)!;
      activatedExtras.push({
        id: row.id, text: row.text, domain: row.domain, cluster_id: row.cluster_id, type: row.memory_type,
        sigma: memSigma, primaryScore: match.score, score: match.score,
        vector: [], contradiction: row.contradiction_flag === 1,
        freshnessBoost: 0, isFileEdit: false, activated: true,
      } as any);
      if (match.values.length > 0) {
        frontier.push({ id: row.id, vector: match.values });
      }
    }
  }
  activatedExtras.sort((a, b) => b.score - a.score);

  // Near-duplicate suppression (MMR-style). The corpus stores the same session summary
  // once per domain; without this they self-reinforce (mutual neighbours + shared entities)
  // and flood injection 8-10x. Keep the highest-scored instance, drop later near-identical
  // ones — embedding cosine when both have vectors, token-Jaccard fallback otherwise.
  const kept = dedupBySimilarity(scored); // scored is already sorted desc by score

  // Threshold-based retrieval: return ALL above score floor, not a hard topK.
  // Context window is 200k — injecting 15 relevant memories costs nothing vs 5.
  // Floor = median of top-topK scores * 0.88, so we always get at least topK
  // but surface more when the corpus has genuinely relevant content.
  const topKSlice = kept.slice(0, topK);
  const floor = topKSlice.length > 0
    ? topKSlice[Math.floor(topKSlice.length / 2)].score * 0.88
    : 0;
  const injectCap = querySigmaVal < 0.4 ? topK * 3 : querySigmaVal > 0.7 ? topK : topK * 2;
  const top = kept.filter(c => c.score >= floor).slice(0, injectCap); // adaptive cap: precise→3×topK, vague→topK

  // Append activated associations not already in results
  const topIdSet = new Set(top.map(c => c.id));
  const bfsExtras = querySigmaVal < 0.5 ? 5 : 2;
  top.push(...activatedExtras.filter(a => !topIdSet.has(a.id)).slice(0, bfsExtras));

  // De-biasing: surface one high-value contradiction that got penalty-suppressed.
  // Skip if it already made the cut — top can extend past index topK, so without
  // this check the same memory could be injected twice.
  const suppressed = kept.slice(topK).find(c => c.contradiction && (c as any).primaryScore > 0.7 && !topIdSet.has(c.id));
  if (suppressed) top.push(suppressed);

  // Temporal de-biasing: activation clusters can drown temporal hits even with a score boost.
  // Guarantee up to 2 session summaries from the temporal window make it into results.
  if (temporalWindowDays >= 0 && allTemporalIds.size > 0) {
    const topIdSetTemp = new Set(top.map(c => c.id));
    const missedTemporalSessions = kept
      .filter(c => allTemporalIds.has(c.id) && c.type === 'session' && !topIdSetTemp.has(c.id))
      .slice(0, 2);
    top.push(...missedTemporalSessions);
  }

  // Final near-dup sweep: the BFS/temporal/contradiction de-biasing above can re-introduce
  // near-duplicates the main pass already dropped — collapse them once more before gating.
  const topDeduped = dedupBySimilarity(top);

  // σ hard gate: specific queries only surface memories whose confidence meets the
  // query's specificity requirement. Always keep at least 2 results to prevent empty injection.
  const finalTop = sigmaGate(topDeduped, querySigmaVal, 2);

  // Diversity cap: prevent same type/micro-cluster from flooding results.
  // Max 2 session summaries, max 3 from any single cluster_id — the raw, uncapped
  // internal grouping signal (microcluster.ts), not the human-facing capped/named
  // `domain` field. Memories without a cluster_id yet (pre-backfill) are exempt
  // rather than all bucketed under one null key, so old rows aren't penalized as
  // if they were one giant cluster.
  const diversityCapped = applyDiversityCap(finalTop);
  // If diversity cap is too aggressive (< 2 results), fall back to finalTop
  const postDiversity = diversityCapped.length >= 2 ? diversityCapped : finalTop;

  // Sharpen accessed memories + record history if σ changed meaningfully.
  // Batched: previously one UPDATE (+ optional INSERT) + one KV read-modify-write
  // per memory — N+1 D1 round-trips and racy KV writes on every retrieve.
  // Skipped entirely under opts.frozen (benchmark trials must not mutate the store).
  if (!opts.frozen) {
    const now = Math.floor(Date.now() / 1000);
    const writeStmts: D1PreparedStatement[] = [];
    for (const mem of postDiversity) {
      const domSize = domainSizeMap.get(mem.domain) ?? 10;
      const newSigma = sharpenSigma(mem.sigma, 0.85, 0.15, mem.contradiction, domSize);
      writeStmts.push(env.DB.prepare(
        'UPDATE memories SET last_accessed = ?, access_count = access_count + 1, sigma_diagonal = ? WHERE id = ?'
      ).bind(now, serializeSigma(newSigma), mem.id));
      // Record sigma history if it moved by more than 0.05 — avoids spammy writes on tiny changes
      const oldMean = meanSigma(mem.sigma);
      const newMean = meanSigma(newSigma);
      if (Math.abs(newMean - oldMean) >= 0.05) {
        writeStmts.push(env.DB.prepare(
          'INSERT INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), mem.id, newMean, 'sharpen', now));
      }
    }
    if (writeStmts.length) await env.DB.batch(writeStmts).catch(() => {});
    await hotTierAddMany(postDiversity.map(m => m.id), env); // hot tier = recently accessed, not recently stored
  }

  // Check memory_relations: mark superseded memories so caller knows they've been replaced
  const topIds = postDiversity.map(m => m.id);
  const supersededSet = new Set<string>();
  if (topIds.length > 0) {
    const relRows = await env.DB.prepare(
      `SELECT to_id FROM memory_relations WHERE relation_type = 'supersedes' AND to_id IN (${topIds.map(() => '?').join(',')})`
    ).bind(...topIds).all<{ to_id: string }>();
    for (const r of relRows.results ?? []) supersededSet.add(r.to_id);
  }

  return postDiversity.map(m => {
    const sig = meanSigma(m.sigma);
    const drift = sig < 0.35 ? '↑' : sig > 0.6 ? '↓' : '→';
    const cohesion = clusterCohesionMap.get(m.id) ?? 0;
    const clusterMark = cohesion > 0.08 ? ' ◆' : cohesion > 0.03 ? ' ◇' : '';
    const baseText = supersededSet.has(m.id)
      ? `[SUPERSEDED] ${m.text}`
      : m.contradiction ? `[CONTRADICTED — re-evaluate] ${m.text}` : m.text;
    return {
      id: m.id,                                      // internal/bench only — tools.ts text format never prints it
      score: m.score,
      text: baseText,
      domain: m.domain,                              // clean — used for KV summary lookup
      displayDomain: `${m.domain} ${drift}${clusterMark}`, // markers for display only
      type: m.type,
      activated: (m as any).activated ?? false,
      sigma: parseFloat(sig.toFixed(3)),
    };
  });
}
