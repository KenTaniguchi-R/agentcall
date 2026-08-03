-- 0005 added the first recovery columns, but 0006's tenant-table rebuild did
-- not copy them. Reintroduce them on the current org-scoped table together
-- with the generation required by the v2 protocol.
ALTER TABLE handles ADD COLUMN recovery_hash TEXT;
ALTER TABLE handles ADD COLUMN recovery_redeemed_at INTEGER;
ALTER TABLE handles ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE org_events RENAME TO org_events_before_recovery;
CREATE TABLE org_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE,
  event TEXT NOT NULL CHECK (event IN (
    'org.invite.issue', 'org.invite.redeem', 'org.invite.revoke',
    'call.submit', 'call.accept', 'call.complete', 'call.fail',
    'call.cancel', 'call.timeout',
    'audit.retention.update', 'audit.hold.create', 'audit.hold.release',
    'credential.recovery.issue', 'credential.recovery.redeem'
  )),
  action_type TEXT NOT NULL CHECK (action_type IN ('C', 'U')),
  org TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('handle', 'bootstrap', 'invite', 'system', 'recovery')),
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
FROM org_events_before_recovery;
DROP TABLE org_events_before_recovery;
CREATE INDEX org_events_by_org ON org_events(org, at);
CREATE INDEX org_events_by_actor ON org_events(org, actor, at);

CREATE TABLE recovery_receipts (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  consumed_generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  consumed_recovery_hash TEXT NOT NULL,
  client_token_hash TEXT NOT NULL,
  client_public_id TEXT NOT NULL,
  successor_recovery_hash TEXT NOT NULL,
  successor_recovery_public_id TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (org, handle, consumed_generation, operation_id),
  FOREIGN KEY (org, handle) REFERENCES handles(org, handle) ON DELETE CASCADE
);

CREATE INDEX recovery_receipts_expiry ON recovery_receipts(expires_at);

CREATE TABLE recovery_evictions (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  recovery_generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  last_attempt INTEGER,
  PRIMARY KEY (org, handle),
  FOREIGN KEY (org, handle) REFERENCES handles(org, handle) ON DELETE CASCADE
);
CREATE INDEX recovery_evictions_due ON recovery_evictions(next_attempt);
