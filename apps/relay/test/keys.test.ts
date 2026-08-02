import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  encryptionKeyTranscript, exportPublicKey, generateEncryptionKeyPair,
  generateIdentityKeyPair, HPKE_SUITE, identityTranscript, keyIdFor, signTranscript,
} from "@benree/agentcall-shared";
import { registerHandle } from "./helpers.js";

// Must match the host the existing relay tests fetch, because the GET handler
// derives the record address from `new URL(c.req.url).host`. A mismatch makes
// the published address and the served address differ and the equality
// assertion below fail.
const HOST = "relay.test";

async function newIdentity(handle: string) {
  const token = await registerHandle(handle);
  const idKp = await generateIdentityKeyPair();
  const identity = {
    v: 1 as const,
    address: `${handle}@${HOST}`,
    identity_pub: await exportPublicKey(idKp.publicKey),
  };
  return { token, idKp, identity, handle };
}

function auth(handle: string, token: string) {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-AgentCall-Org": "acme",
    "X-AgentCall-Handle": handle,
  };
}

async function encRecord(who: Awaited<ReturnType<typeof newIdentity>>, epoch: number) {
  const encKp = await generateEncryptionKeyPair();
  const pub = await exportPublicKey(encKp.publicKey);
  const record = {
    v: 1 as const,
    address: `${who.handle}@${HOST}`,
    key_id: await keyIdFor(pub),
    suite: HPKE_SUITE,
    pub,
    epoch,
    not_before: 1_754_000_000_000,
    not_after: 1_754_000_000_000 + 86_400_000,
    prev: null,
  };
  const signature = await signTranscript(who.idKp.privateKey, encryptionKeyTranscript(record));
  return { record, signature };
}

describe("key publication endpoints", () => {
  it("publishes an identity key and refuses to replace it", async () => {
    const who = await newIdentity("kp-one");
    const body = JSON.stringify({ record: who.identity });

    const first = await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT", headers: auth(who.handle, who.token), body,
    });
    expect(first.status).toBe(200);

    // Re-publishing the identical key is idempotent, not a replace attempt.
    const again = await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT", headers: auth(who.handle, who.token), body,
    });
    expect(again.status).toBe(200);

    // A genuinely different key for the same identity is the actual replace
    // attempt, and that is what must be refused.
    const otherKp = await generateIdentityKeyPair();
    const second = await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT",
      headers: auth(who.handle, who.token),
      body: JSON.stringify({
        record: { ...who.identity, identity_pub: await exportPublicKey(otherKp.publicKey) },
      }),
    });
    expect(second.status).toBe(409);
  });

  it("rejects an identity record whose address is not the caller", async () => {
    const who = await newIdentity("kp-two");
    const res = await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT",
      headers: auth(who.handle, who.token),
      body: JSON.stringify({ record: { ...who.identity, address: `someone-else@${HOST}` } }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a correctly signed encryption record and returns it", async () => {
    const who = await newIdentity("kp-three");
    await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record: who.identity }),
    });
    const { record, signature } = await encRecord(who, 1);

    const put = await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record, signature }),
    });
    expect(put.status).toBe(200);

    const got = await SELF.fetch(`https://${HOST}/v1/keys/${who.handle}`, {
      headers: auth(who.handle, who.token),
    });
    expect(got.status).toBe(200);
    const json = await got.json<{ identity: unknown; encryption: { record: { epoch: number }; signature: string } }>();
    expect(json.identity).toEqual(who.identity);
    expect(json.encryption.record.epoch).toBe(1);
    expect(json.encryption.signature).toBe(signature);
  });

  it("rejects an encryption record signed by the wrong identity", async () => {
    const who = await newIdentity("kp-four");
    await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record: who.identity }),
    });
    const { record } = await encRecord(who, 1);
    const impostor = await generateIdentityKeyPair();
    const signature = await signTranscript(impostor.privateKey, encryptionKeyTranscript(record));

    const res = await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record, signature }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an epoch that does not advance", async () => {
    const who = await newIdentity("kp-five");
    await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record: who.identity }),
    });
    const first = await encRecord(who, 5);
    await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(first),
    });

    const stale = await encRecord(who, 4);
    const res = await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(stale),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for a handle with no published identity", async () => {
    const who = await newIdentity("kp-six");
    const res = await SELF.fetch(`https://${HOST}/v1/keys/nobody-here`, {
      headers: auth(who.handle, who.token),
    });
    expect(res.status).toBe(404);
  });

  it("requires authentication to read keys", async () => {
    const res = await SELF.fetch(`https://${HOST}/v1/keys/anyone`);
    expect(res.status).toBe(401);
  });
});

describe("key publication schema", () => {
  it("creates identity_keys with a composite primary key", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
    ).bind("acme", "ken", "PUB", 1).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
      ).bind("acme", "ken", "OTHER", 2).run(),
    ).rejects.toThrow();
  });

  it("allows the same handle in a different org", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_keys (org, handle, identity_pub, created_at) VALUES (?, ?, ?, ?)",
    ).bind("beta", "ken", "PUB", 1).run();
    const row = await env.DB.prepare(
      "SELECT identity_pub FROM identity_keys WHERE org = ? AND handle = ?",
    ).bind("beta", "ken").first<{ identity_pub: string }>();
    expect(row?.identity_pub).toBe("PUB");
  });

  it("rejects two encryption keys at the same epoch for one identity", async () => {
    const insert = (epoch: number) => env.DB.prepare(
      "INSERT INTO encryption_keys (org, handle, key_id, suite, pub, epoch, not_before, not_after, prev, signature, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("acme", "dup", `k${epoch}`, "SUITE", "PUB", epoch, 1, 2, null, "SIG", 1).run();

    await insert(1);
    await expect(insert(1)).rejects.toThrow();
  });
});
