-- #154 slice 5: a card belongs to the identity that published it, not to the
-- address that identity currently answers on.
--
-- Keyed by handle, a released and reassigned address would hand the next
-- owner the previous owner's published card, tasks, and caller grants. The
-- decision names that inheritance directly: remembering to clear each table
-- in a release endpoint is not an identity boundary, so ownership moves to
-- the stable subject instead.
--
-- Production had zero cards rows when this was prepared. Refuse to rebuild
-- rather than reassign published policy to a guessed owner.
DROP TABLE IF EXISTS cards_migration_guard;
CREATE TABLE cards_migration_guard (row_count INTEGER NOT NULL CHECK (row_count = 0));
INSERT INTO cards_migration_guard SELECT COUNT(*) FROM cards;
DROP TABLE cards_migration_guard;

-- A rebuild is safe here, unlike on `handles`: no foreign key references
-- `cards`, so nothing gets silently repointed at the renamed copy.
ALTER TABLE cards RENAME TO cards_by_handle;
CREATE TABLE cards (
  org TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, agent_id)
);
DROP TABLE cards_by_handle;
