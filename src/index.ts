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
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text: string, env: Env): Promise<Float32Array> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as any;
  const vec = result.data[0] as number[];
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  return new Float32Array(vec.map((v: number) => v / norm));
}

async function batchEmbed(texts: string[], env: Env): Promise<Float32Array[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts }) as any;
  return (result.data as number[][]).map(vec => {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return new Float32Array(vec.map(v => v / norm));
  });
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
  precomputedMu?: Float32Array
): Promise<{ action: string; id: string }> {
  const mu = precomputedMu ?? await embed(text, env);
  const dim = mu.length;
  const sigma = initialSigma(domain, emotionalIntensity, dim);
  const now = Math.floor(Date.now() / 1000);

  // Coarse search via Vectorize — no domain filter so same-text re-ingests always merge
  // regardless of domain reclassification. Bhattacharyya distance handles isolation.
  const results = await env.VECTORIZE.query(Array.from(mu), {
    topK: 10,
    returnValues: false,
    returnMetadata: 'all',
  });

  let bestId: string | null = null;
  let bestDist = Infinity;
  let bestSigma: Float32Array | null = null;
  let bestText: string | null = null;
  let bestScore = 0;

  for (const match of results.matches) {
    // Allow cross-domain contradiction detection but restrict merging to same domain
    const matchDomain = (match.metadata as any)?.domain as string | undefined;
    const row = await env.DB.prepare(
      'SELECT sigma_diagonal, text FROM memories WHERE id = ?'
    ).bind(match.id).first<{ sigma_diagonal: string; text: string }>();

    if (!row) continue;
    // Cross-domain dedup: if cosine similarity is very high (>0.97), merge regardless of domain
    // This prevents near-identical memories from spawning in different domains
    if (matchDomain && matchDomain !== domain && match.score < 0.97) continue;

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
         access_count, memory_type, domain, emotional_intensity, contradiction_flag)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1)
    `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity).run();
    await env.VECTORIZE.upsert([{ id, values: Array.from(mu), metadata: { domain, memory_type: memoryType } }]);
    return { action: 'contradiction', id };
  }

  // Use tighter threshold for cross-domain merges (0.08) vs same-domain (0.20)
  const mergeThreshold = (bestId && results.matches.find(m => m.id === bestId && (m.metadata as any)?.domain === domain)) ? 0.20 : 0.08;
  if (bestId && bestSigma && shouldMerge(mu, sigma, mu, bestSigma, mergeThreshold)) {
    const [, newSigma] = kalmanMerge(mu, sigma, mu, bestSigma);

    await env.DB.prepare(`
      UPDATE memories SET
        sigma_diagonal = ?, last_accessed = ?,
        access_count = access_count + 1, text = ?
      WHERE id = ?
    `).bind(serializeSigma(newSigma), now, text, bestId).run();

    await env.VECTORIZE.upsert([{
      id: bestId,
      values: Array.from(mu),
      metadata: { domain, memory_type: memoryType },
    }]);

    return { action: 'merged', id: bestId };
  }

  // Spawn new
  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO memories
      (id, text, sigma_diagonal, timestamp, last_accessed,
       access_count, memory_type, domain, emotional_intensity)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).bind(id, text, serializeSigma(sigma), now, now, memoryType, domain, emotionalIntensity).run();

  await env.VECTORIZE.upsert([{
    id,
    values: Array.from(mu),
    metadata: { domain, memory_type: memoryType },
  }]);

  return { action: 'spawned', id };
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
  query: string, domain: string | null, topK: number, env: Env
): Promise<{ score: number; text: string; domain: string; type: string }[]> {
  const qvec = await embed(query, env);

  // Infer query sigma: short/specific → low σ (tight), long/vague → high σ (broad)
  const querySigmaVal = 0.3 + 0.5 * Math.min(query.length / 300, 1.0);

  // Stage 1: Domain routing — score query against domain centroids
  let activeDomains: string[] | null = null;
  if (!domain) {
    try {
      const anchorRows = await env.DB.prepare(
        'SELECT name, embedding FROM domain_anchors WHERE memory_count >= 3'
      ).all<{ name: string; embedding: string }>();
      if ((anchorRows.results ?? []).length > 0) {
        const qArr = Array.from(qvec);
        const domScores = (anchorRows.results ?? [])
          .map(r => ({ name: r.name, score: dotProduct(qArr, JSON.parse(r.embedding) as number[]) }))
          .sort((a, b) => b.score - a.score);
        activeDomains = domScores.slice(0, 3).filter(d => d.score > 0.25).map(d => d.name);
      }
    } catch {}
  }

  // Stage 2: Vector search, optionally filtered to active domains
  const queryOpts: any = { topK: topK * 4, returnValues: true, returnMetadata: 'all' };
  if (activeDomains && activeDomains.length > 0) {
    queryOpts.filter = activeDomains.length === 1
      ? { domain: activeDomains[0] }
      : { domain: { $in: activeDomains } };
  }
  let vecResults = await env.VECTORIZE.query(Array.from(qvec), queryOpts);

  // Fallback: if domain filter gave too few results, try global search
  if (activeDomains && (vecResults.matches?.length ?? 0) < topK) {
    vecResults = await env.VECTORIZE.query(Array.from(qvec), {
      topK: topK * 3, returnValues: true, returnMetadata: 'all',
    });
  }

  const results = vecResults;

  if (!results.matches.length) return [];

  const ids = results.matches.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, text, domain, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp, last_accessed
     FROM memories WHERE id IN (${placeholders})`
  ).bind(...ids).all<{
    id: string; text: string; domain: string; memory_type: string;
    sigma_diagonal: string; access_count: number; contradiction_flag: number; timestamp: number; last_accessed: number;
  }>();

  const cosineMap = new Map(results.matches.map(m => [m.id, m.score]));
  const vectorMap = new Map(results.matches.map(m => [m.id, m.values as number[] ?? []]));

  // Build candidates — primary score: 0.6*cosine + 0.25*recency + 0.15*access_freq
  // Spreads scores across a wider range than Bhattacharyya, better differentiation
  const nowSec = Math.floor(Date.now() / 1000);
  const NINETY_DAYS = 90 * 24 * 3600;
  const candidates = (rows.results ?? []).map(row => {
    const memSigma = deserializeSigma(row.sigma_diagonal);
    const cosineSim = cosineMap.get(row.id) ?? 0;
    const lastAccessed = row.last_accessed ?? row.timestamp ?? 0;
    const recency = Math.max(0, 1 - (nowSec - lastAccessed) / NINETY_DAYS);
    const accessFreq = Math.min(1, (row.access_count ?? 0) / 50);
    const primaryScore = 0.6 * cosineSim + 0.25 * recency + 0.15 * accessFreq;
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

    // Recency boost: memories stored in this session (last 30 min) get a lift
    const recencyBoost = c.fresh ? 0.12 : 0;

    // File-edit penalty: "Edited: foo.ts" memories have short generic embeddings
    // that falsely match almost any query — suppress unless no better candidates
    const fileEditPenalty = c.isFileEdit ? 0.55 : 1.0;

    const activation = (c.primaryScore
      + 0.4 * neighborScore * sigmaWeight * contradictionFactor
      + domainBoost
      + recencyBoost) * fileEditPenalty;

    return { ...c, score: activation };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  // De-biasing: surface one high-value contradiction that got penalty-suppressed
  const suppressed = scored.slice(topK).find(c => c.contradiction && c.primaryScore > 0.7);
  if (suppressed) top.push(suppressed);

  // Sharpen accessed memories
  const now = Math.floor(Date.now() / 1000);
  for (const mem of top) {
    const newSigma = sharpenSigma(mem.sigma);
    await env.DB.prepare(
      'UPDATE memories SET last_accessed = ?, access_count = access_count + 1, sigma_diagonal = ? WHERE id = ?'
    ).bind(now, serializeSigma(newSigma), mem.id).run();
  }

  return top.map(m => ({
    score: m.score,
    text: m.contradiction ? `[CONTRADICTED — re-evaluate] ${m.text}` : m.text,
    domain: m.domain,
    type: m.type,
  }));
}

async function updateDecay(env: Env): Promise<{ decayed: number; pruned: number }> {
  const rows = await env.DB.prepare(
    'SELECT id, sigma_diagonal FROM memories'
  ).all<{ id: string; sigma_diagonal: string }>();

  let decayed = 0, pruned = 0;
  const updateStmts: D1PreparedStatement[] = [];
  const pruneIds: string[] = [];

  for (const row of rows.results ?? []) {
    const sigma = decaySigma(deserializeSigma(row.sigma_diagonal));
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

  const profile = result?.response?.trim();
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

function classifyDomainFromCache(
  mu: Float32Array,
  text: string,
  anchorCache: Map<string, number[]>,
): { domain: string; newAnchor?: { name: string; embedding: number[] } } {
  const muArr = Array.from(mu);
  let bestName = '';
  let bestSim = -1;

  for (const [name, anchorEmb] of anchorCache) {
    const sim = dotProduct(muArr, anchorEmb);
    if (sim > bestSim) { bestSim = sim; bestName = name; }
  }

  if (bestSim >= 0.82) return { domain: bestName };

  const name = deriveAnchorName(text);
  anchorCache.set(name, muArr);
  return { domain: name, newAnchor: { name, embedding: muArr } };
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

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
    messages: [
      {
        role: 'system',
        content: `Classify this memory into a semantic domain. Domain names: 2-4 lowercase hyphenated words (e.g. "gaussian-memory-dev", "loreal-internship", "stats-coursework", "career-goals", "personal-life", "cloudflare-dev", "bayer-research").\nStrongly prefer existing domains — only create a new one if NONE of the existing domains reasonably fit. Broad domains are better than narrow ones. Keep total domain count small.\nExisting domains (${existing.length}): ${existing.length ? existing.join(', ') : 'none yet'}\nReturn ONLY JSON: {"domain":"name"}`,
      },
      { role: 'user', content: text.slice(0, 300) },
    ],
    max_tokens: 25,
  }) as any;

  const raw = (result?.response ?? '').trim();
  try {
    const match = raw.match(/\{[^}]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.domain && typeof parsed.domain === 'string') {
        const clean = parsed.domain.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
        if (clean.length >= 2) return clean;
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
    if ((totalDomains?.n ?? 0) >= 75) {
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
  const rows = await env.DB.prepare(
    'SELECT text FROM memories WHERE domain = ? ORDER BY access_count DESC, timestamp DESC LIMIT 12'
  ).bind(domainName).all<{ text: string }>();
  const facts = (rows.results ?? []).map(r => r.text).join('\n');
  if (!facts) return;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
    messages: [
      { role: 'system', content: 'Summarize these memory facts into 2-3 sentences capturing key themes, decisions, and context. Be specific and concise. No preamble.' },
      { role: 'user', content: facts },
    ],
    max_tokens: 150,
  }) as any;

  const summary = result?.response?.trim();
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
    description: 'Store a memory with explicit domain and type.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        domain: { type: 'string', default: 'general' },
        memory_type: { type: 'string', default: 'episodic' },
        emotional_intensity: { type: 'number', default: 0.0 },
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
    name: 'memory_rebuild_domains',
    description: 'Re-classify all existing memories with the current domain threshold. Processes in batches of 100; call repeatedly until it returns "done". Clears domain_anchors on first call and lets them re-emerge.',
    inputSchema: { type: 'object', properties: {} },
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
      const { action, id } = await storeMemory(
        args.text, args.memory_type ?? 'episodic',
        args.domain ?? 'general', args.emotional_intensity ?? 0.0, env
      );
      return `${action.toUpperCase()}: '${args.text.slice(0, 60)}' in domain='${args.domain ?? 'general'}' (id=${id.slice(0, 8)})`;
    }

    case 'memory_auto_store': {
      const mu = await embed(args.text, env);
      const domain = await classifyDomainWithLlama(args.text, env, mu);
      const { memory_type, emotional_intensity: inferred } = inferTypeAndIntensity(args.text);
      const emotional_intensity = Math.max(args.emotional_intensity ?? 0.0, inferred);
      const { action, id } = await storeMemory(
        args.text, memory_type, domain, emotional_intensity, env, mu
      );
      if (action === 'spawned') {
        await updateDomainCentroid(domain, mu, env).catch(() => {});
      }
      return `${action.toUpperCase()}: '${args.text.slice(0, 60)}' -> (${domain}/${memory_type}, id=${id.slice(0, 8)})`;
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
        const project = filePath.match(/\/([^/]+)\/(?:src|lib|app)\//)?.[1] ?? '';
        const oldSnip = ((args.old_string as string) ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
        const newSnip = ((args.new_string as string) ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
        diffContext = `File: ${project ? project + '/' : ''}${file}\nBefore: ${oldSnip}\nAfter: ${newSnip}`;
      }
      if (!diffContext) return 'SKIP: no diff context provided';

      // Ask Llama to describe the change semantically in one sentence
      const descResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: 'Summarize this code change or command in ONE factual sentence for a developer memory system. Be specific about what changed and why it matters. Do not start with "I" or "The developer". Under 30 words. Return ONLY the sentence, no JSON, no quotes.',
          },
          { role: 'user', content: diffContext },
        ],
        max_tokens: 60,
      }) as any;

      const description = ((descResult?.response ?? '') as string).trim();
      if (!description || description.length < 10) return 'SKIP: Llama returned empty description';

      const mu = await embed(description, env);
      const domain = await classifyDomainWithLlama(description, env, mu);
      const { action, id } = await storeMemory(description, 'episodic', domain, 0, env, mu);
      if (action === 'spawned') await updateDomainCentroid(domain, mu, env).catch(() => {});
      return `${action.toUpperCase()}: '${description.slice(0, 60)}' -> (${domain}/episodic, id=${id.slice(0, 8)})`;
    }

    case 'memory_retrieve': {
      const results = await retrieve(args.query, args.domain ?? null, args.top_k ?? 5, env);
      if (!results.length) return 'No memories found.';

      // Fetch domain summaries for domains present in results
      const domainsHit = [...new Set(results.map(r => r.domain))];
      const summaries: Record<string, string> = {};
      for (const d of domainsHit) {
        const s = await env.KV.get(`domain_summary:${d}`);
        if (s) summaries[d] = s;
      }

      // If summaries exist: group output by domain with summary header
      if (Object.keys(summaries).length > 0) {
        const sections = domainsHit.map(d => {
          const mems = results.filter(r => r.domain === d);
          const lines: string[] = [`[DOMAIN: ${d}]`];
          if (summaries[d]) lines.push(`Summary: ${summaries[d]}`);
          lines.push(...mems.map(r => `[${r.score.toFixed(2)}] (${r.domain}/${r.type}) ${r.text}`));
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
        const blended = blend?.response?.trim();
        if (blended) preamble = `[SYNTHESIS] ${blended}\n`;
      }

      return preamble + results.map(r => `[${r.score.toFixed(2)}] (${r.domain}/${r.type}) ${r.text}`).join('\n');
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
        .slice(-4000);

      const extraction = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: `Extract memorable facts from this session log for long-term personal memory storage. Prioritize in this order:

1. DECISIONS — architectural, career, or project direction choices made and why
2. PROBLEMS SOLVED — what broke, how it was diagnosed, what fixed it
3. PROJECT CONTEXT — current state of active work, goals, constraints, blockers
4. PREFERENCES — stated opinions about tools, methods, working style

Extract up to 4 facts per category (up to 12 total). Quality over quantity — skip a category if nothing meaningful happened.

SKIP ALL of these — do not store them under any circumstances:
- Raw conversational messages ("ok", "yea", "sure", "what do u think", "can u", "how about")
- Questions directed at the assistant ("can you verify", "give full summary")
- Pasted external content (CI output, PR descriptions, error logs, API responses)
- Generic status ("successfully", "completed", "updated", "done", "it works")
- Filler and reactions ("lol", "mf", "ig", "tbh", "idk", "bruh")
- Tool outputs and command results
- Anything under 15 words that isn't a clear factual statement

Each stored fact must be a complete, third-person factual sentence about the person or their work. NOT a question. NOT raw chat.

Classify each fact:
- "episodic": specific event or session outcome
- "semantic": belief, value, or personality trait
- "procedural": preference or working style

Return ONLY a JSON array, no other text.
Example: [{"text":"Chose Durable Objects over shared D1 for per-user isolation","type":"episodic"},{"text":"Prefers concise responses without emojis","type":"procedural"}]`,
          },
          { role: 'user', content: filteredLog },
        ],
        max_tokens: 500,
      }) as any;

      interface ExtractedFact { text: string; type?: string }
      let facts: ExtractedFact[] = [];
      const raw = extraction?.response?.trim() ?? '';
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
          .filter((l: string) => l.length > 15)
          .map((t: string) => ({ text: t }));
      }

      let stored = 0;
      for (const fact of facts.slice(0, 12)) {
        const text = fact.text ?? '';
        if (text.length > 10) {
          const mu = await embed(text, env);
          const domain = await classifyDomainWithLlama(text, env, mu);
          const llmType = fact.type && ['episodic','semantic','procedural'].includes(fact.type)
            ? fact.type : null;
          const { memory_type: inferredType, emotional_intensity } = inferTypeAndIntensity(text);
          const memory_type = llmType ?? inferredType;
          const { action } = await storeMemory(text, memory_type, domain, emotional_intensity, env, mu);
          if (action === 'spawned') {
            await updateDomainCentroid(domain, mu, env).catch(() => {});
          }
          stored++;
        }
      }
      return `Extracted ${facts.length} facts, stored ${stored}.`;
    }

    case 'memory_bulk_delete': {
      const rows = await env.DB.prepare(
        'SELECT id FROM memories WHERE text LIKE ?'
      ).bind(args.pattern as string).all<{ id: string }>();
      const ids = (rows.results ?? []).map(r => r.id);
      if (!ids.length) return 'No memories matched pattern.';
      for (const id of ids) {
        await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
      }
      if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids);
      return `Deleted ${ids.length} memories matching "${args.pattern}".`;
    }

    case 'memory_rebuild_domains': {
      await ensureDomainColumns(env);
      const BATCH = 30;  // Smaller batch — 3 Llama calls per invocation (10 texts each)
      const offsetRaw = await env.KV.get('REBUILD_OFFSET');

      // First call: clear all domain anchors so clean ones emerge from Llama
      if (offsetRaw === null) {
        await env.DB.prepare('DELETE FROM domain_anchors').run();
      }

      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      const rows = await env.DB.prepare(
        'SELECT id, text, memory_type FROM memories ORDER BY rowid LIMIT ? OFFSET ?'
      ).bind(BATCH, offset).all<{ id: string; text: string; memory_type: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('REBUILD_OFFSET');
        const total = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{ n: number }>();
        const anchors = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
        return `Done. ${total?.n ?? 0} memories reclassified into ${anchors?.n ?? 0} domains.`;
      }

      // Batch embed all texts in one AI call
      const mus = await batchEmbed(batch.map(r => r.text), env);

      // Batch Llama classification: 10 memories per Llama call
      const GROUP = 10;
      const domainAssignments: string[] = new Array(batch.length).fill('general');

      // Load current domain list once (shared across all Llama calls in this batch)
      const existingDomains = (await env.DB.prepare('SELECT name FROM domain_anchors ORDER BY rowid')
        .all<{ name: string }>()).results?.map(r => r.name) ?? [];
      const canCreate = existingDomains.length < 50;

      for (let g = 0; g < batch.length; g += GROUP) {
        const group = batch.slice(g, g + GROUP);
        const numbered = group.map((r, j) => `${j + 1}. ${r.text.slice(0, 150)}`).join('\n');

        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
          messages: [
            {
              role: 'system',
              content: `Classify each memory into a semantic domain. Domain names: 2-4 lowercase hyphenated words.\n${canCreate ? 'Use existing domains or create new ones.' : 'Use existing domains only (50-domain cap).'}\nExisting: ${existingDomains.length ? existingDomains.join(', ') : 'none yet'}\nReturn ONLY a JSON array of exactly ${group.length} domain name strings: ["domain-1", ...]`,
            },
            { role: 'user', content: numbered },
          ],
          max_tokens: 120,
        }) as any;

        const raw = (result?.response ?? '').trim();
        try {
          const match = raw.match(/\[[\s\S]*?\]/);
          if (match) {
            const parsed = JSON.parse(match[0]) as string[];
            for (let j = 0; j < group.length && j < parsed.length; j++) {
              const d = (parsed[j] ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
              if (d.length >= 2) {
                domainAssignments[g + j] = d;
                if (!existingDomains.includes(d) && existingDomains.length < 50) {
                  existingDomains.push(d);
                }
              }
            }
          }
        } catch {}
      }

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
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Gaussian Memory MCP Server', { status: 200 });
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

  // Daily decay + identity synthesis via cron
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await updateDecay(env);
    await synthesizeIdentityProfile(env);
  },
};
