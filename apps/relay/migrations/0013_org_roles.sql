-- Organization-wide audit exports contain source IP and relationship data.
-- Make the authorization boundary explicit before that surface exists.
ALTER TABLE handles ADD COLUMN org_role TEXT NOT NULL DEFAULT 'member'
  CHECK (org_role IN ('admin', 'member'));
ALTER TABLE invites ADD COLUMN org_role TEXT NOT NULL DEFAULT 'member'
  CHECK (org_role IN ('admin', 'member'));
ALTER TABLE org_events ADD COLUMN target_role TEXT
  CHECK (target_role IN ('admin', 'member'));

-- Existing handles become members. An operator must deliberately bootstrap an
-- administrator; access to IP-bearing organization evidence is never granted
-- merely because a handle existed before roles did.
-- Operator-created bootstrap invites enroll the first organization admin.
UPDATE invites SET org_role = 'admin' WHERE created_by IS NULL;
