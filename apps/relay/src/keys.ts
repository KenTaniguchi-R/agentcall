import type { Context, Hono } from "hono";
import {
  EncryptionKeyRecord, IdentityRecord, encryptionKeyTranscript, identityTranscript,
  importIdentityPublicKey, verifyTranscript,
} from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { registrationAddressHost } from "./tenant.js";
import { NATIVE_CARD, NATIVE_READ } from "./ratelimit/index.js";
import { rateLimit, type RelayAppEnv } from "./middleware.js";

const NOT_FOUND = { error: "not found" } as const;

async function storedIdentity(
  c: Context<RelayAppEnv>, org: string, handle: string,
): Promise<string | null> {
  const row = await c.env.DB.prepare(
    "SELECT identity_pub FROM identity_keys WHERE org = ? AND handle = ?",
  ).bind(org, handle).first<{ identity_pub: string }>();
  return row?.identity_pub ?? null;
}

/**
 * The one definition of an identity's address, shared by publication and by
 * service. `POST /v1/register` returns exactly this string, so it is the only
 * address a CLI has ever seen — deriving it any other way here would sign one
 * address and serve another, and these records are permanent.
 */
function addressFor(c: Context<RelayAppEnv>, org: string, handle: string): string {
  return `${handle}@${registrationAddressHost(org, c.req.url)}`;
}

export function mountKeys(app: Hono<RelayAppEnv>): void {
  // Publish once. Replacement is refused rather than versioned: an identity key
  // a relay can swap is not a trust root.
  app.put("/v1/keys/identity", rateLimit(NATIVE_CARD, "identity"), async (c) => {
    const identity = c.var.identity;
    const body = await c.req.json().catch(() => null) as
      { record?: unknown; signature?: unknown } | null;
    const parsed = IdentityRecord.safeParse(body?.record);
    if (!parsed.success || typeof body?.signature !== "string") {
      return c.json({ error: "invalid record" }, 400);
    }

    // The whole signed address must be the authenticated caller's, host
    // included. Checking only the local part would accept a record naming a
    // foreign relay, which the GET below would then serve rewritten to this
    // host — a record whose signature can never verify again.
    if (parsed.data.address !== addressFor(c, identity.org, identity.handle)) {
      return c.json({ error: "address mismatch" }, 400);
    }

    // Self-signature: proves the publisher holds the private half, and forces
    // the key through a real P-256 import now rather than at the first
    // encryption publish, where an unusable key would be stuck forever because
    // an identity key cannot be replaced.
    let publisherKey: CryptoKey;
    try {
      publisherKey = await importIdentityPublicKey(parsed.data.identity_pub);
    } catch {
      return c.json({ error: "identity_pub is not a P-256 public key" }, 400);
    }
    const selfSigned = await verifyTranscript(
      publisherKey, identityTranscript(parsed.data), body.signature,
    );
    if (!selfSigned) return c.json({ error: "signature does not verify" }, 400);

    // One statement, not SELECT-then-INSERT: two concurrent publishes from the
    // same identity would otherwise both see "no row" and the loser would hit
    // the composite primary key and 500 instead of getting an answer.
    const inserted = await c.env.DB.prepare(
      "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(org, handle) DO NOTHING",
    ).bind(identity.org, identity.handle, parsed.data.identity_pub, Date.now()).run();
    if ((inserted.meta.changes ?? 0) === 1) return c.json({ ok: true });

    // Something was already there. Re-publishing the identical key is
    // idempotent — a CLI retrying after a network timeout must not hard-fail.
    const existing = await storedIdentity(c, identity.org, identity.handle);
    return existing === parsed.data.identity_pub
      ? c.json({ ok: true })
      : c.json({ error: "identity key already published" }, 409);
  });

  app.put("/v1/keys/encryption", rateLimit(NATIVE_CARD, "identity"), async (c) => {
    const identity = c.var.identity;
    const body = await c.req.json().catch(() => null) as
      { record?: unknown; signature?: unknown } | null;
    const parsed = EncryptionKeyRecord.safeParse(body?.record);
    if (!parsed.success || typeof body?.signature !== "string") {
      return c.json({ error: "invalid record" }, 400);
    }
    if (parsed.data.address !== addressFor(c, identity.org, identity.handle)) {
      return c.json({ error: "address mismatch" }, 400);
    }

    const identityPub = await storedIdentity(c, identity.org, identity.handle);
    if (identityPub === null) return c.json({ error: "publish an identity key first" }, 409);

    // The identity PUT validates the key before storing it, so this should not
    // fail. Guarded anyway: a row that predates that check, or arrives by any
    // other route, must not make every future publish for this handle throw.
    let identityKey: CryptoKey;
    try {
      identityKey = await importIdentityPublicKey(identityPub);
    } catch {
      return c.json({ error: "stored identity key is unusable" }, 409);
    }

    // The relay cannot mint these: it verifies the identity key's signature and
    // stores what it is given. It is a distributor, not an authority.
    const verified = await verifyTranscript(
      identityKey, encryptionKeyTranscript(parsed.data), body.signature,
    );
    if (!verified) return c.json({ error: "signature does not verify" }, 400);

    // Monotonicity is enforced by SQLite inside the INSERT, not by a Worker
    // read a concurrent publish can straddle: two racing rotations would both
    // read the same MAX(epoch) and the loser would collide with the composite
    // primary key, turning a 409 into a 500.
    const r = parsed.data;
    const inserted = await c.env.DB.prepare(
      "INSERT INTO encryption_keys (org, handle, key_id, suite, pub, epoch, not_before, not_after, prev, signature, created_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (" +
        "SELECT 1 FROM encryption_keys WHERE org = ? AND handle = ? AND epoch >= ?)",
    ).bind(
      identity.org, identity.handle, r.key_id, r.suite, r.pub, r.epoch,
      r.not_before, r.not_after, r.prev, body.signature, Date.now(),
      identity.org, identity.handle, r.epoch,
    ).run();
    if ((inserted.meta.changes ?? 0) !== 1) {
      // A client can lose the HTTP response after D1 committed. Permit only a
      // byte-identical retry of that signed epoch; a different key/record at
      // the same or an older epoch remains a conflict.
      const existing = await c.env.DB.prepare(
        "SELECT key_id, suite, pub, epoch, not_before, not_after, prev, signature " +
          "FROM encryption_keys WHERE org = ? AND handle = ? AND epoch = ? " +
          "AND epoch = (SELECT MAX(epoch) FROM encryption_keys WHERE org = ? AND handle = ?)",
      ).bind(
        identity.org, identity.handle, r.epoch, identity.org, identity.handle,
      ).first<{
        key_id: string; suite: string; pub: string; epoch: number;
        not_before: number; not_after: number; prev: string | null; signature: string;
      }>();
      if (
        existing && existing.key_id === r.key_id && existing.suite === r.suite &&
        existing.pub === r.pub && existing.epoch === r.epoch &&
        existing.not_before === r.not_before && existing.not_after === r.not_after &&
        existing.prev === r.prev && existing.signature === body.signature
      ) {
        return c.json({ ok: true });
      }
      return c.json({ error: "epoch must advance" }, 409);
    }
    return c.json({ ok: true });
  });

  // Authenticated: key records name who talks to whom, so anonymous reads would
  // hand an unregistered scraper the whole namespace.
  app.get("/v1/keys/:handle", rateLimit(NATIVE_READ, "ip"), async (c) => {
    const identity = c.var.identity;

    const target = c.req.param("handle");
    const identityPub = await storedIdentity(c, identity.org, target);
    if (identityPub === null) return c.json(NOT_FOUND, 404);

    const row = await c.env.DB.prepare(
      "SELECT key_id, suite, pub, epoch, not_before, not_after, prev, signature " +
        "FROM encryption_keys WHERE org = ? AND handle = ? ORDER BY epoch DESC LIMIT 1",
    ).bind(identity.org, target).first<{
      key_id: string; suite: string; pub: string; epoch: number;
      not_before: number; not_after: number; prev: string | null; signature: string;
    }>();
    if (!row) return c.json(NOT_FOUND, 404);

    // Reconstructed, not stored — but reconstructed by the same function the
    // PUT routes checked the signed address against, so it is byte-identical to
    // what was signed. (Stage 1B persists the record verbatim and stops
    // reconstructing at all.)
    const address = addressFor(c, identity.org, target);
    return c.json({
      identity: { v: 1, address, identity_pub: identityPub },
      encryption: {
        record: {
          v: 1, address, key_id: row.key_id, suite: row.suite, pub: row.pub,
          epoch: row.epoch, not_before: row.not_before, not_after: row.not_after, prev: row.prev,
        },
        signature: row.signature,
      },
    });
  });
}
