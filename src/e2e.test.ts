/**
 * E2E integration tests — requires a live Gaussian Memory Worker.
 *
 * Set GAUSSIAN_WORKER_URL (and optionally GAUSSIAN_AUTH_TOKEN) before running:
 *   GAUSSIAN_WORKER_URL=https://... npm run test:e2e
 *
 * All test data is namespaced under a timestamped project and cleaned up in afterAll.
 * Tests are skipped automatically when GAUSSIAN_WORKER_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// process.env is available in the Vitest/Node runtime but not in Workers tsconfig
declare const process: { env: Record<string, string | undefined> };
// http2 is a Node built-in — not available in the Workers runtime, test-only
declare function require(mod: string): any;
declare const Buffer: { byteLength(s: string, enc?: string): number };

const WORKER_URL = process.env.GAUSSIAN_WORKER_URL;
const AUTH_TOKEN = process.env.GAUSSIAN_AUTH_TOKEN ?? '';

// Skip the whole suite when no live worker is configured (e.g., in CI without secrets)
const describeE2E = WORKER_URL ? describe : describe.skip;

const SUITE_ID = Date.now().toString(36); // full base-36 ms timestamp — no 2.78h wrap collision
const TEST_PREFIX = `[E2E-${SUITE_ID}]`;
const TEST_PROJECT = `e2e-${SUITE_ID}`;

// Deliberately topically unrelated to anything this project (or its user) actually discusses —
// Bayesian/Gaussian/Cloudflare content collided with real production memories in the `default`
// project (this system dogfoods its own vocabulary constantly), which silently defeated test
// isolation: `project = ? OR project = 'default'` in retrieve() means every query here also
// searches real data, so on-topic test content gets crowded out or deduped against higher-
// access-count real memories. Several tests below were passing only because their assertions
// didn't filter by TEST_PREFIX and happened to match real content with the same phrase instead
// of the memory this suite actually stored. Off-topic content + TEST_PREFIX filtering closes
// that gap for good, without touching retrieve()'s production scoping semantics.
const TEXT_A = `${TEST_PREFIX} Halvorsen Station biologists band emperor penguin chicks with colored flipper tags before the autumn ice breakup.`;
const SNIPPET_A = 'flipper tags';
const QUERY_A = 'emperor penguin chicks flipper tags ice breakup';

const TEXT_B = `${TEST_PREFIX} Marrow and Reed synth workshop reflows corroded VCO boards from 1978 analog synthesizers with low-temp solder paste.`;
const SNIPPET_B = 'reflows corroded VCO boards';
const QUERY_B = 'analog synthesizer VCO board solder paste repair';

// ── worker RPC helper ──────────────────────────────────────────────────────
// Uses Node's http2 module directly — Node 26's undici (global fetch) hangs
// on HTTP/2 POST requests to Cloudflare Workers deployments.

function call(name: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const http2 = require('node:http2');
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
    // biome-ignore lint/style/noNonNullAssertion: describeE2E skips the whole suite when WORKER_URL is unset
    const client = http2.connect(WORKER_URL!);
    const timer = setTimeout(() => { client.close(); reject(new Error(`call(${name}) timed out after ${timeoutMs}ms`)); }, timeoutMs);
    client.on('error', (e: Error) => { clearTimeout(timer); reject(e); });

    const req = client.request({
      ':method': 'POST',
      ':path': '/',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...(AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    });

    req.setEncoding('utf8');
    let data = '';
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => {
      clearTimeout(timer);
      client.close();
      try {
        const json = JSON.parse(data);
        if (json.error) return reject(new Error(`Worker error: ${JSON.stringify(json.error)}`));
        const content = json.result?.content;
        if (Array.isArray(content) && content[0]?.text) return resolve(content[0].text as string);
        if (typeof json.result === 'string') return resolve(json.result);
        resolve(JSON.stringify(json.result));
      } catch (_e) {
        reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`));
      }
    });
    req.on('error', (e: Error) => { clearTimeout(timer); client.close(); reject(e); });
    req.write(body);
    req.end();
  });
}

// Polls memory_retrieve until expectedSnippet appears or timeout is reached.
// Vectorize has a 2-5 min propagation lag after store — this handles it gracefully.
async function pollUntilFound(
  query: string,
  expectedSnippet: string,
  timeoutMs = 90_000,
  intervalMs = 6_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastResult = '';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    lastResult = await call('memory_retrieve', { query, project: TEST_PROJECT, top_k: 10 }, Math.min(10_000, remaining));
    if (lastResult.includes(expectedSnippet)) return lastResult;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Memory not found after ${timeoutMs / 1000}s.\nQuery: "${query}"\nSnippet: "${expectedSnippet}"\nLast result: ${lastResult.slice(0, 300)}`,
  );
}

// ── suite ──────────────────────────────────────────────────────────────────

describeE2E('E2E: store → retrieve → sigma → dedup → decay', () => {

  beforeAll(async () => {
    if (!WORKER_URL) return; // describe.skip still runs hooks in some Vitest versions
    await call('memory_bulk_delete', { pattern: `%[E2E-%` }).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (!WORKER_URL) return;
    const result = await call('memory_bulk_delete', { pattern: `${TEST_PREFIX}%` }, 29_000);
    expect(result).toMatch(/Deleted \d+ memories|No memories matched/);
  }, 30_000);

  // ── store ────────────────────────────────────────────────────────────────

  it('store: spawns a new memory', async () => {
    const result = await call('memory_store', {
      text: TEXT_A,
      domain: 'gaussian-memory-dev',
      memory_type: 'episodic',
      project: TEST_PROJECT,
      emotional_intensity: 0.5,
    });
    expect(result).toMatch(/SPAWNED/i);
  }, 20_000);

  it('store: exact duplicate is merged, not spawned', async () => {
    const result = await call('memory_store', {
      text: TEXT_A,
      domain: 'gaussian-memory-dev',
      memory_type: 'episodic',
      project: TEST_PROJECT,
      emotional_intensity: 0.5,
    });
    expect(result).toMatch(/MERGED/i);
  }, 15_000);

  it('store: second distinct memory spawns independently', async () => {
    const result = await call('memory_store', {
      text: TEXT_B,
      domain: 'gaussian-memory-dev',
      memory_type: 'episodic',
      project: TEST_PROJECT,
      emotional_intensity: 0.8,
    });
    expect(result).toMatch(/SPAWNED/i);
  }, 20_000);

  // ── retrieve (waits for Vectorize propagation) ───────────────────────────

  it('retrieve: memory surfaces after Vectorize propagation (≤90s)', async () => {
    // Vectorize propagation can take 2-5 min; we poll every 6s up to 90s.
    // Increase GAUSSIAN_E2E_TIMEOUT env var if your deployment is slower.
    const timeout = Number(process.env.GAUSSIAN_E2E_TIMEOUT ?? 90_000);
    const result = await pollUntilFound(QUERY_A, SNIPPET_A, timeout);
    expect(result).toContain(SNIPPET_A);
  }, 100_000);

  it('retrieve: result includes score and confidence indicator', async () => {
    const result = await call('memory_retrieve', {
      query: QUERY_A,
      project: TEST_PROJECT,
      top_k: 5,
    });
    // Score format: [1.23]
    expect(result).toMatch(/\[\d+\.\d+\]/);
    // Confidence indicator — ● or ◑ expected because emotional_intensity=0.5
    // gives initial sigma=0.375, which is ◑; high-intensity (0.8) gives 0.25 → ●
    expect(result).toMatch(/[●◑]/);
  });

  it('retrieve: freshness boost — recently stored memory surfaces once indexed', async () => {
    // Poll until TEXT_B appears. Vectorize propagation for the second memory may
    // lag behind TEXT_A (which the propagation test already waited for).
    const result = await pollUntilFound(QUERY_B, SNIPPET_B, 60_000);
    expect(result).toContain(SNIPPET_B);
  }, 70_000);

  // ── sigma sharpening ──────────────────────────────────────────────────────

  it('sigma: repeated retrieval does not degrade confidence below initial ◑', async () => {
    // TEXT_A was stored with emotional_intensity=0.5 → initialSigma=0.375 (◑).
    // After 5 retrieves sigma should stay ≤ 0.375 — verifies no regression to ○ (≥0.5).
    // Note: proving advancement to ● requires starting from ○; a separate test covers that.
    for (let i = 0; i < 4; i++) {
      await call('memory_retrieve', { query: QUERY_A, project: TEST_PROJECT, top_k: 5 });
    }
    const result = await call('memory_retrieve', { query: QUERY_A, project: TEST_PROJECT, top_k: 5 });
    expect(result).not.toContain('No memories found');
    // Filter by TEST_PREFIX to exclude default-project memories from the assertion
    const lines = result.split('\n').filter(l => l.includes(TEST_PREFIX) && l.includes(SNIPPET_A));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/○/);
    }
  }, 30_000);

  // ── decay ─────────────────────────────────────────────────────────────────

  it('decay: runs and reports decayed + pruned counts', async () => {
    const result = await call('memory_decay', {}, 30_000);
    expect(result).toMatch(/Decay complete: \d+ decayed, \d+ pruned\./);
  }, 35_000);

  // ── stats ─────────────────────────────────────────────────────────────────

  it('stats: returns system health summary with sigma distribution', async () => {
    const result = await call('memory_stats', {}, 30_000);
    expect(result).toMatch(/Total: \d+ memories/);
    expect(result).toMatch(/Sigma:/);
    expect(result).toMatch(/sharp/i);
  }, 35_000);

  // ── bulk delete (also validates cleanup) ─────────────────────────────────

  it('bulk_delete: removes memories by text pattern', async () => {
    // Store a throwaway memory explicitly to ensure pattern delete finds something
    await call('memory_store', {
      text: `${TEST_PREFIX} Throwaway memory for bulk delete test.`,
      domain: 'gaussian-memory-dev',
      memory_type: 'episodic',
      project: TEST_PROJECT,
    });
    const result = await call('memory_bulk_delete', { pattern: `${TEST_PREFIX} Throwaway%` }, 30_000);
    expect(result).toMatch(/Deleted \d+ memories/);
  }, 35_000);
});
