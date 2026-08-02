CREATE TABLE handles (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  agent_kind TEXT CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org, handle)
);
