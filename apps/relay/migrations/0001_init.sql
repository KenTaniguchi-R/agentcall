CREATE TABLE handles (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  agent_kind TEXT CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org, handle)
);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);
CREATE INDEX invites_org_idx ON invites (org, created_at);
