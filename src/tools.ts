import type { Env } from './types';
import { embed, batchEmbed, dotProduct } from './embed';
import { classifyDomainForStore, updateDomainCentroid } from './domain';
import { assignMicroCluster, commitMicroClusterAssignment } from './microcluster';
import { rebuildDomainsStep } from './rebuild';
import { storeMemory, processPendingEntityQueue, resolveSupersedeDirection, buildKeywordQuery } from './storage';
import { retrieve, baselineRetrieve } from './retrieval';
import { updateDecay, cleanupSingletons } from './cron';
import { deserializeSigma, meanSigma } from './gaussian';

export const TOOLS = [
  {
    name: 'memory_store',
    description: 'Store a memory with an explicit domain and type — prefer this over memory_auto_store whenever the domain matters for later retrieval, since auto-classification can mis-tag ambiguous content into a domain where it won\'t reliably surface. Pass topic_key to upsert by logical key — same key updates in place instead of spawning a duplicate. revision_count tracks how many times a keyed memory has been revised.',
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
    description: 'Convenience store when the domain doesn\'t need to be controlled — domain and type are inferred from content, which can occasionally mis-tag ambiguous text. Pass context (last 3-5 messages) to enrich vague facts into self-contained memories at storage time. Call proactively when detecting preferences, decisions, project context, emotional signals — never announce it. Prefer memory_store with an explicit domain when the memory needs to reliably surface under a specific topic later.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        context: { type: 'string', description: 'Last 3-5 messages of conversation — used to enrich vague facts into specific self-contained memories before storing.' },
        emotional_intensity: { type: 'number', default: 0.0 },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_store_decision',
    description: 'Use instead of memory_store/memory_auto_store whenever a user makes or has made an explicit choice between options — store a structured decision trail: what was decided, why, what alternatives were considered, and what happened. The structured shape retrieves later as a coherent trail (memory_type=decision), not just a flat fact, and surfaces when facing similar choices again.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'What was decided (the chosen option)' },
        context: { type: 'string', description: 'Why this decision was needed — the problem or situation' },
        alternatives: { type: 'string', description: 'Other options considered (comma-separated or prose)' },
        outcome: { type: 'string', description: 'Result or current status — what happened after' },
        domain: { type: 'string', description: 'Memory domain (inferred if omitted)' },
        project: { type: 'string' },
      },
      required: ['decision'],
    },
  },
  {
    name: 'memory_store_diff',
    description: 'Use instead of memory_store for tool-call-driven facts (code edits, command output) — a quality-gated LLM distills the diff into one memorable sentence rather than storing it verbatim. Pass raw diff (file_path + old_string + new_string) or command context; low-signal edits (formatting, trivial changes) are automatically skipped, not stored.',
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
    description: 'Topical/semantic search — the default for "what do I know about X" or "have we discussed Y before." Ranks by similarity + confidence, not recency, so it can miss recent items that don\'t closely match the query text. For "what did I just save" or "what happened this week" style questions, prefer memory_list (recency/audit) or memory_timeline (chronological) instead. Set synthesize=true to blend equidistant memories into a single reconstructed memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        domain: { type: 'string' },
        top_k: { type: 'number', default: 8 },
        synthesize: { type: 'boolean', default: false },
        project: { type: 'string', description: 'Scope results to this project. Defaults to searching all projects.' },
        strict_project: { type: 'boolean', default: false, description: 'When project is set, exclude default-project results instead of blending them in.' },
        baseline: { type: 'boolean', default: false, description: 'Benchmark-only: naive top-k cosine retrieval, bypassing hybrid scoring entirely. Used for Stage B ablation comparisons.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: 'Recency and audit tool — use for "what did I save today," finding the ID of a specific memory to update/delete, or confirming a store actually happened. Not for topical search (use memory_retrieve for that, since this doesn\'t rank by relevance). Filter by domain, sort by created_at/access_count/sigma, limit results, or pass since (ISO timestamp) to scope to recent memories only.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        limit: { type: 'number', default: 50 },
        sort: { type: 'string', enum: ['timestamp', 'access_count', 'sigma', 'last_accessed'], default: 'timestamp' },
        since: { type: 'string', description: 'ISO 8601 timestamp — return only memories stored after this time' },
      },
    },
  },
  {
    name: 'memory_decay',
    description: 'Force an immediate decay pass (increase uncertainty, prune faded memories). Runs automatically on the nightly cron — only call this directly to test decay behavior or force cleanup ahead of schedule.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_stats',
    description: 'System health snapshot: total memories, domain/type breakdown, sigma distribution, access heat. Use to sanity-check corpus health, confirm a batch operation (rebuild/dedupe/decay) actually changed something, or answer "how many memories do I have."',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_orphan_check',
    description: 'Detect D1 memories with no Vectorize vector — a silent retrieval gap where a memory exists but can never surface via semantic search. Run this if retrieval seems to be missing something that was definitely stored. Pass repair=true to re-embed and fix orphans found.',
    inputSchema: {
      type: 'object',
      properties: { repair: { type: 'boolean', default: false } },
    },
  },
  {
    name: 'memory_judge',
    description: 'Maintenance tool, not typically needed mid-conversation — judges relationships between a memory and its nearest neighbours, returning supersedes/conflicts_with/compatible/extends verdicts stored in memory_relations. Pass memory_id to judge one memory; omit to auto-judge all memories currently flagged as contradictions.',
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
    description: 'Use when a user pastes or references structured end-of-session notes (headers like "## Key Learnings:", "## Decisions:", "## Problems Solved:") rather than describing one fact to store. Parses the structure and bulk-stores each bullet as its own memory.',
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
    description: 'Chronological/temporal tool — use for "what did I do this week" or "walk me through how X evolved," not topical search (use memory_retrieve for that). Shows memories in time order with sigma trajectory and any supersede/conflict markers. Pass domain to scope it; omit for a cross-domain timeline of the most recent memories.',
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
    description: 'One-time maintenance, not something to call mid-conversation — backfills sigma_history for memories that have no history entry yet, reconstructing trajectory from access metadata. Processes 300/call; run repeatedly until it reports completion.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_delete',
    description: 'Delete a single memory by ID — use memory_list or memory_retrieve first to find the ID. Prefer memory_bulk_delete when removing more than one memory at once.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_update',
    description: 'Correct or refine a memory\'s text in place — use when a stored fact turns out to be wrong or incomplete, not to record a new fact (use memory_store for that). Re-embeds and updates the vector so it still retrieves correctly under the new wording; sigma and access count are preserved since this is a correction, not a new memory.',
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
    description: 'Extracts memorable facts from a raw session log via LLM and stores each. Normally invoked automatically by the session-end hook — not something to call mid-conversation unless manually reprocessing a specific log.',
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
    description: 'Delete memories by text pattern (% as wildcard) and/or exact project match. At least one of pattern/project is required. Returns count deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        project: { type: 'string', description: 'Exact project match. Combine with pattern to narrow further, or use alone to delete an entire project — needed because LLM-rewritten content (memory_extract_and_store, memory_store_diff) may not retain any literal substring from the original input, making pattern-only cleanup unreliable for that content.' },
      },
    },
  },
  {
    name: 'memory_dedupe',
    description: 'One-shot maintenance, not needed in normal operation since new stores already dedupe synchronously — collapses exact-text duplicate memories, keeping the most-reinforced row (highest access_count) and deleting the rest from D1 + FTS + Vectorize. Use only when cleaning up an old duplicate backlog. Pass dry_run=true to preview counts without deleting.',
    inputSchema: {
      type: 'object',
      properties: { dry_run: { type: 'boolean', description: 'Preview duplicate groups and deletable count without deleting. Default false.' } },
    },
  },
  {
    name: 'memory_cleanup_singletons',
    description: 'One-shot maintenance, typically run once after a domain rebuild, not routinely — reclassifies memories sitting in domains with fewer than N memories (default 3) into the nearest anchored domain. Does not create new domains.',
    inputSchema: {
      type: 'object',
      properties: { min_count: { type: 'number', description: 'Domains with fewer than this many memories are singletons. Default 3.' } },
    },
  },
  {
    name: 'memory_rebuild_domains',
    description: 'Re-classify memories. Default targeted=true fixes only general/unanchored memories against existing anchors. targeted=false starts a full deterministic rebuild: clusters all memory embeddings (order-independent average-linkage), then one LLM call per cluster for naming only — rerunning on the same corpus reproduces the same domains. Incremental; call repeatedly until "Done." During a full rebuild, pass dry_run=true at the clustering step to preview domain counts across merge_threshold values before applying.',
    inputSchema: {
      type: 'object',
      properties: {
        targeted: { type: 'boolean', description: 'true (default) = only fix general/unanchored memories; false = full clustering rebuild (wipes domain_anchors at commit)' },
        merge_threshold: { type: 'number', description: 'Full rebuild only: average-linkage similarity cut between clusters (default 0.75). Sweep with dry_run=true first.' },
        micro_threshold: { type: 'number', description: 'Full rebuild only: leader-pass admission similarity (default 0.85). Lower it if the merge phase reports too many micro-clusters.' },
        dry_run: { type: 'boolean', description: 'Full rebuild, clustering step only: report cluster counts per merge_threshold without applying.' },
        restart: { type: 'boolean', description: 'Abandon an in-progress full rebuild and start over.' },
      },
    },
  },
  {
    name: 'memory_retag_projects',
    description: 'One-shot maintenance for memories stuck in the default project pool, not something to trigger routinely — Llama classifies each memory text into the correct project. Call repeatedly until it returns "Done." (~137 calls for 4k memories).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_build_entities',
    description: 'One-shot maintenance for backfilling older memories only — new memories get entities extracted automatically via the entity queue. Processes memories in batches, extracts named entities (tool/project/concept/parameter/person), writes to entity_nodes + memory_entities tables. Call repeatedly until "Done." Enables 1-hop entity graph traversal at retrieve time.',
    inputSchema: {
      type: 'object',
      properties: {
        debug: { type: 'boolean', default: false, description: 'Read-only: returns raw/parsed diagnostics for the current front-of-queue batch instead of writing entities or advancing the offset.' },
      },
    },
  },
  {
    name: 'memory_process_entity_queue',
    description: 'Process the pending entity extraction queue — runs the batch that was deferred at store time. Shows queue depth before/after and total entity links. Call after a heavy store session to flush the queue.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_belief_drift',
    description: 'Use when asked "has my opinion on X changed" or "how confident are you in this" — shows sigma trajectory (confidence over time) from initial store to now. Pass memory_id for a specific memory, or query to find matching memories first.',
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

// Ingestion quality gate: blocks conversational chat-speak addressed to the assistant —
// raw user/assistant turns that slip into the store paths (the historical source of junk
// like "hm what do u thnk", "yea idk", "nah i ddint see it"). Distilled facts read in third
// person ("Prefers X", "Chose Y", "Lohit wants Z") and survive. Conservative by design:
// only clear chat filler is blocked, so real short preferences still get through.
export function isLowSignalText(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 15) return true;                          // fragments ("Yeah, I do.")
  if ((t.match(/\s/g) ?? []).length < 2) return true;      // fewer than 3 words
  const lc = t.toLowerCase();
  // Texting second-person to the assistant — distilled facts use "you/your" or third person.
  const startsLower = /[a-z]/.test(t[0] ?? '');
  if (startsLower && /\b(u|ur|tryna|wanna|gonna|idk|imma|dunno|lemme)\b/.test(lc)) return true;
  // Casual conversational openers.
  if (/^(hm+|yea+h?|nah|yo|lol|haha|hmm+|huh|ok so|so yea)\b/i.test(t)) return true;
  return false;
}

export async function handleToolCall(name: string, args: any, env: Env, ctx?: ExecutionContext): Promise<string> {
  switch (name) {
    case 'memory_store': {
      if (!args.text || isLowSignalText(args.text as string)) return 'SKIP: low-signal or chat-filler text';
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
          await env.DB.batch([
            env.DB.prepare(
              'UPDATE memories SET text = ?, last_accessed = ?, access_count = access_count + 1, revision_count = ? WHERE id = ?'
            ).bind(args.text, now, revisions, existing.id),
            env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(existing.id),
            env.DB.prepare('INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)').bind(existing.id, args.text, project),
          ]);
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
      // Context enrichment: if caller passes conversation context, use Llama to rewrite
      // the fact as a specific self-contained sentence before embedding.
      // Runs in the PostToolUse hook — up to 1500ms added per call when context is provided.
      let storedText = args.text as string;
      if (args.context) {
        try {
          const enrichResult = await Promise.race([
            env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
              messages: [
                {
                  role: 'system',
                  content: 'Given conversation context, rewrite the fact as a single specific self-contained sentence (15-80 words). Preserve exact names, numbers, technologies. No preamble, no quotes — just the sentence.',
                },
                {
                  role: 'user',
                  content: `<context>${(args.context as string).slice(0, 800)}</context>\n<fact>${storedText}</fact>\nRewritten:`,
                },
              ],
              max_tokens: 120,
              temperature: 0,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
          ]) as any;
          const enriched = (enrichResult?.response ?? enrichResult?.choices?.[0]?.message?.content ?? '').trim();
          if (enriched && enriched.length > 20 && enriched.length < 300) storedText = enriched;
        } catch {}
      }
      // Quality gate AFTER enrichment: enriched text is a clean sentence and passes; raw
      // chat-filler that wasn't enriched (no context passed) gets dropped here.
      if (isLowSignalText(storedText)) return `SKIP: low-signal or chat-filler text`;
      const mu = await embed(storedText, env);
      const domain = await classifyDomainForStore(storedText, env, mu);
      const { clusterId, isNew: isNewCluster } = await assignMicroCluster(mu, env);
      const { memory_type, emotional_intensity: inferred } = inferTypeAndIntensity(storedText);
      const emotional_intensity = Math.max(args.emotional_intensity ?? 0.0, inferred);
      const { action, id, conflict_candidates } = await storeMemory(
        storedText, memory_type, domain, emotional_intensity, env, mu, args.project ?? 'default', clusterId
      );
      if (action === 'spawned') {
        await updateDomainCentroid(domain, mu, env, ctx).catch(() => {});
        await commitMicroClusterAssignment(clusterId, isNewCluster, mu, env).catch(() => {});
      }
      let out = `${action.toUpperCase()}: '${storedText.slice(0, 60)}' -> (${domain}/${memory_type}, id=${id.slice(0, 8)})`;
      if (conflict_candidates?.length) {
        out += `\nconflict_candidates: ${JSON.stringify(conflict_candidates)}`;
      }
      return out;
    }

    case 'memory_store_decision': {
      // Fix #8: guard required field before .trim()
      if (!args.decision || typeof args.decision !== 'string') {
        return "ERROR: 'decision' field is required and must be a non-empty string";
      }
      const decision = args.decision.trim();
      if (!decision) return "ERROR: 'decision' must not be blank";

      const parts = [`Decision: ${decision}`];
      // Fix #9: trim before truthiness check so whitespace-only values are skipped
      for (const [label, key] of [['Context', 'context'], ['Alternatives considered', 'alternatives'], ['Outcome', 'outcome']] as const) {
        const val = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
        if (val) parts.push(`${label}: ${val}`);
      }
      const text = parts.join(' | ');
      const mu = await embed(text, env);
      // Fix #5: fallback to 'general' if classification fails
      const domain = (typeof args.domain === 'string' && args.domain.trim())
        ? args.domain.trim()
        : await classifyDomainForStore(text, env, mu).catch(() => 'general');
      // cluster_id is independent of any caller-supplied domain override — always assign.
      const { clusterId, isNew: isNewCluster } = await assignMicroCluster(mu, env);
      // Fix #7: nudge centroid when auto-classifying (matches memory_auto_store pattern)
      const { action, id, conflict_candidates } = await storeMemory(
        text, 'decision', domain, 0.6, env, mu, args.project ?? 'default', clusterId
      );
      if (action === 'spawned') {
        if (!args.domain) await updateDomainCentroid(domain, mu, env, ctx).catch(() => {});
        await commitMicroClusterAssignment(clusterId, isNewCluster, mu, env).catch(() => {});
      }
      // Fix #4: surface conflict_candidates like sibling store handlers
      let out = `${action.toUpperCase()}: '${text.slice(0, 80)}' -> (${domain}/decision, id=${id.slice(0, 8)})`;
      if (conflict_candidates?.length) out += `\nconflict_candidates: ${JSON.stringify(conflict_candidates)}`;
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
        diffContext = `File: ${projectFromPath ? `${projectFromPath}/` : ''}${file}\nBefore: ${oldSnip}\nAfter: ${newSnip}`;
      }
      if (!diffContext) return 'SKIP: no diff context provided';

      // Semantic entropy gate: skip diffs where old and new are mechanically identical
      // after stripping digits, punctuation, whitespace — catches version bumps, count
      // changes, semicolon fixes, blank line additions that have zero semantic content.
      if (args.old_string != null && args.new_string != null) {
        const strip = (s: string) => s.replace(/[\d\s.,;:'"()[\]{}\-_=+!?@#$%^&*|\\/<>]/g, '').toLowerCase();
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
      // Timeout-guarded (matches memory_auto_store's enrichment call, tools.ts:359) — confirmed
      // live 2026-07-06 that an unguarded GLM call here can run long enough for the Workers
      // runtime itself to cancel the request (observed via `wrangler tail`: status "Canceled"),
      // silently dropping every diff from that call with no response ever returned to the
      // caller. This tool fires on every Bash/Write tool call via the PostToolUse hook, so an
      // unbounded hang here is a live reliability gap, not just a test-only concern.
      let gateResult: any;
      try {
        gateResult = await Promise.race([
          env.AI.run('@cf/zai-org/glm-4.7-flash' as any, {
            messages: [
              {
                role: 'system',
                content: 'You decide if a code change or command is worth storing as a long-term developer memory. Answer ONLY "YES" or "NO". Store YES for: decisions with rationale (why X was chosen over Y), non-trivial logic changes, bug fixes, architecture choices, meaningful command outputs. Store NO for: formatting, imports, trivial edits, read-only commands, test runs with no insight, boilerplate. If a senior engineer could reconstruct this change just by reading the file, answer NO.',
              },
              { role: 'user', content: `<diff>${diffContext}</diff>` },
            ],
            max_tokens: 1024,
            temperature: 0,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('GLM gate timeout')), 12_000)),
        ]) as any;
      } catch {
        // Timeout or AI binding error is an infra failure, not a verdict on the content's
        // worth — skip rather than store unverified content, consistent with this gate's
        // conservative default elsewhere (unclassifiable content falls back to 'general', not
        // a forced guess).
        return 'SKIP: quality gate unavailable (timeout)';
      }
      // GLM-4.7-flash is a thinking model: reasoning goes into reasoning_content,
      // the final answer is in choices[0].message.content (null until reasoning completes).
      // Must use max_tokens >= 1024 so the model can finish reasoning and emit content.
      const choice = gateResult?.choices?.[0]?.message;
      const rawGate = (gateResult?.response ?? choice?.content ?? '') as string;
      const gateAnswer = rawGate.trim().toUpperCase();
      if (!gateAnswer.startsWith('YES')) return 'SKIP: low signal (GLM quality gate)';

      // Ask Llama to describe the change semantically in one sentence
      // Llama 3.1 8B for diff description — GLM fails on short/minimal diffs (returns {})
      const descResult = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
        messages: [
          {
            role: 'system',
            content: 'Summarize this code change or command in ONE factual sentence for a developer memory system. Be specific about what changed and why it matters. Do not start with "I" or "The developer". Under 30 words. Return ONLY the sentence, no JSON, no quotes.',
          },
          { role: 'user', content: `<diff>${diffContext}</diff>` },
        ],
        max_tokens: 60,
      }) as any;

      // `as string` is compile-time only — coerce for real, same crash class as
      // memory_build_entities (Workers AI can return a non-string response shape).
      const descRaw = descResult?.response ?? '';
      const description = (typeof descRaw === 'string' ? descRaw : '').trim();
      if (!description || description.length < 10) return 'SKIP: model returned empty description';

      const mu = await embed(description, env);
      const domain = await classifyDomainForStore(description, env, mu);
      const { clusterId, isNew: isNewCluster } = await assignMicroCluster(mu, env);
      const { action, id } = await storeMemory(description, 'episodic', domain, 0, env, mu, args.project ?? 'default', clusterId);
      if (action === 'spawned') {
        await updateDomainCentroid(domain, mu, env, ctx);
        await commitMicroClusterAssignment(clusterId, isNewCluster, mu, env).catch(() => {});
      }
      return `${action.toUpperCase()}: '${description.slice(0, 60)}' -> (${domain}/episodic, id=${id.slice(0, 8)})`;
    }

    case 'memory_retrieve': {
      // Stage B ablation path — naive top-k cosine only, no hybrid scoring. Formatted
      // identically to the normal output below (score/domain/type/text) so the bench
      // harness's existing parser works unchanged against either mode.
      if (args.baseline === true) {
        const baseResults = await baselineRetrieve(args.query, args.top_k ?? 8, env, args.project ?? 'default', args.strict_project === true);
        if (!baseResults.length) return 'No memories found.';
        return baseResults.map(r => `[${r.score.toFixed(2)}] (${r.domain}/${r.type}) ${r.text}`).join('\n');
      }

      // Default 8 — must match the declared inputSchema default (was 5, silently diverging from schema)
      const results = await retrieve(args.query, args.domain ?? null, args.top_k ?? 8, env, args.project ?? 'default', args.strict_project === true);
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
        const blend = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
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
      const limit = Math.min(Number(args.limit) || 50, 500);

      // Corrupt/unparseable sigma_diagonal (e.g. bad base64) must not 500 the whole
      // list — same tolerance memory_dedupe's meanSig helper already applies.
      const safeMeanSigma = (s: string): number => {
        try { return meanSigma(deserializeSigma(s)); } catch { return 1; }
      };

      // sort=sigma: sigma_diagonal is base64-serialized Float32 — SQL ORDER BY on it is a
      // lexicographic string sort, not numeric. Fetch a wider window and sort by meanSigma in JS.
      let resultRows: any[];
      if (args.sort === 'sigma') {
        const rows = await env.DB.prepare(
          `SELECT id, text, sigma_diagonal, domain, memory_type, access_count, timestamp FROM memories ${where} LIMIT 2000`
        ).bind(...params).all<any>();
        resultRows = (rows.results ?? [])
          .sort((a: any, b: any) => safeMeanSigma(a.sigma_diagonal) - safeMeanSigma(b.sigma_diagonal))
          .slice(0, limit);
      } else {
        const sortCol = args.sort === 'access_count' ? 'access_count DESC'
          : args.sort === 'last_accessed' ? 'last_accessed DESC'
          : 'timestamp DESC';
        const rows = await env.DB.prepare(
          `SELECT id, text, sigma_diagonal, domain, memory_type, access_count, timestamp FROM memories ${where} ORDER BY ${sortCol} LIMIT ?`
        ).bind(...params, limit).all<any>();
        resultRows = rows.results ?? [];
      }

      if (!resultRows.length) return 'No memories stored.';
      return resultRows.map((r: any) => {
        const sigmaMean = safeMeanSigma(r.sigma_diagonal);
        const ts = r.timestamp ? new Date(r.timestamp * 1000).toISOString().slice(0, 16) : '';
        return `[${r.id}] [${ts}] [σ=${sigmaMean.toFixed(3)}] [${r.access_count}x] (${r.domain}/${r.memory_type}) ${r.text.slice(0, 80)}`;
      }).join('\n');
    }

    case 'memory_orphan_check': {
      const repair = args.repair === true;
      // Fetch all D1 IDs + text in batches
      const allRows = await env.DB.prepare(
        'SELECT id, text, domain, memory_type, project FROM memories ORDER BY rowid'
      ).all<{ id: string; text: string; domain: string; memory_type: string; project: string }>();

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
          metadata: { domain: row.domain, memory_type: row.memory_type, project: row.project ?? 'default' },
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

      const capturedItems = items.slice(0, 20); // cap at 20 per call
      const mus = await batchEmbed(capturedItems.map(i => i.text), env);

      for (let i = 0; i < capturedItems.length; i++) {
        const item = capturedItems[i];
        const mu = mus[i];
        const tooSimilar = storedMus.some(prev => dotProduct(Array.from(mu), Array.from(prev)) > 0.92);
        if (tooSimilar) { skipped++; continue; }

        const domain = await classifyDomainForStore(item.text, env, mu);
        const { clusterId, isNew: isNewCluster } = await assignMicroCluster(mu, env);
        const { memory_type: inferred, emotional_intensity } = inferTypeAndIntensity(item.text);
        const memType = item.type !== 'episodic' ? item.type : inferred;
        const { action } = await storeMemory(item.text, memType, domain, emotional_intensity, env, mu, project, clusterId);
        if (action === 'spawned') {
          await updateDomainCentroid(domain, mu, env, ctx).catch(() => {});
          await commitMicroClusterAssignment(clusterId, isNewCluster, mu, env).catch(() => {});
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

      // Pull the most recent `limit` rows (DESC), then reverse in JS so the
      // displayed timeline still reads oldest→newest — previously this sorted
      // ASC directly, which returned the OLDEST N rows in a domain and could
      // never surface anything recent once a domain passed `limit` in size.
      const rows = await env.DB.prepare(
        domain
          ? `SELECT id, text, domain, memory_type, sigma_diagonal, access_count,
                    contradiction_flag, timestamp
             FROM memories WHERE domain = ?
             ORDER BY timestamp DESC LIMIT ?`
          : `SELECT id, text, domain, memory_type, sigma_diagonal, access_count,
                    contradiction_flag, timestamp
             FROM memories
             ORDER BY timestamp DESC LIMIT ?`
      ).bind(...(domain ? [domain, limit] : [limit]))
       .all<{ id: string; text: string; domain: string; memory_type: string;
              sigma_diagonal: string; access_count: number;
              contradiction_flag: number; timestamp: number }>();

      const memories = (rows.results ?? []).reverse();
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
        groups.get(key)?.push(m);
      }

      const lines: string[] = [
        domain ? `TIMELINE: ${domain} (${memories.length} memories)` : `TIMELINE: ${memories.length} most recent memories`,
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
      let targets: { id: string; text: string; timestamp: number }[] = [];
      if (args.memory_id) {
        // Support both full UUIDs and 8-char display prefixes shown in tool output
        const memId = args.memory_id as string;
        const isPrefix = memId.length === 8 && !memId.includes('-');
        const row = isPrefix
          ? await env.DB.prepare('SELECT id, text, timestamp FROM memories WHERE id LIKE ?')
              .bind(`${memId}%`).first<{ id: string; text: string; timestamp: number }>()
          : await env.DB.prepare('SELECT id, text, timestamp FROM memories WHERE id = ?')
              .bind(memId).first<{ id: string; text: string; timestamp: number }>();
        if (!row) return `Not found: ${memId}`;
        targets = [row];
      } else {
        // Process pending_judge queue first (near-misses queued at store time), then contradiction_flag
        const pendingRows = await env.DB.prepare(
          `SELECT DISTINCT m.id, m.text, m.timestamp FROM memory_relations mr
           JOIN memories m ON m.id = mr.from_id
           WHERE mr.relation_type = 'pending_judge' LIMIT 20`
        ).all<{ id: string; text: string; timestamp: number }>();
        targets = pendingRows.results ?? [];

        if (!targets.length) {
          const flagged = await env.DB.prepare(
            'SELECT id, text, timestamp FROM memories WHERE contradiction_flag = 1 LIMIT 20'
          ).all<{ id: string; text: string; timestamp: number }>();
          targets = flagged.results ?? [];
        }
        if (!targets.length) return 'No pending judgements or flagged contradictions.';
      }

      const results: string[] = [];

      for (const target of targets) {
        // Find nearest neighbours via Vectorize (cosine) + FTS5 (keyword). Vectorize alone
        // misses topically-related-but-lexically-distant pairs — confirmed live 2026-07-07: a
        // real "domain rebuild has issues" vs "domain/cluster_id split resolved" pair sat below
        // 0.70 cosine (never in Vectorize's top 10) but shared literal keywords ("domain",
        // "rebuild"). No cosine floor applies to FTS5 candidates — shared vocabulary is the
        // signal, and the LLM verdict call below is the actual precision gate, same as it
        // already is for cosine-sourced candidates.
        const mu = await embed(target.text, env);
        const ftsQuery = buildKeywordQuery(target.text);
        const [vecResults, ftsResults] = await Promise.all([
          env.VECTORIZE.query(Array.from(mu), { topK: topK + 1, returnValues: false, returnMetadata: 'indexed' }),
          ftsQuery.length > 0
            ? env.DB.prepare(
                `SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`
              ).bind(ftsQuery, topK).all<{ id: string }>().catch(() => ({ results: [] }))
            : Promise.resolve({ results: [] as { id: string }[] }),
        ]);

        const vecCandidateIds = (vecResults.matches ?? [])
          .filter(m => m.id !== target.id && (m.score ?? 0) >= 0.70)
          .slice(0, topK)
          .map(m => m.id);
        const ftsCandidateIds = (ftsResults.results ?? [])
          .map(r => r.id)
          .filter(id => id !== target.id);

        const candidateIds = [...new Set([...vecCandidateIds, ...ftsCandidateIds])];

        if (!candidateIds.length) {
          results.push(`${target.id.slice(0, 8)}: no candidates above 0.70 or via keyword match`);
          continue;
        }

        const candRows = await env.DB.prepare(
          `SELECT id, text, timestamp FROM memories WHERE id IN (${candidateIds.map(() => '?').join(',')})`
        ).bind(...candidateIds).all<{ id: string; text: string; timestamp: number }>();

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

Examples:
A: "My salary is $120k" B: "My salary is $95k" → {"verdict":"supersedes","confidence":0.95,"reason":"A is a newer salary figure that replaces B"}
A: "The meeting is on Tuesday" B: "The meeting is on Thursday" → {"verdict":"conflicts_with","confidence":0.92,"reason":"A and B give contradictory days for the same meeting"}
A: "Uses PostgreSQL with pgBouncer connection pooling" B: "Uses PostgreSQL for storage" → {"verdict":"extends","confidence":0.88,"reason":"A adds implementation detail without contradicting B"}
A: "Prefers dark mode in VSCode" B: "Favorite language is Python" → {"verdict":"compatible","confidence":0.97,"reason":"A and B are about different preferences with no conflict"}

Return ONLY valid JSON: {"verdict":"supersedes|conflicts_with|extends|compatible","confidence":0.0-1.0,"reason":"one sentence"}`,
              },
              {
                role: 'user',
                content: `<memory_a stored_at="${target.timestamp}">${target.text}</memory_a>\n<memory_b stored_at="${cand.timestamp}">${cand.text}</memory_b>\nIf one supersedes the other, the newer memory (higher stored_at) supersedes the older.`,
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
          } catch (e) {
            console.error('[memory_judge] JSON parse failed, defaulting to compatible:', e);
          }

          const direction = resolveSupersedeDirection(target, cand);
          const [fromId, toId] = verdict === 'supersedes'
            ? [direction.fromId, direction.toId]
            : [target.id, cand.id];

          await env.DB.prepare(
            'INSERT INTO memory_relations (id, from_id, to_id, relation_type, confidence, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), fromId, toId, verdict, confidence, reason, now).run();

          // Clear pending_judge entry now that verdict is stored
          await env.DB.prepare(
            `DELETE FROM memory_relations WHERE relation_type = 'pending_judge'
             AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`
          ).bind(target.id, cand.id, cand.id, target.id).run();

          // If supersedes: expire the older memory so it never surfaces again, and clear the
          // survivor's contradiction_flag (both sides get flagged at store time — leaving the
          // winner flagged after judging keeps showing it as "[CONTRADICTED — re-evaluate]"
          // even though the relation is now resolved).
          if (verdict === 'supersedes') {
            await env.DB.prepare('UPDATE memories SET contradiction_flag = 1, valid_to = ? WHERE id = ?')
              .bind(Math.floor(Date.now() / 1000), direction.olderId).run();
            await env.DB.prepare('UPDATE memories SET contradiction_flag = 0 WHERE id = ?')
              .bind(direction.newerId).run();
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

        // Corrupt/unparseable sigma_diagonal must not 500 the whole stats call.
        let s: number;
        try { s = meanSigma(deserializeSigma(r.sigma_diagonal)); } catch { s = 1; }
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
      const row = await env.DB.prepare(
        'SELECT text, domain, memory_type, timestamp FROM memories WHERE id = ?'
      ).bind(args.id).first<{ text: string; domain: string; memory_type: string; timestamp: number }>();
      if (!row) return `Not found: ${args.id}`;

      // Archive to R2 before hard-delete, same shape/convention as cron.ts consolidateColdMemories,
      // so all deletion paths leave a consistent undo/audit trail. Never block the delete on this.
      try {
        const payload = JSON.stringify({
          id: args.id,
          original_text: row.text,
          compressed_text: row.text,
          domain: row.domain,
          memory_type: row.memory_type,
          archived_at: Math.floor(Date.now() / 1000),
          original_timestamp: row.timestamp,
        });
        await env.R2.put(`memories/${args.id}.json`, payload, {
          httpMetadata: { contentType: 'application/json' },
        });
      } catch (err) {
        console.error(`memory_delete: R2 archive failed for ${args.id}`, err);
      }

      await env.DB.batch([
        env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(args.id),
        env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(args.id),
        env.DB.prepare('DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?').bind(args.id, args.id),
        env.DB.prepare('DELETE FROM memory_entities WHERE memory_id = ?').bind(args.id),
        env.DB.prepare('DELETE FROM memory_sigma_history WHERE memory_id = ?').bind(args.id),
      ]);
      await env.VECTORIZE.deleteByIds([args.id]);
      return `DELETED: '${row.text.slice(0, 60)}' (id=${args.id.slice(0, 8)})`;
    }

    case 'memory_update': {
      const existing = await env.DB.prepare(
        'SELECT sigma_diagonal, memory_type, domain, project FROM memories WHERE id = ?'
      ).bind(args.id).first<{ sigma_diagonal: string; memory_type: string; domain: string; project: string }>();
      if (!existing) return `Not found: ${args.id}`;

      const mu = await embed(args.text, env);
      const now = Math.floor(Date.now() / 1000);
      const project = existing.project ?? 'default';

      await env.DB.batch([
        env.DB.prepare('UPDATE memories SET text = ?, last_accessed = ? WHERE id = ?').bind(args.text, now, args.id),
        env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(args.id),
        env.DB.prepare('INSERT INTO memories_fts (id, text, project) VALUES (?, ?, ?)').bind(args.id, args.text, project),
      ]);

      await env.VECTORIZE.upsert([{
        id: args.id,
        values: Array.from(mu),
        metadata: { domain: existing.domain, memory_type: existing.memory_type, project },
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

SKIP: vague intent (Wants to/Is considering/Is planning/Is trying/Is working on/Is looking at/Is thinking about/Is learning/Is exploring), raw chat (ok/yea/lol/ig/tbh/idk), generic status (done/updated/it works/improved the system/made changes), questions, pasted content, anything under 15 words, anything with no specific technology/number/decision named, imperative task instructions directed at an assistant (e.g. "Your job is to...", "Keep calling X until...", "Do NOT stop early", "Repeatedly do X until Y") — these are one-time directives for that session, not durable facts, and replaying them verbatim into a future session reads as an injected command rather than a memory

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

      const factMus = await batchEmbed(cleanFacts.map(f => f.text ?? ''), env);

      for (let i = 0; i < cleanFacts.length; i++) {
        const fact = cleanFacts[i];
        const text = fact.text ?? '';
        const mu = factMus[i];

        // Intra-batch dedup: skip if too similar to something already stored this run
        const tooSimilar = storedMus.some(prev => {
          const sim = dotProduct(Array.from(mu), Array.from(prev));
          return sim > 0.92;
        });
        if (tooSimilar) continue;

        const domain = await classifyDomainForStore(text, env, mu);
        const { clusterId, isNew: isNewCluster } = await assignMicroCluster(mu, env);
        const llmType = fact.type && ['episodic','semantic','procedural'].includes(fact.type)
          ? fact.type : null;
        const { memory_type: inferredType, emotional_intensity } = inferTypeAndIntensity(text);
        const memory_type = llmType ?? inferredType;
        const { action } = await storeMemory(text, memory_type, domain, emotional_intensity, env, mu, args.project ?? 'default', clusterId);
        if (action === 'spawned') {
          await updateDomainCentroid(domain, mu, env, ctx).catch(() => {});
          await commitMicroClusterAssignment(clusterId, isNewCluster, mu, env).catch(() => {});
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
          const summaryDomain = await classifyDomainForStore(summaryText, env, summaryMu);
          const { clusterId: summaryClusterId, isNew: isNewSummaryCluster } = await assignMicroCluster(summaryMu, env);
          const { action: sAction } = await storeMemory(
            summaryText, 'session', summaryDomain, 0.9, env, summaryMu, args.project ?? 'default', summaryClusterId
          );
          if (sAction === 'spawned') {
            await updateDomainCentroid(summaryDomain, summaryMu, env).catch(() => {});
            await commitMicroClusterAssignment(summaryClusterId, isNewSummaryCluster, summaryMu, env).catch(() => {});
            stored++;
          }
        } catch {}
      }

      return `Extracted ${facts.length} facts, stored ${stored}.`;
    }

    case 'memory_bulk_delete': {
      // project is an exact match, independent of pattern's INSTR-based text matching — added
      // because LLM-rewritten content (memory_extract_and_store's fact extraction,
      // memory_store_diff's GLM/Llama description) doesn't retain any literal substring from
      // the original input, so pattern-only cleanup can never find it, even though every store
      // call accepts and persists a project. Confirmed live 2026-07-06: e2e test cleanup left a
      // permanent 'tidewater-kite-club' domain in production because pattern-based afterAll
      // cleanup couldn't match the LLM-paraphrased text these tools actually stored.
      const conditions: string[] = [];
      const params: string[] = [];
      if (typeof args.pattern === 'string' && args.pattern.length > 0) {
        const parts = args.pattern.split('%').filter((p: string) => p.length > 0);
        if (parts.length > 0) {
          conditions.push(parts.map(() => 'INSTR(LOWER(text), LOWER(?)) > 0').join(' AND '));
          params.push(...parts);
        }
      }
      if (typeof args.project === 'string' && args.project.length > 0) {
        conditions.push('project = ?');
        params.push(args.project);
      }
      if (conditions.length === 0) return 'Invalid pattern: at least one of pattern/project is required.';
      const rows = await env.DB.prepare(
        `SELECT id, text, domain, memory_type, timestamp FROM memories WHERE ${conditions.join(' AND ')}`
      ).bind(...params).all<{ id: string; text: string; domain: string; memory_type: string; timestamp: number }>();
      const matched = rows.results ?? [];
      const ids = matched.map(r => r.id);
      if (!ids.length) return 'No memories matched pattern.';

      // Archive each matched memory to R2 before hard-delete, same shape/convention as
      // cron.ts consolidateColdMemories. Archival failures never block the delete.
      await Promise.all(matched.map(async row => {
        try {
          const payload = JSON.stringify({
            id: row.id,
            original_text: row.text,
            compressed_text: row.text,
            domain: row.domain,
            memory_type: row.memory_type,
            archived_at: Math.floor(Date.now() / 1000),
            original_timestamp: row.timestamp,
          });
          await env.R2.put(`memories/${row.id}.json`, payload, {
            httpMetadata: { contentType: 'application/json' },
          });
        } catch (err) {
          console.error(`memory_bulk_delete: R2 archive failed for ${row.id}`, err);
        }
      }));

      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        await env.DB.batch([
          ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?').bind(id, id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memory_entities WHERE memory_id = ?').bind(id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memory_sigma_history WHERE memory_id = ?').bind(id)),
        ]);
        await env.VECTORIZE.deleteByIds(chunk);
      }
      return `Deleted ${ids.length} memories${typeof args.pattern === 'string' && args.pattern.length > 0 ? ` matching "${args.pattern}".` : '.'}`;
    }

    case 'memory_dedupe': {
      // Collapse exact-text duplicate groups. For each text with >1 row, keep the most-
      // reinforced copy (max access_count, then sharpest sigma, then oldest) and delete the
      // rest from D1 + FTS + Vectorize. This is a backlog artifact from before the
      // synchronous D1 exact-text guard existed (Vectorize indexing lag let rapid re-ingests
      // of the same text spawn instead of merge). Going-forward dedup is handled at write time.
      const dryRun = args.dry_run === true;
      // Pull id + access_count + sigma for every row in a duplicated text group.
      const dupRows = await env.DB.prepare(
        `SELECT m.id, m.text, m.access_count, m.sigma_diagonal, m.timestamp
         FROM memories m
         JOIN (SELECT text FROM memories GROUP BY text HAVING COUNT(*) > 1) d ON m.text = d.text`
      ).all<{ id: string; text: string; access_count: number; sigma_diagonal: string; timestamp: number }>();

      // Group by text, choose a keeper per group, mark the rest for deletion.
      const groups = new Map<string, typeof dupRows.results>();
      for (const r of dupRows.results ?? []) {
        if (!groups.has(r.text)) groups.set(r.text, []);
        groups.get(r.text)?.push(r);
      }
      const meanSig = (s: string) => {
        try { const a = deserializeSigma(s); return meanSigma(a); } catch { return 1; }
      };
      const deleteIds: string[] = [];
      for (const rows of groups.values()) {
        // Keeper = highest access_count, tie-break sharpest sigma (lowest), then oldest row.
        const keeper = rows.slice().sort((a, b) =>
          (b.access_count - a.access_count)
          || (meanSig(a.sigma_diagonal) - meanSig(b.sigma_diagonal))
          || (a.timestamp - b.timestamp)
        )[0];
        for (const r of rows) if (r.id !== keeper.id) deleteIds.push(r.id);
      }

      if (dryRun) {
        return `DRY RUN: ${groups.size} duplicate groups, ${deleteIds.length} rows would be deleted (keeping ${groups.size} most-reinforced copies). No changes made.`;
      }
      for (let i = 0; i < deleteIds.length; i += 100) {
        const chunk = deleteIds.slice(i, i + 100);
        await env.DB.batch([
          ...chunk.map(id => env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memories_fts WHERE id = ?').bind(id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?').bind(id, id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memory_entities WHERE memory_id = ?').bind(id)),
          ...chunk.map(id => env.DB.prepare('DELETE FROM memory_sigma_history WHERE memory_id = ?').bind(id)),
        ]);
        await env.VECTORIZE.deleteByIds(chunk);
      }
      return `Deduped ${groups.size} groups — deleted ${deleteIds.length} duplicate rows, kept ${groups.size} most-reinforced copies.`;
    }

    case 'memory_cleanup_singletons': {
      const minCount = (args.min_count as number) ?? 3;
      return await cleanupSingletons(env, minCount);
    }

    case 'memory_build_entities': {
      // Retroactive entity extraction — processes memories one at a time (own AI.run
      // call per memory, run concurrently within each batch via Promise.all), writes to
      // entity_nodes + memory_entities for 1-hop graph traversal at retrieve time.
      //
      // Previously batched N memories into one array-of-arrays prompt. That let a small
      // model (llama-3.2-3b) degenerate into repeating ONE item's answer for every slot
      // when several batch items were topically similar (e.g. many Gaussian Memory
      // session notes all mentioning topK=2/Bhattacharyya) — confirmed via the debug
      // path below, which showed rawPreview repeating `["project:Gaussian Memory",
      // "parameter:topK=2"]` ~15x before truncating into invalid JSON. Raising max_tokens
      // or shrinking the batch doesn't fix that (it either truncates later or "succeeds"
      // with every slot silently wrong) — one memory per call removes the cross-item
      // interference entirely, since each call only ever sees one memory's text.
      const BATCH = 8;
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

      const SYSTEM_PROMPT = `Extract up to 4 named entities from this memory. Entity types: tool (specific model/library names like GLM-4.7-flash, D1, Vectorize), project (Gaussian Memory, Color Wow, Bayer), concept (spreading activation, Bhattacharyya), parameter (exact values like topK=2), person (proper names).
Return ONLY a JSON array: ["type:canonical_name", ...]. Return [] if no clear entities.
Example: ["tool:GLM-4.7-flash","concept:spreading activation"]`;

      async function extractOne(text: string): Promise<{ raw: string; entities: string[]; parseError: string }> {
        const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text.slice(0, 300) },
          ],
          max_tokens: 120,
          temperature: 0,
        }) as any;

        // Coerce before use — Workers AI can return a non-string `response` (e.g. a
        // safety/moderation object) for sensitive content; without this guard a crash
        // here would propagate past this function with no per-item isolation.
        const rawVal = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
        const raw = typeof rawVal === 'string' ? rawVal.trim() : '';
        try {
          const match = raw.match(/\[[\s\S]*\]/);
          if (!match) return { raw, entities: [], parseError: '' };
          const parsed = JSON.parse(match[0]);
          // Validate shape here, not `as string[]` — a cast is compile-time only and
          // doesn't stop the model from emitting the old array-of-arrays form, numbers,
          // or other junk. Without this, a malformed entity reaches ent.split(':') in
          // the write loop below with no try/catch around it, throws uncaught, and
          // wedges this batch forever since the KV offset never advances on a throw.
          // Silently drop non-string entries instead — matches this function's existing
          // pattern of degrading gracefully (e.g. `if (!type || !name) continue`) rather
          // than failing the whole batch over one bad entity.
          const entities = Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
          return { raw, entities, parseError: '' };
        } catch (e) {
          return { raw, entities: [], parseError: String(e) };
        }
      }

      // Sequential, not Promise.all — firing all 8 AI.run calls concurrently was
      // silently dropping most of them (empty response, not an error): two debug
      // runs on the identical batch came back with the exact same 6/8 positions
      // empty every time, always the same two indices surviving. That's a
      // concurrency ceiling on the AI binding, not a content issue — sequential
      // calls are slower per batch but reliable.
      // Small delay between calls — the empty-response pattern persisted across
      // concurrent/sequential/fresh-content tests, which rules out prompt content,
      // scheduling order, and response caching. A per-model rate limit on this
      // account tripped by call volume (independent of the paid-tier neuron budget)
      // is the remaining explanation; this delay keeps us under it.
      const extractions: Awaited<ReturnType<typeof extractOne>>[] = [];
      for (const r of batch) {
        extractions.push(await extractOne(r.text));
        await new Promise(res => setTimeout(res, 200));
      }

      // Read-only inspection path — returns BEFORE any DB write or offset advance,
      // so it never disturbs the real backfill queue.
      if (args.debug === true) {
        return JSON.stringify({
          debug: true, offset, batchSize: batch.length,
          perMemory: batch.map((r, i) => ({
            id: r.id, rawLength: extractions[i].raw.length,
            entities: extractions[i].entities, parseError: extractions[i].parseError,
            rawPreview: extractions[i].raw.slice(0, 300),
          })),
        }, null, 2);
      }

      const now = Math.floor(Date.now() / 1000);
      const dbOps: any[] = [];
      for (let i = 0; i < batch.length; i++) {
        const memId = batch[i].id;
        for (const ent of extractions[i].entities) {
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
        `SELECT id, text FROM memories WHERE project = 'default' ORDER BY rowid LIMIT ? OFFSET ?`
      ).bind(BATCH, offset).all<{ id: string; text: string }>();

      const batch = rows.results ?? [];
      if (!batch.length) {
        await env.KV.delete('RETAG_OFFSET');
        const counts = await env.DB.prepare(`SELECT project, COUNT(*) as cnt FROM memories GROUP BY project ORDER BY cnt DESC`).all<{project:string;cnt:number}>();
        const summary = (counts.results ?? []).map(r => `${r.project}:${r.cnt}`).join(', ');
        return `Done. ${summary}`;
      }

      const projectList = PROJECTS.map(p => `- ${p}`).join('\n');
      const numbered = batch.map((r, i) => `${i+1}. ${r.text.slice(0, 120)}`).join('\n');
      const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct' as any, {
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

      // Same coercion as memory_build_entities above — a non-string `response` here
      // would throw before RETAG_OFFSET advances below, permanently wedging this
      // batch (see that fix's comment for why: safety/moderation-flagged content
      // can make Workers AI return a non-string response shape).
      const rawVal = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
      const raw = typeof rawVal === 'string' ? rawVal.trim() : '';
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
      return rebuildDomainsStep(args, env);
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
