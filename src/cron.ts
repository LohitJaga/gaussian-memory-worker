import type { Env } from './types';
import { batchEmbed, dotProduct } from './embed';
import {
  ensureDomainColumns, classifyBatchDomains, remapToAnchoredDomains, refreshDomainSummary,
} from './domain';
import { decaySigma, deserializeSigma, serializeSigma, meanSigma } from './gaussian';

export async function updateDecay(env: Env): Promise<{ decayed: number; pruned: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const SEVEN_DAYS = 7 * 86400;

  // Batch 500 at a time to avoid D1 full-table-scan timeouts.
  // Prioritise candidates that are cold (no access) or old — process worst-sigma rows first.
  const rows = await env.DB.prepare(
    `SELECT id, sigma_diagonal, access_count, timestamp FROM memories
     WHERE sigma_diagonal IS NOT NULL
     ORDER BY access_count ASC, timestamp ASC
     LIMIT 500`
  ).all<{ id: string; sigma_diagonal: string; access_count: number; timestamp: number }>();

  let decayed = 0, pruned = 0;
  const updateStmts: D1PreparedStatement[] = [];
  const pruneIds: string[] = [];

  for (const row of rows.results ?? []) {
    const stability = 1 + Math.log((row.access_count ?? 0) + 1);
    const effectiveDelta = 0.02 / stability;
    let sigma = decaySigma(deserializeSigma(row.sigma_diagonal), effectiveDelta);
    const isColdStale = (row.access_count ?? 0) === 0 && (nowSec - (row.timestamp ?? 0)) > SEVEN_DAYS;
    if (isColdStale) {
      sigma = decaySigma(sigma, effectiveDelta);
      sigma = decaySigma(sigma, effectiveDelta); // 3 total = ~3× cold penalty
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
    const chunk = pruneIds.slice(i, i + CHUNK);
    await env.DB.batch([
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
    ]);
  }
  if (pruneIds.length) await env.VECTORIZE.deleteByIds(pruneIds);

  return { decayed, pruned };
}

// Nightly domain rebuild — classifies only domain='general' memories, time-budget guarded.
export async function cronRebuildBatch(env: Env, rowLimit: number, timeBudgetMs: number): Promise<void> {
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
export async function pruneJunkMemories(env: Env): Promise<number> {
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
    await env.DB.batch([
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
    ]);
    await env.VECTORIZE.deleteByIds(chunk);
  }
  return ids.length;
}

export async function deduplicateRecentMemories(env: Env, windowSec = 86400, threshold = 0.90): Promise<string> {
  const since = Math.floor(Date.now() / 1000) - windowSec;
  const recent = await env.DB.prepare(
    'SELECT id, text, project FROM memories WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 200'
  ).bind(since).all<{ id: string; text: string; project: string }>();

  const rows = recent.results ?? [];
  if (rows.length === 0) return 'No recent memories to dedup.';

  const mus = await batchEmbed(rows.map(r => r.text), env);
  const toDelete: string[] = [];
  const deleted = new Set<string>();
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
    const chunk = toDelete.slice(i, i + 500);
    await env.DB.batch([
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
    ]);
  }
  await env.VECTORIZE.deleteByIds(toDelete);
  return `Deduped ${toDelete.length} duplicate memories from last 24h.`;
}

// Daily cold dedup: checks 500 oldest never-accessed memories against full corpus.
// Higher threshold (0.93) than the daily 24h pass (0.90) — conservative to avoid
// false-positives on short memories. Runs oldest-first so domain-bleeding duplicates
// from weeks ago get hit immediately rather than waiting for a full cycle.
export async function deduplicateColdMemories(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    'SELECT id, text, project FROM memories WHERE access_count = 0 ORDER BY timestamp ASC LIMIT 500'
  ).all<{ id: string; text: string; project: string }>();

  const cold = rows.results ?? [];
  if (!cold.length) return 'No cold memories to dedup.';

  const mus = await batchEmbed(cold.map(r => r.text), env);
  const toDelete: string[] = [];
  const deleted = new Set<string>();

  for (let i = 0; i < cold.length; i++) {
    if (deleted.has(cold[i].id)) continue;
    const results = await env.VECTORIZE.query(mus[i], { topK: 3, returnMetadata: 'indexed' });
    for (const match of results.matches ?? []) {
      const matchProject = (match.metadata as any)?.project ?? 'default';
      const rowProject = cold[i].project ?? 'default';
      // Guard !deleted.has(match.id): if the surviving copy was itself deleted earlier
      // in this pass, deleting this one too would destroy BOTH copies of the pair.
      // Same-project guard mirrors deduplicateRecentMemories — never dedup across projects.
      if (match.id !== cold[i].id && (match.score ?? 0) >= 0.93 && !deleted.has(match.id) && matchProject === rowProject) {
        toDelete.push(cold[i].id);
        deleted.add(cold[i].id);
        break;
      }
    }
  }

  if (!toDelete.length) return 'No cold duplicates found.';

  const CHUNK = 500;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    await env.DB.batch([
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
    ]);
  }
  await env.VECTORIZE.deleteByIds(toDelete);
  return `Cold dedup: removed ${toDelete.length} duplicates from oldest cold memories.`;
}

export async function cleanupSingletons(env: Env, minCount = 3): Promise<string> {
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

export async function refreshStaleDomainSummaries(env: Env): Promise<void> {
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

export async function synthesizeIdentityProfile(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT text FROM memories WHERE memory_type = 'semantic'
     ORDER BY access_count DESC, last_accessed DESC LIMIT 20`
  ).all<{ text: string }>();

  const facts = (rows.results ?? []).map(r => r.text).join('\n');
  if (!facts) return;

  const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
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

export async function consolidateColdMemories(env: Env): Promise<{ archived: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400; // older than 30 days
  const rows = await env.DB.prepare(`
    SELECT id, text, sigma_diagonal, domain, memory_type, timestamp
    FROM memories
    WHERE access_count = 0
      AND memory_type NOT IN ('session', 'decision')
      AND timestamp < ?
    ORDER BY timestamp ASC
    LIMIT 200
  `).bind(cutoff).all<{
    id: string; text: string; sigma_diagonal: string;
    domain: string; memory_type: string; timestamp: number;
  }>();

  const cold = (rows.results ?? []).filter(r => meanSigma(deserializeSigma(r.sigma_diagonal)) > 1.5);
  if (!cold.length) return { archived: 0 };

  // Process in batches of 10 to stay within AI budget per cron tick
  const BATCH = 10;
  const archived: string[] = [];

  for (let i = 0; i < cold.length && i < 100; i += BATCH) {
    const batch = cold.slice(i, i + BATCH);
    const summaries = await Promise.all(batch.map(async row => {
      try {
        const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
          messages: [
            { role: 'system', content: 'Summarize the following memory in one concise sentence. Return only the sentence.' },
            { role: 'user', content: row.text },
          ],
          max_tokens: 80,
        }) as any;
        return (result?.response ?? result?.choices?.[0]?.message?.content ?? row.text ?? '').trim();
      } catch {
        return (row.text ?? '').slice(0, 200);
      }
    }));

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const payload = JSON.stringify({
        id: row.id,
        original_text: row.text,
        compressed_text: summaries[j],
        domain: row.domain,
        memory_type: row.memory_type,
        archived_at: Math.floor(Date.now() / 1000),
        original_timestamp: row.timestamp,
      });
      try {
        await env.R2.put(`memories/${row.id}.json`, payload, {
          httpMetadata: { contentType: 'application/json' },
        });
        archived.push(row.id);
      } catch { /* R2 failure — skip this memory, retry next cron run */ }
    }
  }

  if (!archived.length) return { archived: 0 };

  // Delete from D1 and Vectorize in chunks
  const CHUNK = 500;
  for (let i = 0; i < archived.length; i += CHUNK) {
    const chunk = archived.slice(i, i + CHUNK);
    await env.DB.batch([
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
      ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
    ]);
    await env.VECTORIZE.deleteByIds(chunk).catch(() => {});
  }

  return { archived: archived.length };
}
