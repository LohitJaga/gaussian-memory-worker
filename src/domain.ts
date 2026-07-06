import { dotProduct, embed } from './embed';
import type { Env } from './types';

export const DOMAIN_CAP = 50;
// Memory→anchor accept threshold — tuned from real usage history (0.75 → 0.88 → 0.82).
export const ANCHOR_ACCEPT_SIM = 0.82;
// Below this, content is genuinely unrelated to every anchor — the committed
// remap floor that fixed "unrelated content glued into wrong domains".
export const ANCHOR_FLOOR_SIM = 0.3;

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
  'finished','started','updated','fixed','removed','changed','created',
  // time / generic nouns
  'time','today','morning','evening','night','week','month','year','times','days',
  'hours','minutes','session','sessions','clear','head','once','twice',
  // memory-specific words
  'memory','memories','code','file','files','text','data','output','result','value',
  'error','type','list','running','system',
]);

// Always case-fold BEFORE stripping non-letters — stripping first with a lowercase-only
// character class silently deletes uppercase letters instead of folding them (the bug that
// turned "Session" into "ession"). Centralized so all three passes below share one invariant
// instead of each independently re-deriving (and potentially breaking) it.
function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '');
}

export function deriveAnchorName(text: string): string {
  const tokens = text.split(/\s+/);
  // Skip first token (sentence-starter, capitalized by grammar not by being a proper noun)
  for (let i = 1; i < tokens.length; i++) {
    const raw = tokens[i].replace(/[^a-zA-Z]/g, '');
    if (raw.length >= 4 && /^[A-Z]/.test(raw)) {
      const w = normalizeToken(raw);
      if (!ANCHOR_STOP.has(w)) return w;
    }
  }
  // Fall back to distinctive content words (skip first token here too)
  for (let i = 1; i < tokens.length; i++) {
    const w = normalizeToken(tokens[i]);
    if (w.length >= 5 && !ANCHOR_STOP.has(w)) return w;
  }
  // Last resort: any content word including first
  for (const raw of tokens) {
    const w = normalizeToken(raw);
    if (w.length >= 4 && !ANCHOR_STOP.has(w)) return w;
  }
  return `cluster_${Date.now().toString(36).slice(-4)}`;
}

export interface Anchor { name: string; emb: number[] }

export async function loadAnchors(env: Env): Promise<Anchor[]> {
  const rows = await env.DB.prepare('SELECT name, embedding FROM domain_anchors ORDER BY rowid')
    .all<{ name: string; embedding: string }>();
  return (rows.results ?? []).map(r => ({ name: r.name, emb: JSON.parse(r.embedding) as number[] }));
}

export function bestAnchor(mu: number[], anchors: Anchor[]): { name: string; sim: number } | null {
  let bestName = '';
  let bestSim = -Infinity; // not -1: a real anchor at exactly sim=-1 must still win over "nothing seen yet"
  for (const a of anchors) {
    const sim = dotProduct(mu, a.emb);
    if (sim > bestSim) { bestSim = sim; bestName = a.name; }
  }
  return bestName ? { name: bestName, sim: bestSim } : null;
}

const NAMING_RULES = `Domain names must name a PROJECT, TOOL, PERSON, or SUBJECT — not a generic activity.
GOOD: "acme-web-app", "cs101-coursework", "job-search", "react-portfolio-site"
BAD: "data-preprocessing", "homework-submission", "exam-preparation", "file-management"
Format: 2-4 lowercase hyphenated words. NO uppercase, NO spaces, NO leading hyphens.`;

function cleanDomainName(raw: string): string | null {
  const clean = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return clean.length >= 2 && !clean.startsWith('-') ? clean : null;
}

function parseJsonName(result: any, key: string): string | null {
  const rawVal = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
  const raw = (typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal)).trim();
  try {
    const match = raw.match(/\{[^}]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed[key] && typeof parsed[key] === 'string') return cleanDomainName(parsed[key]);
    }
  } catch {}
  return null;
}

export async function ensureDomainColumns(env: Env): Promise<void> {
  try { await env.DB.prepare('ALTER TABLE domain_anchors ADD COLUMN memory_count INTEGER DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE domain_anchors ADD COLUMN last_summarized_count INTEGER DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE memories ADD COLUMN cluster_id TEXT').run(); } catch {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id)').run(); } catch {}
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS micro_clusters (id TEXT PRIMARY KEY, sum TEXT NOT NULL, count INTEGER NOT NULL, updated_at INTEGER NOT NULL)'
    ).run();
  } catch {}
}

// Primary real-time classifier. Deterministic nearest-anchor assignment first
// (BIRCH-style one-pass), LLM only for the ambiguous band below the accept
// threshold — so the common case has zero sampling variance and zero LLM cost.
export async function classifyDomainForStore(text: string, env: Env, precomputedMu?: Float32Array): Promise<string> {
  const mu = precomputedMu ?? await embed(text, env);
  const muArr = Array.from(mu);
  const anchors = await loadAnchors(env);

  const best = bestAnchor(muArr, anchors);
  if (best && best.sim >= ANCHOR_ACCEPT_SIM) return best.name;

  const atCap = anchors.length >= DOMAIN_CAP;
  const fallback = best && best.sim >= ANCHOR_FLOOR_SIM ? best.name : 'general';

  const candidates = anchors
    .map(a => ({ name: a.name, sim: dotProduct(muArr, a.emb) }))
    .filter(c => c.sim >= ANCHOR_FLOOR_SIM)
    .sort((x, y) => y.sim - x.sim)
    .slice(0, 5);

  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
      messages: [
        {
          role: 'system',
          content: `You classify one memory into a semantic domain.
${candidates.length
  ? `Nearest existing domains: ${candidates.map(c => c.name).join(', ')}\nALWAYS pick one of these if it reasonably fits — even loosely.`
  : 'No existing domain is close to this memory.'}
${atCap
  ? 'Do NOT invent a new domain (cap reached) — pick from the list above, or "general" if nothing fits.'
  : `Only if none fits, create a new domain name. ${NAMING_RULES}`}
Return ONLY valid JSON with no explanation: {"domain":"domain-name-here"}`,
        },
        { role: 'user', content: `<memory_text>${text.slice(0, 600)}</memory_text>` },
      ],
      max_tokens: 30,
      temperature: 0,
    }) as any;

    const choice = parseJsonName(result, 'domain');
    if (!choice) return fallback;
    if (choice === 'general') return 'general';
    if (anchors.some(a => a.name === choice)) return choice;
    if (atCap) return fallback;
    // Genuinely novel content: seed a new anchor at this memory's embedding.
    // OR IGNORE, not OR REPLACE: on a name collision with an existing anchor,
    // REPLACE wiped its centroid embedding, memory_count, and last_summarized_count.
    await env.DB.prepare(
      'INSERT OR IGNORE INTO domain_anchors (name, embedding) VALUES (?, ?)'
    ).bind(choice, JSON.stringify(muArr)).run();
    return choice;
  } catch {
    return fallback;
  }
}

// Batch classifier for targeted fixups (nightly general-bucket cron + targeted
// rebuild). Deterministic nearest-anchor gate first; LLM (temperature 0) only
// for the ambiguous band, choosing from a FIXED anchor list. Never creates
// domains and never mutates the list mid-run — the order-dependent cascade that
// made full rebuilds land on 15/31/49/6/50 domains across reruns is gone.
export async function classifyBatchDomains(
  texts: string[],
  mus: Float32Array[],
  env: Env,
  timeBudgetMs = Infinity,
  startTime = Date.now(),
): Promise<string[]> {
  const anchors = await loadAnchors(env);
  const assignments: string[] = new Array(texts.length).fill('general');
  if (!anchors.length) return assignments;

  const muArrs = mus.map(m => Array.from(m));
  const pending: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const best = bestAnchor(muArrs[i], anchors);
    if (!best || best.sim < ANCHOR_FLOOR_SIM) continue; // genuinely unrelated → general
    if (best.sim >= ANCHOR_ACCEPT_SIM) {
      assignments[i] = best.name;
    } else {
      assignments[i] = best.name; // remap default; LLM may override below
      pending.push(i);
    }
  }

  const names = new Set(anchors.map(a => a.name));
  const nameList = [...names].join(', ');
  const GROUP = 10;
  for (let g = 0; g < pending.length; g += GROUP) {
    if (Date.now() - startTime > timeBudgetMs) break;
    const group = pending.slice(g, g + GROUP);
    const numbered = group.map((idx, j) => `${j + 1}. ${texts[idx].slice(0, 400)}`).join('\n');
    try {
      const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
        messages: [
          {
            role: 'system',
            content: `Classify each memory into one of the existing domains. ALWAYS pick an existing domain if any fits — even loosely. Answer "general" only if a memory fits nothing at all. Do not invent new domain names.\nExisting domains: ${nameList}\nReturn ONLY a JSON array of exactly ${group.length} domain name strings: ["domain-1", ...]`,
          },
          { role: 'user', content: numbered },
        ],
        max_tokens: 512,
        temperature: 0,
      }) as any;

      const rawBatch = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
      const raw = (typeof rawBatch === 'string' ? rawBatch : JSON.stringify(rawBatch)).trim();
      const match = raw.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as string[];
        for (let j = 0; j < group.length && j < parsed.length; j++) {
          const choice = cleanDomainName(parsed[j] ?? '');
          if (choice && (names.has(choice) || choice === 'general')) {
            assignments[group[j]] = choice;
          }
          // unknown output → keep the deterministic nearest-anchor default
        }
      }
    } catch {} // LLM failure → nearest-anchor defaults stand
  }
  return assignments;
}

// One LLM call per rebuild cluster — naming only, never grouping.
export async function nameCluster(sampleTexts: string[], takenNames: string[], env: Env): Promise<string | null> {
  const numbered = sampleTexts.map((t, i) => `${i + 1}. ${t.slice(0, 300)}`).join('\n');
  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
      messages: [
        {
          role: 'system',
          content: `These memories all belong to ONE topic cluster in a personal memory system. Name the cluster.
${NAMING_RULES}
${takenNames.length ? `Names already taken (do NOT reuse): ${takenNames.join(', ')}` : ''}
Return ONLY valid JSON with no explanation: {"name":"domain-name-here"}`,
        },
        { role: 'user', content: numbered },
      ],
      max_tokens: 30,
      temperature: 0,
    }) as any;
    return parseJsonName(result, 'name');
  } catch {
    return null;
  }
}

export async function updateDomainCentroid(domainName: string, mu: Float32Array, env: Env, ctx?: ExecutionContext): Promise<void> {
  // 'general' is a holding pen fixed by the nightly cron, never an anchor —
  // an anchor row for it would attract nearest-anchor assignments forever.
  if (domainName === 'general') return;
  await ensureDomainColumns(env);
  const existing = await env.DB.prepare(
    'SELECT embedding, memory_count FROM domain_anchors WHERE name = ?'
  ).bind(domainName).first<{ embedding: string; memory_count: number }>();

  if (!existing) {
    // Enforce domain cap: if at cap, redirect centroid update to nearest existing domain
    const totalDomains = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
    if ((totalDomains?.n ?? 0) >= DOMAIN_CAP) {
      const anchors = await loadAnchors(env);
      const best = bestAnchor(Array.from(mu), anchors);
      if (best) await updateDomainCentroid(best.name, mu, env);
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
    if (ctx) {
      ctx.waitUntil(refreshDomainSummary(domainName, newCount, env));
    } else {
      refreshDomainSummary(domainName, newCount, env).catch(() => {});
    }
  }
}

export async function refreshDomainSummary(domainName: string, newCount: number, env: Env): Promise<void> {
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

  const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
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
