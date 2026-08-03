-- Add an explicit audit event for administrator-authorized budget recovery
-- while preserving every existing roster event and its stable id.
CREATE TABLE roster_events_recovered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (event IN (
    'roster.create', 'roster.join', 'roster.leave', 'roster.expel',
    'roster.join_key.issue', 'roster.join_key.revoke', 'roster.join_key.evict',
    'roster.delete', 'roster.audit_budget_exhausted', 'roster.audit_budget_reset'
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

INSERT INTO roster_events_recovered (
  id, event, action_type, roster_id, org, actor, actor_type, target_type,
  target_id, actor_ip, actor_country, description, at
)
SELECT
  id, event, action_type, roster_id, org, actor, actor_type, target_type,
  target_id, actor_ip, actor_country, description, at
FROM roster_events;

DROP TABLE roster_events;
ALTER TABLE roster_events_recovered RENAME TO roster_events;
CREATE INDEX roster_events_by_roster ON roster_events(roster_id, at);
CREATE INDEX roster_events_by_actor ON roster_events(org, actor, at);
