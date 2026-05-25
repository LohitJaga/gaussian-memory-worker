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

// ── Embedding ────────────────────────────────────────────────────────────────

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
    if (matchDomain && matchDomain !== domain && match.score < 0.95) continue;

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

  if (bestId && bestSigma && shouldMerge(mu, sigma, mu, bestSigma, 0.20)) {
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

  const results = await env.VECTORIZE.query(Array.from(qvec), {
    topK: topK * 3,
    returnValues: true,
    returnMetadata: 'all',
  });

  if (!results.matches.length) return [];

  const ids = results.matches.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, text, domain, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp
     FROM memories WHERE id IN (${placeholders})`
  ).bind(...ids).all<{
    id: string; text: string; domain: string; memory_type: string;
    sigma_diagonal: string; access_count: number; contradiction_flag: number; timestamp: number;
  }>();

  const cosineMap = new Map(results.matches.map(m => [m.id, m.score]));
  const vectorMap = new Map(results.matches.map(m => [m.id, m.values as number[] ?? []]));

  // Build candidates — primary score is now distributional (Bhattacharyya-based)
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = (rows.results ?? []).map(row => {
    const memSigma = deserializeSigma(row.sigma_diagonal);
    const memSigmaVal = meanSigma(memSigma);
    const cosineSim = cosineMap.get(row.id) ?? 0;
    const primaryScore = distributionalScore(cosineSim, querySigmaVal, memSigmaVal);
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

  for (const row of rows.results ?? []) {
    const sigma = decaySigma(deserializeSigma(row.sigma_diagonal));

    if (meanSigma(sigma) > 2.0) {
      await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(row.id).run();
      await env.VECTORIZE.deleteByIds([row.id]);
      pruned++;
    } else {
      await env.DB.prepare(
        'UPDATE memories SET sigma_diagonal = ? WHERE id = ?'
      ).bind(serializeSigma(sigma), row.id).run();
      decayed++;
    }
  }

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
      const mu = await embed(args.text, env, false);
      const domain = await classifyDomain(mu, args.text, env);
      const { memory_type, emotional_intensity: inferred } = inferTypeAndIntensity(args.text);
      const emotional_intensity = Math.max(args.emotional_intensity ?? 0.0, inferred);
      const { action, id } = await storeMemory(
        args.text, memory_type, domain, emotional_intensity, env, mu
      );
      return `${action.toUpperCase()}: '${args.text.slice(0, 60)}' -> (${domain}/${memory_type}, id=${id.slice(0, 8)})`;
    }

    case 'memory_retrieve': {
      const results = await retrieve(args.query, args.domain ?? null, args.top_k ?? 5, env);
      if (!results.length) return 'No memories found.';

      // Soft-collapse: when top-2 scores are within 0.04 and both > 0.85, synthesize a blend
      let preamble = '';
      if (args.synthesize && results.length >= 2
          && results[0].score > 0.85
          && (results[0].score - results[1].score) < 0.04) {
        const blendInput = results.slice(0, 3).map(r => r.text).join('\n');
        const blend = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
          messages: [
            {
              role: 'system',
              content: 'Memory synthesis: given 2-3 closely related memories, write one sentence that reconstructs the underlying belief or fact. Be specific. No preamble.',
            },
            { role: 'user', content: blendInput },
          ],
          max_tokens: 100,
        }) as any;
        const blended = blend?.response?.trim();
        if (blended) preamble = `[SYNTHESIS] ${blended}\n`;
      }

      const raw = results.map(r => `[${r.score.toFixed(2)}] (${r.domain}/${r.type}) ${r.text}`).join('\n');
      return preamble + raw;
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

      const mu = await embed(args.text, env, false);
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
      const extraction = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: `Extract 3-5 memorable facts from this session log for long-term personal memory storage.

INCLUDE: decisions made, problems solved, preferences expressed, project context, career/personal facts, technical approaches chosen.
SKIP: generic status messages ("successfully", "completed", "updated"), file paths, URLs, tool outputs, error messages, one-word answers, filler.

Classify each fact:
- "episodic": specific event or session outcome
- "semantic": belief, value, or personality trait
- "procedural": preference or working style

Return ONLY a JSON array of objects, no other text.
Example: [{"text":"Chose Durable Objects over shared D1 for per-user isolation","type":"episodic"},{"text":"Prefers concise responses without emojis","type":"procedural"}]`,
          },
          { role: 'user', content: (args.log_text as string).slice(0, 2000) },
        ],
        max_tokens: 300,
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
          .map(text => ({ text }));
      }

      let stored = 0;
      for (const fact of facts.slice(0, 5)) {
        const text = fact.text ?? '';
        if (text.length > 10) {
          const mu = await embed(text, env, false);
          const domain = await classifyDomain(mu, text, env);
          // Use Llama-classified type if provided, else fall back to heuristic
          const llmType = fact.type && ['episodic','semantic','procedural'].includes(fact.type)
            ? fact.type : null;
          const { memory_type: inferredType, emotional_intensity } = inferTypeAndIntensity(text);
          const memory_type = llmType ?? inferredType;
          await storeMemory(text, memory_type, domain, emotional_intensity, env, mu);
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
      const BATCH = 50;
      const offsetRaw = await env.KV.get('REBUILD_OFFSET');

      // First call (no offset key): clear anchors so they re-emerge with new threshold
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
        return `Done. ${total?.n ?? 0} memories re-classified into ${anchors?.n ?? 0} domains.`;
      }

      // Load all anchors once — avoids 50× SELECT inside classifyDomain
      const anchorRows = await env.DB.prepare('SELECT name, embedding FROM domain_anchors')
        .all<{ name: string; embedding: string }>();
      const anchorCache = new Map<string, number[]>(
        (anchorRows.results ?? []).map(r => [r.name, JSON.parse(r.embedding)])
      );

      // One AI call for the whole batch — avoids subrequest limit
      const mus = await batchEmbed(batch.map(r => r.text), env);

      const vectorizeUpdates: any[] = [];
      const newAnchors: { name: string; embedding: number[] }[] = [];

      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        const mu = mus[i];
        const { domain: newDomain, newAnchor } = classifyDomainFromCache(mu, row.text, anchorCache);
        if (newAnchor) newAnchors.push(newAnchor);
        await env.DB.prepare('UPDATE memories SET domain = ? WHERE id = ?').bind(newDomain, row.id).run();
        vectorizeUpdates.push({ id: row.id, values: Array.from(mu), metadata: { domain: newDomain, memory_type: row.memory_type } });
      }

      // Write new anchors to D1 in one batch
      for (const a of newAnchors) {
        await env.DB.prepare('INSERT OR REPLACE INTO domain_anchors (name, embedding) VALUES (?, ?)')
          .bind(a.name, JSON.stringify(a.embedding)).run();
      }

      await env.VECTORIZE.upsert(vectorizeUpdates);
      await env.KV.put('REBUILD_OFFSET', String(offset + batch.length));

      const totalCount = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{ n: number }>();
      return `Processed ${offset + batch.length}/${totalCount?.n ?? '?'} — call again to continue.`;
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
