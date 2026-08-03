-- Retention policy and legal holds must exist before any scheduled deletion
-- can consume export acknowledgements. This migration adds the control plane;
-- it deliberately does not delete audit rows or configure a cron trigger.
ALTER TABLE org_events RENAME TO org_events_before_retention_controls;

CREATE TABLE org_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE,
  event TEXT NOT NULL CHECK (event IN (
    'org.invite.issue', 'org.invite.redeem', 'org.invite.revoke',
    'call.submit', 'call.accept', 'call.complete', 'call.fail',
    'call.cancel', 'call.timeout',
    'audit.retention.update', 'audit.hold.create', 'audit.hold.release'
  )),
  action_type TEXT NOT NULL CHECK (action_type IN ('C', 'U')),
  org TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('handle', 'bootstrap', 'invite', 'system')),
  target_type TEXT NOT NULL CHECK (target_type IN ('invite', 'handle', 'call', 'retention_policy', 'legal_hold')),
  target_id TEXT NOT NULL,
  target_role TEXT CHECK (target_role IN ('admin', 'member')),
  actor_ip TEXT,
  actor_country TEXT,
  description TEXT NOT NULL,
  at INTEGER NOT NULL
);

INSERT INTO org_events (
  id, event_key, event, action_type, org, actor, actor_type, target_type,
  target_id, target_role, actor_ip, actor_country, description, at
)
SELECT
  id, event_key, event, action_type, org, actor, actor_type, target_type,
  target_id, target_role, actor_ip, actor_country, description, at
FROM org_events_before_retention_controls;

DROP TABLE org_events_before_retention_controls;
CREATE INDEX org_events_by_org ON org_events(org, at);
CREATE INDEX org_events_by_actor ON org_events(org, actor, at);

CREATE TABLE audit_retention_policies (
  org TEXT PRIMARY KEY,
  event_retention_days INTEGER NOT NULL CHECK (event_retention_days BETWEEN 30 AND 2555),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_request_id TEXT NOT NULL CHECK (length(last_request_id) BETWEEN 16 AND 64)
);

CREATE TABLE audit_retention_policy_requests (
  org TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 16 AND 64),
  requested_days INTEGER NOT NULL CHECK (requested_days BETWEEN 30 AND 2555),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
  actor TEXT NOT NULL,
  at INTEGER NOT NULL CHECK (at >= 0),
  PRIMARY KEY (org, request_id)
);

CREATE TABLE audit_legal_holds (
  org TEXT NOT NULL,
  hold_id TEXT NOT NULL CHECK (length(hold_id) = 37),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  create_request_id TEXT NOT NULL CHECK (length(create_request_id) BETWEEN 16 AND 64),
  released_by TEXT,
  released_at INTEGER CHECK (released_at >= 0),
  release_request_id TEXT CHECK (length(release_request_id) BETWEEN 16 AND 64),
  PRIMARY KEY (org, hold_id),
  UNIQUE (org, create_request_id),
  CHECK (
    (released_by IS NULL AND released_at IS NULL AND release_request_id IS NULL) OR
    (released_by IS NOT NULL AND released_at IS NOT NULL AND release_request_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX audit_legal_holds_one_active_per_org
  ON audit_legal_holds(org) WHERE released_at IS NULL;
CREATE UNIQUE INDEX audit_legal_holds_release_request_per_org
  ON audit_legal_holds(org, release_request_id) WHERE release_request_id IS NOT NULL;
