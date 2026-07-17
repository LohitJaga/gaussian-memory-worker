import type { Env } from './types';
import { embed, dotProduct } from './embed';
import {
  initialSigma, deserializeSigma, serializeSigma,
  kalmanMerge, shouldMerge, meanSigma,
} from './gaussian';
import { callAI, QuotaExceededError } from './ai';

// Live-deployment migration: pending_ingest doesn't exist on already-deployed D1 databases.
// CREATE TABLE IF NOT EXISTS is natively idempotent (unlike ALTER TABLE ADD COLUMN, which SQLite
// has no IF NOT EXISTS form for — see ensureDomainColumns in domain.ts for that pattern), so no
// try/catch-and-swallow dance is needed here, just a plain guarded call before first use.
export async function ensurePendingIngestTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pending_ingest (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'default',
      domain TEXT,
      created_at INTEGER NOT NULL
    )`
  ).run().catch(() => {});
}

const HOT_KEY = 'hot:recent_ids';
const HOT_TTL = 86400; // 24h
const HOT_MAX = 100;

// Closes the Vectorize propagation-lag gap (2-5 min, per the D1 exact-text
// check above) for near-duplicate merge detection specifically. A memory
// stored moments ago and reworded slightly by the LLM extractor won't be an
// exact-text match and won't be in the Vectorize index yet either, so it was
// invisible to storeMemory's merge check entirely — this cache makes it
// visible immediately by keeping embeddings in KV (read-after-write
// consistent) instead of waiting on Vectorize.
const RECENT_EMBEDDINGS_KEY = 'recent:store_embeddings';
const RECENT_EMBEDDINGS_TTL = 600; // 10 min — comfortably past the documented lag
const RECENT_EMBEDDINGS_MAX = 50;

// project (2026-07-17): carried so storeMemory's merge-candidate check can stay
// project-scoped even for the Vectorize-lag window this cache exists to cover —
// without it, a paraphrase stored minutes apart under a DIFFERENT project could
// become a merge candidate here after the main Vectorize search was scoped.
// Optional only for decode compatibility with entries written before the field
// existed; those age out within RECENT_EMBEDDINGS_TTL and never match any project.
interface RecentEmbedding { id: string; mu: number[]; domain: string; ts: number; project?: string }

async function recentEmbeddingsGet(env: Env): Promise<RecentEmbedding[]> {
  try {
    const raw = await env.KV.get(RECENT_EMBEDDINGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function recentEmbeddingsAdd(id: string, mu: Float32Array, domain: string, project: string, env: Env): Promise<void> {
  try {
    const existing = await recentEmbeddingsGet(env);
    const updated = [{ id, mu: Array.from(mu), domain, project, ts: Math.floor(Date.now() / 1000) }, ...existing]
      .slice(0, RECENT_EMBEDDINGS_MAX);
    await env.KV.put(RECENT_EMBEDDINGS_KEY, JSON.stringify(updated), { expirationTtl: RECENT_EMBEDDINGS_TTL });
  } catch {}
}

export async function hotTierAdd(id: string, env: Env): Promise<void> {
  try {
    const raw = await env.KV.get(HOT_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    const updated = [id, ...ids.filter(i => i !== id)].slice(0, HOT_MAX);
    await env.KV.put(HOT_KEY, JSON.stringify(updated), { expirationTtl: HOT_TTL });
  } catch {}
}

// Batch variant — one KV read-modify-write for N ids instead of N round-trips.
// Used by retrieve() which previously called hotTierAdd per result (N+1 KV writes, racy).
export async function hotTierAddMany(ids: string[], env: Env): Promise<void> {
  if (!ids.length) return;
  try {
    const raw = await env.KV.get(HOT_KEY);
    const existing: string[] = raw ? JSON.parse(raw) : [];
    const incoming = new Set(ids);
    const updated = [...ids, ...existing.filter(i => !incoming.has(i))].slice(0, HOT_MAX);
    await env.KV.put(HOT_KEY, JSON.stringify(updated), { expirationTtl: HOT_TTL });
  } catch {}
}

export async function hotTierGet(env: Env): Promise<string[]> {
  try {
    const raw = await env.KV.get(HOT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function extractAndLinkEntities(memoryId: string, text: string, env: Env): Promise<void> {
  // Queue for cron processing — Llama calls too slow for fire-and-forget in Workers context
  try {
    const raw = await env.KV.get('pending_entity_queue');
    const queue: Array<{id: string; text: string}> = raw ? JSON.parse(raw) : [];
    queue.push({ id: memoryId, text: text.slice(0, 300) });
    await env.KV.put('pending_entity_queue', JSON.stringify(queue.slice(-200))); // cap at 200
  } catch {}
}

export async function processPendingEntityQueue(env: Env): Promise<void> {
  try {
    const raw = await env.KV.get('pending_entity_queue');
    if (!raw) return;
    const queue: Array<{id: string; text: string}> = JSON.parse(raw);
    if (!queue.length) return;
    const batch = queue.splice(0, 50); // process up to 50 per cron run
    await env.KV.put('pending_entity_queue', JSON.stringify(queue));
    const now = Math.floor(Date.now() / 1000);
    for (const item of batch) {
      const result = await callAI(env, '@cf/meta/llama-3.2-3b-instruct', {
        messages: [
          { role: 'system', content: `Extract named entities. Return ONLY a JSON array of "type:name" strings. Max 4. Types: tool, project, concept, parameter, person. Return [] if none. Example: ["tool:GLM-4.7-flash","concept:spreading activation"]` },
          { role: 'user', content: item.text },
        ],
        max_tokens: 128, temperature: 0,
      }) as any;
      const rawEnt = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
      const match = rawEnt.match(/\[[\s\S]*?\]/);
      if (!match) continue;
      const entities = JSON.parse(match[0]) as string[];
      const ops: any[] = [];
      for (const ent of entities) {
        const colonIdx = ent.indexOf(':');
        if (colonIdx < 0) continue;
        const type = ent.slice(0, colonIdx).trim();
        const name = ent.slice(colonIdx + 1).trim();
        if (!type || !name) continue;
        const entId = `ent_${type}_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
        ops.push(env.DB.prepare(`INSERT OR IGNORE INTO entity_nodes (id, type, canonical_name, last_seen) VALUES (?,?,?,?)`).bind(entId, type, name, now));
        ops.push(env.DB.prepare(`UPDATE entity_nodes SET last_seen = ? WHERE id = ?`).bind(now, entId));
        ops.push(env.DB.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, entity_span) VALUES (?,?,?)`).bind(item.id, entId, name));
      }
      if (ops.length > 0) await env.DB.batch(ops);
    }
  } catch (e) {
    console.error('[entity-queue]', e);
  }
}

export const NEGATION = /\b(no longer|stop using|stopped using|don't use|switched from|instead of|avoid using|shouldn't use|never use|removed|disabled|deprecated)\b/i;

// Status-flip phrasing: a bug going from "broken" to "fixed" is a contradiction too, but
// isn't a tool-switch negation — different vocabulary class, so it's a separate pair of
// regexes rather than an addition to NEGATION.
export const UNRESOLVED = /\b(still (has |have )?(an? )?(major |minor )?issues?|still broken|doesn't work|does not work|not working|unresolved|known issue|don't trust this|not fixed)\b/i;
// Negative lookbehinds on the bare "fixed"/"resolved" alternatives — without them, "not fixed"
// (already a whole UNRESOLVED phrase above) also satisfies RESOLVED's bare `fixed`, so two
// memories that both say "not fixed" would match RESOLVED on one side and UNRESOLVED on the
// other and be flagged as contradicting, even though they agree the issue is unresolved. Scans
// up to 3 words back (not just the immediately preceding word) — a single-word lookbehind missed
// "not yet fixed"/"never really resolved" (confirmed live 2026-07-07: real, natural phrasing, not
// an edge case). "n't" gets its own lookbehind without a leading \b since it's always attached to
// the preceding word ("isn't") with no word boundary before the "n".
export const RESOLVED = /\b(?<!\b(?:not|never)\b(?:\s+\w+){0,3}\s+)(?<!n't(?:\s+\w+){0,3}\s+)fixed\b|\b(?<!\b(?:not|never)\b(?:\s+\w+){0,3}\s+)(?<!n't(?:\s+\w+){0,3}\s+)resolved\b|\bnow works?\b|\bworks? now\b|\bverified (working|fixed)\b|\bconfirmed (working|fixed)\b/i;

const NEGATION_COSINE_FLOOR = 0.88;
// Status-flip pairs reword more than tool-switch pairs do ("switched from X" keeps "X" verbatim;
// "still has issues" -> "now fixed" often doesn't share much surface text at all), so a shared
// 0.88 floor under-fires on them (confirmed empirically 2026-07-07: a heavily-reworded real pair
// stayed below 0.88 despite both sides clearing the UNRESOLVED/RESOLVED regex). Safe to run lower
// here specifically because this class is already gated on both sides by curated vocabulary,
// unlike a bare cosine check — the regex carries the precision NEGATION gets from its 0.88 floor.
const STATUS_COSINE_FLOOR = 0.75;

// Two independent contradiction classes, each with its own cosine floor: negation language
// ("switched from X" vs "using X") at 0.88, or disagreement on resolution status
// ("still has issues" vs "resolved") at 0.75.
export function isContradiction(newText: string, existingText: string, cosineSim: number): boolean {
  if (cosineSim >= NEGATION_COSINE_FLOOR && NEGATION.test(newText) !== NEGATION.test(existingText)) {
    return true;
  }
  if (cosineSim >= STATUS_COSINE_FLOOR) {
    return (RESOLVED.test(newText) && UNRESOLVED.test(existingText)) ||
           (UNRESOLVED.test(newText) && RESOLVED.test(existingText));
  }
  return false;
}

// Decides how a judged 'supersedes' verdict should be persisted. Callers read to_id as "the
// memory being replaced" (from_id supersedes to_id), but the LLM-judged pair (target/cand)
// isn't reliably ordered newer-first — memory_judge's auto-queue pulls target from
// contradiction_flag=1 rows, which storage.ts always sets on the OLDER side of a pair. Re-orient
// by timestamp so the relation is stored (newer -> older) regardless of which one was target/cand.
export function resolveSupersedeDirection(
  target: { id: string; timestamp: number },
  cand: { id: string; timestamp: number },
): { fromId: string; toId: string; olderId: string; newerId: string } {
  const olderId = (target.timestamp ?? 0) <= (cand.timestamp ?? 0) ? target.id : cand.id;
  const newerId = olderId === target.id ? cand.id : target.id;
  return { fromId: newerId, toId: olderId, olderId, newerId };
}

const FTS_STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'was', 'were',
  'are', 'not', 'now', 'still', 'been', 'into', 'about', 'when', 'then', 'than', 'also',
]);

// Builds a safe FTS5 MATCH query from arbitrary text (memory bodies, not short search queries).
// retrieval.ts's `replace(/['"*()]/g, ' ')` sanitization is fine for short natural-language user
// queries, but breaks on long memory text: FTS5's grammar treats `:` as a column filter, `-`
// directly before a term as NOT, and (confirmed live 2026-07-07 against real memory text) even
// plain commas can trip the parser on long inputs — the query silently returns zero results
// since callers wrap this in .catch(() => []). It's also too restrictive even when it doesn't
// error: FTS5's default is implicit AND between bareword terms, so a 70-word memory text as a
// query requires literally every word to appear in a candidate, which is essentially always zero
// matches. Tokenizing to bare alphanumeric words and OR-joining each as a quoted phrase fixes
// both: quoted alphanumeric-only terms can't be misparsed as operators, and OR means partial
// keyword overlap is enough — this is meant to be a low-precision, high-recall signal, not exact
// matching (the LLM verdict call downstream is the real precision gate). Sorted longest-first
// before truncating to maxTerms — taking first-N in original sentence order (tried first, then
// reverted 2026-07-07) cut off the actual significant words on longer memories, since the
// specific/technical vocabulary that makes a good keyword doesn't reliably show up early in a
// sentence; longer words are a cheap, effective proxy for "specific" over "common filler".
export function buildKeywordQuery(text: string, maxTerms = 20): string {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter(t => t.length >= 4 && !FTS_STOPWORDS.has(t))
    .sort((a, b) => b.length - a.length)
    .slice(0, maxTerms);
  return terms.map(t => `"${t}"`).join(' OR ');
}

// Graphiti-style exact-match normalization: strips punctuation/case/whitespace differences
// so trivial surface variation ("Fixed bug!" vs "fixed bug") is recognized as the same text.
export function normalizeForExactMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Pure merge-candidate selection for storeMemory — extracted (2026-07-17) so the
// same-project eligibility invariant is unit-testable without a D1/Vectorize harness.
// Invariants owned here:
//  - PROJECT: only rows whose D1 project equals the storing project are eligible merge
//    winners. The merge UPDATE overwrites the winner's text/domain/vector but never its
//    D1 `project` column, so a cross-project winner silently teleports content across a
//    project boundary (and strands the row from project-scoped cleanup — see the
//    Vectorize-query block comment in storeMemory). The upstream candidate sources are
//    already project-filtered; this guard makes the invariant hold no matter how a
//    candidate got into the list.
//
//    Deliberately STRICT AND SYMMETRIC — 'default' gets no special treatment in either
//    direction. An asymmetric rule (named store may absorb a default row, default store
//    stays narrow) was evaluated and rejected 2026-07-17 against live data:
//    (1) synthetic/eval corpora are themselves named projects ('locomo-eval'), so
//        named→default merge permission re-opens the exact incident this fix closed —
//        destructive benchmark writes into the default bucket, 46% of the corpus;
//    (2) the measured duplication pattern is cwd-noise, not "generic fact restated in
//        its own project": the same fact shows up under default + multiple named
//        projects (project tags follow the session's working directory, not content),
//        so named↔named restatement is as common as default↔named and the asymmetric
//        rule wouldn't fix the dominant case anyway;
//    (3) the default copy of a restated fact is the only copy other projects can see
//        (named-context reads are own+default — projectScopeClause, retrieval.ts), so
//        "absorbing" it destructively rewrites the one globally-visible copy.
//    The duplication this strictness allows is handled non-destructively where it
//    belongs: retrieval-time dedupBySimilarity collapses near-dup restatements at
//    injection, memory_dedupe handles exact text.
//  - CLUSTER: cross-cluster dedup keeps a looser ceiling (0.90) for session summaries
//    (same content tagged per-cluster — collapse at the source instead of spawning 6-10
//    rows that later flood retrieval) and a strict one (0.97) otherwise. Reads
//    cluster_id from D1 rows, not Vectorize metadata — cluster_id isn't written to
//    Vectorize at all (see microcluster.ts), and D1 is read-after-write consistent.
export interface MergeCandidateRow { sigma_diagonal: string; text: string; cluster_id: string | null; project: string }
export function selectMergeCandidate(
  matches: { id: string; score?: number }[],
  rowMap: Map<string, MergeCandidateRow>,
  project: string,
  clusterId: string | null,
  memoryType: string,
): { bestId: string | null; bestSigma: Float32Array | null } {
  let bestId: string | null = null;
  let bestDist = Infinity;
  let bestSigma: Float32Array | null = null;

  for (const match of matches) {
    const row = rowMap.get(match.id);
    if (!row) continue;
    if (row.project !== project) continue;

    const score = match.score ?? 0;
    const crossClusterCeil = memoryType === 'session' ? 0.90 : 0.97;
    if (row.cluster_id && clusterId && row.cluster_id !== clusterId && score < crossClusterCeil) continue;

    const approxDist = 0.5 * (1 - score);
    if (approxDist < bestDist) {
      bestDist = approxDist;
      bestId = match.id;
      bestSigma = deserializeSigma(row.sigma_diagonal);
    }
  }
  return { bestId, bestSigma };
}

export async function storeMemory(
  text: string, memoryType: string, domain: string,
  emotionalIntensity: number, env: Env,
  precomputedMu?: Float32Array,
  project: string = 'default',
  clusterId: string | null = null
): Promise<{ action: string; id: string; conflict_candidates?: Array<{ id: string; text: string; score: number }> }> {
  let mu: Float32Array;
  try {
    mu = precomputedMu ?? await embed(text, env);
  } catch (e) {
    if (!(e instanceof QuotaExceededError)) throw e;
    // Workers AI daily quota exhausted mid-embed — don't drop the write. Queue it to
    // pending_ingest (NOT the memories table: a vectorless row here would need merge/dedup,
    // contradiction detection, domain classification, and microcluster assignment all taught to
    // tolerate a missing embedding, none of which they do today) and let the nightly
    // drainPendingIngest cron step (tools.ts) run it through this exact same function again,
    // for real, once quota resets at 00:00 UTC.
    await ensurePendingIngestTable(env);
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO pending_ingest (id, kind, payload, project, domain, created_at) VALUES (?, 'fact', ?, ?, ?, ?)`
    ).bind(id, text, project, domain, now).run();
    return { action: 'queued_pending', id };
  }
  const dim = mu.length;
  const sigma = initialSigma(domain, emotionalIntensity, dim);
  const now = Math.floor(Date.now() / 1000);

  // D1 exact-text check before Vectorize — Vectorize has 2-5 min propagation lag so
  // a second ingest of the same text would spawn a duplicate before Vectorize indexes it.
  // Project-scoped (2026-07-17): unscoped, this returned 'merged' against another
  // project's row, so the fact silently ended up existing ONLY in that other project —
  // a real cross-project leak for the caller, who stored into theirs and got nothing.
  const exactRow = await env.DB.prepare(
    `SELECT id, sigma_diagonal FROM memories WHERE text = ? AND project = ? LIMIT 1`
  ).bind(text, project).first<{ id: string; sigma_diagonal: string }>().catch(() => null);
  if (exactRow) {
    const existingSigma = deserializeSigma(exactRow.sigma_diagonal);
    const [, newSigma] = kalmanMerge(mu, existingSigma, mu, existingSigma);
    await env.DB.prepare(
      `UPDATE memories SET sigma_diagonal = ?, last_accessed = ?, access_count = access_count + 1 WHERE id = ?`
    ).bind(serializeSigma(newSigma), now, exactRow.id).run();
    return { action: 'merged', id: exactRow.id };
  }

  // Coarse search via Vectorize (no domain filter so same-text re-ingests always merge
  // regardless of domain reclassification; Bhattacharyya distance handles isolation), the FTS5
  // keyword query (for contradiction detection — see below), and the recent-cache KV read all
  // run in parallel: none of the three depend on each other's result, so awaiting them
  // sequentially (as an earlier version of this function did) was pure added latency on the
  // write hot path (storeMemory fires on every memory_store/auto_store/extract_and_store call,
  // including the PostToolUse hook on every Bash/Write in Claude Code sessions).
  //
  // Project-scoped as of 2026-07-17 (strict, including 'default' — a store may only merge
  // into rows of its OWN project): this query was globally unscoped, so a store under one
  // project could select a merge winner from ANY project — and the merge UPDATE below
  // overwrites the winner's text/domain/vector while leaving its D1 `project` column
  // untouched. Concrete hazard traced during the LoCoMo post-mortem (2026-07-16): a
  // benchmark chunk (project='locomo-eval') merging into a real default-project memory
  // would have destroyed its content while stranding the row from the project-scoped
  // cleanup; the reverse direction would have routed a real memory's content into a row
  // the cleanup then deleted. The project metadata index this filter needs exists and
  // covers the full corpus (re-upserted, confirmed live 2026-07-10 — see retrieval.ts's
  // projectScopeClause block). Contradiction DETECTION below deliberately keeps its
  // wider view (FTS5 candidates are not project-filtered): it only sets a flag, never
  // rewrites content, and cross-project contradictions are real signal.
  const ftsQuery = buildKeywordQuery(text);
  const [results, ftsRows, recentEmbeddings] = await Promise.all([
    env.VECTORIZE.query(Array.from(mu), { topK: 10, returnValues: false, returnMetadata: 'indexed', filter: { project } }),
    ftsQuery.length > 0
      ? env.DB.prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 10`)
          .bind(ftsQuery).all<{ id: string }>().catch(() => ({ results: [] as { id: string }[] }))
      : Promise.resolve({ results: [] as { id: string }[] }),
    recentEmbeddingsGet(env),
  ]);

  // Recent-cache candidates: memories stored in the last ~10 min may not be in
  // Vectorize yet (2-5 min propagation lag), so a same-minute paraphrase would
  // otherwise never become a merge candidate at all. Compute cosine locally
  // against the KV cache (immediately consistent) and fold matches above a
  // low floor into the same candidate list the rest of this function already
  // scores — real merge/contradiction decisions still go through the existing
  // Bhattacharyya/shouldMerge logic below, this only fixes candidate recall.
  const recentMuArr = Array.from(mu);
  const recentCandidates = recentEmbeddings
    // Same strict project scope as the Vectorize query above — entries written before
    // the cache carried a project never match and age out within the TTL.
    .filter(r => r.ts > now - RECENT_EMBEDDINGS_TTL && r.project === project)
    .map(r => ({ id: r.id, score: dotProduct(recentMuArr, r.mu), metadata: { domain: r.domain } }))
    .filter(r => r.score > 0.5);

  const seenIds = new Set(results.matches.map(m => m.id));
  const matches = [
    ...results.matches,
    ...recentCandidates.filter(r => !seenIds.has(r.id)),
  ];

  // FTS5 keyword candidates — for contradiction detection only, not merge/dedup. Vectorize's
  // cosine search misses topically-related-but-lexically-distant pairs entirely (confirmed live
  // 2026-07-07: a real "domain rebuild has issues" vs "domain/cluster_id split resolved" pair
  // sat below 0.70 cosine, never appearing in Vectorize's own top 10, but shared literal
  // keywords). Fetches stored vectors via getByIds (20-id cap, same pattern as rebuild.ts — the
  // FTS query above is hardcoded to LIMIT 10, comfortably under that) to compute a real local
  // cosine (dotProduct over unit-normalized embeddings, same technique as recentCandidates
  // above) so isContradiction still gets a real score to gate on — merge/dedup deliberately does
  // NOT see these, only the contradiction loop below does. `.catch()` guards this the same way
  // the FTS5 query above is guarded — without it, a transient Vectorize error here would hard-fail
  // the entire store call instead of just skipping the keyword-candidate signal for this write.
  const matchIds = new Set(matches.map(m => m.id));
  // Sliced to 20 defensively — getByIds hard-caps there (VECTOR_GET_ERROR 40007 above it, per
  // rebuild.ts). Currently ftsOnlyIds is already <=10 from the FTS LIMIT above, but that's a
  // coincidence of an unrelated constant, not a structural guarantee tying the two together.
  const ftsOnlyIds = (ftsRows.results ?? []).map(r => r.id).filter(id => !matchIds.has(id)).slice(0, 20);
  const ftsCandidates = ftsOnlyIds.length > 0
    ? ((await env.VECTORIZE.getByIds(ftsOnlyIds).catch(() => [])) ?? [])
        .filter(v => v.values)
        .map(v => ({ id: v.id, score: dotProduct(recentMuArr, Array.from(v.values as number[])) }))
    : [];
  const contradictionMatches = [...matches, ...ftsCandidates];

  // Batch fetch all candidate rows in one D1 query instead of N sequential selects.
  // `project` is fetched so the merge paths below can enforce same-project eligibility
  // even for rows that entered rowMap via the (deliberately unscoped) FTS5 arm.
  const candidateIds = [...matchIds, ...ftsOnlyIds];
  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = candidateIds.length > 0
    ? await env.DB.prepare(
        `SELECT id, sigma_diagonal, text, cluster_id, project FROM memories WHERE id IN (${placeholders})`
      ).bind(...candidateIds).all<{ id: string; sigma_diagonal: string; text: string; cluster_id: string | null; project: string }>()
    : { results: [] };
  const rowMap = new Map(rows.results.map(r => [r.id, r]));

  // Graphiti-style fast path: exact normalized match skips Bhattacharyya entirely.
  // Catches same-text re-ingestion with trivial surface differences (case, punctuation).
  // Same-project only — rowMap includes FTS5-sourced rows from other projects (kept for
  // contradiction detection), which must not become merge targets (see the block comment
  // on the Vectorize query above).
  const normalizedNew = normalizeForExactMatch(text);
  for (const row of rows.results) {
    if (row.project !== project) continue;
    if (normalizeForExactMatch(row.text) === normalizedNew) {
      const existingSigma = deserializeSigma(row.sigma_diagonal);
      const [, newSigma] = kalmanMerge(mu, existingSigma, mu, existingSigma);
      const exactTypeClause = memoryType === 'session' ? ', memory_type = ?' : '';
      const exactTypeParams = memoryType === 'session'
        ? [serializeSigma(newSigma), Math.floor(Date.now() / 1000), 'session', row.id]
        : [serializeSigma(newSigma), Math.floor(Date.now() / 1000), row.id];
      await env.DB.prepare(
        `UPDATE memories SET sigma_diagonal = ?, last_accessed = ?, access_count = access_count + 1${exactTypeClause} WHERE id = ?`
      ).bind(...exactTypeParams).run();
      return { action: 'merged', id: row.id };
    }
  }

  const { bestId, bestSigma } = selectMergeCandidate(matches, rowMap, project, clusterId, memoryType);

  // Contradiction check: scans ALL candidates independently (Vectorize + recent-cache + FTS5
  // keyword matches above), not just the merge-selected bestId. Three bugs found 2026-07-07
  // (code review) made this necessary: (1) a closer, non-contradicting candidate would silently
  // win the single bestId slot and prevent a real but lower-cosine contradiction from ever being
  // checked; (2) the cross-cluster ceiling above exists for merge precision, but reworded
  // status-flip pairs (what the 0.75 STATUS_COSINE_FLOOR was added for) are exactly the kind
  // likely to land in a different cluster — gating them on the merge ceiling made that floor
  // unreachable in practice; (3) topically-related-but-lexically-distant pairs never appear in
  // Vectorize's candidates at all (see ftsCandidates above). Contradiction detection has its own
  // precision guard (the NEGATION/UNRESOLVED/RESOLVED regexes + their own cosine floors), so it
  // doesn't need the merge ceiling's protection.
  let contradictionId: string | null = null;
  let contradictionText: string | null = null;
  for (const match of contradictionMatches) {
    const row = rowMap.get(match.id);
    if (!row) continue;
    if (isContradiction(text, row.text, match.score ?? 0)) {
      contradictionId = match.id;
      contradictionText = row.text;
      break;
    }
  }

  if (contradictionId && contradictionText) {
    await env.DB.prepare('UPDATE memories SET contradiction_flag = 1 WHERE id = ?')
      .bind(contradictionId).run();
    // Fall through to spawn WITHOUT contradiction_flag set — only the older/existing side
    // (contradictionId, above) gets flagged. The new memory is presumptively the current,
    // correct information and shouldn't eat the retrieval penalty (contradictionFactor=0.3
    // in retrieval.ts) for the ~24h until the nightly auto-judge cron resolves the pair.
    // Confirmed live 2026-07-15: hardcoding 1 here suppressed a same-day backfilled
    // correction alongside the stale memory it was replacing, right when it mattered most.
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO memories
        (id, text, sigma_diagonal, timestamp, last_accessed,
         access_count, memory_type, domain, emotional_intensity, contradiction_flag, project, valid_from, cluster_id)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?)
    `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity, project, now, clusterId).run();
    await env.DB.prepare(`INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)`)
      .bind(id, text, project).run().catch(() => {});
    await env.VECTORIZE.upsert([{ id, values: Array.from(mu), metadata: { domain, memory_type: memoryType, project } }]);
    await recentEmbeddingsAdd(id, mu, domain, project, env); // visible to merge-check immediately, unlike Vectorize
    await extractAndLinkEntities(id, text, env); // awaited — KV write must complete
    // Record initial σ — baseline for belief drift tracking
    await env.DB.prepare(
      'INSERT INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), id, meanSigma(sigma), 'store', now).run().catch(() => {});
    return { action: 'contradiction', id };
  }

  // Use tighter threshold for cross-cluster merges (0.08) vs same-cluster (0.20).
  // Reads cluster_id from rowMap (D1), same reasoning as the ceiling check above.
  const bestRow = bestId ? rowMap.get(bestId) : undefined;
  const mergeThreshold = (bestRow && clusterId && bestRow.cluster_id === clusterId) ? 0.20 : 0.08;
  if (bestId && bestSigma && shouldMerge(mu, sigma, mu, bestSigma, mergeThreshold)) {
    const [, newSigma] = kalmanMerge(mu, sigma, mu, bestSigma);

    // Preserve 'session' type on merge — session summaries must not silently become episodic
    const typeUpdate = memoryType === 'session' ? ', memory_type = ?' : '';
    const typeParams = memoryType === 'session'
      ? [serializeSigma(newSigma), now, text, domain, 'session', bestId]
      : [serializeSigma(newSigma), now, text, domain, bestId];
    await env.DB.prepare(`
      UPDATE memories SET
        sigma_diagonal = ?, last_accessed = ?,
        access_count = access_count + 1, text = ?, domain = ?${typeUpdate}
      WHERE id = ?
    `).bind(...typeParams).run();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(bestId),
      env.DB.prepare('INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)').bind(bestId, text, project),
    ]).catch(() => {});

    await env.VECTORIZE.upsert([{
      id: bestId,
      values: Array.from(mu),
      metadata: { domain, memory_type: memoryType, project },
    }]);

    return { action: 'merged', id: bestId };
  }

  // Spawn new
  const id = crypto.randomUUID();

  // Batched: 3 D1 writes (memories, fts, sigma_history baseline) in one round-trip
  // instead of 3 sequential ones — this is the write hot path (fires on every
  // memory_store/auto_store call, including the PostToolUse hook on every Bash/Write).
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO memories
        (id, text, sigma_diagonal, timestamp, last_accessed,
         access_count, memory_type, domain, emotional_intensity, project, valid_from, cluster_id)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity, project, now, clusterId),
    env.DB.prepare(`INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)`).bind(id, text, project),
    // Record initial σ — baseline for belief drift tracking
    env.DB.prepare(
      'INSERT INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), id, meanSigma(sigma), 'store', now),
  ]);

  // Vectorize upsert and the two KV bookkeeping writes touch independent stores —
  // none depends on another's result, so run them in parallel.
  await Promise.all([
    env.VECTORIZE.upsert([{
      id,
      values: Array.from(mu),
      metadata: { domain, memory_type: memoryType, project },
    }]),
    recentEmbeddingsAdd(id, mu, domain, project, env), // visible to merge-check immediately, unlike Vectorize
    extractAndLinkEntities(id, text, env), // awaited — KV write must complete
  ]);

  // Surface near-miss candidates (score > 0.85, not merged) for memory_judge
  const nearMissIds = matches
    .filter(m => m.score > 0.85 && m.id !== id)
    .map(m => m.id);

  let conflict_candidates: Array<{ id: string; text: string; score: number }> | undefined;
  if (nearMissIds.length > 0) {
    const nearPlaceholders = nearMissIds.map(() => '?').join(',');
    const nearRows = await env.DB.prepare(
      `SELECT id, text FROM memories WHERE id IN (${nearPlaceholders})`
    ).bind(...nearMissIds).all<{ id: string; text: string }>();
    const scoreMap = new Map(matches.map(m => [m.id, m.score]));
    conflict_candidates = nearRows.results.map(r => ({
      id: r.id,
      text: r.text.slice(0, 100),
      score: scoreMap.get(r.id) ?? 0,
    }));

    // Queue near-miss pairs for nightly memory_judge — store as pending_judge
    // so cron can process them without needing isContradiction() to fire
    const pendingInserts = nearMissIds.map(nearId =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO memory_relations (id, from_id, to_id, relation_type, confidence, reason, created_at)
         VALUES (?, ?, ?, 'pending_judge', ?, 'near-miss at store time', ?)`
      ).bind(crypto.randomUUID(), id, nearId, scoreMap.get(nearId) ?? 0, now)
    );
    if (pendingInserts.length > 0) await env.DB.batch(pendingInserts);
  }

  return { action: 'spawned', id, conflict_candidates };
}
