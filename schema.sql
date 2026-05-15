CREATE TABLE IF NOT EXISTS domain_anchors (
  name TEXT PRIMARY KEY,
  embedding TEXT NOT NULL
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
  contradiction_flag INTEGER DEFAULT 0
);
