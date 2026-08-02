-- One-time convergence from the five migrations already recorded by
-- production to the current tenant-scoped schema. Existing global handles and
-- cards are preserved under the initial "acme" tenant. There are no production
-- roster rows; fail rather than silently discard data if that precondition has
-- changed before this migration is applied.
DROP TABLE IF EXISTS roster_migration_guard;
CREATE TABLE roster_migration_guard (row_count INTEGER NOT NULL CHECK (row_count = 0));
INSERT INTO roster_migration_guard SELECT COUNT(*) FROM rosters;
INSERT INTO roster_migration_guard SELECT COUNT(*) FROM roster_members;
DROP TABLE roster_migration_guard;

ALTER TABLE handles RENAME TO handles_pre_tenancy;
CREATE TABLE handles (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  agent_kind TEXT CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org, handle)
);
INSERT INTO handles (org, handle, token_hash, agent_kind, created_at)
SELECT 'acme', handle, token_hash, agent_kind, created_at FROM handles_pre_tenancy;
DROP TABLE handles_pre_tenancy;

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

ALTER TABLE cards RENAME TO cards_pre_tenancy;
CREATE TABLE cards (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, handle)
);
INSERT INTO cards (org, handle, card_json, updated_at)
SELECT 'acme', handle, card_json, updated_at FROM cards_pre_tenancy;
DROP TABLE cards_pre_tenancy;

DROP TABLE roster_members;
DROP TABLE rosters;

CREATE TABLE rosters (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  join_secret_hash TEXT NOT NULL,
  admin_secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE roster_members (
  roster_id TEXT NOT NULL,
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (roster_id, org, handle)
);
CREATE INDEX roster_members_by_identity ON roster_members(org, handle);

CREATE TABLE roster_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_id TEXT NOT NULL,
  org TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'join', 'leave', 'expel', 'rotate', 'evict_all', 'delete')),
  actor TEXT NOT NULL,
  subject TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX roster_events_by_roster ON roster_events(roster_id, at);
