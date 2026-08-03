-- The identity key is the trust root contacts pin. One per identity, and the
-- relay refuses to replace it: a replaceable identity key would let the relay
-- silently re-point a pinned relationship, which is the attack this whole
-- design exists to prevent. Losing it means registering a new identity.
CREATE TABLE identity_keys (
  org           TEXT NOT NULL,
  handle        TEXT NOT NULL,
  identity_pub  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (org, handle)
);

-- Encryption keys rotate. Each record is signed by the identity key above, and
-- `epoch` is monotonic per identity so a relay cannot roll a client back to an
-- older, compromised, but still validly signed key.
CREATE TABLE encryption_keys (
  org         TEXT NOT NULL,
  handle      TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  suite       TEXT NOT NULL,
  pub         TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  not_before  INTEGER NOT NULL,
  not_after   INTEGER NOT NULL,
  prev        TEXT,
  signature   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org, handle, epoch)
);
CREATE INDEX encryption_keys_current ON encryption_keys(org, handle, epoch DESC);
