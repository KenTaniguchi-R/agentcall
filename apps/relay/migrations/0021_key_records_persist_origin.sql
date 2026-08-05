-- #345: GET /v1/keys/:handle used to reconstruct relay_origin from the live
-- request's own URL instead of the value that was actually signed at publish
-- time. Those two can disagree (self-hosted behind a reverse proxy, an
-- IP-based deployment, local dev) and the served record then fails signature
-- verification against the identity key that legitimately signed it.
--
-- Fix: store what the client submitted and signed, verbatim, and stop
-- recomputing anything on GET. address was already safe to reconstruct
-- (deterministic from org+handle, which never disagree), but it moves here
-- too so there is one code path, not two.
ALTER TABLE identity_keys ADD COLUMN relay_origin TEXT;
ALTER TABLE identity_keys ADD COLUMN address TEXT;
ALTER TABLE encryption_keys ADD COLUMN relay_origin TEXT;
ALTER TABLE encryption_keys ADD COLUMN address TEXT;

-- Backfill rows published before this migration. Every one of them was
-- published against the hosted relay's one configured route
-- (HOSTED_RELAY_HOST in packages/shared/src/protocol.ts), so this is exactly
-- the value GET has always reconstructed and served for them — it changes no
-- observed behavior for existing data, it just stops recomputing it every
-- read. Nullable rather than NOT NULL: nothing but this backfill and the PUT
-- routes ever populate these columns, so a CHECK/trigger guard is not needed.
UPDATE identity_keys
  SET relay_origin = 'agentcall.benree.tech', address = '@' || org || '/' || handle
  WHERE relay_origin IS NULL;
UPDATE encryption_keys
  SET relay_origin = 'agentcall.benree.tech', address = '@' || org || '/' || handle
  WHERE relay_origin IS NULL;
