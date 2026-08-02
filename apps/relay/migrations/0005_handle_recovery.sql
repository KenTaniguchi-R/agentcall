-- A second, out-of-band credential that can authenticate a token rotation
-- when the token itself is gone. Nullable on purpose: every handle
-- registered before this migration has no code, and `recovery_hash IS NULL`
-- is the state `agentcall doctor` reports so an existing owner can mint one
-- while they still hold their token. That nullability is also the trap —
-- redeem MUST reject NULL explicitly before any hash comparison.
ALTER TABLE handles ADD COLUMN recovery_hash TEXT;
ALTER TABLE handles ADD COLUMN recovery_redeemed_at INTEGER;
