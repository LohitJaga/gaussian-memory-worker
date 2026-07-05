import {
  type MicroCluster, addToMicros, applyMergeTrace, buildMergeTrace,
  clusterCountAtThreshold, finalizeClusters, newMicroFromRow, normalize,
} from './cluster';
import {
  ANCHOR_FLOOR_SIM, DOMAIN_CAP, classifyBatchDomains, deriveAnchorName,
  ensureDomainColumns, nameCluster,
} from './domain';
import { batchEmbed } from './embed';
import type { Env } from './types';

// Full rebuild = deterministic clustering pipeline (scan → cluster → name → commit).
// Replaces the sequential per-batch LLM classification that was measurably
// unstable (same ~4600-memory corpus → 15/31/49/6/50 domains across reruns).
// Grouping is pure embedding math on raw memory vectors; the LLM runs once per
// final cluster, for naming only. Rerunning on the same corpus converges to the
// same clusters by construction.

const STATE_KEY = 'REBUILD_STATE';
const LEGACY_OFFSET_KEY = 'REBUILD_OFFSET';
const TARGETED_OFFSET_KEY = 'REBUILD_TARGETED_OFFSET';
const SCAN_BATCH = 200;
const NAME_BATCH = 5;
const COMMIT_BATCH = 300;
const TARGETED_BATCH = 100;

// Leader-pass admission: micro-clusters are near-identical topics (dedup fires
// at 0.90-0.93 in this corpus, so 0.85 sits just below the duplicate band).
export const DEFAULT_MICRO_THRESHOLD = 0.85;
// Average-linkage cut between micro-clusters. A guess until measured on real
// data — sweep with dry_run=true (reports the count-per-threshold curve) and
// pass merge_threshold explicitly before trusting the default.
export const DEFAULT_MERGE_THRESHOLD = 0.75;
const TRACE_FLOOR = 0.6; // merges below this avg similarity are never meaningful
const MIN_CLUSTER_SIZE = 3; // matches cleanupSingletons minCount
const REPORT_THRESHOLDS = [0.65, 0.7, 0.725, 0.75, 0.775, 0.8, 0.85];

// Above this many micro-clusters, the O(k²) merge phase risks the Workers CPU
// budget — restart with a lower micro_threshold to get coarser micros instead.
const MAX_MICROS = 2500;

interface RebuildState {
  phase: 'scan' | 'cluster' | 'name' | 'commit';
  offset: number;
  mergeThreshold: number;
  microThreshold: number;
  anchorsWritten?: boolean;
}

async function loadState(env: Env): Promise<RebuildState | null> {
  const raw = await env.KV.get(STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as RebuildState; } catch { return null; }
}

async function saveState(env: Env, state: RebuildState): Promise<void> {
  await env.KV.put(STATE_KEY, JSON.stringify(state));
}

async function ensureScratchTables(env: Env): Promise<void> {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS rebuild_micros (idx INTEGER PRIMARY KEY, sum TEXT NOT NULL, count INTEGER NOT NULL, final_idx INTEGER)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS rebuild_finals (idx INTEGER PRIMARY KEY, sum TEXT NOT NULL, count INTEGER NOT NULL, name TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS rebuild_assign (memory_id TEXT PRIMARY KEY, mc INTEGER NOT NULL, sim REAL NOT NULL)'
  ).run();
}

async function dropScratchTables(env: Env): Promise<void> {
  await env.DB.prepare('DROP TABLE IF EXISTS rebuild_micros').run();
  await env.DB.prepare('DROP TABLE IF EXISTS rebuild_finals').run();
  await env.DB.prepare('DROP TABLE IF EXISTS rebuild_assign').run();
}

// Reuse stored Vectorize vectors (same normalized bge embeddings) instead of
// re-embedding the whole corpus; fall back to embed() for D1/Vectorize drift.
async function fetchVectors(ids: string[], texts: string[], env: Env): Promise<number[][]> {
  const found = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const vecs = await env.VECTORIZE.getByIds(ids.slice(i, i + 100));
    for (const v of vecs ?? []) found.set(v.id, normalize(Array.from(v.values as number[])));
  }
  const missing = ids.map((id, i) => (found.has(id) ? -1 : i)).filter(i => i >= 0);
  if (missing.length) {
    const embedded = await batchEmbed(missing.map(i => texts[i]), env);
    missing.forEach((idx, j) => {
      found.set(ids[idx], Array.from(embedded[j]));
    });
  }
  return ids.map(id => found.get(id) as number[]);
}

async function loadMicros(env: Env): Promise<MicroCluster[]> {
  const rows = await env.DB.prepare('SELECT idx, sum, count FROM rebuild_micros ORDER BY idx')
    .all<{ idx: number; sum: string; count: number }>();
  return (rows.results ?? []).map(r => newMicroFromRow(JSON.parse(r.sum) as number[], r.count));
}

export async function rebuildDomainsStep(args: any, env: Env): Promise<string> {
  await ensureDomainColumns(env);
  let state = await loadState(env);
  const targeted = !(args.targeted === false || args.targeted === 'false');

  // Escape hatch: abandon a stuck full rebuild (no other way to abort mid-flight)
  if (state && (args.restart === true || args.restart === 'true')) {
    await dropScratchTables(env);
    await env.KV.delete(STATE_KEY);
    state = null;
  }

  // A full rebuild in progress always continues, regardless of the targeted flag.
  if (state) {
    if (typeof args.merge_threshold === 'number' && state.phase === 'cluster') {
      state.mergeThreshold = args.merge_threshold;
    }
    switch (state.phase) {
      case 'scan': return scanStep(state, env);
      case 'cluster': return clusterStep(state, env, args.dry_run === true || args.dry_run === 'true');
      case 'name': return nameStep(state, env);
      case 'commit': return commitStep(state, env);
    }
  }

  if (targeted) return targetedStep(env);

  // Fresh full rebuild
  await dropScratchTables(env);
  await ensureScratchTables(env);
  await env.KV.delete(LEGACY_OFFSET_KEY);
  await env.KV.delete(TARGETED_OFFSET_KEY);
  const fresh: RebuildState = {
    phase: 'scan',
    offset: 0,
    mergeThreshold: typeof args.merge_threshold === 'number' ? args.merge_threshold : DEFAULT_MERGE_THRESHOLD,
    microThreshold: typeof args.micro_threshold === 'number' ? args.micro_threshold : DEFAULT_MICRO_THRESHOLD,
  };
  await saveState(env, fresh);
  return scanStep(fresh, env);
}

async function scanStep(state: RebuildState, env: Env): Promise<string> {
  const rows = await env.DB.prepare('SELECT id, text FROM memories ORDER BY rowid LIMIT ? OFFSET ?')
    .bind(SCAN_BATCH, state.offset).all<{ id: string; text: string }>();
  const batch = rows.results ?? [];

  if (!batch.length) {
    state.phase = 'cluster';
    await saveState(env, state);
    const n = await env.DB.prepare('SELECT COUNT(*) as n FROM rebuild_micros').first<{ n: number }>();
    return `Scan complete: ${state.offset} memories in ${n?.n ?? 0} micro-clusters. Call again to cluster (pass dry_run=true first to preview domain counts per merge_threshold).`;
  }

  // Crash recovery: the page's D1 writes below are one atomic batch, so if this
  // page's first row is already assigned, the whole page landed but the KV
  // offset save didn't — skip ahead instead of double-counting into micro sums.
  const already = await env.DB.prepare('SELECT 1 as x FROM rebuild_assign WHERE memory_id = ?')
    .bind(batch[0].id).first<{ x: number }>();
  if (already) {
    state.offset += batch.length;
    await saveState(env, state);
    return `Recovered scan offset to ${state.offset}. Call again to continue.`;
  }

  const vectors = await fetchVectors(batch.map(r => r.id), batch.map(r => r.text), env);
  const micros = await loadMicros(env);
  const touched = new Set<number>();
  const assignStmts: D1PreparedStatement[] = [];

  for (let i = 0; i < batch.length; i++) {
    const { idx, sim } = addToMicros(vectors[i], micros, state.microThreshold ?? DEFAULT_MICRO_THRESHOLD);
    touched.add(idx);
    assignStmts.push(
      env.DB.prepare('INSERT OR REPLACE INTO rebuild_assign (memory_id, mc, sim) VALUES (?, ?, ?)')
        .bind(batch[i].id, idx, sim)
    );
  }

  const microStmts = [...touched].map(idx =>
    env.DB.prepare('INSERT OR REPLACE INTO rebuild_micros (idx, sum, count) VALUES (?, ?, ?)')
      .bind(idx, JSON.stringify(micros[idx].sum), micros[idx].count)
  );
  await env.DB.batch([...microStmts, ...assignStmts]); // atomic — see recovery note above

  state.offset += batch.length;
  await saveState(env, state);
  return `Scanned ${state.offset} memories — ${micros.length} micro-clusters so far. Call again to continue.`;
}

async function clusterStep(state: RebuildState, env: Env, dryRun: boolean): Promise<string> {
  const micros = await loadMicros(env);
  if (!micros.length) {
    await dropScratchTables(env);
    await env.KV.delete(STATE_KEY);
    return 'No memories to cluster.';
  }
  if (micros.length > MAX_MICROS) {
    return `Too many micro-clusters (${micros.length} > ${MAX_MICROS}) for the merge phase. Restart with a coarser leader pass: memory_rebuild_domains(targeted=false, restart=true, micro_threshold=${(state.microThreshold ?? DEFAULT_MICRO_THRESHOLD) - 0.05}).`;
  }

  const trace = buildMergeTrace(micros, TRACE_FLOOR);
  const curve = REPORT_THRESHOLDS
    .map(t => `${t}→${clusterCountAtThreshold(micros.length, trace, t)}`)
    .join(', ');

  if (dryRun) {
    await saveState(env, state); // persist a merge_threshold override passed with dry_run
    return `Dry run — ${micros.length} micro-clusters. Cluster count by merge_threshold: ${curve}. Current merge_threshold=${state.mergeThreshold}. Re-run without dry_run to apply (optionally pass merge_threshold).`;
  }

  const labels = applyMergeTrace(micros.length, trace, state.mergeThreshold);
  const { microToFinal, clusters } = finalizeClusters(
    micros, labels, DOMAIN_CAP, MIN_CLUSTER_SIZE, ANCHOR_FLOOR_SIM
  );

  const microStmts = microToFinal.map((f, idx) =>
    env.DB.prepare('UPDATE rebuild_micros SET final_idx = ? WHERE idx = ?').bind(f, idx)
  );
  for (let i = 0; i < microStmts.length; i += 100) {
    await env.DB.batch(microStmts.slice(i, i + 100));
  }
  for (let j = 0; j < clusters.length; j += 20) {
    await env.DB.batch(clusters.slice(j, j + 20).map((c, k) =>
      env.DB.prepare('INSERT OR REPLACE INTO rebuild_finals (idx, sum, count, name) VALUES (?, ?, ?, NULL)')
        .bind(j + k, JSON.stringify(c.sum), c.count)
    ));
  }

  state.phase = 'name';
  await saveState(env, state);
  const outliers = microToFinal.filter(f => f < 0).length;
  return `Clustered into ${clusters.length} domains at merge_threshold=${state.mergeThreshold} (counts at other thresholds: ${curve}); ${outliers} outlier micro-clusters → general. Call again to name clusters.`;
}

async function nameStep(state: RebuildState, env: Env): Promise<string> {
  const unnamed = await env.DB.prepare(
    'SELECT idx FROM rebuild_finals WHERE name IS NULL ORDER BY idx LIMIT ?'
  ).bind(NAME_BATCH).all<{ idx: number }>();
  const pending = unnamed.results ?? [];

  if (!pending.length) {
    state.phase = 'commit';
    state.offset = 0;
    state.anchorsWritten = false;
    await saveState(env, state);
    const n = await env.DB.prepare('SELECT COUNT(*) as n FROM rebuild_finals').first<{ n: number }>();
    return `All ${n?.n ?? 0} clusters named. Call again to commit.`;
  }

  const namedRows = await env.DB.prepare(
    'SELECT name FROM rebuild_finals WHERE name IS NOT NULL'
  ).all<{ name: string }>();
  const taken = ['general', ...(namedRows.results ?? []).map(r => r.name)];

  for (const { idx } of pending) {
    // Representatives: members most typical of their micro-cluster, so the LLM
    // names the cluster's core rather than its stragglers.
    const reps = await env.DB.prepare(
      `SELECT m.text FROM rebuild_assign a
       JOIN rebuild_micros mc ON mc.idx = a.mc
       JOIN memories m ON m.id = a.memory_id
       WHERE mc.final_idx = ? ORDER BY a.sim DESC LIMIT 8`
    ).bind(idx).all<{ text: string }>();
    const texts = (reps.results ?? []).map(r => r.text);

    const suggested = (await nameCluster(texts, taken, env)) ?? deriveAnchorName(texts[0] ?? '');
    let name = suggested;
    for (let n = 2; taken.includes(name); n++) name = `${suggested.slice(0, 37)}-${n}`;
    taken.push(name);
    await env.DB.prepare('UPDATE rebuild_finals SET name = ? WHERE idx = ?').bind(name, idx).run();
  }

  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) as n FROM rebuild_finals WHERE name IS NULL'
  ).first<{ n: number }>();
  return `Named ${pending.length} clusters (${remaining?.n ?? 0} remaining). Call again to continue.`;
}

async function commitStep(state: RebuildState, env: Env): Promise<string> {
  const finals = await env.DB.prepare('SELECT idx, sum, count, name FROM rebuild_finals')
    .all<{ idx: number; sum: string; count: number; name: string | null }>();
  const nameByFinal = new Map<number, string>();
  for (const f of finals.results ?? []) nameByFinal.set(f.idx, f.name ?? 'general');

  if (!state.anchorsWritten) {
    await env.DB.prepare('DELETE FROM domain_anchors').run();
    for (const f of finals.results ?? []) {
      if (!f.name) continue;
      await env.DB.prepare(
        'INSERT OR REPLACE INTO domain_anchors (name, embedding, memory_count, last_summarized_count) VALUES (?, ?, ?, 0)'
      ).bind(f.name, JSON.stringify(normalize(JSON.parse(f.sum) as number[])), f.count).run();
    }
    state.anchorsWritten = true;
    state.offset = 0;
    await saveState(env, state);
  }

  const rows = await env.DB.prepare(
    `SELECT a.memory_id as id, mc.final_idx as f FROM rebuild_assign a
     JOIN rebuild_micros mc ON mc.idx = a.mc
     ORDER BY a.memory_id LIMIT ? OFFSET ?`
  ).bind(COMMIT_BATCH, state.offset).all<{ id: string; f: number | null }>();
  const batch = rows.results ?? [];

  if (!batch.length) {
    await dropScratchTables(env);
    await env.KV.delete(STATE_KEY);
    const total = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{ n: number }>();
    const anchors = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
    return `Done. ${total?.n ?? 0} memories reclassified into ${anchors?.n ?? 0} domains (+ general outliers). Rerunning this rebuild on the same corpus reproduces the same clusters.`;
  }

  const domainFor = (f: number | null) => (f === null || f < 0 ? 'general' : nameByFinal.get(f) ?? 'general');

  const d1Updates = batch.map(r =>
    env.DB.prepare('UPDATE memories SET domain = ? WHERE id = ?').bind(domainFor(r.f), r.id)
  );
  for (let i = 0; i < d1Updates.length; i += 100) {
    await env.DB.batch(d1Updates.slice(i, i + 100));
  }

  // Vectorize metadata: getByIds preserves values AND full metadata (incl.
  // project, which dedup guards rely on) — only domain changes.
  const domainById = new Map(batch.map(r => [r.id, domainFor(r.f)]));
  const upserts: VectorizeVector[] = [];
  const ids = batch.map(r => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const vecs = await env.VECTORIZE.getByIds(ids.slice(i, i + 100));
    for (const v of vecs ?? []) {
      upserts.push({
        id: v.id,
        values: Array.from(v.values as number[]),
        metadata: { ...(v.metadata ?? {}), domain: domainById.get(v.id) ?? 'general' },
      });
    }
  }
  for (let i = 0; i < upserts.length; i += 500) {
    await env.VECTORIZE.upsert(upserts.slice(i, i + 500));
  }

  state.offset += batch.length;
  await saveState(env, state);
  return `Committed ${state.offset} domain assignments. Call again to continue.`;
}

// Shared by targetedStep and cronRebuildBatch: apply batch assignments to D1 +
// Vectorize and fold changed vectors into existing anchor centroids. Never
// creates anchors — classifyBatchDomains only returns existing names or 'general'.
export async function applyBatchAssignments(
  batch: { id: string; domain: string; memory_type: string; project: string | null }[],
  mus: Float32Array[],
  assignments: string[],
  env: Env,
): Promise<number> {
  const d1Updates: D1PreparedStatement[] = [];
  const upserts: VectorizeVector[] = [];
  const centroidAccum = new Map<string, { sum: number[]; count: number }>();

  for (let i = 0; i < batch.length; i++) {
    const domain = assignments[i];
    if (domain === batch[i].domain) continue;
    d1Updates.push(env.DB.prepare('UPDATE memories SET domain = ? WHERE id = ?').bind(domain, batch[i].id));
    upserts.push({
      id: batch[i].id,
      values: Array.from(mus[i]),
      metadata: { domain, memory_type: batch[i].memory_type, project: batch[i].project ?? 'default' },
    });
    if (domain === 'general') continue;
    const acc = centroidAccum.get(domain) ?? { sum: new Array(mus[i].length).fill(0), count: 0 };
    mus[i].forEach((v, j) => { acc.sum[j] = (acc.sum[j] ?? 0) + v; });
    acc.count++;
    centroidAccum.set(domain, acc);
  }

  for (let i = 0; i < d1Updates.length; i += 500) {
    await env.DB.batch(d1Updates.slice(i, i + 500));
  }
  for (let i = 0; i < upserts.length; i += 500) {
    await env.VECTORIZE.upsert(upserts.slice(i, i + 500));
  }

  for (const [domain, { sum, count }] of centroidAccum) {
    const existing = await env.DB.prepare(
      'SELECT embedding, memory_count FROM domain_anchors WHERE name = ?'
    ).bind(domain).first<{ embedding: string; memory_count: number }>();
    if (!existing) continue; // defensive: assignments should always be anchored
    const n = existing.memory_count ?? 0;
    const old: number[] = JSON.parse(existing.embedding);
    const updated = old.map((v, j) => (v * n + (sum[j] ?? 0)) / (n + count));
    await env.DB.prepare(
      'UPDATE domain_anchors SET embedding = ?, memory_count = ? WHERE name = ?'
    ).bind(JSON.stringify(normalize(updated)), n + count, domain).run();
  }

  return d1Updates.length;
}

// Targeted pass: fix only general/unanchored memories against the existing
// anchor set. Offset advances by the rows that stayed general (rows that get an
// anchored domain leave the selection set on their own).
async function targetedStep(env: Env): Promise<string> {
  const offsetRaw = await env.KV.get(TARGETED_OFFSET_KEY);
  const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

  const rows = await env.DB.prepare(
    `SELECT id, text, domain, memory_type, project FROM memories
     WHERE domain = 'general' OR domain NOT IN (SELECT name FROM domain_anchors)
     ORDER BY rowid LIMIT ? OFFSET ?`
  ).bind(TARGETED_BATCH, offset).all<{
    id: string; text: string; domain: string; memory_type: string; project: string | null;
  }>();
  const batch = rows.results ?? [];

  if (!batch.length) {
    await env.KV.delete(TARGETED_OFFSET_KEY);
    const anchors = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
    return `Done. No unanchored memories left to fix (${anchors?.n ?? 0} domains).`;
  }

  const mus = await batchEmbed(batch.map(r => r.text), env);
  const assignments = await classifyBatchDomains(batch.map(r => r.text), mus, env);
  const changed = await applyBatchAssignments(batch, mus, assignments, env);
  const stayed = assignments.filter(a => a === 'general').length;

  await env.KV.put(TARGETED_OFFSET_KEY, String(offset + stayed));
  return `Targeted pass: reclassified ${changed}/${batch.length} memories (${stayed} stayed general). Call again to continue.`;
}
