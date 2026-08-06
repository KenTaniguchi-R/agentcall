-- #154 slice 6: roster membership belongs to the identity that joined, not to
-- the address it joined under.
--
-- Membership was the last authorization subject still keyed by (org, handle)
-- after slices 4 and 5 moved Durable Object naming and cards. It is the one
-- that transfers most quietly: `sharedRosterIds` turns membership into the
-- group grants that drive call admission and card projection, so a reclaimed
-- address inherited the previous owner's audience without any row being
-- rewritten.
--
-- `handle` is NOT carried over as a display snapshot. Every reader that needs
-- an address already joins `handles` (the bundle did so before this change),
-- and joining on agent_id yields the CURRENT address rather than one frozen at
-- join time. A snapshot here would only be a second, staler answer to a
-- question storage can already answer correctly. `roster_events` keeps its
-- handle actor/subject, which are genuine event-time snapshots — moving those
-- onto identity is audit-subject work and belongs to a later slice.

-- Same zero-user guard as 0019, for the same reason the spec gives: a non-empty
-- table must stop the cutover rather than have the migration invent identity
-- continuity from a handle. There is no correct backfill here — mapping a
-- membership row to today's holder of its address is exactly the transfer this
-- slice exists to make impossible.
DROP TABLE IF EXISTS roster_members_identity_migration_guard;
CREATE TABLE roster_members_identity_migration_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO roster_members_identity_migration_guard SELECT COUNT(*) FROM roster_members;
DROP TABLE roster_members_identity_migration_guard;

-- Rebuild rather than ADD COLUMN. 0019 chose ADD COLUMN for `handles` because
-- two foreign keys pointed at handles(org, handle) and a rebuild would have
-- silently repointed them at the discarded copy. Nothing references
-- roster_members, so the rebuild is safe here — and it is what lets agent_id be
-- NOT NULL in the column definition instead of enforced by a pair of triggers.
DROP INDEX IF EXISTS roster_members_by_identity;
DROP INDEX IF EXISTS roster_members_by_join_key;
DROP TABLE roster_members;

CREATE TABLE roster_members (
  roster_id TEXT NOT NULL,
  org TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  -- Which join key admitted this member, for prefix-scoped eviction. Unchanged
  -- by this slice; it names a credential, not a principal.
  joined_via_prefix TEXT,
  PRIMARY KEY (roster_id, org, agent_id)
);

-- Now genuinely by identity. 0006 already named an index
-- `roster_members_by_identity` while keying it (org, handle) — aspirational at
-- the time, accurate now.
CREATE INDEX roster_members_by_identity ON roster_members(org, agent_id);
-- Recreated verbatim from 0008: prefix-scoped eviction scans by join key, and
-- dropping the table drops its indexes with it.
CREATE INDEX roster_members_by_join_key ON roster_members(roster_id, org, joined_via_prefix);
