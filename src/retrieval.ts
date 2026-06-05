import type { Env } from './types';
import { embed, batchEmbed, dotProduct } from './embed';
import { hotTierGet, hotTierAdd } from './storage';
import {
  deserializeSigma, serializeSigma, meanSigma, sharpenSigma, distributionalScore,
} from './gaussian';

export async function retrieve(
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
  const mergedSet = new Set(mergedIds);
  const hotOnlyIds = hotIds.filter(id => !mergedSet.has(id));

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

  // Merge IDs for D1 fetch — hot tier first so it gets guaranteed slots (D1 bind limit ~100)
  const allIds = [...new Set([...hotOnlyIds.slice(0, 10), ...results.matches.map(m => m.id), ...ftsOnlyIds])].slice(0, 90);
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

  // σ hard gate: specific queries only surface memories whose confidence meets the
  // query's specificity requirement. sigmaCeiling scales with querySigmaVal so vague
  // queries stay permissive. Always keep at least 2 results to prevent empty injection.
  const sigmaCeiling = Math.max(0.65, querySigmaVal * 1.8);
  const gated = top.filter(m => meanSigma(m.sigma) <= sigmaCeiling);
  const finalTop = gated.length >= 2 ? gated : top.slice(0, Math.max(2, Math.ceil(top.length / 2)));

  // Sharpen accessed memories + record history if σ changed meaningfully
  const now = Math.floor(Date.now() / 1000);
  for (const mem of finalTop) {
    const domSize = domainSizeMap.get(mem.domain) ?? 10;
    const newSigma = sharpenSigma(mem.sigma, 0.85, 0.15, mem.contradiction, domSize);
    await env.DB.prepare(
      'UPDATE memories SET last_accessed = ?, access_count = access_count + 1, sigma_diagonal = ? WHERE id = ?'
    ).bind(now, serializeSigma(newSigma), mem.id).run();
    await hotTierAdd(mem.id, env); // hot tier = recently accessed, not recently stored
    // Record sigma history if it moved by more than 0.05 — avoids spammy writes on tiny changes
    const oldMean = meanSigma(mem.sigma);
    const newMean = meanSigma(newSigma);
    if (Math.abs(newMean - oldMean) >= 0.05) {
      await env.DB.prepare(
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

  return finalTop.map(m => {
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
