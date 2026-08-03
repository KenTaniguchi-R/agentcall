-- A retention job must never infer that an export happened merely because an
-- administrator requested pages. This tenant-level watermark records an
-- explicit acknowledgement of a server-signed, terminal full-ledger export.
CREATE TABLE audit_export_acknowledgements (
  org TEXT PRIMARY KEY,
  org_event_id INTEGER NOT NULL CHECK (org_event_id >= 0),
  org_event_count INTEGER NOT NULL CHECK (org_event_count >= 0),
  roster_event_id INTEGER NOT NULL CHECK (roster_event_id >= 0),
  roster_event_count INTEGER NOT NULL CHECK (roster_event_count >= 0),
  acknowledged_by TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL CHECK (acknowledged_at >= 0)
);
