import { describe, expect, it } from "vitest";
import {
  EncryptionKeyRecord, HPKE_SUITE, IdentityRecord,
  encryptionKeyTranscript, encryptionKeyTranscriptHash, fingerprint, identityTranscript,
} from "../src/keys.js";

const identity = {
  v: 2 as const,
  relay_origin: "agentcall.benree.tech",
  address: "@acme/ken",
  identity_pub: "BASE64URLPUBLICKEY",
};

const encKey = {
  v: 2 as const,
  relay_origin: "agentcall.benree.tech",
  address: "@acme/ken",
  key_id: "0123456789abcdef0123456789abcdef",
  suite: HPKE_SUITE,
  pub: "BASE64URLENCRYPTIONKEY",
  epoch: 1,
  not_before: 1_754_000_000_000,
  not_after: 1_754_600_000_000,
  prev: null,
};

describe("IdentityRecord", () => {
  it("accepts a well-formed record", () => {
    expect(IdentityRecord.parse(identity)).toEqual(identity);
  });

  it("rejects an address with no relay origin", () => {
    expect(IdentityRecord.safeParse({ ...identity, address: "ken" }).success).toBe(false);
  });
});

describe("EncryptionKeyRecord", () => {
  it("accepts a well-formed record", () => {
    expect(EncryptionKeyRecord.parse(encKey)).toEqual(encKey);
  });

  it("rejects a suite it does not implement", () => {
    expect(EncryptionKeyRecord.safeParse({ ...encKey, suite: "DHKEM(X25519,HKDF-SHA256)" }).success).toBe(false);
  });

  it("rejects a key_id that is not 32 lowercase hex characters", () => {
    expect(EncryptionKeyRecord.safeParse({ ...encKey, key_id: "TOOSHORT" }).success).toBe(false);
  });

  it("rejects a validity window longer than 30 days", () => {
    const tooLong = { ...encKey, not_after: encKey.not_before + 2_592_000_001 };
    expect(EncryptionKeyRecord.safeParse(tooLong).success).toBe(false);
  });

  it("accepts a validity window of exactly 30 days", () => {
    const exact = { ...encKey, not_after: encKey.not_before + 2_592_000_000 };
    expect(EncryptionKeyRecord.safeParse(exact).success).toBe(true);
  });

  it("rejects not_after at or before not_before", () => {
    expect(EncryptionKeyRecord.safeParse({ ...encKey, not_after: encKey.not_before }).success).toBe(false);
  });

  it("rejects a negative epoch", () => {
    expect(EncryptionKeyRecord.safeParse({ ...encKey, epoch: -1 }).success).toBe(false);
  });

  it("rejects epoch 0, because epochs start at 1", () => {
    expect(EncryptionKeyRecord.safeParse({ ...encKey, epoch: 0 }).success).toBe(false);
  });

  it("accepts a prev that is 32 lowercase hex characters", () => {
    const chained = { ...encKey, epoch: 2, prev: "abcdef0123456789abcdef0123456789" };
    expect(EncryptionKeyRecord.safeParse(chained).success).toBe(true);
  });

  it("requires null prev exactly for the genesis epoch", () => {
    expect(EncryptionKeyRecord.safeParse({ ...encKey, prev: "a".repeat(32) }).success).toBe(false);
    expect(EncryptionKeyRecord.safeParse({ ...encKey, epoch: 2, prev: null }).success).toBe(false);
  });

  it("rejects a prev that is not 32 lowercase hex characters", () => {
    // A full untruncated SHA-256 (64 hex) is the most likely wrong value, since
    // that is what an implementer reading "SHA-256 of the previous record"
    // would produce. It must fail as loudly as obvious garbage.
    expect(EncryptionKeyRecord.safeParse({ ...encKey, prev: "ab".repeat(32) }).success).toBe(false);
    expect(EncryptionKeyRecord.safeParse({ ...encKey, prev: "NOTHEX" }).success).toBe(false);
    expect(EncryptionKeyRecord.safeParse({ ...encKey, prev: "ABCDEF0123456789ABCDEF0123456789" }).success).toBe(false);
  });
});

describe("transcripts", () => {
  it("changes when any identity field changes", () => {
    const a = identityTranscript(identity);
    const b = identityTranscript({ ...identity, address: "@acme/sarah" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  // The cross-relay binding. It used to ride inside `address` as the host part,
  // which meant it survived only as long as addresses were DNS-shaped. It is an
  // explicit signed field now, so a record published on one relay still cannot
  // be presented as valid on another once the address is a bare registry key.
  it("binds an identity record to its relay", () => {
    const a = identityTranscript(identity);
    const b = identityTranscript({ ...identity, relay_origin: "relay.other.example" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("binds an encryption key record to its relay", () => {
    const a = encryptionKeyTranscript(encKey);
    const b = encryptionKeyTranscript({ ...encKey, relay_origin: "relay.other.example" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("requires relay_origin on both records", () => {
    const { relay_origin: _i, ...identityWithout } = identity;
    const { relay_origin: _e, ...encWithout } = encKey;
    expect(IdentityRecord.safeParse(identityWithout).success).toBe(false);
    expect(EncryptionKeyRecord.safeParse(encWithout).success).toBe(false);
  });

  it("changes when the encryption epoch changes", () => {
    const a = encryptionKeyTranscript(encKey);
    const b = encryptionKeyTranscript({ ...encKey, epoch: 2, prev: "a".repeat(32) });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("derives a stable truncated SHA-256 chain link from the canonical encryption transcript", async () => {
    const link = await encryptionKeyTranscriptHash(encKey);
    expect(link).toMatch(/^[0-9a-f]{32}$/);
    expect(await encryptionKeyTranscriptHash(encKey)).toBe(link);
    expect(await encryptionKeyTranscriptHash({
      ...encKey, epoch: 2, prev: "a".repeat(32),
    })).not.toBe(link);
  });
});

describe("fingerprint", () => {
  it("formats as SHA256: plus 32 lowercase hex characters", async () => {
    const fp = await fingerprint(identityTranscript(identity));
    expect(fp).toMatch(/^SHA256:[0-9a-f]{32}$/);
  });

  it("is stable for the same input", async () => {
    const a = await fingerprint(identityTranscript(identity));
    const b = await fingerprint(identityTranscript(identity));
    expect(a).toBe(b);
  });

  it("differs for different input", async () => {
    const a = await fingerprint(identityTranscript(identity));
    const b = await fingerprint(identityTranscript({ ...identity, identity_pub: "OTHER" }));
    expect(a).not.toBe(b);
  });
});
