import type { Env } from './types';
import { embed, dotProduct } from './embed';

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
  // OR IGNORE, not OR REPLACE: on a derived-name collision with an existing anchor,
  // REPLACE wiped its centroid embedding, memory_count, and last_summarized_count.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO domain_anchors (name, embedding) VALUES (?, ?)'
  ).bind(name, JSON.stringify(muArr)).run();
  return name;
}

export async function ensureDomainColumns(env: Env): Promise<void> {
  try { await env.DB.prepare('ALTER TABLE domain_anchors ADD COLUMN memory_count INTEGER DEFAULT 0').run(); } catch {}
  try { await env.DB.prepare('ALTER TABLE domain_anchors ADD COLUMN last_summarized_count INTEGER DEFAULT 0').run(); } catch {}
}

export async function classifyDomainWithLlama(text: string, env: Env, precomputedMu?: Float32Array): Promise<string> {
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
3. Domain names must name a PROJECT, TOOL, or PERSON — not a generic activity.
   GOOD: "gaussian-memory-dev", "loreal-internship", "color-wow-agents", "career-goals", "purdue-coursework", "cloudflare-workers"
   BAD: "data-preprocessing", "homework-submission", "exam-preparation", "data-manipulation", "file-management"
   If the memory is about a specific project or tool, name the domain after THAT project/tool.
   If it's about a course or subject, name it after the subject: "probability-theory", "stat-416", not "exam-preparation".
4. New domain names: 2-4 lowercase hyphenated words. NO uppercase, NO spaces, NO leading hyphens.
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

export async function updateDomainCentroid(domainName: string, mu: Float32Array, env: Env, ctx?: ExecutionContext): Promise<void> {
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

// Shared Llama batch classifier — used by both cronRebuildBatch and memory_rebuild_domains.
// Takes batch of texts + existing domain list, returns domain assignment per row.
export async function classifyBatchDomains(
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
      max_tokens: 512,
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
export async function remapToAnchoredDomains(
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
