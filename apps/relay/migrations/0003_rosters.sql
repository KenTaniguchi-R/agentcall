-- A roster is a named set of handles that can discover each other via
-- `agentcall search`. There is deliberately no owner column: see the design
-- spec's "The honest tradeoff" — a single owner_handle creates a dead-owner
-- failure mode, because `uninstall --purge` destroys local credentials while
-- handle release is deliberately unimplemented.
CREATE TABLE rosters (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
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
