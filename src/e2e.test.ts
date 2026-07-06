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

// Additional off-topic fixtures for tool-specific tests below — same isolation rationale as A/B.
const TEXT_C = `${TEST_PREFIX} Tidewater Kite Club rigs box kites with bamboo spars for steady onshore wind afternoons.`;

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
    lastResult = await call('memory_retrieve', { query, project: TEST_PROJECT, strict_project: true, top_k: 10 }, Math.min(10_000, remaining));
    if (lastResult.includes(expectedSnippet)) return lastResult;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Memory not found after ${timeoutMs / 1000}s.\nQuery: "${query}"\nSnippet: "${expectedSnippet}"\nLast result: ${lastResult.slice(0, 300)}`,
  );
}

// memory_list shows full (non-truncated) IDs, unlike store/retrieve output which shows an
// 8-char prefix — so ID-scoped tools (belief_drift, update, delete, judge) need this to get a
// real ID to operate on, same as a real caller would ("Use memory_list to find IDs.").
//
// Resolves to the single newest row in `domain` (sort defaults to timestamp DESC, limit=1) —
// deliberately NOT a text-substring search. Two real bugs were found trying that approach
// (2026-07-06): (1) memory_list truncates displayed text to 80 chars, so a snippet late in a
// long TEST_PREFIX-prefixed string (e.g. "flipper tags" in TEXT_A) can never appear in the
// output regardless of retries — it's silently cut off, not missing; (2) a global `since`-only
// search with no domain filter competes against this account's real ambient write volume across
// a multi-minute suite run and can genuinely evict a real entry from even a 500-row window.
// Domain-scoping + "just take the newest" avoids both: it must be called immediately after the
// relevant store (while that row is still the newest in its domain), which every call site here
// already does.
async function findLatestMemoryId(domain: string, attempts = 2, delayMs = 2000): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs));
    const result = await call('memory_list', { domain, limit: 1 });
    const line = result.split('\n')[0];
    const match = line?.match(/^\[([a-f0-9-]+)\]/);
    if (match) return match[1];
  }
  throw new Error(`Could not find any memory in domain "${domain}" after ${attempts} attempts`);
}

// Parses the domain a store/auto_store/store_decision response landed in, e.g.
// "SPAWNED: '...' -> (tidewater-kite-club/episodic, id=e4df04f8)" — needed for
// memory_auto_store, which doesn't take a domain param and auto-classifies instead.
function parseDomainFromStoreResponse(response: string): string {
  const match = response.match(/\(([a-z0-9-]+)\/\w+, id=/);
  if (!match) throw new Error(`Could not parse domain from store response: ${response}`);
  return match[1];
}

// ── suite ──────────────────────────────────────────────────────────────────

describeE2E('E2E: store → retrieve → sigma → dedup → decay', () => {
  // Resolved once, immediately after TEXT_A is stored, while it's still guaranteed to be the
  // single newest matching entry. Reused later by belief_drift/judge instead of re-searching
  // memory_list late in the run — confirmed live 2026-07-06 that a late-run since-filtered
  // search can still miss it (real background writes across a 2+ minute suite can exceed even
  // a 500-row window), while resolving it right after store never has that problem.
  let textAId = '';
  let textCId = '';

  beforeAll(async () => {
    if (!WORKER_URL) return; // describe.skip still runs hooks in some Vitest versions
    await call('memory_bulk_delete', { pattern: `%[E2E-%` }).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (!WORKER_URL) return;
    // project (exact match), NOT pattern — memory_extract_and_store and memory_store_diff both
    // LLM-rewrite/paraphrase their input, so the stored text may not retain any literal
    // substring from TEST_PREFIX, making pattern-based cleanup silently miss it. Every store
    // call in this suite passes project: TEST_PROJECT explicitly, so this reliably catches
    // everything regardless of whether the text was rewritten. Confirmed live 2026-07-06: the
    // old pattern-only cleanup left a permanent 'tidewater-kite-club' domain in production.
    const result = await call('memory_bulk_delete', { project: TEST_PROJECT }, 29_000);
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
    textAId = await findLatestMemoryId('gaussian-memory-dev');
  }, 30_000);

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
      strict_project: true,
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

  // ── retrieval edge cases ─────────────────────────────────────────────────

  it('retrieve: empty query returns no memories instead of erroring', async () => {
    const result = await call('memory_retrieve', { query: '', project: TEST_PROJECT }, 15_000);
    expect(result).toBe('No memories found.');
  }, 20_000);

  it('retrieve: whitespace-only query returns no memories instead of erroring', async () => {
    const result = await call('memory_retrieve', { query: '   ', project: TEST_PROJECT }, 15_000);
    expect(result).toBe('No memories found.');
  }, 20_000);

  it('retrieve: domain param does not exclude a match in a different domain (soft boost, not a hard filter)', async () => {
    const result = await call('memory_retrieve', {
      query: QUERY_A, domain: 'some-unrelated-domain', project: TEST_PROJECT, strict_project: true, top_k: 5,
    }, 15_000);
    expect(result).toContain(SNIPPET_A);
  }, 20_000);

  it('retrieve: synthesize=true does not error on a normal query', async () => {
    // Forcing the exact synthesis trigger (score>0.85 and top-2 scores within 0.04) isn't
    // reliably reproducible against live embeddings — this confirms the flag is safe to pass.
    const result = await call('memory_retrieve', {
      query: QUERY_A, synthesize: true, project: TEST_PROJECT, strict_project: true, top_k: 5,
    }, 15_000);
    expect(result).toContain(SNIPPET_A);
  }, 20_000);

  it('retrieve: temporal cue ("today") surfaces a memory stored earlier in this run', async () => {
    const result = await call('memory_retrieve', {
      query: `${QUERY_A} today`, project: TEST_PROJECT, strict_project: true, top_k: 5,
    }, 15_000);
    expect(result).toContain(SNIPPET_A);
  }, 20_000);

  it('retrieve: capitalized entity token in the query exercises the entity-boost path', async () => {
    // "Halvorsen Station" is a capitalized entity token in TEXT_A — this exercises entity
    // extraction/graph-boost code without asserting on ranking specifics, which are LLM-adjacent.
    const result = await call('memory_retrieve', {
      query: 'Halvorsen Station penguin tagging', project: TEST_PROJECT, strict_project: true, top_k: 5,
    }, 15_000);
    expect(result).toContain(SNIPPET_A);
  }, 20_000);

  // ── sigma sharpening ──────────────────────────────────────────────────────

  it('sigma: repeated retrieval does not degrade confidence below initial ◑', async () => {
    // TEXT_A was stored with emotional_intensity=0.5 → initialSigma=0.375 (◑).
    // After 5 retrieves sigma should stay ≤ 0.375 — verifies no regression to ○ (≥0.5).
    // Note: proving advancement to ● requires starting from ○; a separate test covers that.
    for (let i = 0; i < 4; i++) {
      await call('memory_retrieve', { query: QUERY_A, project: TEST_PROJECT, strict_project: true, top_k: 5 });
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

  // ── additional store-family tools ─────────────────────────────────────────

  it('auto_store: infers domain/type and spawns', async () => {
    const result = await call('memory_auto_store', {
      text: TEXT_C,
      project: TEST_PROJECT,
    });
    expect(result).toMatch(/SPAWNED/i);
    textCId = await findLatestMemoryId(parseDomainFromStoreResponse(result));
  }, 30_000);

  it('store_decision: stores a structured decision trail', async () => {
    const result = await call('memory_store_decision', {
      decision: `${TEST_PREFIX} Chose bamboo spars over carbon fiber for the kite club's box kites`,
      context: 'Carbon fiber spars snap in gusty coastal wind; bamboo flexes instead',
      alternatives: 'Fiberglass spars (too heavy for box kite lift), carbon fiber (too brittle)',
      outcome: 'Bamboo-spar kites held together through a full gusty afternoon session',
      project: TEST_PROJECT,
    });
    expect(result).toMatch(/SPAWNED/i);
    expect(result).toContain('decision');
  }, 20_000);

  it('store_diff: stores semantic meaning of a command output', async () => {
    // The GLM quality gate is now timeout-guarded at 12s (tools.ts) — including the
    // subsequent Llama description call + embed/store, 20s is comfortable headroom.
    // GLM's quality-gate verdict is a real LLM judgment call, not deterministic — assert on
    // the response shape (SPAWNED/MERGED/SKIP) rather than forcing a specific outcome.
    const result = await call('memory_store_diff', {
      command: 'wrangler deploy --dry-run',
      output: `${TEST_PREFIX} Switched bamboo spar diameter from 6mm to 8mm because 6mm snapped under sustained 15mph gusts during the kite club's onshore test session`,
      project: TEST_PROJECT,
    }, 20_000);
    expect(result).toMatch(/^(SPAWNED|MERGED|SKIP)/i);
  }, 25_000);

  it('capture_passive: parses structured notes and stores bullets', async () => {
    const notes = `## Key Learnings
- ${TEST_PREFIX} Box kite bridle angle of 20 degrees gives the most stable lift in light wind
- ${TEST_PREFIX} Bamboo spars need a full season of drying before they hold a stable curve

## Decisions
- ${TEST_PREFIX} Decided to switch the club's kite fabric from ripstop nylon to spinnaker cloth`;
    const result = await call('memory_capture_passive', { text: notes, project: TEST_PROJECT }, 25_000);
    expect(result).toMatch(/Captured \d+ memories/);
  }, 30_000);

  // ── read-only tools ────────────────────────────────────────────────────────

  it('list: finds stored memories by domain', async () => {
    const result = await call('memory_list', { domain: 'gaussian-memory-dev', limit: 100 });
    expect(result).toContain(TEST_PREFIX);
  }, 20_000);

  it('timeline: returns a chronological view for a domain', async () => {
    const result = await call('memory_timeline', { domain: 'gaussian-memory-dev', limit: 50 });
    expect(result).toMatch(/TIMELINE:/);
  }, 20_000);

  it('identity_profile_get: returns without erroring (read-only)', async () => {
    // Read-only — identity_profile_set is a single shared production slot, not test-scoped,
    // so it's deliberately not exercised here. This just confirms the read path works.
    const result = await call('identity_profile_get', {}, 15_000);
    expect(typeof result).toBe('string');
  }, 20_000);

  it('orphan_check: scans the corpus for D1 rows missing a Vectorize vector (read-only)', async () => {
    // Full-corpus scan (chunks of 20 via Vectorize getByIds) — real cost scales with total
    // memory count, hence the generous timeout. repair is not passed, so this never mutates data.
    const result = await call('memory_orphan_check', {}, 90_000);
    expect(result).toMatch(/No orphans found|Found \d+ orphans/);
  }, 95_000);

  it('belief_drift_backfill: reports progress without erroring (idempotent, additive-only)', async () => {
    const result = await call('memory_belief_drift_backfill', {}, 30_000);
    expect(result).toMatch(/Backfilled \d+ memories|Backfill complete/);
  }, 35_000);

  // ── ID-scoped tools ──────────────────────────────────────────────────────

  it('belief_drift: reports confidence trajectory for a specific memory', async () => {
    expect(textAId).not.toBe('');
    const result = await call('memory_belief_drift', { memory_id: textAId }, 20_000);
    expect(result).toMatch(/Belief Drift Report/);
  }, 25_000);

  it('judge: compares a memory against its nearest neighbours without erroring', async () => {
    // TEXT_A's off-topic content has no real-world neighbours above the 0.70 threshold,
    // so this exercises the code path safely — no real memory_relations get created.
    expect(textAId).not.toBe('');
    const result = await call('memory_judge', { memory_id: textAId }, 25_000);
    expect(result).toMatch(/no candidates above 0\.70|→|All relations already judged/);
  }, 30_000);

  it('update: re-embeds and updates an existing memory\'s text', async () => {
    expect(textCId).not.toBe('');
    const updatedText = `${TEST_PREFIX} Tidewater Kite Club now rigs box kites with reinforced bamboo spars for gusty afternoons.`;
    const result = await call('memory_update', { id: textCId, text: updatedText }, 20_000);
    expect(result).toMatch(/^UPDATED:/);
  }, 25_000);

  it('delete: removes a specific memory by ID', async () => {
    await call('memory_store', {
      text: `${TEST_PREFIX} Throwaway memory for delete-by-id test.`,
      domain: 'gaussian-memory-dev',
      memory_type: 'episodic',
      project: TEST_PROJECT,
    });
    const id = await findLatestMemoryId('gaussian-memory-dev');
    const result = await call('memory_delete', { id }, 20_000);
    expect(result).toMatch(/^DELETED:/);
  }, 40_000);

  // ── memory_extract_and_store ─────────────────────────────────────────────

  it('extract_and_store: extracts facts from a raw session log', async () => {
    const log = `[User]: ${TEST_PREFIX} Switched the kite club's spar material from carbon fiber to bamboo because carbon fiber snapped under sustained 15mph coastal gusts during testing. | [Assistant]: Noted — bamboo spars flex instead of snapping, and the club settled on 8mm diameter after 6mm failed under the same wind conditions.`;
    const result = await call('memory_extract_and_store', { log_text: log, project: TEST_PROJECT }, 30_000);
    expect(result).toMatch(/Extracted \d+ facts, stored \d+\./);
  }, 35_000);

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
