CREATE TABLE handles (
  handle TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL
);
