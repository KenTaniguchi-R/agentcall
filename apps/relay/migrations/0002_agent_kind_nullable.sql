-- Caller-only handles register without an agent_kind; make the column nullable.
CREATE TABLE handles_new (
  handle TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  agent_kind TEXT CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL
);
INSERT INTO handles_new SELECT handle, token_hash, agent_kind, created_at FROM handles;
DROP TABLE handles;
ALTER TABLE handles_new RENAME TO handles;
