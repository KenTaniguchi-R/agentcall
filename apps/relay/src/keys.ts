import type { Context, Hono } from "hono";
import {
  EncryptionKeyRecord, IdentityRecord, encryptionKeyTranscript,
  importIdentityPublicKey, verifyTranscript,
} from "@benree/agentcall-shared";
import type { Env } from "./index.js";
import { authenticateRequest } from "./tenant.js";
import { checkLimit, NATIVE_READ } from "./ratelimit/index.js";

const NOT_FOUND = { error: "not found" } as const;

async function storedIdentity(
  c: Context<{ Bindings: Env }>, org: string, handle: string,
): Promise<string | null> {
  const row = await c.env.DB.prepare(
    "SELECT identity_pub FROM identity_keys WHERE org = ? AND handle = ?",
  ).bind(org, handle).first<{ identity_pub: string }>();
  return row?.identity_pub ?? null;
}

export function mountKeys(app: Hono<{ Bindings: Env }>): void {
  // Publish once. Replacement is refused rather than versioned: an identity key
  // a relay can swap is not a trust root.
  app.put("/v1/keys/identity", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = IdentityRecord.safeParse((body as { record?: unknown } | null)?.record);
    if (!parsed.success) return c.json({ error: "invalid record" }, 400);

    // The signed address must be the authenticated caller, or one identity
    // could publish a record claiming to be another.
    const [handle] = parsed.data.address.split("@");
    if (handle !== identity.handle) return c.json({ error: "address mismatch" }, 400);

    const existing = await storedIdentity(c, identity.org, identity.handle);
    if (existing !== null) {
      return existing === parsed.data.identity_pub
        ? c.json({ ok: true })
        : c.json({ error: "identity key already published" }, 409);
    }

    await c.env.DB.prepare(
      "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
    ).bind(identity.org, identity.handle, parsed.data.identity_pub, Date.now()).run();
    return c.json({ ok: true });
  });

  app.put("/v1/keys/encryption", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as
      { record?: unknown; signature?: unknown } | null;
    const parsed = EncryptionKeyRecord.safeParse(body?.record);
    if (!parsed.success || typeof body?.signature !== "string") {
      return c.json({ error: "invalid record" }, 400);
    }
    const [handle] = parsed.data.address.split("@");
    if (handle !== identity.handle) return c.json({ error: "address mismatch" }, 400);

    const identityPub = await storedIdentity(c, identity.org, identity.handle);
    if (identityPub === null) return c.json({ error: "publish an identity key first" }, 409);

    // The relay cannot mint these: it verifies the identity key's signature and
    // stores what it is given. It is a distributor, not an authority.
    const verified = await verifyTranscript(
      await importIdentityPublicKey(identityPub),
      encryptionKeyTranscript(parsed.data),
      body.signature,
    );
    if (!verified) return c.json({ error: "signature does not verify" }, 400);

    const highest = await c.env.DB.prepare(
      "SELECT MAX(epoch) AS epoch FROM encryption_keys WHERE org = ? AND handle = ?",
    ).bind(identity.org, identity.handle).first<{ epoch: number | null }>();
    if (highest?.epoch !== null && highest?.epoch !== undefined && parsed.data.epoch <= highest.epoch) {
      return c.json({ error: "epoch must advance" }, 409);
    }

    const r = parsed.data;
    await c.env.DB.prepare(
      "INSERT INTO encryption_keys (org, handle, key_id, suite, pub, epoch, not_before, not_after, prev, signature, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      identity.org, identity.handle, r.key_id, r.suite, r.pub, r.epoch,
      r.not_before, r.not_after, r.prev, body.signature, Date.now(),
    ).run();
    return c.json({ ok: true });
  });

  // Authenticated: key records name who talks to whom, so anonymous reads would
  // hand an unregistered scraper the whole namespace.
  app.get("/v1/keys/:handle", async (c) => {
    const identity = await authenticateRequest(c.env.DB, c.req);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await checkLimit(c.env, ip, NATIVE_READ))) return c.json({ error: "rate limited" }, 429);

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

    const address = `${target}@${new URL(c.req.url).host}`;
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
