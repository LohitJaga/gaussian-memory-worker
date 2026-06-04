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
  emotional_intensity REAL DEFAULT 0.0,
  contradiction_flag INTEGER DEFAULT 0,
  project TEXT NOT NULL DEFAULT 'default',
  topic_key TEXT,
  revision_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_topic_key ON memories(topic_key) WHERE topic_key IS NOT NULL;

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
