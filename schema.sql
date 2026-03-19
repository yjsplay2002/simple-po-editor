CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lock_owner_id TEXT,
  lock_owner_name TEXT,
  lock_expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
