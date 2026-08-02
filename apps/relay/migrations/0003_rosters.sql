-- A roster is a named set of handles that can discover each other via
-- `agentcall search`. There is deliberately no owner column: see the design
-- spec's "The honest tradeoff" — a single owner_handle creates a dead-owner
-- failure mode, because `uninstall --purge` destroys local credentials while
-- handle release is deliberately unimplemented.
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

-- Supports "which rosters does this identity belong to", which membership
-- checks and any future cleanup need; the PK only indexes the other direction.
CREATE INDEX roster_members_by_identity ON roster_members(org, handle);

-- Append-only evidence. Deliberately has no foreign key: lifecycle events
-- survive roster teardown even though the live roster and membership rows do
-- not. There is no public read surface; this is relay-side audit material.
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
