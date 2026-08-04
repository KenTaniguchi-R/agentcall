-- First slice of the identity/address separation (#154, #319).
--
-- Adds the stable, opaque agent_id that later slices move Durable Object
-- naming, cards, roster membership, policy, and audit subjects onto. Nothing
-- reads it yet: this migration is additive and changes no behaviour.
--
-- Production had zero handles rows when this was prepared, and the spec is
-- explicit that a non-empty table must stop the cutover rather than have the
-- migration invent identity continuity from a handle. Guard it the way 0006,
-- 0007, and 0008 guard their rebuilds. `handles` has never carried one.
DROP TABLE IF EXISTS handle_identity_migration_guard;
CREATE TABLE handle_identity_migration_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO handle_identity_migration_guard SELECT COUNT(*) FROM handles;
DROP TABLE handle_identity_migration_guard;

-- ADD COLUMN, deliberately, rather than the rename-and-rebuild that 0006 and
-- 0018 use elsewhere. 0018 added two foreign keys pointing at
-- handles(org, handle) -- recovery_receipts and recovery_evictions. Modern
-- SQLite rewrites references to follow an ALTER TABLE ... RENAME, so
-- rebuilding this table would silently repoint both at the discarded copy.
-- 0006 is also the cautionary case for a rebuild here: it dropped the
-- recovery columns 0005 had added, and 0018 had to restore them.
ALTER TABLE handles ADD COLUMN agent_id TEXT;

-- At most one identity per address, and the address is not part of the
-- identity: uniqueness is scoped by org so two organizations may hold the
-- same handle without sharing one.
CREATE UNIQUE INDEX handles_agent_id ON handles(org, agent_id);

-- ADD COLUMN cannot express NOT NULL without a DEFAULT, and a default would
-- be a fabricated identity -- exactly what the guard above refuses. SQLite
-- also treats NULLs as distinct in a UNIQUE index, so the index alone would
-- let unpopulated rows accumulate.
--
-- Enforce it at the storage boundary instead of trusting every future INSERT
-- to remember. That is the decision's own argument: "Remembering to clean
-- each table and object in the release endpoint is not an identity boundary."
-- Relying on call sites is the failure mode this whole cutover exists to end.
-- A later slice rebuilds this table for address bindings and can fold the
-- constraint into the column definition, retiring both triggers.
CREATE TRIGGER handles_agent_id_required_on_insert
BEFORE INSERT ON handles
WHEN NEW.agent_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'handles.agent_id is required');
END;

CREATE TRIGGER handles_agent_id_immutable
BEFORE UPDATE OF agent_id ON handles
WHEN NEW.agent_id IS NOT OLD.agent_id
BEGIN
  SELECT RAISE(ABORT, 'handles.agent_id is immutable');
END;
