-- Call lifecycle evidence is delivered from each callee Durable Object through
-- an idempotent outbox. Production has no users at this migration, so rebuild
-- the constrained organization ledger instead of carrying a second event table
-- or weakening its event/actor/target invariants.
ALTER TABLE org_events RENAME TO org_events_before_call_audit;

CREATE TABLE org_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE,
  event TEXT NOT NULL CHECK (event IN (
    'org.invite.issue', 'org.invite.redeem', 'org.invite.revoke',
    'call.submit', 'call.accept', 'call.complete', 'call.fail',
    'call.cancel', 'call.timeout'
  )),
  action_type TEXT NOT NULL CHECK (action_type IN ('C', 'U')),
  org TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('handle', 'bootstrap', 'invite', 'system')),
  target_type TEXT NOT NULL CHECK (target_type IN ('invite', 'handle', 'call')),
  target_id TEXT NOT NULL,
  target_role TEXT CHECK (target_role IN ('admin', 'member')),
  actor_ip TEXT,
  actor_country TEXT,
  description TEXT NOT NULL,
  at INTEGER NOT NULL
);

INSERT INTO org_events (
  id, event, action_type, org, actor, actor_type, target_type, target_id,
  target_role, actor_ip, actor_country, description, at
)
SELECT
  id, event, action_type, org, actor, actor_type, target_type, target_id,
  target_role, actor_ip, actor_country, description, at
FROM org_events_before_call_audit;

DROP TABLE org_events_before_call_audit;
CREATE INDEX org_events_by_org ON org_events(org, at);
CREATE INDEX org_events_by_actor ON org_events(org, actor, at);
