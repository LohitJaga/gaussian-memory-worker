import type { Env } from './types';
import { embed, batchEmbed, dotProduct } from './embed';
import {
  classifyDomainWithLlama, updateDomainCentroid,
  ensureDomainColumns, classifyBatchDomains, remapToAnchoredDomains,
} from './domain';
import { storeMemory, processPendingEntityQueue } from './storage';
import { retrieve } from './retrieval';
import { updateDecay, cleanupSingletons } from './cron';
import { deserializeSigma, meanSigma } from './gaussian';

export const TOOLS = [
  {
    name: 'memory_store',
    description: 'Store a memory with explicit domain and type. Pass topic_key to upsert by logical key — same key updates in place instead of spawning a duplicate. revision_count tracks how many times a keyed memory has been revised.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        domain: { type: 'string', default: 'general' },
        memory_type: { type: 'string', default: 'episodic' },
        emotional_intensity: { type: 'number', default: 0.0 },
        topic_key: { type: 'string' },
        project: { type: 'string' },
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
    description: 'List stored memories. Filter by domain, sort by created_at/access_count/sigma, limit results, or pass since (ISO timestamp) to see only recent memories.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        limit: { type: 'number', default: 50 },
        sort: { type: 'string', enum: ['timestamp', 'access_count', 'sigma'], default: 'timestamp' },
        since: { type: 'string', description: 'ISO 8601 timestamp — return only memories stored after this time' },
      },
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
    name: 'memory_orphan_check',
    description: 'Detect D1 memories with no Vectorize vector (silent data loss). Pass repair=true to re-embed and fix orphans.',
    inputSchema: {
      type: 'object',
      properties: { repair: { type: 'boolean', default: false } },
    },
  },
  {
    name: 'memory_judge',
    description: 'Judge relationships between a memory and its nearest neighbours. Returns supersedes/conflicts_with/compatible/extends verdicts and stores them in memory_relations. Pass memory_id to judge one memory; omit to auto-judge all flagged contradictions.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
    },
  },
  {
    name: 'memory_capture_passive',
    description: 'Parse structured notes and bulk-store each item as a memory. Looks for sections like "## Key Learnings:", "## Decisions:", "## Problems Solved:" and stores each bullet. Ideal for end-of-session notes.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        project: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_timeline',
    description: 'Chronological view of memories in a domain — shows how knowledge evolved over time, sigma trajectory, and any supersede/conflict markers. Pass domain to scope it; omit for a cross-domain timeline of the most-accessed memories.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'memory_belief_drift_backfill',
    description: 'Backfill sigma_history for all memories that have no history entry. Reconstructs trajectory from access metadata. Processes 300/call — run repeatedly until complete.',
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
    name: 'memory_cleanup_singletons',
    description: 'Reclassify all memories in domains with fewer than N memories (default 3) into the nearest anchored domain. Does not create new domains. Call once — completes in one shot.',
    inputSchema: {
      type: 'object',
      properties: { min_count: { type: 'number', description: 'Domains with fewer than this many memories are singletons. Default 3.' } },
    },
  },
  {
    name: 'memory_rebuild_domains',
    description: 'Re-classify all existing memories with the current domain threshold. Processes in batches of 100; call repeatedly until it returns "done". Clears domain_anchors on first call and lets them re-emerge.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_retag_projects',
    description: 'LLM-based project retagging for memories in the default pool. Llama classifies each memory text into the correct project. Call repeatedly until it returns "Done." ~137 calls for 4k memories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_build_entities',
    description: 'Retroactive entity extraction — processes memories in batches, extracts named entities (tool/project/concept/parameter/person), writes to entity_nodes + memory_entities tables. Call repeatedly until "Done." Enables 1-hop entity graph traversal at retrieve time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_belief_drift',
    description: 'Show how confidence in a memory has changed over time — sigma trajectory from initial store to now. Pass memory_id for a specific memory, or query to find matching memories.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string' },
        query: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
    },
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

export async function handleToolCall(name: string, args: any, env: Env): Promise<string> {
  switch (name) {
    case 'memory_store': {
      if (!args.text || (args.text as string).trim().length < 10) return 'SKIP: text too short (min 10 chars)';
      const topicKey = args.topic_key as string | undefined;
      const project = (args.project as string) ?? 'default';
      const now = Math.floor(Date.now() / 1000);

      // topic_key upsert: if a memory with this key exists, update in place
      if (topicKey) {
        const existing = await env.DB.prepare(
          'SELECT id, revision_count, domain, memory_type FROM memories WHERE topic_key = ? AND (project = ? OR project = \'default\') LIMIT 1'
        ).bind(topicKey, project).first<{ id: string; revision_count: number; domain: string; memory_type: string }>();

        if (existing) {
          const mu = await embed(args.text, env);
          const revisions = (existing.revision_count ?? 0) + 1;
          await env.DB.prepare(
            'UPDATE memories SET text = ?, last_accessed = ?, access_count = access_count + 1, revision_count = ? WHERE id = ?'
          ).bind(args.text, now, revisions, existing.id).run();
          await env.VECTORIZE.upsert([{
            id: existing.id, values: Array.from(mu),
            metadata: { domain: existing.domain, memory_type: existing.memory_type, project },
          }]);
          return `REVISED (r${revisions}): '${args.text.slice(0, 60)}' topic_key='${topicKey}' (id=${existing.id.slice(0, 8)})`;
        }
      }

      // No topic_key or no existing match — normal store path
      const { action, id, conflict_candidates } = await storeMemory(
        args.text, args.memory_type ?? 'episodic',
        args.domain ?? 'general', args.emotional_intensity ?? 0.0, env,
        undefined, project
      );

      // Persist topic_key on the new memory if provided
      if (topicKey && action === 'spawned') {
        await env.DB.prepare('UPDATE memories SET topic_key = ? WHERE id = ?').bind(topicKey, id).run();
      }

      let out = `${action.toUpperCase()}: '${args.text.slice(0, 60)}' in domain='${args.domain ?? 'general'}'${topicKey ? ` topic_key='${topicKey}'` : ''} (id=${id.slice(0, 8)})`;
      if (conflict_candidates?.length) out += `\nconflict_candidates: ${JSON.stringify(conflict_candidates)}`;
      return out;
    }

    case 'memory_auto_store': {
      const mu = await embed(args.text, env);
      const domain = await classifyDomainWithLlama(args.text, env, mu);
      const { memory_type, emotional_intensity: inferred } = inferTypeAndIntensity(args.text);
      const emotional_intensity = Math.max(args.emotional_intensity ?? 0.0, inferred);
      const { action, id, conflict_candidates } = await storeMemory(
        args.text, memory_type, domain, emotional_intensity, env, mu, args.project ?? 'default'
      );
      if (action === 'spawned') {
        await updateDomainCentroid(domain, mu, env).catch(() => {});
      }
      let out = `${action.toUpperCase()}: '${args.text.slice(0, 60)}' -> (${domain}/${memory_type}, id=${id.slice(0, 8)})`;
      if (conflict_candidates?.length) {
        out += `\nconflict_candidates: ${JSON.stringify(conflict_candidates)}`;
      }
      return out;
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
        const projectFromPath = filePath.match(/\/([^/]+)\/(?:src|lib|app)\//)?.[1] ?? '';
        const oldSnip = ((args.old_string as string) ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
        const newSnip = ((args.new_string as string) ?? '').trim().replace(/\s+/g, ' ').slice(0, 150);
        diffContext = `File: ${projectFromPath ? projectFromPath + '/' : ''}${file}\nBefore: ${oldSnip}\nAfter: ${newSnip}`;
      }
      if (!diffContext) return 'SKIP: no diff context provided';

      // Semantic entropy gate: skip diffs where old and new are mechanically identical
      // after stripping digits, punctuation, whitespace — catches version bumps, count
      // changes, semicolon fixes, blank line additions that have zero semantic content.
      if (args.old_string != null && args.new_string != null) {
        const strip = (s: string) => s.replace(/[\d\s.,;:'"()\[\]{}\-_=+!?@#$%^&*|\\/<>]/g, '').toLowerCase();
        const strippedOld = strip(args.old_string as string);
        const strippedNew = strip(args.new_string as string);
        // Only skip if both sides have content that strips to the same thing —
        // avoids skipping new-file writes where old is genuinely empty
        if (strippedOld === strippedNew && (strippedOld.length > 0 || (args.old_string as string).length > 0)) {
          return 'SKIP: trivial mechanical change (digits/punctuation only)';
        }
      }

      // GLM quality gate: is this diff worth storing as a long-term memory?
      // Replaces hardcoded skip lists — generalizes to any user's workflow.
      // Runs before Llama description to avoid wasting tokens on low-signal diffs.
      const gateResult = await env.AI.run('@cf/zai-org/glm-4.7-flash' as any, {
        messages: [
          {
            role: 'system',
            content: 'You decide if a code change or command is worth storing as a long-term developer memory. Answer ONLY "YES" or "NO". Store YES for: decisions with rationale (why X was chosen over Y), non-trivial logic changes, bug fixes, architecture choices, meaningful command outputs. Store NO for: formatting, imports, trivial edits, read-only commands, test runs with no insight, boilerplate. If a senior engineer could reconstruct this change just by reading the file, answer NO.',
          },
          { role: 'user', content: `<diff>${diffContext}</diff>` },
        ],
        max_tokens: 1024,
        temperature: 0,
      }) as any;
      // GLM-4.7-flash is a thinking model: reasoning goes into reasoning_content,
      // the final answer is in choices[0].message.content (null until reasoning completes).
      // Must use max_tokens >= 1024 so the model can finish reasoning and emit content.
      const choice = gateResult?.choices?.[0]?.message;
      const rawGate = (gateResult?.response ?? choice?.content ?? '') as string;
      const gateAnswer = rawGate.trim().toUpperCase();
      if (!gateAnswer.startsWith('YES')) return 'SKIP: low signal (GLM quality gate)';

      // Ask Llama to describe the change semantically in one sentence
      // Llama 3.1 8B for diff description — GLM fails on short/minimal diffs (returns {})
      const descResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: 'Summarize this code change or command in ONE factual sentence for a developer memory system. Be specific about what changed and why it matters. Do not start with "I" or "The developer". Under 30 words. Return ONLY the sentence, no JSON, no quotes.',
          },
          { role: 'user', content: `<diff>${diffContext}</diff>` },
        ],
        max_tokens: 60,
      }) as any;

      const description = ((descResult?.response ?? '') as string).trim();
      if (!description || description.length < 10) return 'SKIP: model returned empty description';

      const mu = await embed(description, env);
      const domain = await classifyDomainWithLlama(description, env, mu);
      const { action, id } = await storeMemory(description, 'episodic', domain, 0, env, mu, args.project ?? 'default');
      if (action === 'spawned') await updateDomainCentroid(domain, mu, env).catch(() => {});
      return `${action.toUpperCase()}: '${description.slice(0, 60)}' -> (${domain}/episodic, id=${id.slice(0, 8)})`;
    }

    case 'memory_retrieve': {
      const results = await retrieve(args.query, args.domain ?? null, args.top_k ?? 5, env, args.project ?? 'default', args.context as string | undefined);
      if (!results.length) return 'No memories found.';

      // Fetch domain summaries for domains present in results (uses clean domain, not display)
      const domainsHit = [...new Set(results.map(r => r.domain))];
      const summaries: Record<string, string> = {};
      for (const d of domainsHit) {
        const s = await env.KV.get(`domain_summary:${d}`);
        if (s) summaries[d] = s;
      }

      const fmt = (r: any) => {
        const dd = (r as any).displayDomain ?? r.domain;
        const conf = r.sigma !== undefined ? (r.sigma < 0.3 ? '●' : r.sigma < 0.5 ? '◑' : '○') : '';
        return `[${r.score.toFixed(2)}] (${dd}/${r.type})${r.activated ? ' ~' : ''} ${conf} ${r.text}`;
      };

      // If summaries exist: group output by domain with summary header
      if (Object.keys(summaries).length > 0) {
        const sections = domainsHit.map(d => {
          const mems = results.filter(r => r.domain === d);
          const lines: string[] = [`[DOMAIN: ${d}]`];
          if (summaries[d] && mems.length >= 2) lines.push(`Summary: ${summaries[d]}`);
          lines.push(...mems.map(fmt));
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
        const blended = (blend?.response ?? blend?.choices?.[0]?.message?.content ?? '').trim();
        if (blended) preamble = `[SYNTHESIS] ${blended}\n`;
      }

      return preamble + results.map(fmt).join('\n');
    }

    case 'memory_list': {
      const conditions: string[] = [];
      const params: any[] = [];
      if (args.domain) { conditions.push('domain = ?'); params.push(args.domain); }
      if (args.since) { conditions.push('timestamp >= ?'); params.push(Math.floor(new Date(args.since).getTime() / 1000)); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const sortCol = args.sort === 'access_count' ? 'access_count DESC'
                    : args.sort === 'sigma' ? 'sigma_diagonal ASC'
                    : 'timestamp DESC';
      const limit = Math.min(Number(args.limit) || 50, 500);
      const rows = await env.DB.prepare(
        `SELECT id, text, sigma_diagonal, domain, memory_type, access_count, timestamp FROM memories ${where} ORDER BY ${sortCol} LIMIT ?`
      ).bind(...params, limit).all<any>();

      if (!rows.results?.length) return 'No memories stored.';
      return rows.results.map((r: any) => {
        const sigma = deserializeSigma(r.sigma_diagonal);
        const ts = r.timestamp ? new Date(r.timestamp * 1000).toISOString().slice(0, 16) : '';
        return `[${r.id}] [${ts}] [σ=${meanSigma(sigma).toFixed(3)}] [${r.access_count}x] (${r.domain}/${r.memory_type}) ${r.text.slice(0, 80)}`;
      }).join('\n');
    }

    case 'memory_orphan_check': {
      const repair = args.repair === true;
      // Fetch all D1 IDs + text in batches
      const allRows = await env.DB.prepare(
        'SELECT id, text, domain, memory_type FROM memories ORDER BY rowid'
      ).all<{ id: string; text: string; domain: string; memory_type: string }>();

      const rows = allRows.results ?? [];
      if (!rows.length) return 'No memories found.';

      // Check Vectorize in batches of 20 (API hard limit for getByIds)
      const CHUNK = 20;
      const orphanIds: string[] = [];
      const orphanRows: typeof rows = [];

      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const ids = chunk.map(r => r.id);
        const vecResult = await (env.VECTORIZE as any).getByIds(ids);
        const foundIds = new Set((vecResult ?? []).map((v: any) => v.id));
        for (const row of chunk) {
          if (!foundIds.has(row.id)) {
            orphanIds.push(row.id);
            orphanRows.push(row);
          }
        }
      }

      if (!orphanIds.length) return `No orphans found. All ${rows.length} D1 rows have Vectorize vectors.`;

      if (!repair) {
        return `Found ${orphanIds.length} orphans (D1 rows with no Vectorize vector) out of ${rows.length} total.\nFirst 5: ${orphanIds.slice(0, 5).join(', ')}\nCall with repair=true to re-embed and fix.`;
      }

      // Repair: re-embed orphans and upsert into Vectorize
      let fixed = 0;
      const EMBED_BATCH = 20;
      for (let i = 0; i < orphanRows.length; i += EMBED_BATCH) {
        const batch = orphanRows.slice(i, i + EMBED_BATCH);
        const mus = await batchEmbed(batch.map(r => r.text), env);
        await env.VECTORIZE.upsert(batch.map((row, j) => ({
          id: row.id,
          values: Array.from(mus[j]),
          metadata: { domain: row.domain, memory_type: row.memory_type },
        })));
        fixed += batch.length;
      }
      return `Repaired ${fixed} orphans — re-embedded and upserted to Vectorize.`;
    }

    case 'memory_capture_passive': {
      const rawText = args.text as string;
      const project = (args.project as string) ?? 'default';

      // Section headers that indicate storable content
      const SECTION_PATTERNS = [
        /^#{1,3}\s*(key\s*learnings?|learnings?)/i,
        /^#{1,3}\s*(decisions?(\s+made)?)/i,
        /^#{1,3}\s*(problems?\s*(solved|fixed|resolved))/i,
        /^#{1,3}\s*(insights?|takeaways?)/i,
        /^#{1,3}\s*(todo|action\s*items?|next\s*steps?)/i,
        /^#{1,3}\s*(context|notes?|summary)/i,
      ];

      // Parse: split into lines, find section headers, collect bullets under them
      const lines = rawText.split('\n');
      const items: { text: string; type: string }[] = [];
      let inSection = false;
      let sectionType = 'episodic';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if this line is a matching section header
        if (SECTION_PATTERNS.some(p => p.test(trimmed))) {
          inSection = true;
          // Infer memory type from section name
          if (/preference|style|habit|always|never/i.test(trimmed)) sectionType = 'procedural';
          else if (/belief|value|insight|principle/i.test(trimmed)) sectionType = 'semantic';
          else sectionType = 'episodic';
          continue;
        }

        // Non-matching header resets section context
        if (/^#{1,3}\s/.test(trimmed)) { inSection = false; continue; }

        if (!inSection) continue;

        // Collect bullet points and numbered list items
        const bullet = trimmed.replace(/^[-*+•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
        if (bullet.length >= 20 && bullet.split(' ').length >= 4) {
          items.push({ text: bullet, type: sectionType });
        }
      }

      if (!items.length) return 'No storable items found. Use headers like "## Key Learnings:", "## Decisions:", "## Problems Solved:" with bullet points underneath.';

      // Embed + classify + store each item
      let stored = 0, skipped = 0;
      const storedMus: Float32Array[] = [];

      for (const item of items.slice(0, 20)) { // cap at 20 per call
        const mu = await embed(item.text, env);
        const tooSimilar = storedMus.some(prev => dotProduct(Array.from(mu), Array.from(prev)) > 0.92);
        if (tooSimilar) { skipped++; continue; }

        const domain = await classifyDomainWithLlama(item.text, env, mu);
        const { memory_type: inferred, emotional_intensity } = inferTypeAndIntensity(item.text);
        const memType = item.type !== 'episodic' ? item.type : inferred;
        const { action } = await storeMemory(item.text, memType, domain, emotional_intensity, env, mu, project);
        if (action === 'spawned') {
          await updateDomainCentroid(domain, mu, env).catch(() => {});
          storedMus.push(mu);
          stored++;
        } else {
          skipped++;
        }
      }

      return `Captured ${stored} memories from structured notes (${skipped} skipped — duplicates or intra-batch similar).`;
    }

    case 'memory_timeline': {
      const limit = Math.min((args.limit as number) ?? 20, 50);
      const domain = args.domain as string | undefined;

      const rows = await env.DB.prepare(
        domain
          ? `SELECT id, text, domain, memory_type, sigma_diagonal, access_count,
                    contradiction_flag, timestamp
             FROM memories WHERE domain = ?
             ORDER BY timestamp ASC LIMIT ?`
          : `SELECT id, text, domain, memory_type, sigma_diagonal, access_count,
                    contradiction_flag, timestamp
             FROM memories
             ORDER BY access_count DESC, timestamp ASC LIMIT ?`
      ).bind(...(domain ? [domain, limit] : [limit]))
       .all<{ id: string; text: string; domain: string; memory_type: string;
              sigma_diagonal: string; access_count: number;
              contradiction_flag: number; timestamp: number }>();

      const memories = rows.results ?? [];
      if (!memories.length) return domain ? `No memories in domain "${domain}".` : 'No memories found.';

      // Fetch supersede relations for these IDs in one query
      const ids = memories.map(m => m.id);
      const relRows = await env.DB.prepare(
        `SELECT from_id, to_id, relation_type FROM memory_relations
         WHERE relation_type IN ('supersedes','conflicts_with')
           AND (from_id IN (${ids.map(() => '?').join(',')})
             OR to_id IN (${ids.map(() => '?').join(',')}))`
      ).bind(...ids, ...ids).all<{ from_id: string; to_id: string; relation_type: string }>();

      const supersededIds = new Set(
        (relRows.results ?? [])
          .filter(r => r.relation_type === 'supersedes')
          .map(r => r.to_id)
      );
      const conflictIds = new Set(
        (relRows.results ?? []).flatMap(r =>
          r.relation_type === 'conflicts_with' ? [r.from_id, r.to_id] : []
        )
      );

      // Group by month for readability
      const groups = new Map<string, typeof memories>();
      for (const m of memories) {
        const d = new Date((m.timestamp ?? 0) * 1000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(m);
      }

      const lines: string[] = [
        domain ? `TIMELINE: ${domain} (${memories.length} memories)` : `TIMELINE: top ${memories.length} most-accessed memories`,
        '',
      ];

      for (const [month, mems] of groups) {
        lines.push(`── ${month} ──`);
        for (const m of mems) {
          const sigma = meanSigma(deserializeSigma(m.sigma_diagonal));
          const conf = sigma < 0.3 ? '●' : sigma < 0.5 ? '◑' : '○';
          const marker = supersededIds.has(m.id) ? '[SUPERSEDED] '
            : conflictIds.has(m.id) ? '[CONFLICT] '
            : m.contradiction_flag ? '[FLAGGED] '
            : '';
          const day = new Date((m.timestamp ?? 0) * 1000).toISOString().slice(0, 10);
          const accessed = m.access_count > 0 ? ` · ${m.access_count}x` : '';
          lines.push(`  ${day} ${conf} σ=${sigma.toFixed(2)}${accessed}  ${marker}${m.text}`);
        }
        lines.push('');
      }

      return lines.join('\n').trimEnd();
    }

    case 'memory_belief_drift': {
      // Resolve which memory IDs to inspect
      let targetIds: string[] = [];
      if (args.memory_id) {
        targetIds = [args.memory_id as string];
      } else if (args.query) {
        const qvec = await embed(args.query as string, env);
        const hits = await env.VECTORIZE.query(Array.from(qvec), { topK: args.top_k ?? 5, returnValues: false, returnMetadata: 'none' });
        targetIds = (hits.matches ?? []).map(m => m.id);
      }
      if (!targetIds.length) return 'No memories found.';

      const placeholders = targetIds.map(() => '?').join(',');
      const mems = await env.DB.prepare(
        `SELECT id, text, sigma_diagonal, access_count, timestamp, domain FROM memories WHERE id IN (${placeholders})`
      ).bind(...targetIds).all<{ id: string; text: string; sigma_diagonal: string; access_count: number; timestamp: number; domain: string }>();

      const lines: string[] = ['## Belief Drift Report\n'];

      for (const m of mems.results ?? []) {
        const currentSigma = meanSigma(deserializeSigma(m.sigma_diagonal));
        const agedays = Math.floor((Date.now() / 1000 - (m.timestamp ?? 0)) / 86400);

        // Pull sigma history for this memory
        const hist = await env.DB.prepare(
          'SELECT sigma, event_type, recorded_at FROM memory_sigma_history WHERE memory_id = ? ORDER BY recorded_at ASC'
        ).bind(m.id).all<{ sigma: number; event_type: string; recorded_at: number }>();
        const histRows = hist.results ?? [];

        const initialSigmaVal = histRows.length > 0 ? histRows[0].sigma : 0.5;
        const drift = initialSigmaVal - currentSigma; // positive = sharpened, negative = faded

        // Verdict
        let verdict: string;
        if (drift > 0.3) verdict = `strongly reinforced — confident belief`;
        else if (drift > 0.15) verdict = `sharpening — belief gaining confidence`;
        else if (drift > 0.05) verdict = `slightly reinforced`;
        else if (drift < -0.1) verdict = `fading — belief losing confidence`;
        else verdict = `stable — unchanged since storage`;

        const conf = currentSigma < 0.3 ? '●' : currentSigma < 0.5 ? '◑' : '○';
        lines.push(`**${conf} ${m.text.slice(0, 120)}**`);
        lines.push(`Domain: ${m.domain} · Age: ${agedays}d · Accessed: ${m.access_count}x`);
        lines.push(`σ: ${initialSigmaVal.toFixed(3)} → ${currentSigma.toFixed(3)} (Δ${drift >= 0 ? '+' : ''}${drift.toFixed(3)}) — ${verdict}`);

        if (histRows.length > 1) {
          lines.push(`Trajectory (${histRows.length} snapshots):`);
          for (const h of histRows) {
            const d = new Date(h.recorded_at * 1000).toISOString().slice(0, 10);
            lines.push(`  ${d}  σ=${h.sigma.toFixed(3)}  [${h.event_type}]`);
          }
        }
        lines.push('');
      }

      return lines.join('\n').trimEnd();
    }

    case 'memory_belief_drift_backfill': {
      // Backfill sigma_history for memories that have no 'store' entry.
      // Reconstructs plausible trajectory from access metadata.
      // Run repeatedly — processes 300/call.
      const bfBatch = await env.DB.prepare(`
        SELECT m.id, m.sigma_diagonal, m.timestamp, m.last_accessed, m.access_count
        FROM memories m
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_sigma_history h WHERE h.memory_id = m.id AND h.event_type = 'store'
        )
        LIMIT 300
      `).all<{ id: string; sigma_diagonal: string; timestamp: number; last_accessed: number; access_count: number }>();

      const bfRows = bfBatch.results ?? [];
      if (!bfRows.length) return 'Backfill complete — all memories have sigma history.';

      const inserts: D1PreparedStatement[] = [];
      for (const row of bfRows) {
        const currentSigma = meanSigma(deserializeSigma(row.sigma_diagonal));
        const t0 = row.timestamp ?? 0;
        const t1 = row.last_accessed ?? t0;
        const accesses = Math.min(row.access_count ?? 0, 8);

        inserts.push(env.DB.prepare(
          'INSERT OR IGNORE INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?,?,?,?,?)'
        ).bind(crypto.randomUUID(), row.id, 0.5, 'store', t0));

        if (accesses >= 2 && t1 > t0) {
          for (let i = 1; i < accesses; i++) {
            const t = Math.floor(t0 + (t1 - t0) * (i / accesses));
            const sigma = parseFloat((0.5 - (0.5 - currentSigma) * (i / accesses)).toFixed(4));
            inserts.push(env.DB.prepare(
              'INSERT OR IGNORE INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?,?,?,?,?)'
            ).bind(crypto.randomUUID(), row.id, sigma, 'synthetic', t));
          }
        }

        if (currentSigma !== 0.5) {
          inserts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO memory_sigma_history (id, memory_id, sigma, event_type, recorded_at) VALUES (?,?,?,?,?)'
          ).bind(crypto.randomUUID(), row.id, currentSigma, 'sharpen', t1));
        }
      }

      for (let i = 0; i < inserts.length; i += 100) {
        await env.DB.batch(inserts.slice(i, i + 100));
      }

      const remaining = await env.DB.prepare(`
        SELECT COUNT(*) as n FROM memories m
        WHERE NOT EXISTS (SELECT 1 FROM memory_sigma_history h WHERE h.memory_id = m.id AND h.event_type = 'store')
      `).first<{ n: number }>();

      return `Backfilled ${bfRows.length} memories. ${remaining?.n ?? '?'} remaining — call again to continue.`;
    }

    case 'memory_process_entity_queue': {
      const before = await env.KV.get('pending_entity_queue');
      const beforeCount = before ? JSON.parse(before).length : 0;
      await processPendingEntityQueue(env);
      const after = await env.KV.get('pending_entity_queue');
      const afterCount = after ? JSON.parse(after).length : 0;
      const entityCount = await env.DB.prepare('SELECT COUNT(*) as n FROM memory_entities').first<{n:number}>();
      return `Processed ${beforeCount - afterCount} memories. Queue: ${beforeCount} → ${afterCount}. Total entity links: ${entityCount?.n ?? 0}`;
    }

    case 'memory_judge': {
      const topK = (args.top_k as number) ?? 5;
      const now = Math.floor(Date.now() / 1000);

      // Build candidate list: explicit ID or all unflagged contradiction memories
      let targets: { id: string; text: string }[] = [];
      if (args.memory_id) {
        // Support both full UUIDs and 8-char display prefixes shown in tool output
        const memId = args.memory_id as string;
        const isPrefix = memId.length === 8 && !memId.includes('-');
        const row = isPrefix
          ? await env.DB.prepare('SELECT id, text FROM memories WHERE id LIKE ?')
              .bind(memId + '%').first<{ id: string; text: string }>()
          : await env.DB.prepare('SELECT id, text FROM memories WHERE id = ?')
              .bind(memId).first<{ id: string; text: string }>();
        if (!row) return `Not found: ${memId}`;
        targets = [row];
      } else {
        // Process pending_judge queue first (near-misses queued at store time), then contradiction_flag
        const pendingRows = await env.DB.prepare(
          `SELECT DISTINCT m.id, m.text FROM memory_relations mr
           JOIN memories m ON m.id = mr.from_id
           WHERE mr.relation_type = 'pending_judge' LIMIT 20`
        ).all<{ id: string; text: string }>();
        targets = pendingRows.results ?? [];

        if (!targets.length) {
          const flagged = await env.DB.prepare(
            'SELECT id, text FROM memories WHERE contradiction_flag = 1 LIMIT 20'
          ).all<{ id: string; text: string }>();
          targets = flagged.results ?? [];
        }
        if (!targets.length) return 'No pending judgements or flagged contradictions.';
      }

      const results: string[] = [];

      for (const target of targets) {
        // Find nearest neighbours via Vectorize
        const mu = await embed(target.text, env);
        const vecResults = await env.VECTORIZE.query(Array.from(mu), {
          topK: topK + 1, returnValues: false, returnMetadata: 'indexed',
        });

        const candidateIds = (vecResults.matches ?? [])
          .filter(m => m.id !== target.id && (m.score ?? 0) >= 0.70)
          .slice(0, topK)
          .map(m => m.id);

        if (!candidateIds.length) {
          results.push(`${target.id.slice(0, 8)}: no candidates above 0.70`);
          continue;
        }

        const candRows = await env.DB.prepare(
          `SELECT id, text FROM memories WHERE id IN (${candidateIds.map(() => '?').join(',')})`
        ).bind(...candidateIds).all<{ id: string; text: string }>();

        for (const cand of candRows.results ?? []) {
          // Check if relation already judged
          const existing = await env.DB.prepare(
            'SELECT id FROM memory_relations WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)'
          ).bind(target.id, cand.id, cand.id, target.id).first();
          if (existing) continue;

          // LLM verdict — Llama 3.3 70B for reliability
          const judgeResult = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
            messages: [
              {
                role: 'system',
                content: `Compare two memories and return their relationship.
Verdicts:
- "supersedes": Memory A is a newer/more accurate version of B (A replaces B)
- "conflicts_with": A and B make contradictory claims about the same topic
- "extends": A adds detail to B without contradicting it
- "compatible": A and B are about different things, no conflict

Return ONLY valid JSON: {"verdict":"supersedes|conflicts_with|extends|compatible","confidence":0.0-1.0,"reason":"one sentence"}`,
              },
              {
                role: 'user',
                content: `<memory_a>${target.text}</memory_a>\n<memory_b>${cand.text}</memory_b>`,
              },
            ],
            max_tokens: 80,
            temperature: 0,
          }) as any;

          const rawVVal = judgeResult?.response ?? judgeResult?.choices?.[0]?.message?.content ?? '';
          const rawV = (typeof rawVVal === 'string' ? rawVVal : JSON.stringify(rawVVal)).trim();
          let verdict = 'compatible', confidence = 0.5, reason = '';
          try {
            const match = rawV.match(/\{[^}]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (['supersedes','conflicts_with','extends','compatible'].includes(parsed.verdict)) {
                verdict = parsed.verdict;
                confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
                reason = (parsed.reason ?? '').slice(0, 200);
              }
            }
          } catch {}

          await env.DB.prepare(
            'INSERT INTO memory_relations (id, from_id, to_id, relation_type, confidence, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), target.id, cand.id, verdict, confidence, reason, now).run();

          // Clear pending_judge entry now that verdict is stored
          await env.DB.prepare(
            `DELETE FROM memory_relations WHERE relation_type = 'pending_judge'
             AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`
          ).bind(target.id, cand.id, cand.id, target.id).run();

          // If supersedes: flag old memory for decay acceleration
          if (verdict === 'supersedes') {
            await env.DB.prepare('UPDATE memories SET contradiction_flag = 1 WHERE id = ?')
              .bind(cand.id).run();
          }

          results.push(`${target.id.slice(0, 8)} → ${cand.id.slice(0, 8)}: ${verdict} (${(confidence * 100).toFixed(0)}%) — ${reason}`);
        }
      }

      return results.length ? results.join('\n') : 'All relations already judged.';
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
        .slice(0, 60000); // GLM has 131K context — was 4000 for Llama 3.1 8B, now captures full sessions

      // Llama 3.3 70B for extraction — GLM fails on complex multi-object JSON with long prompts.
      // Extraction runs once per session end so cost vs Llama 3.1 8B is negligible.
      const extraction = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
        messages: [
          {
            role: 'system',
            content: `Extract facts from this session log for long-term memory. Today: ${new Date().toISOString().slice(0, 10)}. Resolve relative dates to ISO 8601.

EXTRACT (up to 12 total, prioritized):
1. Decisions — exact technology/approach chosen and WHY. Format transitions as "Switched X → Y because Z" (e.g. "Switched GLM → Llama-3.1-8b because GLM exhausts token budget before emitting content")
2. Implementation parameters — preserve exact numbers/thresholds ("topK=2, threshold=0.65, decay=0.6" not "adjusted parameters")
3. Problems solved — what broke, exact fix applied
4. Project context — concrete state, named blockers, specific counts/dates
5. Preferences — specific tools/methods/patterns with reasoning

RULES:
- Preserve exact names, numbers, technologies ("GLM-4.7-flash" not "a model", "topK=2" not "small topK")
- Capture state transitions: "Changed X from A to B because C"
- Each fact must stand alone without reading the session
- Third-person factual sentence only
- 15–80 words per fact

SKIP: vague intent (Wants to/Is considering/Is planning/Is trying/Is working on/Is looking at/Is thinking about/Is learning/Is exploring), raw chat (ok/yea/lol/ig/tbh/idk), generic status (done/updated/it works/improved the system/made changes), questions, pasted content, anything under 15 words, anything with no specific technology/number/decision named

Return ONLY valid JSON array:
[{"text":"Chose Cloudflare D1 over PlanetScale — zero egress fees, edge-native","type":"episodic"},{"text":"Switched GLM-4.7-flash → Llama-3.1-8b for batch classification because GLM exhausts token budget on reasoning_content before emitting final content, causing timeouts","type":"episodic"},{"text":"Prefers concise responses without emojis","type":"procedural"}]`,
          },
          { role: 'user', content: `<session_log>${filteredLog}</session_log>` },
        ],
        max_tokens: 800,
        temperature: 0,
      }) as any;

      interface ExtractedFact { text: string; type?: string }
      let facts: ExtractedFact[] = [];
      const rawVal = extraction?.response ?? extraction?.choices?.[0]?.message?.content ?? '';
      const raw = (typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal)).trim();
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
          .filter((l: string) =>
            l.length > 25 &&
            !l.startsWith('{') &&
            !l.startsWith('[') &&
            !/^here are/i.test(l) &&
            !/^extracted/i.test(l) &&
            !/^json/i.test(l)
          )
          .map((t: string) => ({ text: t }));
      }

      // Filter out obvious garbage before embedding
      const cleanFacts = facts.slice(0, 12).filter(f => {
        const t = (f.text ?? '').trim();
        if (t.length < 20) return false;
        if (t.startsWith('{') || t.startsWith('[')) return false;
        if (/^here are/i.test(t) || /^extracted/i.test(t)) return false;
        if (t.split(' ').length < 4) return false;
        return true;
      });

      let stored = 0;
      const storedMus: Float32Array[] = [];  // intra-batch dedup

      for (const fact of cleanFacts) {
        const text = fact.text ?? '';
        const mu = await embed(text, env);

        // Intra-batch dedup: skip if too similar to something already stored this run
        const tooSimilar = storedMus.some(prev => {
          const sim = dotProduct(Array.from(mu), Array.from(prev));
          return sim > 0.92;
        });
        if (tooSimilar) continue;

        const domain = await classifyDomainWithLlama(text, env, mu);
        const llmType = fact.type && ['episodic','semantic','procedural'].includes(fact.type)
          ? fact.type : null;
        const { memory_type: inferredType, emotional_intensity } = inferTypeAndIntensity(text);
        const memory_type = llmType ?? inferredType;
        const { action } = await storeMemory(text, memory_type, domain, emotional_intensity, env, mu, args.project ?? 'default');
        if (action === 'spawned') {
          await updateDomainCentroid(domain, mu, env).catch(() => {});
          storedMus.push(mu);
          stored++;
        }
      }

      // Session summary — compose from extracted facts, no extra LLM call.
      // Avoids rate limit failures after N domain classification calls.
      // Stored as memory_type='session' so it gets +0.20 retrieval boost and slow decay.
      if (cleanFacts.length >= 2) {
        try {
          const date = new Date().toISOString().slice(0, 10);
          const summaryText = `Session ${date}: ${cleanFacts.slice(0, 5).map(f => f.text).join(' | ')}`;
          const summaryMu = await embed(summaryText, env);
          const summaryDomain = await classifyDomainWithLlama(summaryText, env, summaryMu);
          const { action: sAction } = await storeMemory(
            summaryText, 'session', summaryDomain, 0.9, env, summaryMu, args.project ?? 'default'
          );
          if (sAction === 'spawned') {
            await updateDomainCentroid(summaryDomain, summaryMu, env).catch(() => {});
            stored++;
          }
        } catch {}
      }

      return `Extracted ${facts.length} facts, stored ${stored}.`;
    }

    case 'memory_bulk_delete': {
      // LIKE has a complexity limit on long patterns — use INSTR instead.
      // Split pattern on % to get literal parts; require all parts present (case-insensitive).
      const rawPattern = args.pattern as string;
      const parts = rawPattern.split('%').filter((p: string) => p.length > 0);
      if (parts.length === 0) return 'Invalid pattern.';
      const conditions = parts.map(() => 'INSTR(LOWER(text), LOWER(?)) > 0').join(' AND ');
      const rows = await env.DB.prepare(
        `SELECT id FROM memories WHERE ${conditions}`
      ).bind(...parts).all<{ id: string }>();
      const ids = (rows.results ?? []).map(r => r.id);
      if (!ids.length) return 'No memories matched pattern.';
      for (const id of ids) {
        await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
      }
      // Vectorize hard limit: 100 IDs per deleteByIds call
      for (let i = 0; i < ids.length; i += 100) {
        await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
      }
      return `Deleted ${ids.length} memories matching "${args.pattern}".`;
    }

    case 'memory_cleanup_singletons': {
      const minCount = (args.min_count as number) ?? 3;
      return await cleanupSingletons(env, minCount);
    }

    case 'memory_build_entities': {
      // Retroactive entity extraction — batch processes memories, extracts named entities,
      // writes to entity_nodes + memory_entities for 1-hop graph traversal at retrieve time
      const BATCH = 20;
      const offsetRaw = await env.KV.get('ENTITY_BUILD_OFFSET');
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

      const rows = await env.DB.prepare(
        `SELECT id, text FROM memories ORDER BY access_count DESC, rowid DESC LIMIT ? OFFSET ?`
      ).bind(BATCH, offset).all<{ id: string; text: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('ENTITY_BUILD_OFFSET');
        const count = await env.DB.prepare('SELECT COUNT(*) as n FROM memory_entities').first<{n:number}>();
        return `Done. ${count?.n ?? 0} entity links built.`;
      }

      const numbered = batch.map((r, i) => `${i+1}. ${r.text.slice(0, 150)}`).join('\n');
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: `Extract named entities from each memory. Return ONLY a JSON array of arrays.
Entity types: tool (specific model/library names like GLM-4.7-flash, D1, Vectorize), project (Gaussian Memory, Color Wow, Bayer), concept (spreading activation, Bhattacharyya), parameter (exact values like topK=2), person (proper names).
For each memory return up to 4 entities as ["type:canonical_name", ...]. Use empty array [] if no clear entities.
Example: [["tool:GLM-4.7-flash","concept:spreading activation"],["project:Gaussian Memory","parameter:topK=2"],[]]`,
          },
          { role: 'user', content: numbered },
        ],
        max_tokens: 512,
        temperature: 0,
      }) as any;

      const raw = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
      try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as string[][];
          const now = Math.floor(Date.now() / 1000);
          const dbOps: any[] = [];

          for (let i = 0; i < batch.length; i++) {
            const memId = batch[i].id;
            const entities = parsed[i] ?? [];
            for (const ent of entities) {
              const [type, ...nameParts] = ent.split(':');
              const name = nameParts.join(':').trim();
              if (!type || !name) continue;
              const entId = `ent_${type}_${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
              dbOps.push(
                env.DB.prepare(`INSERT OR IGNORE INTO entity_nodes (id, type, canonical_name, last_seen) VALUES (?,?,?,?)`)
                  .bind(entId, type, name, now)
              );
              dbOps.push(
                env.DB.prepare(`UPDATE entity_nodes SET last_seen = ? WHERE id = ?`).bind(now, entId)
              );
              dbOps.push(
                env.DB.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, entity_span) VALUES (?,?,?)`)
                  .bind(memId, entId, name)
              );
            }
          }
          if (dbOps.length > 0) await env.DB.batch(dbOps);
        }
      } catch {}

      await env.KV.put('ENTITY_BUILD_OFFSET', String(offset + BATCH));
      const total = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{n:number}>();
      return `Processed batch at offset ${offset}. ${total?.n ?? 0} memories total, ~${Math.max(0, (total?.n ?? 0) - offset - BATCH)} remaining.`;
    }

    case 'memory_retag_projects': {
      const BATCH = 30;
      // Discover projects from DB rather than hardcoding personal project names
      const projectRows = await env.DB.prepare(
        `SELECT DISTINCT project FROM memories WHERE project != 'default' ORDER BY project`
      ).all<{ project: string }>();
      const PROJECTS = [...(projectRows.results ?? []).map(r => r.project), 'default'];

      const offsetRaw = await env.KV.get('RETAG_OFFSET');
      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;

      const rows = await env.DB.prepare(
        `SELECT id, text FROM memories WHERE project = 'default' ORDER BY rowid LIMIT ?`
      ).bind(BATCH).all<{ id: string; text: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('RETAG_OFFSET');
        const counts = await env.DB.prepare(`SELECT project, COUNT(*) as cnt FROM memories GROUP BY project ORDER BY cnt DESC`).all<{project:string;cnt:number}>();
        const summary = (counts.results ?? []).map(r => `${r.project}:${r.cnt}`).join(', ');
        return `Done. ${summary}`;
      }

      const projectList = PROJECTS.map(p => `- ${p}`).join('\n');
      const numbered = batch.map((r, i) => `${i+1}. ${r.text.slice(0, 120)}`).join('\n');
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: `Classify each memory by project. Return ONLY a JSON array of exactly ${batch.length} project name strings.

Known projects (pick the closest match, or use "default" if unclear):
${projectList}

Return: ["project-name", "project-name", ...]`,
          },
          { role: 'user', content: numbered },
        ],
        max_tokens: 256,
      }) as any;

      const raw = (result?.response ?? result?.choices?.[0]?.message?.content ?? '').trim();
      try {
        const match = raw.match(/\[[\s\S]*?\]/);
        if (match) {
          const parsed = JSON.parse(match[0]) as string[];
          const updates = batch
            .map((r, i) => {
              const p = (parsed[i] ?? 'default').trim();
              return PROJECTS.includes(p) ? { id: r.id, project: p } : null;
            })
            .filter(Boolean) as { id: string; project: string }[];

          if (updates.length) {
            await env.DB.batch(
              updates.map(u => env.DB.prepare('UPDATE memories SET project = ? WHERE id = ?').bind(u.project, u.id))
            );
          }
        }
      } catch {}

      await env.KV.put('RETAG_OFFSET', String(offset + BATCH));
      const remaining = await env.DB.prepare(`SELECT COUNT(*) as n FROM memories WHERE project = 'default'`).first<{n:number}>();
      return `Processed batch. ~${remaining?.n ?? '?'} default memories remaining.`;
    }

    case 'memory_rebuild_domains': {
      await ensureDomainColumns(env);
      const BATCH = 30;  // Smaller batch — 3 Llama calls per invocation (10 texts each)
      const offsetRaw = await env.KV.get('REBUILD_OFFSET');

      const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
      // targeted=true (default): only reclassify unanchored/general memories, keep existing anchors
      // targeted=false: full wipe-and-rebuild (pass targeted=false explicitly)
      const targeted = args.targeted !== false;

      // Only wipe anchors on full rebuild, not targeted pass
      if (offsetRaw === null && !targeted) {
        await env.DB.prepare('DELETE FROM domain_anchors').run();
      }
      // Targeted mode uses no OFFSET — rows disappear from result set as they're fixed,
      // so OFFSET-based pagination skips rows. Just LIMIT without offset, keep calling until empty.
      const rows = await env.DB.prepare(
        targeted
          ? `SELECT id, text, memory_type FROM memories
             WHERE domain = 'general' OR domain NOT IN (SELECT name FROM domain_anchors)
             ORDER BY rowid LIMIT ?`
          : 'SELECT id, text, memory_type FROM memories ORDER BY rowid LIMIT ? OFFSET ?'
      ).bind(...(targeted ? [BATCH] : [BATCH, offset])).all<{ id: string; text: string; memory_type: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('REBUILD_OFFSET');
        const total = await env.DB.prepare('SELECT COUNT(*) as n FROM memories').first<{ n: number }>();
        const anchors = await env.DB.prepare('SELECT COUNT(*) as n FROM domain_anchors').first<{ n: number }>();
        return `Done. ${total?.n ?? 0} memories reclassified into ${anchors?.n ?? 0} domains.`;
      }

      // Batch embed + classify using shared helper
      const mus = await batchEmbed(batch.map(r => r.text), env);
      const existingDomains = (await env.DB.prepare('SELECT name FROM domain_anchors ORDER BY rowid')
        .all<{ name: string }>()).results?.map(r => r.name) ?? [];
      const rawAssignments = await classifyBatchDomains(batch.map(r => r.text), existingDomains, env);
      const domainAssignments = await remapToAnchoredDomains(rawAssignments, mus, env);

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
