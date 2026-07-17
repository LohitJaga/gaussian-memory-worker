CREATE TABLE IF NOT EXISTS domain_anchors (
  name TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  memory_count INTEGER DEFAULT 0,
  last_summarized_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT,
  sigma_diagonal TEXT,
  embedding_model_version TEXT DEFAULT 'bge-base-en-v1.5',
  timestamp INTEGER,
  last_accessed INTEGER,
  access_count INTEGER DEFAULT 0,
  memory_type TEXT DEFAULT 'episodic',
  domain TEXT DEFAULT 'general',
  cluster_id TEXT,
  emotional_intensity REAL DEFAULT 0.0,
  contradiction_flag INTEGER DEFAULT 0,
  project TEXT NOT NULL DEFAULT 'default',
  topic_key TEXT,
  revision_count INTEGER DEFAULT 0,
  valid_from INTEGER,
  valid_to INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_topic_key ON memories(topic_key) WHERE topic_key IS NOT NULL;

-- cluster_id: raw, uncapped, unnamed micro-cluster assignment — the internal
-- retrieval-mechanics signal, separate from the human-facing capped/named `domain`.
-- Added via ensureDomainColumns()'s ALTER pattern for existing deployments; declared
-- here too so fresh installs get it without a migration step.
CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id);

CREATE TABLE IF NOT EXISTS micro_clusters (
  id TEXT PRIMARY KEY,        -- same id as the centroid's MICRO_VECTORIZE vector id
  sum TEXT NOT NULL,          -- JSON number[] — mirrors cluster.ts's MicroCluster.sum
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id);

CREATE TABLE IF NOT EXISTS memory_sigma_history (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  sigma REAL NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'sharpen',
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sigma_history_memory ON memory_sigma_history(memory_id, recorded_at);

-- FTS5 keyword search (hybrid retrieval: RRF fusion with Vectorize)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  text,
  project UNINDEXED
);

-- Entity graph for 1-hop traversal at retrieve time
CREATE TABLE IF NOT EXISTS entity_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_nodes_name ON entity_nodes(canonical_name);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_span TEXT,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);

CREATE INDEX IF NOT EXISTS idx_memories_valid_to ON memories(valid_to) WHERE valid_to IS NOT NULL;

-- Quota-degraded write queue: rows land here instead of `memories` when a Workers AI daily quota
-- exhaustion (QuotaExceededError, see src/ai.ts) interrupts storeMemory's embed() call or
-- memory_extract_and_store's extraction call. Deliberately a separate table, not memories-table
-- columns (e.g. needs_reembed/needs_extraction) — a quota-degraded write skips embedding AND
-- domain classification AND merge/contradiction detection AND microcluster assignment, so a
-- placeholder row in `memories` would need every one of those systems taught to tolerate a
-- vectorless/undomained/unclustered row. A separate table instead lets the nightly
-- drainPendingIngest cron step (tools.ts) run each row through the exact same real
-- storeMemory()/memory_extract_and_store() path a live call uses, once quota resets — no
-- partial-state invariants for the rest of the system to special-case.
-- Added via ensurePendingIngestTable()'s CREATE TABLE IF NOT EXISTS (storage.ts) for existing
-- deployments; declared here too so fresh installs get it without a migration step.
CREATE TABLE IF NOT EXISTS pending_ingest (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'raw_log' | 'fact'
  payload TEXT NOT NULL,       -- raw session log text (raw_log) or a single fact's text (fact)
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT,                 -- meaningful for kind='fact' only; NULL for 'raw_log' (re-extracted fresh, domain isn't known yet)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_ingest_created ON pending_ingest(created_at);
