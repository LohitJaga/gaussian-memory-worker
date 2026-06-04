import {
  bhattacharyyaDistance, kalmanMerge, shouldMerge,
  sharpenSigma, decaySigma, initialSigma, cosine,
  meanSigma, serializeSigma, deserializeSigma
} from './gaussian';

export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  KV: KVNamespace;
  AUTH_TOKEN?: string;
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text: string, env: Env): Promise<Float32Array> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as any;
  const vec = result.data[0] as number[];
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  return new Float32Array(vec.map((v: number) => v / norm));
}

async function batchEmbed(texts: string[], env: Env): Promise<Float32Array[]> {
  const CHUNK = 100; // Workers AI bge-base-en-v1.5 hard limit
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts.slice(i, i + CHUNK) }) as any;
    for (const vec of result.data as number[][]) {
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      out.push(new Float32Array(vec.map(v => v / norm)));
    }
  }
  return out;
}

// ── Core memory ops ──────────────────────────────────────────────────────────

const NEGATION = /\b(no longer|stop using|stopped using|don't use|switched from|instead of|avoid using|shouldn't use|never use|removed|disabled|deprecated)\b/i;

function isContradiction(newText: string, existingText: string, cosineSim: number): boolean {
  if (cosineSim < 0.88) return false;
  return NEGATION.test(newText) !== NEGATION.test(existingText);
}

async function storeMemory(
  text: string, memoryType: string, domain: string,
  emotionalIntensity: number, env: Env,
  precomputedMu?: Float32Array,
  project: string = 'default'
): Promise<{ action: string; id: string; conflict_candidates?: Array<{ id: string; text: string; score: number }> }> {
  const mu = precomputedMu ?? await embed(text, env);
  const dim = mu.length;
  const sigma = initialSigma(domain, emotionalIntensity, dim);
  const now = Math.floor(Date.now() / 1000);

  // Coarse search via Vectorize — no domain filter so same-text re-ingests always merge
  // regardless of domain reclassification. Bhattacharyya distance handles isolation.
  const results = await env.VECTORIZE.query(Array.from(mu), {
    topK: 10,
    returnValues: false,
    returnMetadata: 'indexed',
  });

  let bestId: string | null = null;
  let bestDist = Infinity;
  let bestSigma: Float32Array | null = null;
  let bestText: string | null = null;
  let bestScore = 0;

  // Batch fetch all candidate rows in one D1 query instead of N sequential selects
  const candidateIds = results.matches.map(m => m.id);
  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = candidateIds.length > 0
    ? await env.DB.prepare(
        `SELECT id, sigma_diagonal, text FROM memories WHERE id IN (${placeholders})`
      ).bind(...candidateIds).all<{ id: string; sigma_diagonal: string; text: string }>()
    : { results: [] };
  const rowMap = new Map(rows.results.map(r => [r.id, r]));

  // Graphiti-style fast path: exact normalized match skips Bhattacharyya entirely.
  // Catches same-text re-ingestion with trivial surface differences (case, punctuation).
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const normalizedNew = normalize(text);
  for (const row of rows.results) {
    if (normalize(row.text) === normalizedNew) {
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

  for (const match of results.matches) {
    const matchDomain = (match.metadata as any)?.domain as string | undefined;
    // Cross-domain dedup: if cosine similarity is very high (>0.97), merge regardless of domain
    if (matchDomain && matchDomain !== domain && match.score < 0.97) continue;

    const row = rowMap.get(match.id);
    if (!row) continue;

    const existingSigma = deserializeSigma(row.sigma_diagonal);
    const approxDist = 0.5 * (1 - match.score);

    if (approxDist < bestDist) {
      bestDist = approxDist;
      bestId = match.id;
      bestSigma = existingSigma;
      bestText = row.text;
      bestScore = match.score;
    }
  }

  // Contradiction check: similar text with opposing negation pattern → flag both, force spawn
  if (bestId && bestText && isContradiction(text, bestText, bestScore)) {
    await env.DB.prepare('UPDATE memories SET contradiction_flag = 1 WHERE id = ?')
      .bind(bestId).run();
    // Fall through to spawn with contradiction_flag set
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO memories
        (id, text, sigma_diagonal, timestamp, last_accessed,
         access_count, memory_type, domain, emotional_intensity, contradiction_flag, project)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
    `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity, project).run();
    await env.VECTORIZE.upsert([{ id, values: Array.from(mu), metadata: { domain, memory_type: memoryType, project } }]);
    return { action: 'contradiction', id };
  }

  // Use tighter threshold for cross-domain merges (0.08) vs same-domain (0.20)
  const mergeThreshold = (bestId && results.matches.find(m => m.id === bestId && (m.metadata as any)?.domain === domain)) ? 0.20 : 0.08;
  if (bestId && bestSigma && shouldMerge(mu, sigma, mu, bestSigma, mergeThreshold)) {
    const [, newSigma] = kalmanMerge(mu, sigma, mu, bestSigma);

    // Preserve 'session' type on merge — session summaries must not silently become episodic
    const typeUpdate = memoryType === 'session' ? ', memory_type = ?' : '';
    const typeParams = memoryType === 'session'
      ? [serializeSigma(newSigma), now, text, 'session', bestId]
      : [serializeSigma(newSigma), now, text, bestId];
    await env.DB.prepare(`
      UPDATE memories SET
        sigma_diagonal = ?, last_accessed = ?,
        access_count = access_count + 1, text = ?${typeUpdate}
      WHERE id = ?
    `).bind(...typeParams).run();

    await env.VECTORIZE.upsert([{
      id: bestId,
      values: Array.from(mu),
      metadata: { domain, memory_type: memoryType, project },
    }]);

    return { action: 'merged', id: bestId };
  }

  // Spawn new
  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO memories
      (id, text, sigma_diagonal, timestamp, last_accessed,
       access_count, memory_type, domain, emotional_intensity, project)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity, project).run();

  await env.VECTORIZE.upsert([{
    id,
    values: Array.from(mu),
    metadata: { domain, memory_type: memoryType, project },
  }]);
  await extractAndLinkEntities(id, text, env); // awaited — KV write must complete
  // Record initial σ — baseline for belief drift tracking
  env.DB.prepare(
    'INSERT INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), id, meanSigma(sigma), 'store', now).run().catch(() => {});

  // Surface near-miss candidates (score > 0.85, not merged) for memory_judge
  const nearMissIds = results.matches
    .filter(m => m.score > 0.85 && m.id !== id)
    .map(m => m.id);

  let conflict_candidates: Array<{ id: string; text: string; score: number }> | undefined;
  if (nearMissIds.length > 0) {
    const placeholders = nearMissIds.map(() => '?').join(',');
    const nearRows = await env.DB.prepare(
      `SELECT id, text FROM memories WHERE id IN (${placeholders})`
    ).bind(...nearMissIds).all<{ id: string; text: string }>();
    const scoreMap = new Map(results.matches.map(m => [m.id, m.score]));
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

// Recency hot tier — KV stores last 100 stored/accessed memory IDs (24h TTL)
// retrieve() merges hot IDs into candidate pool; high recency score elevates them naturally
const HOT_KEY = 'hot:recent_ids';
const HOT_TTL = 86400; // 24h
const HOT_MAX = 100;

async function hotTierAdd(id: string, env: Env): Promise<void> {
  try {
    const raw = await env.KV.get(HOT_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    const updated = [id, ...ids.filter(i => i !== id)].slice(0, HOT_MAX);
    await env.KV.put(HOT_KEY, JSON.stringify(updated), { expirationTtl: HOT_TTL });
  } catch {}
}

async function processPendingEntityQueue(env: Env): Promise<void> {
  try {
    const raw = await env.KV.get('pending_entity_queue');
    if (!raw) return;
    const queue: Array<{id: string; text: string}> = JSON.parse(raw);
    if (!queue.length) return;
    const batch = queue.splice(0, 50); // process up to 50 per cron run
    await env.KV.put('pending_entity_queue', JSON.stringify(queue));
    const now = Math.floor(Date.now() / 1000);
    for (const item of batch) {
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
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
  } catch {}
}

async function hotTierGet(env: Env): Promise<string[]> {
  try {
    const raw = await env.KV.get(HOT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function extractAndLinkEntities(memoryId: string, text: string, env: Env): Promise<void> {
  // Queue for cron processing — Llama calls too slow for fire-and-forget in Workers context
  try {
    const raw = await env.KV.get('pending_entity_queue');
    const queue: Array<{id: string; text: string}> = raw ? JSON.parse(raw) : [];
    queue.push({ id: memoryId, text: text.slice(0, 300) });
    await env.KV.put('pending_entity_queue', JSON.stringify(queue.slice(-200))); // cap at 200
  } catch {}
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i];
  return sum;
}

// Scalar Bhattacharyya using cosine sim as mu-distance proxy.
// querySigma derived from query length; memorySigma from stored sigma_diagonal.
// Sharp memories (low σ) activated selectively; fuzzy ones activate broadly.
function distributionalScore(cosineSim: number, querySigma: number, memorySigma: number): number {
  const muDistSq = 2 * (1 - Math.max(0, cosineSim));
  const sigmaAvg = (querySigma + memorySigma) / 2;
  const term1 = 0.125 * muDistSq / sigmaAvg;
  const term2 = 0.5 * Math.log(sigmaAvg / Math.sqrt(querySigma * memorySigma));
  return Math.exp(-(term1 + term2));
}

async function retrieve(
  query: string, domain: string | null, topK: number, env: Env, project: string = 'default', context?: string
): Promise<{ score: number; text: string; domain: string; type: string; activated?: boolean; sigma?: number }[]> {

  // Session-aware intent extraction — only for short/vague queries where raw embedding is poor
  // Llama rewrites to a concrete standalone search intent. 1.5s timeout, fallback to raw query.
  let searchQuery = query;
  if (context && query.length < 60) {
    try {
      const intentResult = await Promise.race([
        env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
          messages: [
            {
              role: 'system',
              content: 'Given recent context and a query, extract the user\'s true search intent as a single concrete standalone sentence. No questions, no "I want". If the query is already specific and clear, return it unchanged. Return ONLY the intent sentence, nothing else.',
            },
            {
              role: 'user',
              content: `<context>${context.slice(0, 300)}</context>\n<query>${query}</query>\nIntent:`,
            },
          ],
          max_tokens: 60,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ]) as any;
      const intent = (intentResult?.response ?? intentResult?.choices?.[0]?.message?.content ?? '').trim();
      if (intent && intent.length > 5 && intent.length < 200) searchQuery = intent;
    } catch {}
  }

  const qvec = await embed(searchQuery, env);

  // Entity extraction — Mem0-style: pull capitalized tokens + known patterns as entity candidates
  // These become extra Vectorize queries; matching memories get a score boost
  const entityTokens = [
    ...new Set(
      query.match(/\b([A-Z][a-zA-Z0-9._-]{2,}|@cf\/[^\s]+|CW[0-9]+[A-Z]?)\b/g) ?? []
    )
  ].slice(0, 3); // cap at 3 entities to limit extra queries

  // Infer query sigma: short/specific → low σ (tight), long/vague → high σ (broad)
  const querySigmaVal = 0.3 + 0.5 * Math.min(query.length / 300, 1.0);

  // Domain routing removed — Vectorize queries globally.
  // FTS5+RRF+entity graph handles relevance without domain pre-filtering.
  // Domain labels kept for display and scoring only (small boost if domain matches).
  const domainSizeMap = new Map<string, number>();

  // Vector search + FTS5 keyword search in parallel (hybrid retrieval, global scope)
  const queryOpts: any = { topK: topK * 4, returnValues: true, returnMetadata: 'indexed' };

  // Build FTS5 query — sanitize to valid FTS5 syntax (remove special chars)
  const ftsQuery = searchQuery.replace(/['"*()]/g, ' ').trim();
  const [vecFinal, ftsResults] = await Promise.all([
    env.VECTORIZE.query(Array.from(qvec), queryOpts),
    ftsQuery.length >= 3
      ? env.DB.prepare(
          `SELECT id FROM memories_fts WHERE memories_fts MATCH ? AND (project = ? OR project = 'default') ORDER BY rank LIMIT ?`
        ).bind(ftsQuery, project, topK * 4).all<{ id: string }>().catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
  ]);

  // RRF fusion (k=60): combine vector ranks + FTS5 ranks
  const RRF_K = 60;
  const rrfScores = new Map<string, number>();
  (vecFinal.matches ?? []).forEach((m, rank) => {
    rrfScores.set(m.id, (rrfScores.get(m.id) ?? 0) + 1 / (RRF_K + rank + 1));
  });
  (ftsResults.results ?? []).forEach((r, rank) => {
    rrfScores.set(r.id, (rrfScores.get(r.id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  // Build merged ID set sorted by RRF score, preserve vector metadata for top vector hits
  const mergedIds = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK * 4)
    .map(([id]) => id);

  const results = vecFinal;
  // Inject RRF-only IDs (from FTS5) that weren't in vector results
  const vecIds = new Set((vecFinal.matches ?? []).map(m => m.id));
  const ftsOnlyIds = mergedIds.filter(id => !vecIds.has(id));

  // Hot tier — inject recently stored/accessed memory IDs into candidate pool
  const hotIds = await hotTierGet(env);
  const allCandidateIds = new Set([...mergedIds, ...hotIds]);
  const hotOnlyIds = hotIds.filter(id => !allCandidateIds.has(id) || !vecIds.has(id));

  if (!results.matches.length && !ftsOnlyIds.length && !hotOnlyIds.length) return [];

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

  // Merge vector + FTS5-only + hot tier IDs for D1 fetch
  const allIds = [...new Set([...results.matches.map(m => m.id), ...ftsOnlyIds, ...hotOnlyIds])];
  const placeholders = allIds.map(() => '?').join(',');
  // project='default' = no project context (direct MCP call) → search all projects
  const projectClause = project === 'default'
    ? ''
    : 'AND (project = ? OR project = \'default\')';
  const binds = project === 'default' ? [...allIds] : [...allIds, project];
  const rows = await env.DB.prepare(
    `SELECT id, text, domain, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp, last_accessed
     FROM memories WHERE id IN (${placeholders}) ${projectClause}`
  ).bind(...binds).all<{
    id: string; text: string; domain: string; memory_type: string;
    sigma_diagonal: string; access_count: number; contradiction_flag: number; timestamp: number; last_accessed: number;
  }>();

  const cosineMap = new Map(results.matches.map(m => [m.id, m.score]));
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
      entityToMembers.get(r.entity_id)!.add(r.memory_id);
      if (!memToEntities.has(r.memory_id)) memToEntities.set(r.memory_id, new Set());
      memToEntities.get(r.memory_id)!.add(r.entity_id);
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
        clusterCohesionMap.set(id, Math.min(0.18, 0.04 * clusterSize));
      }
    }
  }

  // Build candidates — compute raw components first, then normalize within batch
  const nowSec = Math.floor(Date.now() / 1000);
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
    const lastAccessed = row.last_accessed ?? row.timestamp ?? 0;
    const recency = Math.max(0, 1 - (nowSec - lastAccessed) / NINETY_DAYS);
    const accessFreq = Math.min(1, (row.access_count ?? 0) / 50);
    const sigExcess = Math.max(0, meanSigma(memSigma) - querySigmaVal);
    const cosineWeighted = cosineSim * Math.max(0.75, 1.0 - 0.25 * sigExcess);
    return { row, memSigma, cosineWeighted, recency, accessFreq };
  });

  // Min-max normalization within batch — spreads scores across [0,1] per component
  const minMax = (arr: number[]) => {
    const mn = Math.min(...arr), mx = Math.max(...arr);
    return mx === mn ? arr.map(() => 1) : arr.map(v => (v - mn) / (mx - mn));
  };
  const normCosine = minMax(rawCandidates.map(c => c.cosineWeighted));
  const normRecency = minMax(rawCandidates.map(c => c.recency));
  const normAccess = minMax(rawCandidates.map(c => c.accessFreq));

  // Pass 2: build scored candidates using normalized components
  const candidates = rawCandidates.map(({ row, memSigma }, i) => {
    const entityBoost = Math.min(0.25, entityBoostMap.get(row.id) ?? 0);
    const rrfBoost = Math.min(0.2, (rrfScores.get(row.id) ?? 0) * 12);
    // Cluster cohesion only applies if memory has meaningful semantic relevance on its own
    const cohesionBonus = normCosine[i] >= 0.4 ? (clusterCohesionMap.get(row.id) ?? 0) : 0;
    // Bhattacharyya distribution overlap: measures how well query and memory uncertainty match.
    // Uses cosine sim as μ-distance proxy + σ overlap to compute distributional similarity.
    // Specific query (low querySigma) → only sharp memories score high.
    // Vague query (high querySigma) → both sharp and fuzzy memories can surface.
    // This is the core Gaussian claim: retrieval is uncertainty-aware, not just semantic.
    const currentSigma = meanSigma(memSigma);
    const bhattScore = distributionalScore(normCosine[i], querySigmaVal, currentSigma);
    // Scale [0,1] Bhattacharyya score to multiplier range [0.70, 1.40]
    const bhattMultiplier = 0.70 + 0.70 * bhattScore;
    const baseScore = 0.6 * normCosine[i] + 0.25 * normRecency[i] + 0.15 * normAccess[i] + entityBoost + rrfBoost + cohesionBonus;
    const primaryScore = baseScore * Math.min(1.40, Math.max(0.70, bhattMultiplier));
    const ageSeconds = nowSec - (row.timestamp ?? 0);
    return {
      id: row.id,
      text: row.text,
      domain: row.domain,
      type: row.memory_type,
      sigma: memSigma,
      primaryScore,
      vector: vectorMap.get(row.id) ?? [],
      contradiction: row.contradiction_flag === 1,
      fresh: ageSeconds < 1800,  // stored within last 30 min
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

    // Session memory boost: session summaries are the highest-value retrieval target
    // for "what were we working on" queries — give them a strong lift over atomic facts
    const sessionBoost = c.type === 'session' ? 0.20 : 0;

    // Recency boost: memories stored in this session (last 30 min) get a lift
    const recencyBoost = c.fresh ? 0.12 : 0;

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

  // True spreading activation: second Vectorize pass from top-3 anchors
  // Activated memories SUPPLEMENT direct results — they don't compete within top-K
  const seenIds = new Set(candidates.map(c => c.id));
  const activationAnchors = scored.slice(0, 3).filter(c => c.vector.length > 0);
  const activatedExtras: typeof scored = [];

  if (activationAnchors.length > 0) {
    const neighborQueries = activationAnchors.map(anchor =>
      env.VECTORIZE.query(anchor.vector, { topK: 2, returnValues: false, returnMetadata: 'indexed' })
    );
    const neighborResults = await Promise.all(neighborQueries);

    const newMatches: { id: string; score: number }[] = [];
    for (const result of neighborResults) {
      for (const m of result.matches ?? []) {
        // Lower threshold (0.65) captures weak associations per Collins & Loftus; 0.6 decay = empirical priming slope
        if (!seenIds.has(m.id) && (m.score ?? 0) >= 0.65) {
          newMatches.push({ id: m.id, score: (m.score ?? 0) * 0.6 });
          seenIds.add(m.id);
        }
      }
    }

    if (newMatches.length > 0) {
      const newIds = newMatches.map(m => m.id);
      const newRows = await env.DB.prepare(
        `SELECT id, text, domain, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp, last_accessed
         FROM memories WHERE id IN (${newIds.map(() => '?').join(',')}) AND (project = ? OR project = 'default')`
      ).bind(...newIds, project).all<{
        id: string; text: string; domain: string; memory_type: string;
        sigma_diagonal: string; access_count: number; contradiction_flag: number; timestamp: number; last_accessed: number;
      }>();

      const newScoreMap = new Map(newMatches.map(m => [m.id, m.score]));
      for (const row of newRows.results ?? []) {
        const memSigma = deserializeSigma(row.sigma_diagonal);
        const anchorSim = newScoreMap.get(row.id) ?? 0;
        const isFileEdit = /^(Edited:|Worked on .+edited|Ran:)/i.test(row.text);
        if (isFileEdit) continue;
        activatedExtras.push({
          id: row.id, text: row.text, domain: row.domain, type: row.memory_type,
          sigma: memSigma, primaryScore: anchorSim, score: anchorSim,
          vector: [], contradiction: row.contradiction_flag === 1,
          fresh: false, isFileEdit: false, activated: true,
        } as any);
      }
      activatedExtras.sort((a, b) => b.score - a.score);
    }
  }

  // Threshold-based retrieval: return ALL above score floor, not a hard topK.
  // Context window is 200k — injecting 15 relevant memories costs nothing vs 5.
  // Floor = median of top-topK scores * 0.75, so we always get at least topK
  // but surface more when the corpus has genuinely relevant content.
  const topKSlice = scored.slice(0, topK);
  const floor = topKSlice.length > 0
    ? topKSlice[Math.floor(topKSlice.length / 2)].score * 0.88
    : 0;
  const top = scored.filter(c => c.score >= floor).slice(0, topK * 2); // hard cap at 2× topK

  // Append activated associations not already in results
  const topIdSet = new Set(top.map(c => c.id));
  top.push(...activatedExtras.filter(a => !topIdSet.has(a.id)).slice(0, 3));

  // De-biasing: surface one high-value contradiction that got penalty-suppressed
  const suppressed = scored.slice(topK).find(c => c.contradiction && (c as any).primaryScore > 0.7);
  if (suppressed) top.push(suppressed);

  // Sharpen accessed memories + record history if σ changed meaningfully
  const now = Math.floor(Date.now() / 1000);
  for (const mem of top) {
    const domSize = domainSizeMap.get(mem.domain) ?? 10;
    const newSigma = sharpenSigma(mem.sigma, 0.85, 0.15, mem.contradiction, domSize);
    await env.DB.prepare(
      'UPDATE memories SET last_accessed = ?, access_count = access_count + 1, sigma_diagonal = ? WHERE id = ?'
    ).bind(now, serializeSigma(newSigma), mem.id).run();
    hotTierAdd(mem.id, env); // hot tier = recently accessed, not recently stored
    // Record sigma history if it moved by more than 0.05 — avoids spammy writes on tiny changes
    const oldMean = meanSigma(mem.sigma);
    const newMean = meanSigma(newSigma);
    if (Math.abs(newMean - oldMean) >= 0.05) {
      env.DB.prepare(
        'INSERT INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), mem.id, newMean, 'sharpen', now).run().catch(() => {});
    }
  }

  // Check memory_relations: mark superseded memories so caller knows they've been replaced
  const topIds = top.map(m => m.id);
  const supersededSet = new Set<string>();
  if (topIds.length > 0) {
    const relRows = await env.DB.prepare(
      `SELECT to_id FROM memory_relations WHERE relation_type = 'supersedes' AND to_id IN (${topIds.map(() => '?').join(',')})`
    ).bind(...topIds).all<{ to_id: string }>();
    (relRows.results ?? []).forEach(r => supersededSet.add(r.to_id));
  }

  return top.map(m => {
    const sig = meanSigma(m.sigma);
    const drift = sig < 0.35 ? '↑' : sig > 0.6 ? '↓' : '→';
    const cohesion = clusterCohesionMap.get(m.id) ?? 0;
    const clusterMark = cohesion > 0.08 ? ' ◆' : cohesion > 0.03 ? ' ◇' : '';
    const baseText = supersededSet.has(m.id)
      ? `[SUPERSEDED] ${m.text}`
      : m.contradiction ? `[CONTRADICTED — re-evaluate] ${m.text}` : m.text;
    return {
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

async function updateDecay(env: Env): Promise<{ decayed: number; pruned: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const SIXTY_DAYS = 60 * 86400;

  const rows = await env.DB.prepare(
    'SELECT id, sigma_diagonal, access_count, timestamp FROM memories'
  ).all<{ id: string; sigma_diagonal: string; access_count: number; timestamp: number }>();

  let decayed = 0, pruned = 0;
  const updateStmts: D1PreparedStatement[] = [];
  const pruneIds: string[] = [];

  for (const row of rows.results ?? []) {
    let sigma = decaySigma(deserializeSigma(row.sigma_diagonal));
    // Accelerated decay: cold memories older than 60 days decay 1.5× faster —
    // gets dead weight to pruning threshold without touching accessed memories
    const isOld = (nowSec - (row.timestamp ?? 0)) > SIXTY_DAYS;
    if ((row.access_count ?? 0) === 0 && isOld) {
      sigma = decaySigma(sigma); // apply decay twice = 1.5× effective rate
    }
    if (meanSigma(sigma) > 2.0) {
      pruneIds.push(row.id);
      pruned++;
    } else {
      updateStmts.push(
        env.DB.prepare('UPDATE memories SET sigma_diagonal = ? WHERE id = ?')
          .bind(serializeSigma(sigma), row.id)
      );
      decayed++;
    }
  }

  // Batch all D1 writes — one API call instead of N, stays under limits
  const CHUNK = 500;
  for (let i = 0; i < updateStmts.length; i += CHUNK) {
    await env.DB.batch(updateStmts.slice(i, i + CHUNK));
  }
  for (let i = 0; i < pruneIds.length; i += CHUNK) {
    await env.DB.batch(
      pruneIds.slice(i, i + CHUNK).map(id =>
        env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)
      )
    );
  }
  if (pruneIds.length) await env.VECTORIZE.deleteByIds(pruneIds);

  return { decayed, pruned };
}

// Shared Llama batch classifier — used by both cronRebuildBatch and memory_rebuild_domains.
// Takes batch of texts + existing domain list, returns domain assignment per row.
async function classifyBatchDomains(
  texts: string[],
  existingDomains: string[],
  env: Env,
  timeBudgetMs = Infinity,
  startTime = Date.now(),
): Promise<string[]> {
  const GROUP = 10;
  const canCreate = existingDomains.length < 50;
  const assignments: string[] = new Array(texts.length).fill('general');

  for (let g = 0; g < texts.length; g += GROUP) {
    if (Date.now() - startTime > timeBudgetMs) break;
    const group = texts.slice(g, g + GROUP);
    const numbered = group.map((t, j) => `${j + 1}. ${t.slice(0, 150)}`).join('\n');
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
      messages: [
        {
          role: 'system',
          content: `Classify each memory into a semantic domain. Domain names: 2-4 lowercase hyphenated words.\n${canCreate ? 'Use existing domains or create new ones.' : 'Use existing domains only (50-domain cap).'}\nExisting: ${existingDomains.length ? existingDomains.join(', ') : 'none yet'}\nReturn ONLY a JSON array of exactly ${group.length} domain name strings: ["domain-1", ...]`,
        },
        { role: 'user', content: numbered },
      ],
      max_tokens: 256,
    }) as any;

    const rawBatch = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
    const raw = (typeof rawBatch === 'string' ? rawBatch : JSON.stringify(rawBatch)).trim();
    try {
      const match = raw.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as string[];
        for (let j = 0; j < group.length && j < parsed.length; j++) {
          let d = (parsed[j] ?? '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          if (d.length === 0) d = 'unclassified';
          assignments[g + j] = d.slice(0, 40);
          if (!existingDomains.includes(d) && existingDomains.length < 50) existingDomains.push(d.slice(0, 40));
        }
      }
    } catch {}
  }
  return assignments;
}

// Remap any domain assignments that have no anchor to the nearest existing anchor.
// Uses pre-computed embeddings (mus) so no extra embed calls needed.
// Prevents memories from being assigned micro-domains invisible to two-stage retrieval.
async function remapToAnchoredDomains(
  assignments: string[],
  mus: Float32Array[],
  env: Env,
): Promise<string[]> {
  const anchorRows = await env.DB.prepare('SELECT name, embedding FROM domain_anchors')
    .all<{ name: string; embedding: string }>();
  const anchors = (anchorRows.results ?? []).map(r => ({
    name: r.name,
    emb: JSON.parse(r.embedding) as number[],
  }));
  if (!anchors.length) return assignments;

  const anchoredNames = new Set(anchors.map(a => a.name));
  for (let i = 0; i < assignments.length; i++) {
    if (anchoredNames.has(assignments[i])) continue;
    const muArr = Array.from(mus[i]);
    let best = anchors[0].name;
    let bestSim = -1;
    for (const anchor of anchors) {
      const sim = dotProduct(muArr, anchor.emb);
      if (sim > bestSim) { bestSim = sim; best = anchor.name; }
    }
    assignments[i] = best;
  }
  return assignments;
}

// Nightly domain rebuild — classifies only domain='general' memories, time-budget guarded.
async function cronRebuildBatch(env: Env, rowLimit: number, timeBudgetMs: number): Promise<void> {
  const start = Date.now();
  await ensureDomainColumns(env);

  // Only reclassify memories stuck in domain='general' — these failed initial classification.
  // No wipe-and-rebuild: domain anchors stay intact, no multi-night inconsistency window.
  // No KV offset needed: general bucket stays small (~100-200 rows), runs in one cron tick.
  const rows = await env.DB.prepare(
    "SELECT id, text, memory_type FROM memories WHERE domain = 'general' ORDER BY rowid LIMIT ?"
  ).bind(rowLimit).all<{ id: string; text: string; memory_type: string }>();

  const batch = rows.results ?? [];
  if (!batch.length) return;

  const mus = await batchEmbed(batch.map(r => r.text), env);

  const existingDomains = (await env.DB.prepare('SELECT name FROM domain_anchors ORDER BY rowid')
    .all<{ name: string }>()).results?.map(r => r.name) ?? [];

  const rawAssignments = await classifyBatchDomains(batch.map(r => r.text), existingDomains, env, timeBudgetMs, start);
  const domainAssignments = await remapToAnchoredDomains(rawAssignments, mus, env);

  // Batch D1 updates + Vectorize upserts + centroid accumulation
  const d1Updates = batch.map((row, i) =>
    env.DB.prepare('UPDATE memories SET domain = ? WHERE id = ?').bind(domainAssignments[i], row.id)
  );
  for (let i = 0; i < d1Updates.length; i += 500) {
    await env.DB.batch(d1Updates.slice(i, i + 500));
  }
  await env.VECTORIZE.upsert(batch.map((row, i) => ({
    id: row.id, values: Array.from(mus[i]),
    metadata: { domain: domainAssignments[i], memory_type: row.memory_type },
  })));

  const centroidAccum = new Map<string, { sum: number[]; count: number }>();
  for (let i = 0; i < batch.length; i++) {
    const domain = domainAssignments[i];
    const acc = centroidAccum.get(domain) ?? { sum: new Array(mus[i].length).fill(0), count: 0 };
    mus[i].forEach((v, j) => { acc.sum[j] = (acc.sum[j] ?? 0) + v; });
    acc.count++;
    centroidAccum.set(domain, acc);
  }
  for (const [domain, { sum, count }] of centroidAccum) {
    const existing = await env.DB.prepare(
      'SELECT embedding, memory_count FROM domain_anchors WHERE name = ?'
    ).bind(domain).first<{ embedding: string; memory_count: number }>();
    if (!existing) {
      const total = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
      if ((total?.n ?? 0) < 50) {
        const norm = Math.sqrt(sum.reduce((s, v) => s + v * v, 0));
        await env.DB.prepare(
          'INSERT INTO domain_anchors (name, embedding, memory_count, last_summarized_count) VALUES (?, ?, ?, 0)'
        ).bind(domain, JSON.stringify(sum.map(v => v / (norm || 1))), count).run();
      }
    } else {
      const n = existing.memory_count ?? 0;
      const old: number[] = JSON.parse(existing.embedding);
      const updated = old.map((v, j) => (v * n + (sum[j] ?? 0)) / (n + count));
      const norm = Math.sqrt(updated.reduce((s, v) => s + v * v, 0));
      await env.DB.prepare(
        'UPDATE domain_anchors SET embedding = ?, memory_count = ? WHERE name = ?'
      ).bind(JSON.stringify(updated.map(v => v / (norm || 1))), n + count, domain).run();
    }
  }

}

// Prune low-signal junk: cold episodic memories that are short, old, and never accessed.
// Catches tool artifacts (git ops, file refs) and chat filler that slipped past SKIP rules.
// Conservative criteria: all four must be true to avoid deleting real short facts.
async function pruneJunkMemories(env: Env): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400; // older than 30 days
  const rows = await env.DB.prepare(`
    SELECT id FROM memories
    WHERE access_count = 0
      AND memory_type = 'episodic'
      AND length(text) < 80
      AND timestamp < ?
  `).bind(cutoff).all<{ id: string }>();

  const ids = (rows.results ?? []).map(r => r.id);
  if (!ids.length) return 0;

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await env.DB.batch(chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)));
    await env.VECTORIZE.deleteByIds(chunk);
  }
  return ids.length;
}

async function deduplicateRecentMemories(env: Env, windowSec = 86400, threshold = 0.90): Promise<string> {
  const since = Math.floor(Date.now() / 1000) - windowSec;
  const recent = await env.DB.prepare(
    'SELECT id, text, project FROM memories WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 200'
  ).bind(since).all<{ id: string; text: string; project: string }>();

  const rows = recent.results ?? [];
  if (rows.length === 0) return 'No recent memories to dedup.';

  const mus = await batchEmbed(rows.map(r => r.text), env);
  const toDelete: string[] = [];
  const deleted = new Set<string>();
  const projectMap = new Map(rows.map(r => [r.id, r.project]));

  for (let i = 0; i < rows.length; i++) {
    if (deleted.has(rows[i].id)) continue;
    const results = await env.VECTORIZE.query(mus[i], { topK: 2, returnMetadata: 'indexed' });
    for (const match of results.matches) {
      const matchProject = (match.metadata as any)?.project ?? 'default';
      const rowProject = rows[i].project ?? 'default';
      // Only dedup within same project — never delete a memory from a different project
      if (match.id !== rows[i].id && (match.score ?? 0) >= threshold && !deleted.has(match.id) && matchProject === rowProject) {
        toDelete.push(rows[i].id);
        deleted.add(rows[i].id);
        break;
      }
    }
  }

  if (toDelete.length === 0) return 'No duplicates in last 24h.';

  for (let i = 0; i < toDelete.length; i += 500) {
    await env.DB.batch(
      toDelete.slice(i, i + 500).map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id))
    );
  }
  await env.VECTORIZE.deleteByIds(toDelete);
  return `Deduped ${toDelete.length} duplicate memories from last 24h.`;
}

// Daily cold dedup: checks 500 oldest never-accessed memories against full corpus.
// Higher threshold (0.93) than the daily 24h pass (0.90) — conservative to avoid
// false-positives on short memories. Runs oldest-first so domain-bleeding duplicates
// from weeks ago get hit immediately rather than waiting for a full cycle.
async function deduplicateColdMemories(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    'SELECT id, text FROM memories WHERE access_count = 0 ORDER BY timestamp ASC LIMIT 500'
  ).all<{ id: string; text: string }>();

  const cold = rows.results ?? [];
  if (!cold.length) return 'No cold memories to dedup.';

  const mus = await batchEmbed(cold.map(r => r.text), env);
  const toDelete: string[] = [];
  const deleted = new Set<string>();

  for (let i = 0; i < cold.length; i++) {
    if (deleted.has(cold[i].id)) continue;
    const results = await env.VECTORIZE.query(mus[i], { topK: 3, returnMetadata: 'indexed' });
    for (const match of results.matches ?? []) {
      if (match.id !== cold[i].id && (match.score ?? 0) >= 0.93 && !deleted.has(cold[i].id)) {
        toDelete.push(cold[i].id);
        deleted.add(cold[i].id);
        break;
      }
    }
  }

  if (!toDelete.length) return 'No cold duplicates found.';

  const CHUNK = 500;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    await env.DB.batch(toDelete.slice(i, i + CHUNK).map(id =>
      env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)
    ));
  }
  await env.VECTORIZE.deleteByIds(toDelete);
  return `Cold dedup: removed ${toDelete.length} duplicates from oldest cold memories.`;
}

async function cleanupSingletons(env: Env, minCount = 3): Promise<string> {
  await ensureDomainColumns(env);

  const domainCounts = await env.DB.prepare(
    'SELECT domain, COUNT(*) as cnt FROM memories GROUP BY domain'
  ).all<{ domain: string; cnt: number }>();
  const countMap = new Map<string, number>();
  for (const row of domainCounts.results ?? []) countMap.set(row.domain, row.cnt);

  const allAnchors = await env.DB.prepare(
    'SELECT name, embedding, memory_count FROM domain_anchors'
  ).all<{ name: string; embedding: string; memory_count: number }>();
  const allAnchorList = allAnchors.results ?? [];

  const anchoredDomains = allAnchorList.filter(a => (countMap.get(a.name) ?? 0) >= minCount);
  if (anchoredDomains.length === 0) return 'No anchored domains — run memory_rebuild_domains first.';

  const singletonNames: string[] = allAnchorList
    .filter(a => (countMap.get(a.name) ?? 0) < minCount)
    .map(a => a.name);

  const anchoredSet = new Set(allAnchorList.map(a => a.name));
  for (const [domain, cnt] of countMap) {
    if (!anchoredSet.has(domain) && cnt < minCount) singletonNames.push(domain);
  }

  if (singletonNames.length === 0) return `No singleton domains (all have >= ${minCount} memories).`;

  let totalReassigned = 0;
  const d1Updates: ReturnType<typeof env.DB.prepare>[] = [];
  const vectorizeUpdates: { id: string; values: number[]; metadata: Record<string, string> }[] = [];

  const anchoredParsed = anchoredDomains.map(a => ({
    name: a.name,
    centroid: JSON.parse(a.embedding) as number[],
  }));

  for (const singletonName of singletonNames) {
    const memories = await env.DB.prepare(
      'SELECT id, text, memory_type FROM memories WHERE domain = ?'
    ).bind(singletonName).all<{ id: string; text: string; memory_type: string }>();

    const batch = memories.results ?? [];
    if (batch.length === 0) continue;

    const mus = await batchEmbed(batch.map(r => r.text), env);

    for (let i = 0; i < batch.length; i++) {
      const mu = Array.from(mus[i]);
      let bestDomain = anchoredParsed[0].name;
      let bestSim = -1;
      for (const anchor of anchoredParsed) {
        const sim = dotProduct(mu, anchor.centroid);
        if (sim > bestSim) { bestSim = sim; bestDomain = anchor.name; }
      }
      d1Updates.push(
        env.DB.prepare('UPDATE memories SET domain = ? WHERE id = ?').bind(bestDomain, batch[i].id)
      );
      vectorizeUpdates.push({
        id: batch[i].id, values: mu,
        metadata: { domain: bestDomain, memory_type: batch[i].memory_type },
      });
      totalReassigned++;
    }
  }

  for (let i = 0; i < d1Updates.length; i += 500) await env.DB.batch(d1Updates.slice(i, i + 500));
  if (vectorizeUpdates.length > 0) await env.VECTORIZE.upsert(vectorizeUpdates);

  for (const name of singletonNames) {
    await env.DB.prepare('DELETE FROM domain_anchors WHERE name = ?').bind(name).run();
  }

  const remaining = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
  return `Cleaned ${singletonNames.length} singleton domains, reassigned ${totalReassigned} memories. Domains remaining: ${remaining?.n ?? 0}.`;
}

async function refreshStaleDomainSummaries(env: Env): Promise<void> {
  const counts = await env.DB.prepare(
    'SELECT domain, COUNT(*) as cnt FROM memories GROUP BY domain'
  ).all<{ domain: string; cnt: number }>();
  const countMap = new Map<string, number>();
  for (const r of counts.results ?? []) countMap.set(r.domain, r.cnt);

  const anchors = await env.DB.prepare(
    'SELECT name, last_summarized_count FROM domain_anchors WHERE memory_count >= 5 ORDER BY memory_count DESC LIMIT 20'
  ).all<{ name: string; last_summarized_count: number }>();

  for (const a of anchors.results ?? []) {
    const actual = countMap.get(a.name) ?? 0;
    const lastSummarized = a.last_summarized_count ?? 0;
    // Refresh if count grew >20% or was never summarized
    if (actual === 0) continue;
    if (lastSummarized === 0 || actual > lastSummarized * 1.2) {
      await refreshDomainSummary(a.name, actual, env).catch(() => {});
    }
  }
}

async function synthesizeIdentityProfile(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT text FROM memories WHERE memory_type = 'semantic'
     ORDER BY access_count DESC, last_accessed DESC LIMIT 20`
  ).all<{ text: string }>();

  const facts = (rows.results ?? []).map(r => r.text).join('\n');
  if (!facts) return;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
    messages: [
      {
        role: 'system',
        content: 'You are building an identity profile for a personal AI memory system. Given semantic memory facts about a person, synthesize a concise markdown identity document. Include sections: Identity/background, Active projects, Career goals, Tech stack, Working style. Use only facts present in the memories. Be concise — under 600 words.',
      },
      { role: 'user', content: facts },
    ],
    max_tokens: 700,
  }) as any;

  const profile = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
  if (profile) {
    await env.KV.put('IDENTITY_PROFILE', profile);
  }
}

interface DomainAnchor {
  name: string;
  embedding: number[];
}

const ANCHOR_STOP = new Set([
  // articles / conjunctions / prepositions
  'the','and','for','with','from','that','this','have','been','were','they','will',
  'would','could','should','about','which','when','then','also','into','more','some',
  'than','your','their','there','what','just','like','very','after','over','such',
  'well','only','even','most','each','these','those','both','much','many','other',
  'same','here','done','upon','within','between','through','against',
  // common verbs / actions
  'used','make','take','give','come','know','think','work','need','want','call',
  'said','wrote','built','found','made','runs','worked','called','using','added',
  'going','getting','taking','making','hitting','trying','solving','building',
  'finished','started','updated','fixed','added','removed','changed','created',
  // time / generic nouns
  'time','today','morning','evening','night','week','month','year','times','days',
  'hours','minutes','session','sessions','clear','head','once','twice',
  // memory-specific words
  'memory','memories','code','file','files','text','data','output','result','value',
  'error','type','list','running','system',
]);

function deriveAnchorName(text: string): string {
  const tokens = text.split(/\s+/);
  // Skip first token (sentence-starter, capitalized by grammar not by being a proper noun)
  for (let i = 1; i < tokens.length; i++) {
    const w = tokens[i].replace(/[^a-zA-Z]/g, '');
    if (w.length >= 4 && /^[A-Z]/.test(w)) {
      const lw = w.toLowerCase();
      if (!ANCHOR_STOP.has(lw)) return lw;
    }
  }
  // Fall back to distinctive content words (skip first token here too)
  for (let i = 1; i < tokens.length; i++) {
    const w = tokens[i].replace(/[^a-z]/g, '');
    if (w.length >= 5 && !ANCHOR_STOP.has(w)) return w;
  }
  // Last resort: any content word including first
  for (const w of tokens) {
    const c = w.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (c.length >= 4 && !ANCHOR_STOP.has(c)) return c;
  }
  return `cluster_${Date.now().toString(36).slice(-4)}`;
}


async function classifyDomain(mu: Float32Array, text: string, env: Env): Promise<string> {
  const muArr = Array.from(mu);

  const rows = await env.DB.prepare(
    'SELECT name, embedding FROM domain_anchors'
  ).all<{ name: string; embedding: string }>();

  let bestName = '';
  let bestSim = -1;

  for (const row of rows.results ?? []) {
    const anchorEmb: number[] = JSON.parse(row.embedding);
    const sim = dotProduct(muArr, anchorEmb);
    if (sim > bestSim) { bestSim = sim; bestName = row.name; }
  }

  if (bestSim >= 0.82) return bestName;

  // At cap: return nearest existing anchor instead of creating a new micro-domain
  const totalDomains = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
  if ((totalDomains?.n ?? 0) >= 50) {
    return bestName || 'general';
  }

  const name = deriveAnchorName(text);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO domain_anchors (name, embedding) VALUES (?, ?)'
  ).bind(name, JSON.stringify(muArr)).run();
  return name;
}

// ── Llama domain classification (capped at 50) ───────────────────────────────

async function ensureDomainColumns(env: Env): Promise<void> {
  try { await env.DB.prepare('ALTER TABLE domain_anchors ADD COLUMN memory_count INTEGER DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE domain_anchors ADD COLUMN last_summarized_count INTEGER DEFAULT 0').run(); } catch {}
}

async function classifyDomainWithLlama(text: string, env: Env, precomputedMu?: Float32Array): Promise<string> {
  const rows = await env.DB.prepare('SELECT name FROM domain_anchors ORDER BY rowid').all<{ name: string }>();
  const existing = (rows.results ?? []).map(r => r.name);

  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
    messages: [
      {
        role: 'system',
        content: `You are a memory classifier. Assign this memory to a semantic domain.

RULES (follow strictly):
1. ALWAYS pick from the existing domain list if ANY of them reasonably fits — even loosely.
2. Only create a new domain if the memory is completely unrelated to ALL existing domains.
3. New domain names must be 2-4 lowercase hyphenated words. NO single words. NO verbs. NO leading hyphens. NO punctuation. Examples: "gaussian-memory-dev", "loreal-internship", "career-goals".
4. Never output a domain that starts with "-" or contains uppercase letters or spaces.
5. When in doubt, pick the closest existing domain.

Existing domains (${existing.length}): ${existing.length ? existing.join(', ') : 'none yet'}

Return ONLY valid JSON with no explanation: {"domain":"domain-name-here"}`,
      },
      { role: 'user', content: `<memory_text>${text.slice(0, 300)}</memory_text>` },
    ],
    max_tokens: 30,
  }) as any;

  const rawVal = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
  const raw = (typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal)).trim();
  try {
    const match = raw.match(/\{[^}]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.domain && typeof parsed.domain === 'string') {
        const clean = parsed.domain.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
        if (clean.length >= 2 && !clean.startsWith('-')) {
          // If Llama chose an existing anchor, accept it
          if (existing.includes(clean)) return clean;
          // If cap hit and Llama invented a new domain, fall through to cosine fallback
          if (existing.length >= 50) {
            const mu2 = precomputedMu ?? await embed(text, env);
            return classifyDomain(mu2, text, env);
          }
          return clean;
        }
      }
    }
  } catch {}

  // Fallback: cosine classifier
  const mu = precomputedMu ?? await embed(text, env);
  return classifyDomain(mu, text, env);
}

async function updateDomainCentroid(domainName: string, mu: Float32Array, env: Env): Promise<void> {
  await ensureDomainColumns(env);
  const existing = await env.DB.prepare(
    'SELECT embedding, memory_count FROM domain_anchors WHERE name = ?'
  ).bind(domainName).first<{ embedding: string; memory_count: number }>();

  if (!existing) {
    // Enforce 50-domain cap: if at cap, redirect centroid update to nearest existing domain
    const totalDomains = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
    if ((totalDomains?.n ?? 0) >= 50) {
      const allAnchors = await env.DB.prepare('SELECT name, embedding FROM domain_anchors').all<{ name: string; embedding: string }>();
      const muArr = Array.from(mu);
      let bestName = '';
      let bestSim = -1;
      for (const row of allAnchors.results ?? []) {
        const sim = dotProduct(muArr, JSON.parse(row.embedding) as number[]);
        if (sim > bestSim) { bestSim = sim; bestName = row.name; }
      }
      if (bestName) await updateDomainCentroid(bestName, mu, env);
      return;
    }
    await env.DB.prepare(
      'INSERT INTO domain_anchors (name, embedding, memory_count, last_summarized_count) VALUES (?, ?, 1, 0)'
    ).bind(domainName, JSON.stringify(Array.from(mu))).run();
    return;
  }

  const n = existing.memory_count ?? 0;
  const old: number[] = JSON.parse(existing.embedding);
  const updated = old.map((v, i) => (v * n + (mu[i] ?? 0)) / (n + 1));
  const norm = Math.sqrt(updated.reduce((s, v) => s + v * v, 0));
  const centroid = updated.map(v => v / (norm || 1));
  const newCount = n + 1;

  await env.DB.prepare(
    'UPDATE domain_anchors SET embedding = ?, memory_count = ? WHERE name = ?'
  ).bind(JSON.stringify(centroid), newCount, domainName).run();

  // Trigger summary when domain has ≥5 memories and grew 25%+ since last summary
  const lastSummarized = (await env.DB.prepare(
    'SELECT last_summarized_count FROM domain_anchors WHERE name = ?'
  ).bind(domainName).first<{ last_summarized_count: number }>())?.last_summarized_count ?? 0;

  if (newCount >= 5 && (lastSummarized === 0 || newCount >= Math.ceil(lastSummarized * 1.25))) {
    refreshDomainSummary(domainName, newCount, env).catch(() => {});
  }
}

async function refreshDomainSummary(domainName: string, newCount: number, env: Env): Promise<void> {
  // Prefer recent memories (last 90 days) to avoid stale/misclassified content polluting the summary
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  const rows = await env.DB.prepare(
    'SELECT text FROM memories WHERE domain = ? AND timestamp > ? ORDER BY access_count DESC, timestamp DESC LIMIT 15'
  ).bind(domainName, cutoff).all<{ text: string }>();

  // Fall back to all-time top if no recent memories
  const fallback = (rows.results ?? []).length === 0
    ? await env.DB.prepare(
        'SELECT text FROM memories WHERE domain = ? ORDER BY access_count DESC LIMIT 10'
      ).bind(domainName).all<{ text: string }>()
    : null;

  const facts = ((fallback ?? rows).results ?? []).map(r => r.text).join('\n');
  if (!facts) return;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
    messages: [
      { role: 'system', content: `Summarize what this person knows, does, or prefers specifically in the "${domainName}" domain. Focus only on what distinguishes this domain from others. 2 sentences, specific and factual. No speculation or preamble.` },
      { role: 'user', content: facts },
    ],
    max_tokens: 120,
  }) as any;

  const summary = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
  if (summary) {
    await env.KV.put(`domain_summary:${domainName}`, summary);
    await env.DB.prepare('UPDATE domain_anchors SET last_summarized_count = ? WHERE name = ?')
      .bind(newCount, domainName).run();
  }
}

function inferTypeAndIntensity(text: string): { memory_type: string; emotional_intensity: number } {
  const t = text.toLowerCase();

  let memory_type = 'episodic';
  if (/prefer|like|don't like|always|never|habit|style|usually/.test(t))
    memory_type = 'procedural';
  else if (/believe|think|understand|know|fact|means/.test(t))
    memory_type = 'semantic';

  let emotional_intensity = 0.0;
  if (/\b(urgent|critical|broke|broken|failed|blocked|deadline|breakthrough|finally works|solved it|fixed it)\b/.test(t))
    emotional_intensity = 0.7;
  else if (/\b(important|concerned|struggled|realized|figured out|key insight|discovered)\b/.test(t))
    emotional_intensity = 0.45;

  return { memory_type, emotional_intensity };
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_store',
    description: 'Store a memory with explicit domain and type. Pass topic_key to upsert by logical key — same key updates in place instead of spawning a duplicate. revision_count tracks how many times a keyed memory has been revised.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        domain: { type: 'string', default: 'general' },
        memory_type: { type: 'string', default: 'episodic' },
        emotional_intensity: { type: 'number', default: 0.0 },
        topic_key: { type: 'string' },
        project: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_auto_store',
    description: 'Auto-store a memory — domain and type inferred from content. Call proactively when detecting preferences, decisions, project context, emotional signals. Never announce it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        emotional_intensity: { type: 'number', default: 0.0 },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_store_diff',
    description: 'Store a semantic description of a code edit or bash command. Pass raw diff (file_path + old_string + new_string) or command context; worker infers meaning via Llama before storing.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        command: { type: 'string' },
        output: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_retrieve',
    description: 'Retrieve top-k relevant memories by semantic similarity + sharpness. Set synthesize=true to blend equidistant memories into a single reconstructed memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        domain: { type: 'string' },
        top_k: { type: 'number', default: 5 },
        synthesize: { type: 'boolean', default: false },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: 'List all stored memories with uncertainty level.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string' } },
    },
  },
  {
    name: 'memory_decay',
    description: 'Run decay pass — increase uncertainty, prune faded memories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_stats',
    description: 'System health: total memories, domain/type breakdown, sigma distribution, access heat.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_orphan_check',
    description: 'Detect D1 memories with no Vectorize vector (silent data loss). Pass repair=true to re-embed and fix orphans.',
    inputSchema: {
      type: 'object',
      properties: { repair: { type: 'boolean', default: false } },
    },
  },
  {
    name: 'memory_judge',
    description: 'Judge relationships between a memory and its nearest neighbours. Returns supersedes/conflicts_with/compatible/extends verdicts and stores them in memory_relations. Pass memory_id to judge one memory; omit to auto-judge all flagged contradictions.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
    },
  },
  {
    name: 'memory_capture_passive',
    description: 'Parse structured notes and bulk-store each item as a memory. Looks for sections like "## Key Learnings:", "## Decisions:", "## Problems Solved:" and stores each bullet. Ideal for end-of-session notes.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        project: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_timeline',
    description: 'Chronological view of memories in a domain — shows how knowledge evolved over time, sigma trajectory, and any supersede/conflict markers. Pass domain to scope it; omit for a cross-domain timeline of the most-accessed memories.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'memory_belief_drift_backfill',
    description: 'Backfill sigma_history for all memories that have no history entry. Reconstructs trajectory from access metadata. Processes 300/call — run repeatedly until complete.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by ID. Use memory_list to find IDs.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_update',
    description: 'Update a memory\'s text in place — re-embeds and updates the vector. Sigma and access count are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'memory_extract_and_store',
    description: 'Send a session log to LLM, extract 3-5 memorable facts, store each. Called by session_end hook.',
    inputSchema: {
      type: 'object',
      properties: {
        log_text: { type: 'string' },
      },
      required: ['log_text'],
    },
  },
  {
    name: 'memory_bulk_delete',
    description: 'Delete all memories whose text matches a SQL LIKE pattern. Use % as wildcard. Returns count deleted.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'memory_cleanup_singletons',
    description: 'Reclassify all memories in domains with fewer than N memories (default 3) into the nearest anchored domain. Does not create new domains. Call once — completes in one shot.',
    inputSchema: {
      type: 'object',
      properties: { min_count: { type: 'number', description: 'Domains with fewer than this many memories are singletons. Default 3.' } },
    },
  },
  {
    name: 'memory_rebuild_domains',
    description: 'Re-classify all existing memories with the current domain threshold. Processes in batches of 100; call repeatedly until it returns "done". Clears domain_anchors on first call and lets them re-emerge.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_retag_projects',
    description: 'LLM-based project retagging for memories in the default pool. Llama classifies each memory text into the correct project. Call repeatedly until it returns "Done." ~137 calls for 4k memories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_build_entities',
    description: 'Retroactive entity extraction — processes memories in batches, extracts named entities (tool/project/concept/parameter/person), writes to entity_nodes + memory_entities tables. Call repeatedly until "Done." Enables 1-hop entity graph traversal at retrieve time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_belief_drift',
    description: 'Show how confidence in a memory has changed over time — sigma trajectory from initial store to now. Pass memory_id for a specific memory, or query to find matching memories.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        query: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
    },
  },
  {
    name: 'identity_profile_get',
    description: 'Retrieve the stored CLAUDE.md identity profile from KV. Returns empty string if not set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'identity_profile_set',
    description: 'Store CLAUDE.md identity profile content in KV for cross-device sync.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
  },
];

async function handleToolCall(name: string, args: any, env: Env): Promise<string> {
  switch (name) {
    case 'memory_store': {
      const topicKey = args.topic_key as string | undefined;
      const project = (args.project as string) ?? 'default';
      const now = Math.floor(Date.now() / 1000);

      // topic_key upsert: if a memory with this key exists, update in place
      if (topicKey) {
        const existing = await env.DB.prepare(
          'SELECT id, revision_count, domain, memory_type FROM memories WHERE topic_key = ? AND (project = ? OR project = \'default\') LIMIT 1'
        ).bind(topicKey, project).first<{ id: string; revision_count: number; domain: string; memory_type: string }>();

        if (existing) {
          const mu = await embed(args.text, env);
          const revisions = (existing.revision_count ?? 0) + 1;
          await env.DB.prepare(
            'UPDATE memories SET text = ?, last_accessed = ?, access_count = access_count + 1, revision_count = ? WHERE id = ?'
          ).bind(args.text, now, revisions, existing.id).run();
          await env.VECTORIZE.upsert([{
            id: existing.id, values: Array.from(mu),
            metadata: { domain: existing.domain, memory_type: existing.memory_type, project },
          }]);
          return `REVISED (r${revisions}): '${args.text.slice(0, 60)}' topic_key='${topicKey}' (id=${existing.id.slice(0, 8)})`;
        }
      }

      // No topic_key or no existing match — normal store path
      const { action, id, conflict_candidates } = await storeMemory(
        args.text, args.memory_type ?? 'episodic',
        args.domain ?? 'general', args.emotional_intensity ?? 0.0, env,
        undefined, project
      );

      // Persist topic_key on the new memory if provided
      if (topicKey && action === 'spawned') {
        await env.DB.prepare('UPDATE memories SET topic_key = ? WHERE id = ?').bind(topicKey, id).run();
      }

      let out = `${action.toUpperCase()}: '${args.text.slice(0, 60)}' in domain='${args.domain ?? 'general'}'${topicKey ? ` topic_key='${topicKey}'` : ''} (id=${id.slice(0, 8)})`;
      if (conflict_candidates?.length) out += `\nconflict_candidates: ${JSON.stringify(conflict_candidates)}`;
      return out;
    }

    case 'memory_auto_store': {
      const mu = await embed(args.text, env);
      const domain = await classifyDomainWithLlama(args.text, env, mu);
      const { memory_type, emotional_intensity: inferred } = inferTypeAndIntensity(args.text);
      const emotional_intensity = Math.max(args.emotional_intensity ?? 0.0, inferred);
      const { action, id, conflict_candidates } = await storeMemory(
        args.text, memory_type, domain, emotional_intensity, env, mu, args.project ?? 'default'
      );
      if (action === 'spawned') {
        await updateDomainCentroid(domain, mu, env).catch(() => {});
      }
      let out = `${action.toUpperCase()}: '${args.text.slice(0, 60)}' -> (${domain}/${memory_type}, id=${id.slice(0, 8)})`;
      if (conflict_candidates?.length) {
        out += `\nconflict_candidates: ${JSON.stringify(conflict_candidates)}`;
      }
      return out;
    }

    case 'memory_store_diff': {
      // Build raw context for Llama to interpret
      let diffContext = '';
      if (args.command) {
        const cmd = (args.command as string).slice(0, 200);
        const out = ((args.output as string) ?? '').trim().slice(0, 200);
        diffContext = `Command: ${cmd}${out ? `\nOutput: ${out}` : ''}`;
      } else if (args.file_path || args.new_string) {
        const filePath = (args.file_path as string) ?? '';
        const file = filePath.split('/').pop() ?? 'unknown';
        const projectFromPath = filePath.match(/\/([^/]+)\/(?:src|lib|app)\//)?.[1] ?? '';
        const oldSnip = ((args.old_string as string) ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
        const newSnip = ((args.new_string as string) ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
        diffContext = `File: ${projectFromPath ? projectFromPath + '/' : ''}${file}\nBefore: ${oldSnip}\nAfter: ${newSnip}`;
      }
      if (!diffContext) return 'SKIP: no diff context provided';

      // Semantic entropy gate: skip diffs where old and new are mechanically identical
      // after stripping digits, punctuation, whitespace — catches version bumps, count
      // changes, semicolon fixes, blank line additions that have zero semantic content.
      if (args.old_string != null && args.new_string != null) {
        const strip = (s: string) => s.replace(/[\d\s.,;:'"()\[\]{}\-_=+!?@#$%^&*|\\/<>]/g, '').toLowerCase();
        const strippedOld = strip(args.old_string as string);
        const strippedNew = strip(args.new_string as string);
        // Only skip if both sides have content that strips to the same thing —
        // avoids skipping new-file writes where old is genuinely empty
        if (strippedOld === strippedNew && (strippedOld.length > 0 || (args.old_string as string).length > 0)) {
          return 'SKIP: trivial mechanical change (digits/punctuation only)';
        }
      }


      // GLM quality gate: is this diff worth storing as a long-term memory?
      // Replaces hardcoded skip lists — generalizes to any user's workflow.
      // Runs before Llama description to avoid wasting tokens on low-signal diffs.
      const gateResult = await env.AI.run('@cf/zai-org/glm-4.7-flash' as any, {
        messages: [
          {
            role: 'system',
            content: 'You decide if a code change or command is worth storing as a long-term developer memory. Answer ONLY "YES" or "NO". Store YES for: decisions with rationale (why X was chosen over Y), non-trivial logic changes, bug fixes, architecture choices, meaningful command outputs. Store NO for: formatting, imports, trivial edits, read-only commands, test runs with no insight, boilerplate. If a senior engineer could reconstruct this change just by reading the file, answer NO.',
          },
          { role: 'user', content: `<diff>${diffContext}</diff>` },
        ],
        max_tokens: 1024,
        temperature: 0,
      }) as any;
      // GLM-4.7-flash is a thinking model: reasoning goes into reasoning_content,
      // the final answer is in choices[0].message.content (null until reasoning completes).
      // Must use max_tokens >= 1024 so the model can finish reasoning and emit content.
      const choice = gateResult?.choices?.[0]?.message;
      const rawGate = (gateResult?.response ?? choice?.content ?? '') as string;
      const gateAnswer = rawGate.trim().toUpperCase();
      if (!gateAnswer.startsWith('YES')) return 'SKIP: low signal (GLM quality gate)';

      // Ask Llama to describe the change semantically in one sentence
      // Llama 3.1 8B for diff description — GLM fails on short/minimal diffs (returns {})
      const descResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: 'Summarize this code change or command in ONE factual sentence for a developer memory system. Be specific about what changed and why it matters. Do not start with "I" or "The developer". Under 30 words. Return ONLY the sentence, no JSON, no quotes.',
          },
          { role: 'user', content: `<diff>${diffContext}</diff>` },
        ],
        max_tokens: 60,
      }) as any;

      const description = ((descResult?.response ?? '') as string).trim();
      if (!description || description.length < 10) return 'SKIP: model returned empty description';

      const mu = await embed(description, env);
      const domain = await classifyDomainWithLlama(description, env, mu);
      const { action, id } = await storeMemory(description, 'episodic', domain, 0, env, mu, args.project ?? 'default');
      if (action === 'spawned') await updateDomainCentroid(domain, mu, env).catch(() => {});
      return `${action.toUpperCase()}: '${description.slice(0, 60)}' -> (${domain}/episodic, id=${id.slice(0, 8)})`;
    }

    case 'memory_retrieve': {
      const results = await retrieve(args.query, args.domain ?? null, args.top_k ?? 5, env, args.project ?? 'default', args.context as string | undefined);
      if (!results.length) return 'No memories found.';

      // Fetch domain summaries for domains present in results (uses clean domain, not display)
      const domainsHit = [...new Set(results.map(r => r.domain))];
      const summaries: Record<string, string> = {};
      for (const d of domainsHit) {
        const s = await env.KV.get(`domain_summary:${d}`);
        if (s) summaries[d] = s;
      }

      const fmt = (r: any) => {
        const dd = (r as any).displayDomain ?? r.domain;
        const conf = r.sigma !== undefined ? (r.sigma < 0.3 ? '●' : r.sigma < 0.5 ? '◑' : '○') : '';
        return `[${r.score.toFixed(2)}] (${dd}/${r.type})${r.activated ? ' ~' : ''} ${conf} ${r.text}`;
      };

      // If summaries exist: group output by domain with summary header
      if (Object.keys(summaries).length > 0) {
        const sections = domainsHit.map(d => {
          const mems = results.filter(r => r.domain === d);
          const lines: string[] = [`[DOMAIN: ${d}]`];
          if (summaries[d] && mems.length >= 2) lines.push(`Summary: ${summaries[d]}`);
          lines.push(...mems.map(fmt));
          return lines.join('\n');
        });
        return sections.join('\n\n');
      }

      // Soft-collapse fallback: flat list with optional synthesis
      let preamble = '';
      if (args.synthesize && results.length >= 2
          && results[0].score > 0.85
          && (results[0].score - results[1].score) < 0.04) {
        const blendInput = results.slice(0, 3).map(r => r.text).join('\n');
        const blend = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
          messages: [
            { role: 'system', content: 'Memory synthesis: given 2-3 closely related memories, write one sentence that reconstructs the underlying belief or fact. Be specific. No preamble.' },
            { role: 'user', content: blendInput },
          ],
          max_tokens: 100,
        }) as any;
        const blended = (blend?.response ?? blend?.choices?.[0]?.message?.content ?? '').trim();
        if (blended) preamble = `[SYNTHESIS] ${blended}\n`;
      }

      return preamble + results.map(fmt).join('\n');
    }

    case 'memory_list': {
      const filter = args.domain ? 'WHERE domain = ?' : '';
      const params = args.domain ? [args.domain] : [];
      const rows = await env.DB.prepare(
        `SELECT id, text, sigma_diagonal, domain, memory_type, access_count FROM memories ${filter}`
      ).bind(...params).all<any>();

      if (!rows.results?.length) return 'No memories stored.';
      return rows.results.map((r: any) => {
        const sigma = deserializeSigma(r.sigma_diagonal);
        return `[${r.id.slice(0, 8)}] [σ=${meanSigma(sigma).toFixed(3)}] [${r.access_count}x] (${r.domain}/${r.memory_type}) ${r.text.slice(0, 60)}`;
      }).join('\n');
    }

    case 'memory_orphan_check': {
      const repair = args.repair === true;
      // Fetch all D1 IDs + text in batches
      const allRows = await env.DB.prepare(
        'SELECT id, text, domain, memory_type FROM memories ORDER BY rowid'
      ).all<{ id: string; text: string; domain: string; memory_type: string }>();

      const rows = allRows.results ?? [];
      if (!rows.length) return 'No memories found.';

      // Check Vectorize in batches of 20 (API hard limit for getByIds)
      const CHUNK = 20;
      const orphanIds: string[] = [];
      const orphanRows: typeof rows = [];

      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const ids = chunk.map(r => r.id);
        const vecResult = await (env.VECTORIZE as any).getByIds(ids);
        const foundIds = new Set((vecResult ?? []).map((v: any) => v.id));
        for (const row of chunk) {
          if (!foundIds.has(row.id)) {
            orphanIds.push(row.id);
            orphanRows.push(row);
          }
        }
      }

      if (!orphanIds.length) return `No orphans found. All ${rows.length} D1 rows have Vectorize vectors.`;

      if (!repair) {
        return `Found ${orphanIds.length} orphans (D1 rows with no Vectorize vector) out of ${rows.length} total.\nFirst 5: ${orphanIds.slice(0, 5).join(', ')}\nCall with repair=true to re-embed and fix.`;
      }

      // Repair: re-embed orphans and upsert into Vectorize
      let fixed = 0;
      const EMBED_BATCH = 20;
      for (let i = 0; i < orphanRows.length; i += EMBED_BATCH) {
        const batch = orphanRows.slice(i, i + EMBED_BATCH);
        const mus = await batchEmbed(batch.map(r => r.text), env);
        await env.VECTORIZE.upsert(batch.map((row, j) => ({
          id: row.id,
          values: Array.from(mus[j]),
          metadata: { domain: row.domain, memory_type: row.memory_type },
        })));
        fixed += batch.length;
      }
      return `Repaired ${fixed} orphans — re-embedded and upserted to Vectorize.`;
    }

    case 'memory_capture_passive': {
      const rawText = args.text as string;
      const project = (args.project as string) ?? 'default';

      // Section headers that indicate storable content
      const SECTION_PATTERNS = [
        /^#{1,3}\s*(key\s*learnings?|learnings?)/i,
        /^#{1,3}\s*(decisions?(\s+made)?)/i,
        /^#{1,3}\s*(problems?\s*(solved|fixed|resolved))/i,
        /^#{1,3}\s*(insights?|takeaways?)/i,
        /^#{1,3}\s*(todo|action\s*items?|next\s*steps?)/i,
        /^#{1,3}\s*(context|notes?|summary)/i,
      ];

      // Parse: split into lines, find section headers, collect bullets under them
      const lines = rawText.split('\n');
      const items: { text: string; type: string }[] = [];
      let inSection = false;
      let sectionType = 'episodic';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if this line is a matching section header
        if (SECTION_PATTERNS.some(p => p.test(trimmed))) {
          inSection = true;
          // Infer memory type from section name
          if (/preference|style|habit|always|never/i.test(trimmed)) sectionType = 'procedural';
          else if (/belief|value|insight|principle/i.test(trimmed)) sectionType = 'semantic';
          else sectionType = 'episodic';
          continue;
        }

        // Non-matching header resets section context
        if (/^#{1,3}\s/.test(trimmed)) { inSection = false; continue; }

        if (!inSection) continue;

        // Collect bullet points and numbered list items
        const bullet = trimmed.replace(/^[-*+•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
        if (bullet.length >= 20 && bullet.split(' ').length >= 4) {
          items.push({ text: bullet, type: sectionType });
        }
      }

      if (!items.length) return 'No storable items found. Use headers like "## Key Learnings:", "## Decisions:", "## Problems Solved:" with bullet points underneath.';

      // Embed + classify + store each item
      let stored = 0, skipped = 0;
      const storedMus: Float32Array[] = [];

      for (const item of items.slice(0, 20)) { // cap at 20 per call
        const mu = await embed(item.text, env);
        const tooSimilar = storedMus.some(prev => dotProduct(Array.from(mu), Array.from(prev)) > 0.92);
        if (tooSimilar) { skipped++; continue; }

        const domain = await classifyDomainWithLlama(item.text, env, mu);
        const { memory_type: inferred, emotional_intensity } = inferTypeAndIntensity(item.text);
        const memType = item.type !== 'episodic' ? item.type : inferred;
        const { action } = await storeMemory(item.text, memType, domain, emotional_intensity, env, mu, project);
        if (action === 'spawned') {
          await updateDomainCentroid(domain, mu, env).catch(() => {});
          storedMus.push(mu);
          stored++;
        } else {
          skipped++;
        }
      }

      return `Captured ${stored} memories from structured notes (${skipped} skipped — duplicates or intra-batch similar).`;
    }

    case 'memory_timeline': {
      const limit = Math.min((args.limit as number) ?? 20, 50);
      const domain = args.domain as string | undefined;

      const rows = await env.DB.prepare(
        domain
          ? `SELECT id, text, domain, memory_type, sigma_diagonal, access_count,
                    contradiction_flag, timestamp
             FROM memories WHERE domain = ?
             ORDER BY timestamp ASC LIMIT ?`
          : `SELECT id, text, domain, memory_type, sigma_diagonal, access_count,
                    contradiction_flag, timestamp
             FROM memories
             ORDER BY access_count DESC, timestamp ASC LIMIT ?`
      ).bind(...(domain ? [domain, limit] : [limit]))
       .all<{ id: string; text: string; domain: string; memory_type: string;
              sigma_diagonal: string; access_count: number;
              contradiction_flag: number; timestamp: number }>();

      const memories = rows.results ?? [];
      if (!memories.length) return domain ? `No memories in domain "${domain}".` : 'No memories found.';

      // Fetch supersede relations for these IDs in one query
      const ids = memories.map(m => m.id);
      const relRows = await env.DB.prepare(
        `SELECT from_id, to_id, relation_type FROM memory_relations
         WHERE relation_type IN ('supersedes','conflicts_with')
           AND (from_id IN (${ids.map(() => '?').join(',')})
             OR to_id IN (${ids.map(() => '?').join(',')}))`
      ).bind(...ids, ...ids).all<{ from_id: string; to_id: string; relation_type: string }>();

      const supersededIds = new Set(
        (relRows.results ?? [])
          .filter(r => r.relation_type === 'supersedes')
          .map(r => r.to_id)
      );
      const conflictIds = new Set(
        (relRows.results ?? []).flatMap(r =>
          r.relation_type === 'conflicts_with' ? [r.from_id, r.to_id] : []
        )
      );

      // Group by month for readability
      const groups = new Map<string, typeof memories>();
      for (const m of memories) {
        const d = new Date((m.timestamp ?? 0) * 1000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(m);
      }

      const lines: string[] = [
        domain ? `TIMELINE: ${domain} (${memories.length} memories)` : `TIMELINE: top ${memories.length} most-accessed memories`,
        '',
      ];

      for (const [month, mems] of groups) {
        lines.push(`── ${month} ──`);
        for (const m of mems) {
          const sigma = meanSigma(deserializeSigma(m.sigma_diagonal));
          const conf = sigma < 0.3 ? '●' : sigma < 0.5 ? '◑' : '○';
          const marker = supersededIds.has(m.id) ? '[SUPERSEDED] '
            : conflictIds.has(m.id) ? '[CONFLICT] '
            : m.contradiction_flag ? '[FLAGGED] '
            : '';
          const day = new Date((m.timestamp ?? 0) * 1000).toISOString().slice(0, 10);
          const accessed = m.access_count > 0 ? ` · ${m.access_count}x` : '';
          lines.push(`  ${day} ${conf} σ=${sigma.toFixed(2)}${accessed}  ${marker}${m.text}`);
        }
        lines.push('');
      }

      return lines.join('\n').trimEnd();
    }

    case 'memory_belief_drift': {
      // Resolve which memory IDs to inspect
      let targetIds: string[] = [];
      if (args.memory_id) {
        targetIds = [args.memory_id as string];
      } else if (args.query) {
        const qvec = await embed(args.query as string, env);
        const hits = await env.VECTORIZE.query(Array.from(qvec), { topK: args.top_k ?? 5, returnValues: false, returnMetadata: 'none' });
        targetIds = (hits.matches ?? []).map(m => m.id);
      }
      if (!targetIds.length) return 'No memories found.';

      const placeholders = targetIds.map(() => '?').join(',');
      const mems = await env.DB.prepare(
        `SELECT id, text, sigma_diagonal, access_count, timestamp, domain FROM memories WHERE id IN (${placeholders})`
      ).bind(...targetIds).all<{ id: string; text: string; sigma_diagonal: string; access_count: number; timestamp: number; domain: string }>();

      const lines: string[] = ['## Belief Drift Report\n'];

      for (const m of mems.results ?? []) {
        const currentSigma = meanSigma(deserializeSigma(m.sigma_diagonal));
        const agedays = Math.floor((Date.now() / 1000 - (m.timestamp ?? 0)) / 86400);

        // Pull sigma history for this memory
        const hist = await env.DB.prepare(
          'SELECT sigma, event_type, recorded_at FROM memory_sigma_history WHERE memory_id = ? ORDER BY recorded_at ASC'
        ).bind(m.id).all<{ sigma: number; event_type: string; recorded_at: number }>();
        const histRows = hist.results ?? [];

        const initialSigma = histRows.length > 0 ? histRows[0].sigma : 0.5;
        const drift = initialSigma - currentSigma; // positive = sharpened, negative = faded

        // Verdict
        let verdict: string;
        if (drift > 0.3) verdict = `strongly reinforced — confident belief`;
        else if (drift > 0.15) verdict = `sharpening — belief gaining confidence`;
        else if (drift > 0.05) verdict = `slightly reinforced`;
        else if (drift < -0.1) verdict = `fading — belief losing confidence`;
        else verdict = `stable — unchanged since storage`;

        const conf = currentSigma < 0.3 ? '●' : currentSigma < 0.5 ? '◑' : '○';
        lines.push(`**${conf} ${m.text.slice(0, 120)}**`);
        lines.push(`Domain: ${m.domain} · Age: ${agedays}d · Accessed: ${m.access_count}x`);
        lines.push(`σ: ${initialSigma.toFixed(3)} → ${currentSigma.toFixed(3)} (Δ${drift >= 0 ? '+' : ''}${drift.toFixed(3)}) — ${verdict}`);

        if (histRows.length > 1) {
          lines.push(`Trajectory (${histRows.length} snapshots):`);
          for (const h of histRows) {
            const d = new Date(h.recorded_at * 1000).toISOString().slice(0, 10);
            lines.push(`  ${d}  σ=${h.sigma.toFixed(3)}  [${h.event_type}]`);
          }
        }
        lines.push('');
      }

      return lines.join('\n').trimEnd();
    }

    case 'memory_belief_drift_backfill': {
      // Backfill sigma_history for memories that have no 'store' entry.
      // Reconstructs plausible trajectory from access metadata.
      // Run repeatedly — processes 300/call.
      const bfBatch = await env.DB.prepare(`
        SELECT m.id, m.sigma_diagonal, m.timestamp, m.last_accessed, m.access_count
        FROM memories m
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_sigma_history h WHERE h.memory_id = m.id AND h.event_type = 'store'
        )
        LIMIT 300
      `).all<{ id: string; sigma_diagonal: string; timestamp: number; last_accessed: number; access_count: number }>();

      const bfRows = bfBatch.results ?? [];
      if (!bfRows.length) return 'Backfill complete — all memories have sigma history.';

      const inserts: D1PreparedStatement[] = [];
      for (const row of bfRows) {
        const currentSigma = meanSigma(deserializeSigma(row.sigma_diagonal));
        const t0 = row.timestamp ?? 0;
        const t1 = row.last_accessed ?? t0;
        const accesses = Math.min(row.access_count ?? 0, 8);

        inserts.push(env.DB.prepare(
          'INSERT OR IGNORE INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?,?,?,?,?)'
        ).bind(crypto.randomUUID(), row.id, 0.5, 'store', t0));

        if (accesses >= 2 && t1 > t0) {
          for (let i = 1; i < accesses; i++) {
            const t = Math.floor(t0 + (t1 - t0) * (i / accesses));
            const sigma = parseFloat((0.5 - (0.5 - currentSigma) * (i / accesses)).toFixed(4));
            inserts.push(env.DB.prepare(
              'INSERT OR IGNORE INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?,?,?,?,?)'
            ).bind(crypto.randomUUID(), row.id, sigma, 'synthetic', t));
          }
        }

        if (currentSigma !== 0.5) {
          inserts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?,?,?,?,?)'
          ).bind(crypto.randomUUID(), row.id, currentSigma, 'sharpen', t1));
        }
      }

      for (let i = 0; i < inserts.length; i += 100) {
        await env.DB.batch(inserts.slice(i, i + 100));
      }

      const remaining = await env.DB.prepare(`
        SELECT COUNT(*) as n FROM memories m
        WHERE NOT EXISTS (SELECT 1 FROM memory_sigma_history h WHERE h.memory_id = m.id AND h.event_type = 'store')
      `).first<{ n: number }>();

      return `Backfilled ${bfRows.length} memories. ${remaining?.n ?? '?'} remaining — call again to continue.`;
    }

    case 'memory_process_entity_queue': {
      const before = await env.KV.get('pending_entity_queue');
      const beforeCount = before ? JSON.parse(before).length : 0;
      await processPendingEntityQueue(env);
      const after = await env.KV.get('pending_entity_queue');
      const afterCount = after ? JSON.parse(after).length : 0;
      const entityCount = await env.DB.prepare('SELECT COUNT(*) as n FROM memory_entities').first<{n:number}>();
      return `Processed ${beforeCount - afterCount} memories. Queue: ${beforeCount} → ${afterCount}. Total entity links: ${entityCount?.n ?? 0}`;
    }

    case 'memory_judge': {
      const topK = (args.top_k as number) ?? 5;
      const now = Math.floor(Date.now() / 1000);

      // Build candidate list: explicit ID or all unflagged contradiction memories
      let targets: { id: string; text: string }[] = [];
      if (args.memory_id) {
        // Support both full UUIDs and 8-char display prefixes shown in tool output
        const memId = args.memory_id as string;
        const isPrefix = memId.length === 8 && !memId.includes('-');
        const row = isPrefix
          ? await env.DB.prepare('SELECT id, text FROM memories WHERE id LIKE ?')
              .bind(memId + '%').first<{ id: string; text: string }>()
          : await env.DB.prepare('SELECT id, text FROM memories WHERE id = ?')
              .bind(memId).first<{ id: string; text: string }>();
        if (!row) return `Not found: ${memId}`;
        targets = [row];
      } else {
        // Process pending_judge queue first (near-misses queued at store time), then contradiction_flag
        const pendingRows = await env.DB.prepare(
          `SELECT DISTINCT m.id, m.text FROM memory_relations mr
           JOIN memories m ON m.id = mr.from_id
           WHERE mr.relation_type = 'pending_judge' LIMIT 20`
        ).all<{ id: string; text: string }>();
        targets = pendingRows.results ?? [];

        if (!targets.length) {
          const flagged = await env.DB.prepare(
            'SELECT id, text FROM memories WHERE contradiction_flag = 1 LIMIT 20'
          ).all<{ id: string; text: string }>();
          targets = flagged.results ?? [];
        }
        if (!targets.length) return 'No pending judgements or flagged contradictions.';
      }

      const results: string[] = [];

      for (const target of targets) {
        // Find nearest neighbours via Vectorize
        const mu = await embed(target.text, env);
        const vecResults = await env.VECTORIZE.query(Array.from(mu), {
          topK: topK + 1, returnValues: false, returnMetadata: 'indexed',
        });

        const candidateIds = (vecResults.matches ?? [])
          .filter(m => m.id !== target.id && (m.score ?? 0) >= 0.70)
          .slice(0, topK)
          .map(m => m.id);

        if (!candidateIds.length) {
          results.push(`${target.id.slice(0, 8)}: no candidates above 0.70`);
          continue;
        }

        const candRows = await env.DB.prepare(
          `SELECT id, text FROM memories WHERE id IN (${candidateIds.map(() => '?').join(',')})`
        ).bind(...candidateIds).all<{ id: string; text: string }>();

        for (const cand of candRows.results ?? []) {
          // Check if relation already judged
          const existing = await env.DB.prepare(
            'SELECT id FROM memory_relations WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)'
          ).bind(target.id, cand.id, cand.id, target.id).first();
          if (existing) continue;

          // LLM verdict — Llama 3.3 70B for reliability
          const judgeResult = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
            messages: [
              {
                role: 'system',
                content: `Compare two memories and return their relationship.
Verdicts:
- "supersedes": Memory A is a newer/more accurate version of B (A replaces B)
- "conflicts_with": A and B make contradictory claims about the same topic
- "extends": A adds detail to B without contradicting it
- "compatible": A and B are about different things, no conflict

Return ONLY valid JSON: {"verdict":"supersedes|conflicts_with|extends|compatible","confidence":0.0-1.0,"reason":"one sentence"}`,
              },
              {
                role: 'user',
                content: `<memory_a>${target.text}</memory_a>\n<memory_b>${cand.text}</memory_b>`,
              },
            ],
            max_tokens: 80,
            temperature: 0,
          }) as any;

          const rawVVal = judgeResult?.response ?? judgeResult?.choices?.[0]?.message?.content ?? '';
          const rawV = (typeof rawVVal === 'string' ? rawVVal : JSON.stringify(rawVVal)).trim();
          let verdict = 'compatible', confidence = 0.5, reason = '';
          try {
            const match = rawV.match(/\{[^}]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (['supersedes','conflicts_with','extends','compatible'].includes(parsed.verdict)) {
                verdict = parsed.verdict;
                confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
                reason = (parsed.reason ?? '').slice(0, 200);
              }
            }
          } catch {}

          await env.DB.prepare(
            'INSERT INTO memory_relations (id, from_id, to_id, relation_type, confidence, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), target.id, cand.id, verdict, confidence, reason, now).run();

          // Clear pending_judge entry now that verdict is stored
          await env.DB.prepare(
            `DELETE FROM memory_relations WHERE relation_type = 'pending_judge'
             AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`
          ).bind(target.id, cand.id, cand.id, target.id).run();

          // If supersedes: flag old memory for decay acceleration
          if (verdict === 'supersedes') {
            await env.DB.prepare('UPDATE memories SET contradiction_flag = 1 WHERE id = ?')
              .bind(cand.id).run();
          }

          results.push(`${target.id.slice(0, 8)} → ${cand.id.slice(0, 8)}: ${verdict} (${(confidence * 100).toFixed(0)}%) — ${reason}`);
        }
      }

      return results.length ? results.join('\n') : 'All relations already judged.';
    }

    case 'memory_decay': {
      const { decayed, pruned } = await updateDecay(env);
      return `Decay complete: ${decayed} decayed, ${pruned} pruned.`;
    }

    case 'memory_stats': {
      const rows = await env.DB.prepare(
        `SELECT sigma_diagonal, domain, memory_type, access_count, emotional_intensity, contradiction_flag
         FROM memories`
      ).all<{ sigma_diagonal: string; domain: string; memory_type: string; access_count: number; emotional_intensity: number; contradiction_flag: number }>();

      const all = rows.results ?? [];
      const total = all.length;

      // Anchor stats from D1
      let anchorLine = 'Anchors: 0 domains discovered';
      try {
        const anchorRows = await env.DB.prepare('SELECT name FROM domain_anchors').all<{ name: string }>();
        const anchorNames = (anchorRows.results ?? []).map(r => r.name);
        if (anchorNames.length) anchorLine = `Anchors: ${anchorNames.length} domains discovered — ${anchorNames.join(', ')}`;
      } catch {}

      if (total === 0) return `No memories stored.\n${anchorLine}`;

      const byDomain: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let sharp = 0, medium = 0, fuzzy = 0, prunable = 0;
      let hot = 0, warm = 0, cold = 0;
      let contradictions = 0;
      let totalSigma = 0;

      for (const r of all) {
        byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
        byType[r.memory_type] = (byType[r.memory_type] ?? 0) + 1;

        const s = meanSigma(deserializeSigma(r.sigma_diagonal));
        totalSigma += s;
        if (s < 0.3) sharp++;
        else if (s < 0.8) medium++;
        else if (s < 1.8) fuzzy++;
        else prunable++;

        if (r.access_count > 50) hot++;
        else if (r.access_count > 0) warm++;
        else cold++;

        if (r.contradiction_flag) contradictions++;
      }

      const avgSigma = (totalSigma / total).toFixed(4);
      const domainLines = Object.entries(byDomain).sort((a, b) => b[1] - a[1])
        .map(([d, n]) => `  ${d}: ${n}`).join('\n');
      const typeLines = Object.entries(byType).sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `  ${t}: ${n}`).join('\n');

      return [
        `Total: ${total} memories  (avg σ=${avgSigma})`,
        `Sigma: sharp(<0.3)=${sharp}  medium=${medium}  fuzzy=${fuzzy}  prunable(>1.8)=${prunable}`,
        `Access: hot(>50x)=${hot}  warm(1-50x)=${warm}  cold(0x)=${cold}`,
        `Contradictions flagged: ${contradictions}`,
        anchorLine,
        `\nBy domain:\n${domainLines}`,
        `\nBy type:\n${typeLines}`,
      ].join('\n');
    }

    case 'memory_delete': {
      const row = await env.DB.prepare('SELECT text FROM memories WHERE id = ?')
        .bind(args.id).first<{ text: string }>();
      if (!row) return `Not found: ${args.id}`;
      await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(args.id).run();
      await env.VECTORIZE.deleteByIds([args.id]);
      return `DELETED: '${row.text.slice(0, 60)}' (id=${args.id.slice(0, 8)})`;
    }

    case 'memory_update': {
      const existing = await env.DB.prepare(
        'SELECT sigma_diagonal, memory_type, domain FROM memories WHERE id = ?'
      ).bind(args.id).first<{ sigma_diagonal: string; memory_type: string; domain: string }>();
      if (!existing) return `Not found: ${args.id}`;

      const mu = await embed(args.text, env);
      const now = Math.floor(Date.now() / 1000);

      await env.DB.prepare(
        'UPDATE memories SET text = ?, last_accessed = ? WHERE id = ?'
      ).bind(args.text, now, args.id).run();

      await env.VECTORIZE.upsert([{
        id: args.id,
        values: Array.from(mu),
        metadata: { domain: existing.domain, memory_type: existing.memory_type },
      }]);

      return `UPDATED: '${args.text.slice(0, 60)}' (id=${args.id.slice(0, 8)}, sigma preserved)`;
    }

    case 'memory_extract_and_store': {
      // Pre-filter: strip file paths, URLs, extensions before Llama sees them
      const rawLog = args.log_text as string;
      const filteredLog = rawLog
        .split(/\s*\|\s*/)
        .filter(line => {
          const t = line.trim();
          if (t.length < 25) return false;
          if (/https?:\/\//.test(t)) return false;
          if (/^\/Users|^\/home|^[A-Z]:\\/.test(t)) return false;
          if (/\.(csv|jsonl|pdf|png|jpg|jpeg|js|ts|md|json|txt|py|sh|sql|ipynb)\b/i.test(t)) return false;
          if (/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}/.test(t)) return false;
          return true;
        })
        .join(' | ')
        .slice(0, 60000); // GLM has 131K context — was 4000 for Llama 3.1 8B, now captures full sessions

      // Llama 3.3 70B for extraction — GLM fails on complex multi-object JSON with long prompts.
      // Extraction runs once per session end so cost vs Llama 3.1 8B is negligible.
      const extraction = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
        messages: [
          {
            role: 'system',
            content: `Extract facts from this session log for long-term memory. Today: ${new Date().toISOString().slice(0, 10)}. Resolve relative dates to ISO 8601.

EXTRACT (up to 12 total, prioritized):
1. Decisions — exact technology/approach chosen and WHY. Format transitions as "Switched X → Y because Z" (e.g. "Switched GLM → Llama-3.1-8b because GLM exhausts token budget before emitting content")
2. Implementation parameters — preserve exact numbers/thresholds ("topK=2, threshold=0.65, decay=0.6" not "adjusted parameters")
3. Problems solved — what broke, exact fix applied
4. Project context — concrete state, named blockers, specific counts/dates
5. Preferences — specific tools/methods/patterns with reasoning

RULES:
- Preserve exact names, numbers, technologies ("GLM-4.7-flash" not "a model", "topK=2" not "small topK")
- Capture state transitions: "Changed X from A to B because C"
- Each fact must stand alone without reading the session
- Third-person factual sentence only
- 15–80 words per fact

SKIP: vague intent (Wants to/Is considering/Is planning/Is trying/Is working on/Is looking at/Is thinking about/Is learning/Is exploring), raw chat (ok/yea/lol/ig/tbh/idk), generic status (done/updated/it works/improved the system/made changes), questions, pasted content, anything under 15 words, anything with no specific technology/number/decision named

Return ONLY valid JSON array:
[{"text":"Chose Cloudflare D1 over PlanetScale — zero egress fees, edge-native","type":"episodic"},{"text":"Switched GLM-4.7-flash → Llama-3.1-8b for batch classification because GLM exhausts token budget on reasoning_content before emitting final content, causing timeouts","type":"episodic"},{"text":"Prefers concise responses without emojis","type":"procedural"}]`,
          },
          { role: 'user', content: `<session_log>${filteredLog}</session_log>` },
        ],
        max_tokens: 800,
        temperature: 0,
      }) as any;

      interface ExtractedFact { text: string; type?: string }
      let facts: ExtractedFact[] = [];
      const rawVal = extraction?.response ?? extraction?.choices?.[0]?.message?.content ?? '';
      const raw = (typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal)).trim();
      try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          // Handle both object array and legacy string array
          facts = parsed.map((f: any) =>
            typeof f === 'string' ? { text: f } : f
          );
        }
      } catch {}

      if (!facts.length) {
        facts = raw.split('\n')
          .map((l: string) => l.replace(/^[-*\d.)\s]+/, '').trim())
          .filter((l: string) =>
            l.length > 25 &&
            !l.startsWith('{') &&
            !l.startsWith('[') &&
            !/^here are/i.test(l) &&
            !/^extracted/i.test(l) &&
            !/^json/i.test(l)
          )
          .map((t: string) => ({ text: t }));
      }

      // Filter out obvious garbage before embedding
      const cleanFacts = facts.slice(0, 12).filter(f => {
        const t = (f.text ?? '').trim();
        if (t.length < 20) return false;
        if (t.startsWith('{') || t.startsWith('[')) return false;
        if (/^here are/i.test(t) || /^extracted/i.test(t)) return false;
        if (t.split(' ').length < 4) return false;
        return true;
      });

      let stored = 0;
      const storedMus: Float32Array[] = [];  // intra-batch dedup

      for (const fact of cleanFacts) {
        const text = fact.text ?? '';
        const mu = await embed(text, env);

        // Intra-batch dedup: skip if too similar to something already stored this run
        const tooSimilar = storedMus.some(prev => {
          const sim = dotProduct(Array.from(mu), Array.from(prev));
          return sim > 0.92;
        });
        if (tooSimilar) continue;

        const domain = await classifyDomainWithLlama(text, env, mu);
        const llmType = fact.type && ['episodic','semantic','procedural'].includes(fact.type)
          ? fact.type : null;
        const { memory_type: inferredType, emotional_intensity } = inferTypeAndIntensity(text);
        const memory_type = llmType ?? inferredType;
        const { action } = await storeMemory(text, memory_type, domain, emotional_intensity, env, mu, args.project ?? 'default');
        if (action === 'spawned') {
          await updateDomainCentroid(domain, mu, env).catch(() => {});
          storedMus.push(mu);
        }
        stored++;
      }

      // Session summary — compose from extracted facts, no extra LLM call.
      // Avoids rate limit failures after N domain classification calls.
      // Stored as memory_type='session' so it gets +0.20 retrieval boost and slow decay.
      if (cleanFacts.length >= 2) {
        try {
          const date = new Date().toISOString().slice(0, 10);
          const summaryText = `Session ${date}: ${cleanFacts.slice(0, 5).map(f => f.text).join(' | ')}`;
          const summaryMu = await embed(summaryText, env);
          const summaryDomain = await classifyDomainWithLlama(summaryText, env, summaryMu);
          const { action: sAction } = await storeMemory(
            summaryText, 'session', summaryDomain, 0.9, env, summaryMu, args.project ?? 'default'
          );
          if (sAction === 'spawned') {
            await updateDomainCentroid(summaryDomain, summaryMu, env).catch(() => {});
            stored++;
          }
        } catch {}
      }

      return `Extracted ${facts.length} facts, stored ${stored}.`;
    }

    case 'memory_bulk_delete': {
      // LIKE has a complexity limit on long patterns — use INSTR instead.
      // Split pattern on % to get literal parts; require all parts present (case-insensitive).
      const rawPattern = args.pattern as string;
      const parts = rawPattern.split('%').filter((p: string) => p.length > 0);
      if (parts.length === 0) return 'Invalid pattern.';
      const conditions = parts.map(() => 'INSTR(LOWER(text), LOWER(?)) > 0').join(' AND ');
      const rows = await env.DB.prepare(
        `SELECT id FROM memories WHERE ${conditions}`
      ).bind(...parts).all<{ id: string }>();
      const ids = (rows.results ?? []).map(r => r.id);
      if (!ids.length) return 'No memories matched pattern.';
      for (const id of ids) {
        await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
      }
      // Vectorize hard limit: 100 IDs per deleteByIds call
      for (let i = 0; i < ids.length; i += 100) {
        await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
      }
      return `Deleted ${ids.length} memories matching "${args.pattern}".`;
    }

    case 'memory_cleanup_singletons': {
      const minCount = (args.min_count as number) ?? 3;
      return await cleanupSingletons(env, minCount);
    }

    case 'memory_build_entities': {
      // Retroactive entity extraction — batch processes memories, extracts named entities,
      // writes to entity_nodes + memory_entities for 1-hop graph traversal at retrieve time
      const BATCH = 20;
      const offsetRaw = await env.KV.get('ENTITY_BUILD_OFFSET');
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

      const rows = await env.DB.prepare(
        `SELECT id, text FROM memories ORDER BY access_count DESC, rowid DESC LIMIT ? OFFSET ?`
      ).bind(BATCH, offset).all<{ id: string; text: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('ENTITY_BUILD_OFFSET');
        const count = await env.DB.prepare('SELECT COUNT(*) as n FROM memory_entities').first<{n:number}>();
        return `Done. ${count?.n ?? 0} entity links built.`;
      }

      const numbered = batch.map((r, i) => `${i+1}. ${r.text.slice(0, 150)}`).join('\n');
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: `Extract named entities from each memory. Return ONLY a JSON array of arrays.
Entity types: tool (specific model/library names like GLM-4.7-flash, D1, Vectorize), project (Gaussian Memory, Color Wow, Bayer), concept (spreading activation, Bhattacharyya), parameter (exact values like topK=2), person (proper names).
For each memory return up to 4 entities as ["type:canonical_name", ...]. Use empty array [] if no clear entities.
Example: [["tool:GLM-4.7-flash","concept:spreading activation"],["project:Gaussian Memory","parameter:topK=2"],[]]`,
          },
          { role: 'user', content: numbered },
        ],
        max_tokens: 512,
        temperature: 0,
      }) as any;

      const raw = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
      try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as string[][];
          const now = Math.floor(Date.now() / 1000);
          const dbOps: any[] = [];

          for (let i = 0; i < batch.length; i++) {
            const memId = batch[i].id;
            const entities = parsed[i] ?? [];
            for (const ent of entities) {
              const [type, ...nameParts] = ent.split(':');
              const name = nameParts.join(':').trim();
              if (!type || !name) continue;
              const entId = `ent_${type}_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
              dbOps.push(
                env.DB.prepare(`INSERT OR IGNORE INTO entity_nodes (id, type, canonical_name, last_seen) VALUES (?,?,?,?)`)
                  .bind(entId, type, name, now)
              );
              dbOps.push(
                env.DB.prepare(`UPDATE entity_nodes SET last_seen = ? WHERE id = ?`).bind(now, entId)
              );
              dbOps.push(
                env.DB.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, entity_span) VALUES (?,?,?)`)
                  .bind(memId, entId, name)
              );
            }
          }
          if (dbOps.length > 0) await env.DB.batch(dbOps);
        }
      } catch {}

      await env.KV.put('ENTITY_BUILD_OFFSET', String(offset + BATCH));
      const total = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{n:number}>();
      return `Processed batch at offset ${offset}. ${total?.n ?? 0} memories total, ~${Math.max(0, (total?.n ?? 0) - offset - BATCH)} remaining.`;
    }

    case 'memory_retag_projects': {
      const BATCH = 30;
      const PROJECTS = ['gaussian-memory-worker','bayer-traitprediction','loreal-internship','leetcode-practice','personal','default'];
      const offsetRaw = await env.KV.get('RETAG_OFFSET');
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

      const rows = await env.DB.prepare(
        `SELECT id, text FROM memories WHERE project = 'default' ORDER BY rowid LIMIT ?`
      ).bind(BATCH).all<{ id: string; text: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('RETAG_OFFSET');
        const counts = await env.DB.prepare(`SELECT project, COUNT(*) as cnt FROM memories GROUP BY project ORDER BY cnt DESC`).all<{project:string;cnt:number}>();
        const summary = (counts.results ?? []).map(r => `${r.project}:${r.cnt}`).join(', ');
        return `Done. ${summary}`;
      }

      const numbered = batch.map((r, i) => `${i+1}. ${r.text.slice(0, 120)}`).join('\n');
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: `Classify each memory by project. Return ONLY a JSON array of exactly ${batch.length} project name strings.

Projects:
- gaussian-memory-worker: Cloudflare Workers, D1, Vectorize, MCP server, memory_retrieve, spreading activation, sigma, domain classification, wrangler
- bayer-traitprediction: UAV imagery, maize, G2F, phenotypic data, CyVerse, shapefiles, field trials, Purdue Data Mine, crop science
- loreal-internship: Color Wow, SKU anomaly, BigQuery, Gemini, sales digest, GChat, Federici Brands, Sephora, Ulta, Amazon US
- leetcode-practice: LeetCode, statistics, probability, binomial, z-score, regression, homework, exam, cheat sheet
- personal: career goals, dating, relationships, health, apartment, fitness, social life, job search, recruiting
- default: genuinely unclear or cross-project

Return: ["project-name", "project-name", ...]`,
          },
          { role: 'user', content: numbered },
        ],
        max_tokens: 256,
      }) as any;

      const raw = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
      try {
        const match = raw.match(/\[[\s\S]*?\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as string[];
          const updates = batch
            .map((r, i) => {
              const p = (parsed[i] ?? 'default').trim();
              return PROJECTS.includes(p) ? { id: r.id, project: p } : null;
            })
            .filter(Boolean) as { id: string; project: string }[];

          if (updates.length) {
            await env.DB.batch(
              updates.map(u => env.DB.prepare('UPDATE memories SET project = ? WHERE id = ?').bind(u.project, u.id))
            );
          }
        }
      } catch {}

      await env.KV.put('RETAG_OFFSET', String(offset + BATCH));
      const remaining = await env.DB.prepare(`SELECT COUNT(*) as n FROM memories WHERE project = 'default'`).first<{n:number}>();
      return `Processed batch. ~${remaining?.n ?? '?'} default memories remaining.`;
    }

    case 'memory_rebuild_domains': {
      await ensureDomainColumns(env);
      const BATCH = 30;  // Smaller batch — 3 Llama calls per invocation (10 texts each)
      const offsetRaw = await env.KV.get('REBUILD_OFFSET');

      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      // targeted=true (default): only reclassify unanchored/general memories, keep existing anchors
      // targeted=false: full wipe-and-rebuild (pass targeted=false explicitly)
      const targeted = args.targeted !== false;

      // Only wipe anchors on full rebuild, not targeted pass
      if (offsetRaw === null && !targeted) {
        await env.DB.prepare('DELETE FROM domain_anchors').run();
      }
      // Targeted mode uses no OFFSET — rows disappear from result set as they're fixed,
      // so OFFSET-based pagination skips rows. Just LIMIT without offset, keep calling until empty.
      const rows = await env.DB.prepare(
        targeted
          ? `SELECT id, text, memory_type FROM memories
             WHERE domain = 'general' OR domain NOT IN (SELECT name FROM domain_anchors)
             ORDER BY rowid LIMIT ?`
          : 'SELECT id, text, memory_type FROM memories ORDER BY rowid LIMIT ? OFFSET ?'
      ).bind(...(targeted ? [BATCH] : [BATCH, offset])).all<{ id: string; text: string; memory_type: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('REBUILD_OFFSET');
        const total = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{ n: number }>();
        const anchors = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
        return `Done. ${total?.n ?? 0} memories reclassified into ${anchors?.n ?? 0} domains.`;
      }

      // Batch embed + classify using shared helper
      const mus = await batchEmbed(batch.map(r => r.text), env);
      const existingDomains = (await env.DB.prepare('SELECT name FROM domain_anchors ORDER BY rowid')
        .all<{ name: string }>()).results?.map(r => r.name) ?? [];
      const rawAssignments = await classifyBatchDomains(batch.map(r => r.text), existingDomains, env);
      const domainAssignments = await remapToAnchoredDomains(rawAssignments, mus, env);

      // Batch D1 updates + centroid accumulation
      const d1Updates: D1PreparedStatement[] = [];
      const vectorizeUpdates: any[] = [];
      const centroidAccum = new Map<string, { sum: number[]; count: number }>();

      for (let i = 0; i < batch.length; i++) {
        const domain = domainAssignments[i];
        d1Updates.push(env.DB.prepare('UPDATE memories SET domain = ? WHERE id = ?').bind(domain, batch[i].id));
        vectorizeUpdates.push({ id: batch[i].id, values: Array.from(mus[i]), metadata: { domain, memory_type: batch[i].memory_type } });

        const acc = centroidAccum.get(domain) ?? { sum: new Array(mus[i].length).fill(0), count: 0 };
        mus[i].forEach((v, j) => { acc.sum[j] = (acc.sum[j] ?? 0) + v; });
        acc.count++;
        centroidAccum.set(domain, acc);
      }

      // Write D1 memory updates in one batch
      for (let i = 0; i < d1Updates.length; i += 500) {
        await env.DB.batch(d1Updates.slice(i, i + 500));
      }
      await env.VECTORIZE.upsert(vectorizeUpdates);

      // Update domain centroids (incremental mean)
      for (const [domain, { sum, count }] of centroidAccum) {
        const existing = await env.DB.prepare(
          'SELECT embedding, memory_count FROM domain_anchors WHERE name = ?'
        ).bind(domain).first<{ embedding: string; memory_count: number }>();

        if (!existing) {
          // Cap guard: don't create new anchors beyond 50
          const totalDomains = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
          if ((totalDomains?.n ?? 0) < 50) {
            const norm = Math.sqrt(sum.reduce((s, v) => s + v * v, 0));
            const centroid = sum.map(v => v / (norm || 1));
            await env.DB.prepare(
              'INSERT INTO domain_anchors (name, embedding, memory_count, last_summarized_count) VALUES (?, ?, ?, 0)'
            ).bind(domain, JSON.stringify(centroid), count).run();
          }
        } else {
          const n = existing.memory_count ?? 0;
          const old: number[] = JSON.parse(existing.embedding);
          const updated = old.map((v, j) => (v * n + (sum[j] ?? 0)) / (n + count));
          const norm = Math.sqrt(updated.reduce((s, v) => s + v * v, 0));
          await env.DB.prepare(
            'UPDATE domain_anchors SET embedding = ?, memory_count = ? WHERE name = ?'
          ).bind(JSON.stringify(updated.map(v => v / (norm || 1))), n + count, domain).run();
        }
      }

      await env.KV.put('REBUILD_OFFSET', String(offset + batch.length));
      const totalCount = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{ n: number }>();
      const domainCount = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
      return `Processed ${offset + batch.length}/${totalCount?.n ?? '?'} — ${domainCount?.n ?? 0} domains so far. Call again to continue.`;
    }

    case 'identity_profile_get': {
      const content = await env.KV.get('IDENTITY_PROFILE') ?? '';
      return content;
    }

    case 'identity_profile_set': {
      await env.KV.put('IDENTITY_PROFILE', args.content as string);
      return `Identity profile stored (${(args.content as string).length} chars)`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── HTTP Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Gaussian Memory MCP Server', { status: 200 });
    }

    // API key auth — required. Accepts Bearer header OR ?token= query param (for MCP clients that don't support headers).
    // Deploy must set AUTH_TOKEN secret via: wrangler secret put AUTH_TOKEN
    if (!env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Server misconfigured: AUTH_TOKEN not set. Run: wrangler secret put AUTH_TOKEN' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    const authHeader = request.headers.get('Authorization') ?? '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const urlToken = new URL(request.url).searchParams.get('token') ?? '';
    if (headerToken !== env.AUTH_TOKEN && urlToken !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json() as any;
    const { method, params, id } = body;

    // MCP notifications have no id — must return 202 with no body
    if (id === undefined) {
      return new Response(null, {
        status: 202,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    let result: any;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gaussian-memory', version: '1.0.0' },
      };
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      let content: string;
      try {
        content = await handleToolCall(params.name, params.arguments ?? {}, env);
      } catch (e: any) {
        content = `ERROR: ${e?.message ?? String(e)}\nStack: ${e?.stack ?? 'none'}`;
      }
      result = { content: [{ type: 'text', text: content }] };
    } else {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id,
        error: { code: -32601, message: 'Method not found' },
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },

  // Daily decay + domain cleanup + identity synthesis via cron
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await pruneJunkMemories(env);
    await updateDecay(env);
    await deduplicateRecentMemories(env);
    await deduplicateColdMemories(env);
    await cleanupSingletons(env, 3);
    await refreshStaleDomainSummaries(env);
    await cronRebuildBatch(env, 2000, 10 * 60 * 1000);
    await synthesizeIdentityProfile(env);
    // Process up to 20 pending_judge pairs nightly — feeds memory_relations with verdicts
    await handleToolCall('memory_judge', {}, env).catch(() => {});
    // Process pending entity extraction queue (new memories queued during day)
    await processPendingEntityQueue(env);
  },
};
