import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  encryptionKeyTranscript, exportPublicKey, generateEncryptionKeyPair,
  generateIdentityKeyPair, HPKE_SUITE, identityTranscript, keyIdFor, signTranscript,
} from "@benree/agentcall-shared";
import app from "../src/index.js";
import { fixedRateLimit, registerHandle } from "./helpers.js";

// The address in a record is `handle@registrationAddressHost(org, url)`, and
// registrationAddressHost returns the request hostname unchanged for any host
// that is not the hosted relay. So for these tests the address host is exactly
// the host fetched below — which is the whole point: publication and service
// derive it the same way.
const HOST = "relay.test";

async function newIdentity(handle: string) {
  const token = await registerHandle(handle);
  const idKp = await generateIdentityKeyPair();
  const record = {
    v: 1 as const,
    relay_origin: HOST,
    address: `@acme/${handle}`,
    identity_pub: await exportPublicKey(idKp.publicKey),
  };
  const signature = await signTranscript(idKp.privateKey, identityTranscript(record));
  return { token, idKp, identity: record, identityBody: { record, signature }, handle };
}

function auth(handle: string, token: string) {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-AgentCall-Org": "acme",
    "X-AgentCall-Handle": handle,
  };
}

function putIdentity(who: { handle: string; token: string; identityBody: unknown }, body?: unknown) {
  return SELF.fetch(`https://${HOST}/v1/keys/identity`, {
    method: "PUT",
    headers: auth(who.handle, who.token),
    body: JSON.stringify(body ?? who.identityBody),
  });
}

async function encRecord(who: Awaited<ReturnType<typeof newIdentity>>, epoch: number, address?: string) {
  const encKp = await generateEncryptionKeyPair();
  const pub = await exportPublicKey(encKp.publicKey);
  const record = {
    v: 1 as const,
    relay_origin: HOST,
    address: address ?? `@acme/${who.handle}`,
    key_id: await keyIdFor(pub),
    suite: HPKE_SUITE,
    pub,
    epoch,
    not_before: 1_754_000_000_000,
    not_after: 1_754_000_000_000 + 86_400_000,
    prev: epoch === 1 ? null : "a".repeat(32),
  };
  const signature = await signTranscript(who.idKp.privateKey, encryptionKeyTranscript(record));
  return { record, signature };
}

describe("key publication endpoints", () => {
  it("publishes an identity key and refuses to replace it", async () => {
    const who = await newIdentity("kp-one");

    expect((await putIdentity(who)).status).toBe(200);

    // Re-publishing the identical key is idempotent, not a replace attempt.
    expect((await putIdentity(who)).status).toBe(200);

    // A genuinely different key for the same identity is the actual replace
    // attempt, and that is what must be refused.
    const otherKp = await generateIdentityKeyPair();
    const otherRecord = { ...who.identity, identity_pub: await exportPublicKey(otherKp.publicKey) };
    const second = await putIdentity(who, {
      record: otherRecord,
      signature: await signTranscript(otherKp.privateKey, identityTranscript(otherRecord)),
    });
    expect(second.status).toBe(409);
  });

  it("rejects an identity record whose address is not the caller", async () => {
    const who = await newIdentity("kp-two");
    const record = { ...who.identity, address: "@acme/someone-else" };
    const res = await putIdentity(who, {
      record, signature: await signTranscript(who.idKp.privateKey, identityTranscript(record)),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an identity record naming a different relay host", async () => {
    // The host is signed so a record cannot be lifted from one relay to
    // another. Accepting this would store a record whose address the GET below
    // rewrites to this host — permanently unverifiable against its signature.
    const who = await newIdentity("kp-foreign-id");
    const record = { ...who.identity, address: `@evil/${who.handle}` };
    const res = await putIdentity(who, {
      record, signature: await signTranscript(who.idKp.privateKey, identityTranscript(record)),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an identity record with no self-signature", async () => {
    const who = await newIdentity("kp-nosig");
    expect((await putIdentity(who, { record: who.identity })).status).toBe(400);
  });

  it("rejects an identity record signed by a different key than it publishes", async () => {
    const who = await newIdentity("kp-wrongsig");
    const impostor = await generateIdentityKeyPair();
    const res = await putIdentity(who, {
      record: who.identity,
      signature: await signTranscript(impostor.privateKey, identityTranscript(who.identity)),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an identity_pub that is not a P-256 public key", async () => {
    // "AAAA" passes the base64url shape check but is not a point. Storing it
    // would make every later encryption publish fail on import, forever, since
    // an identity key cannot be replaced.
    const who = await newIdentity("kp-badpoint");
    const record = { ...who.identity, identity_pub: "AAAA" };
    const res = await putIdentity(who, {
      record, signature: await signTranscript(who.idKp.privateKey, identityTranscript(record)),
    });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare(
      "SELECT identity_pub FROM identity_keys WHERE org = ? AND handle = ?",
    ).bind("acme", who.handle).first();
    expect(row).toBeNull();
  });

  it("accepts a correctly signed encryption record and returns it", async () => {
    const who = await newIdentity("kp-three");
    await putIdentity(who);
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

  it("accepts an exact equal-epoch retry after the original response is lost", async () => {
    const who = await newIdentity("kp-retry");
    await putIdentity(who);
    const publication = await encRecord(who, 1);
    const put = () => SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(publication),
    });
    expect((await put()).status).toBe(200);
    // Treat the first response as lost: the client sends the exact signed body
    // again and must receive success rather than becoming permanently wedged.
    expect((await put()).status).toBe(200);

    const secondBase = await encRecord(who, 2);
    const secondRecord = { ...secondBase.record, prev: "a".repeat(32) };
    const second = {
      record: secondRecord,
      signature: await signTranscript(who.idKp.privateKey, encryptionKeyTranscript(secondRecord)),
    };
    expect((await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(second),
    })).status).toBe(200);
    // Idempotency applies only to the latest committed epoch. A rolled-back
    // client cannot treat an exact old record as current after the chain moved.
    expect((await put()).status).toBe(409);
  });

  it("serves the exact address that was signed", async () => {
    // The served address is reconstructed, not stored. If publication and
    // service ever derive it differently — org prefix, port, hostname vs host —
    // the signature over the record stops verifying and the record, which is
    // permanent, becomes worthless. Byte equality is the whole assertion.
    const who = await newIdentity("kp-served");
    await putIdentity(who);
    const { record, signature } = await encRecord(who, 1);
    await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record, signature }),
    });

    const got = await SELF.fetch(`https://${HOST}/v1/keys/${who.handle}`, {
      headers: auth(who.handle, who.token),
    });
    const json = await got.json<{
      identity: { address: string }; encryption: { record: { address: string } };
    }>();

    expect(json.identity.address).toBe(who.identity.address);
    expect(json.encryption.record.address).toBe(record.address);
    expect(json.identity.address).toBe(json.encryption.record.address);
  });

  it("serves the org-prefixed apex address, not URL.host verbatim (regression)", async () => {
    // Was: the served address must be org-prefixed rather than URL.host
    // verbatim. Addresses no longer contain a host at all, so the stronger
    // invariant this becomes is that the served address does not vary with the
    // request URL — the apex, a port, or a subdomain all yield `@acme/<handle>`.
    const APEX = "agentcall.benree.tech";
    const handle = "kp-apex2";
    const address = `@acme/${handle}`;
    const token = await registerHandle(handle);
    const idKp = await generateIdentityKeyPair();
    const identity = {
      v: 1 as const, relay_origin: HOST,
      address, identity_pub: await exportPublicKey(idKp.publicKey),
    };
    const headers = {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-AgentCall-Org": "acme",
      "X-AgentCall-Handle": handle,
    };

    const putId = await SELF.fetch(`https://${APEX}/v1/keys/identity`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        record: identity,
        signature: await signTranscript(idKp.privateKey, identityTranscript(identity)),
      }),
    });
    expect(putId.status).toBe(200);

    const encKp = await generateEncryptionKeyPair();
    const pub = await exportPublicKey(encKp.publicKey);
    const encryption = {
      v: 1 as const,
      relay_origin: HOST,
      address,
      key_id: await keyIdFor(pub),
      suite: HPKE_SUITE,
      pub,
      epoch: 1,
      not_before: 1_754_000_000_000,
      not_after: 1_754_000_000_000 + 86_400_000,
      prev: null,
    };
    const putEnc = await SELF.fetch(`https://${APEX}/v1/keys/encryption`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        record: encryption,
        signature: await signTranscript(idKp.privateKey, encryptionKeyTranscript(encryption)),
      }),
    });
    expect(putEnc.status).toBe(200);

    const got = await SELF.fetch(`https://${APEX}/v1/keys/${handle}`, { headers });
    expect(got.status).toBe(200);
    const json = await got.json<{
      identity: { address: string }; encryption: { record: { address: string } };
    }>();
    expect(json.identity.address).toBe(address);
    expect(json.encryption.record.address).toBe(address);
  });

  it("serves the org-prefixed apex address when the request URL carries a port (regression)", async () => {
    // registrationAddressHost derives the address from URL.hostname (no
    // port); the reverted bug used URL.host, which includes a port when one
    // is present. relay.test and the bare-apex test above never carry a port,
    // so neither exercises this half of the divergence.
    const APEX = "agentcall.benree.tech";
    const handle = "kp-apex-port";
    const address = `@acme/${handle}`;
    const origin = `https://${APEX}:8443`;
    const token = await registerHandle(handle);
    const idKp = await generateIdentityKeyPair();
    const identity = {
      v: 1 as const, relay_origin: HOST,
      address, identity_pub: await exportPublicKey(idKp.publicKey),
    };
    const headers = {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-AgentCall-Org": "acme",
      "X-AgentCall-Handle": handle,
    };

    const putId = await SELF.fetch(`${origin}/v1/keys/identity`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        record: identity,
        signature: await signTranscript(idKp.privateKey, identityTranscript(identity)),
      }),
    });
    expect(putId.status).toBe(200);

    const encKp = await generateEncryptionKeyPair();
    const pub = await exportPublicKey(encKp.publicKey);
    const encryption = {
      v: 1 as const,
      relay_origin: HOST,
      address,
      key_id: await keyIdFor(pub),
      suite: HPKE_SUITE,
      pub,
      epoch: 1,
      not_before: 1_754_000_000_000,
      not_after: 1_754_000_000_000 + 86_400_000,
      prev: null,
    };
    const putEnc = await SELF.fetch(`${origin}/v1/keys/encryption`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        record: encryption,
        signature: await signTranscript(idKp.privateKey, encryptionKeyTranscript(encryption)),
      }),
    });
    expect(putEnc.status).toBe(200);

    const got = await SELF.fetch(`${origin}/v1/keys/${handle}`, { headers });
    expect(got.status).toBe(200);
    const json = await got.json<{
      identity: { address: string }; encryption: { record: { address: string } };
    }>();
    expect(json.identity.address).toBe(address);
    expect(json.encryption.record.address).toBe(address);
  });

  it("rejects an encryption record signed by the wrong identity", async () => {
    const who = await newIdentity("kp-four");
    await putIdentity(who);
    const { record } = await encRecord(who, 1);
    const impostor = await generateIdentityKeyPair();
    const signature = await signTranscript(impostor.privateKey, encryptionKeyTranscript(record));

    const res = await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify({ record, signature }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an encryption record naming a different relay host", async () => {
    const who = await newIdentity("kp-foreign-enc");
    await putIdentity(who);
    // Correctly signed by the right identity — only the host is foreign. The
    // signature check alone would let this through.
    const body = await encRecord(who, 1, `${who.handle}@evil.example`);

    const res = await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an epoch that does not advance", async () => {
    const who = await newIdentity("kp-five");
    await putIdentity(who);
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

  it("rejects an epoch equal to the current maximum", async () => {
    // The boundary the strictly-lower test does not reach. It must be a clean
    // 409, not a primary-key violation surfacing as a 500.
    const who = await newIdentity("kp-equal-epoch");
    await putIdentity(who);
    const first = await encRecord(who, 5);
    expect((await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(first),
    })).status).toBe(200);

    // A *different* key at the same epoch: the collision case, not a retry.
    const sameEpoch = await encRecord(who, 5);
    const res = await SELF.fetch(`https://${HOST}/v1/keys/encryption`, {
      method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(sameEpoch),
    });
    expect(res.status).toBe(409);

    // And the stored record is still the first one, not half-overwritten.
    const got = await SELF.fetch(`https://${HOST}/v1/keys/${who.handle}`, {
      headers: auth(who.handle, who.token),
    });
    const json = await got.json<{ encryption: { record: { pub: string } } }>();
    expect(json.encryption.record.pub).toBe(first.record.pub);
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

  it("requires authentication to publish either kind of key", async () => {
    for (const path of ["/v1/keys/identity", "/v1/keys/encryption"]) {
      const res = await SELF.fetch(`https://${HOST}${path}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(res.status).toBe(401);
    }
  });

  it("rate limits both publication routes", async () => {
    // Without a limit, an authenticated handle can hammer the signature
    // verification path and grow encryption_keys without bound — there is no
    // retention on that table.
    //
    // An injected limiter rather than 21 real requests against CARD_RL's
    // 20-per-60s window: a wall-clock burst test is only correct if every
    // request lands in the same window, which is exactly the ambient-window
    // flake register.test.ts already has. A 401 here instead of 429 would also
    // mean the check runs before authentication, so ordering is covered too.
    const who = await newIdentity("kp-rl");
    const { record, signature } = await encRecord(who, 1);
    const bodies: Array<[string, unknown]> = [
      ["/v1/keys/identity", who.identityBody],
      ["/v1/keys/encryption", { record, signature }],
    ];
    for (const [path, body] of bodies) {
      const res = await app.request(
        `https://${HOST}${path}`,
        { method: "PUT", headers: auth(who.handle, who.token), body: JSON.stringify(body) },
        { ...env, CARD_RL: fixedRateLimit(0) },
      );
      expect(res.status).toBe(429);
    }
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
