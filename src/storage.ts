import type { Env } from './types';
import { embed } from './embed';
import {
  initialSigma, deserializeSigma, serializeSigma,
  kalmanMerge, shouldMerge, meanSigma,
} from './gaussian';

const HOT_KEY = 'hot:recent_ids';
const HOT_TTL = 86400; // 24h
const HOT_MAX = 100;

export async function hotTierAdd(id: string, env: Env): Promise<void> {
  try {
    const raw = await env.KV.get(HOT_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    const updated = [id, ...ids.filter(i => i !== id)].slice(0, HOT_MAX);
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
  } catch (e) {
    console.error('[entity-queue]', e);
  }
}

const NEGATION = /\b(no longer|stop using|stopped using|don't use|switched from|instead of|avoid using|shouldn't use|never use|removed|disabled|deprecated)\b/i;

function isContradiction(newText: string, existingText: string, cosineSim: number): boolean {
  if (cosineSim < 0.88) return false;
  return NEGATION.test(newText) !== NEGATION.test(existingText);
}

export async function storeMemory(
  text: string, memoryType: string, domain: string,
  emotionalIntensity: number, env: Env,
  precomputedMu?: Float32Array,
  project: string = 'default'
): Promise<{ action: string; id: string; conflict_candidates?: Array<{ id: string; text: string; score: number }> }> {
  const mu = precomputedMu ?? await embed(text, env);
  const dim = mu.length;
  const sigma = initialSigma(domain, emotionalIntensity, dim);
  const now = Math.floor(Date.now() / 1000);

  // D1 exact-text check before Vectorize — Vectorize has 2-5 min propagation lag so
  // a second ingest of the same text would spawn a duplicate before Vectorize indexes it.
  const exactRow = await env.DB.prepare(
    `SELECT id, sigma_diagonal FROM memories WHERE text = ? LIMIT 1`
  ).bind(text).first<{ id: string; sigma_diagonal: string }>().catch(() => null);
  if (exactRow) {
    const existingSigma = deserializeSigma(exactRow.sigma_diagonal);
    const [, newSigma] = kalmanMerge(mu, existingSigma, mu, existingSigma);
    await env.DB.prepare(
      `UPDATE memories SET sigma_diagonal = ?, last_accessed = ?, access_count = access_count + 1 WHERE id = ?`
    ).bind(serializeSigma(newSigma), now, exactRow.id).run();
    return { action: 'merged', id: exactRow.id };
  }

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
         access_count, memory_type, domain, emotional_intensity, contradiction_flag, project, valid_from)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)
    `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity, project, now).run();
    await env.DB.prepare(`INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)`)
      .bind(id, text, project).run().catch(() => {});
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

  await env.DB.prepare(`
    INSERT INTO memories
      (id, text, sigma_diagonal, timestamp, last_accessed,
       access_count, memory_type, domain, emotional_intensity, project, valid_from)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity, project, now).run();
  await env.DB.prepare(`INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)`)
    .bind(id, text, project).run().catch(() => {});

  await env.VECTORIZE.upsert([{
    id,
    values: Array.from(mu),
    metadata: { domain, memory_type: memoryType, project },
  }]);
  await extractAndLinkEntities(id, text, env); // awaited — KV write must complete
  // Record initial σ — baseline for belief drift tracking
  await env.DB.prepare(
    'INSERT INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), id, meanSigma(sigma), 'store', now).run().catch(() => {});

  // Surface near-miss candidates (score > 0.85, not merged) for memory_judge
  const nearMissIds = results.matches
    .filter(m => m.score > 0.85 && m.id !== id)
    .map(m => m.id);

  let conflict_candidates: Array<{ id: string; text: string; score: number }> | undefined;
  if (nearMissIds.length > 0) {
    const nearPlaceholders = nearMissIds.map(() => '?').join(',');
    const nearRows = await env.DB.prepare(
      `SELECT id, text FROM memories WHERE id IN (${nearPlaceholders})`
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
