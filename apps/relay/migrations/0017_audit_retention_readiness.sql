-- Retention readiness counts are tenant- and time-bounded. The organization
-- ledger already has this access path; add the matching roster-ledger index
-- before an administrator can request exact dry-run counts.
CREATE INDEX roster_events_by_org_at ON roster_events(org, at);
