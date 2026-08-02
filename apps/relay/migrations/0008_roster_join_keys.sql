-- Production had zero rosters, members, and roster audit events when this
-- zero-user credential-model replacement was prepared. Refuse to rebuild if
-- that precondition changes rather than losing membership or audit evidence.
DROP TABLE IF EXISTS roster_join_key_migration_guard;
CREATE TABLE roster_join_key_migration_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO roster_join_key_migration_guard SELECT COUNT(*) FROM rosters;
INSERT INTO roster_join_key_migration_guard SELECT COUNT(*) FROM roster_members;
INSERT INTO roster_join_key_migration_guard SELECT COUNT(*) FROM roster_events;
DROP TABLE roster_join_key_migration_guard;

DROP TABLE roster_members;
DROP TABLE rosters;

CREATE TABLE rosters (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  admin_secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  audit_budget_used INTEGER NOT NULL DEFAULT 0,
  audit_budget_exhausted_at INTEGER
);

-- Prefix is public identity and lookup material. Only the high-entropy secret
-- half is hashed; the full agjk_ credential is returned once and never stored.
CREATE TABLE roster_join_keys (
  prefix TEXT PRIMARY KEY CHECK (length(prefix) = 12 AND prefix NOT GLOB '*[^0-9a-f]*'),
  roster_id TEXT NOT NULL,
  org TEXT NOT NULL,
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  description TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reusable INTEGER NOT NULL CHECK (reusable IN (0, 1)),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  revoked_at INTEGER
);
CREATE INDEX roster_join_keys_by_roster ON roster_join_keys(roster_id, org, created_at);

CREATE TABLE roster_members (
  roster_id TEXT NOT NULL,
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  joined_via_prefix TEXT,
  PRIMARY KEY (roster_id, org, handle)
);
CREATE INDEX roster_members_by_identity ON roster_members(org, handle);
CREATE INDEX roster_members_by_join_key ON roster_members(roster_id, org, joined_via_prefix);

DROP TABLE roster_events;
CREATE TABLE roster_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (event IN (
    'roster.create', 'roster.join', 'roster.leave', 'roster.expel',
    'roster.join_key.issue', 'roster.join_key.revoke', 'roster.join_key.evict',
    'roster.delete', 'roster.audit_budget_exhausted'
  )),
  action_type TEXT NOT NULL CHECK (action_type IN ('C', 'R', 'U', 'D')),
  roster_id TEXT NOT NULL,
  org TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('handle', 'admin_secret', 'system')),
  target_type TEXT CHECK (target_type IN ('handle', 'roster', 'join_key')),
  target_id TEXT,
  actor_ip TEXT,
  actor_country TEXT,
  description TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX roster_events_by_roster ON roster_events(roster_id, at);
CREATE INDEX roster_events_by_actor ON roster_events(org, actor, at);
