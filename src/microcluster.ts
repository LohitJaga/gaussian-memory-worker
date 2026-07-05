import { DEFAULT_MICRO_THRESHOLD, type MicroCluster, addToMicros, newMicroFromRow, normalize } from './cluster';
import type { Env } from './types';

// Live, per-memory version of cluster.ts's leader pass (phase 1 only — no merge/
// name/cap phase). Feeds retrieval.ts's diversity cap and storage.ts's merge-
// threshold gate; kept separate from the human-facing, capped/named `domain`
// field on purpose (see plan: split retrieval-mechanics signal from taxonomy).
//
// Backed by a dedicated Vectorize index (MICRO_VECTORIZE) rather than a brute-
// force D1 scan: this corpus already has ~2,500-2,900 micro-clusters (measured
// via a live dry-run sweep), 40-60x domain_anchors' size — loading and cosine-
// comparing all of them on every single store() call would be a real per-request
// cost. Vectorize's ANN search stays cheap regardless of how many clusters
// accumulate. D1 (micro_clusters table) remains the source of truth for the
// mutable {sum, count} used to recompute each cluster's centroid — Vectorize is
// a derived, always-rebuildable cache purely for fast nearest-lookup.

export interface MicroClusterAssignment {
  clusterId: string;
  isNew: boolean;
  sim: number;
}

// Read-only: find the nearest existing micro-cluster, or signal that a new one
// is needed. Does NOT write anything — creation is deferred to
// commitMicroClusterAssignment, called only once storeMemory knows the memory
// actually spawned (not merged), so a memory that merges into an existing row
// never leaves an orphan micro-cluster behind.
export async function assignMicroCluster(mu: Float32Array, env: Env): Promise<MicroClusterAssignment> {
  const muArr = Array.from(mu);
  const result = await env.MICRO_VECTORIZE.query(muArr, { topK: 1, returnMetadata: 'none' });
  const best = result.matches?.[0];
  if (best && (best.score ?? -1) >= DEFAULT_MICRO_THRESHOLD) {
    return { clusterId: best.id, isNew: false, sim: best.score ?? 0 };
  }
  return { clusterId: crypto.randomUUID(), isNew: true, sim: -1 };
}

// Given an existing micro-cluster's stored row and a new member vector, produce
// the updated {sum, count} row. Pure function — reuses addToMicros's exact
// accept-branch math (threshold=-Infinity guarantees the single candidate is
// always accepted) instead of re-deriving the update arithmetic, and is the one
// piece of this module worth unit-testing without any D1/Vectorize I/O.
export function updatedMicroClusterRow(existingSum: number[], existingCount: number, mu: number[]): MicroCluster {
  const micros: MicroCluster[] = [newMicroFromRow(existingSum.slice(), existingCount)];
  addToMicros(mu, micros, -Infinity);
  return micros[0];
}

// Called only when storeMemory reports action === 'spawned' (same gating
// updateDomainCentroid already uses in domain.ts) — cluster_id is written once,
// at spawn time, never on a merge/contradiction update, matching the existing
// precedent that `domain` isn't touched on those paths either.
export async function commitMicroClusterAssignment(
  clusterId: string,
  isNew: boolean,
  mu: Float32Array,
  env: Env,
): Promise<void> {
  const muArr = Array.from(mu);
  const now = Math.floor(Date.now() / 1000);

  if (isNew) {
    await env.DB.prepare(
      'INSERT INTO micro_clusters (id, sum, count, updated_at) VALUES (?, ?, 1, ?)'
    ).bind(clusterId, JSON.stringify(muArr), now).run();
    await env.MICRO_VECTORIZE.upsert([{ id: clusterId, values: muArr }]);
    return;
  }

  const existing = await env.DB.prepare(
    'SELECT sum, count FROM micro_clusters WHERE id = ?'
  ).bind(clusterId).first<{ sum: string; count: number }>();
  if (!existing) {
    // Centroid existed in Vectorize but its D1 row is missing (shouldn't happen,
    // but Vectorize and D1 are two systems) — treat as new rather than throw.
    await env.DB.prepare(
      'INSERT OR REPLACE INTO micro_clusters (id, sum, count, updated_at) VALUES (?, ?, 1, ?)'
    ).bind(clusterId, JSON.stringify(muArr), now).run();
    await env.MICRO_VECTORIZE.upsert([{ id: clusterId, values: muArr }]);
    return;
  }

  const updated = updatedMicroClusterRow(JSON.parse(existing.sum) as number[], existing.count, muArr);
  await env.DB.prepare(
    'UPDATE micro_clusters SET sum = ?, count = ?, updated_at = ? WHERE id = ?'
  ).bind(JSON.stringify(updated.sum), updated.count, now, clusterId).run();
  await env.MICRO_VECTORIZE.upsert([{ id: clusterId, values: normalize(updated.sum) }]);
}
