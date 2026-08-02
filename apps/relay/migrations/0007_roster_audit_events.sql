-- Production had zero roster_events rows when this migration was prepared.
-- Refuse to rebuild the table if that precondition changes: silently dropping
-- audit evidence is never an acceptable migration strategy.
DROP TABLE IF EXISTS roster_event_migration_guard;
CREATE TABLE roster_event_migration_guard (
  row_count INTEGER NOT NULL CHECK (row_count = 0)
);
INSERT INTO roster_event_migration_guard SELECT COUNT(*) FROM roster_events;
DROP TABLE roster_event_migration_guard;

-- Only create/join/leave consume this persistent budget. Administrative
-- recovery operations remain available after exhaustion.
ALTER TABLE rosters ADD COLUMN audit_budget_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rosters ADD COLUMN audit_budget_exhausted_at INTEGER;

DROP TABLE roster_events;
CREATE TABLE roster_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (event IN (
    'roster.create', 'roster.join', 'roster.leave', 'roster.expel',
    'roster.rotate', 'roster.evict_all', 'roster.delete',
    'roster.audit_budget_exhausted'
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
