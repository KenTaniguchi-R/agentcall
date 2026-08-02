ALTER TABLE invites ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE invites ADD COLUMN revoked_at INTEGER;

CREATE INDEX invites_by_org_lifecycle
ON invites(org, revoked_at, used_at, expires_at, created_at);

-- Organization events stay separate from roster_events: an organization
-- mutation has no honest roster_id, and weakening that table's NOT NULL scope
-- would make the existing roster audit contract ambiguous. Runtime mutations
-- retain a rolling maximum of 10,000 rows per organization.
CREATE TABLE org_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (event IN (
    'org.invite.issue', 'org.invite.redeem', 'org.invite.revoke'
  )),
  action_type TEXT NOT NULL CHECK (action_type IN ('C', 'U')),
  org TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('handle', 'bootstrap', 'invite')),
  target_type TEXT NOT NULL CHECK (target_type IN ('invite', 'handle')),
  target_id TEXT NOT NULL,
  actor_ip TEXT,
  actor_country TEXT,
  description TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX org_events_by_org ON org_events(org, at);
CREATE INDEX org_events_by_actor ON org_events(org, actor, at);
