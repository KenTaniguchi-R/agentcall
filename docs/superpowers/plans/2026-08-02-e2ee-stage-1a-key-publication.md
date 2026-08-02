# E2EE Stage 1A — Key Material and Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every install generates a stable ECDSA P-256 identity key and a rotating HPKE encryption key, publishes signed key records to the relay, and can fetch any handle's records — with no payload encryption yet.

**Architecture:** Two key types. The identity key is generated once and published once; the relay refuses to replace it. Encryption key records are signed by the identity key and carry a monotonic epoch; the relay verifies the signature and rejects any epoch that does not advance. Canonical encoding is a tagged, length-prefixed binary format so signed bytes are unambiguous. All crypto uses Web Crypto, which exists in both Node and workerd, so `packages/shared` stays runtime-neutral.

**Tech Stack:** TypeScript (ESM), zod 4, vitest, Hono, Cloudflare D1, Web Crypto (`globalThis.crypto.subtle`).

## Global Constraints

- Package manager is pnpm. Run from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test` — **build first**, because `packages/cli` typechecks against `packages/shared`'s built `dist`.
- Protocol types live in `packages/shared`. Do not duplicate record shapes in `apps/relay` or `packages/cli` — import them.
- TDD: write the failing test, run it, see it fail, then implement.
- Stage files explicitly with `git add <file> <file>`. Never `git add -A` or `git add .`.
- Curve is **P-256** everywhere. Identity keys are `ECDSA` with `SHA-256`. Encryption keys are `ECDH` P-256 (HPKE `DHKEM(P-256, HKDF-SHA256)` uses ECDH key material).
- Suite string is exactly `DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM` — no spaces.
- Encryption key validity: `not_after - not_before` must not exceed **30 days** (`2_592_000_000` ms).
- New D1 migrations must be added to `apps/relay/migrations/.immutable` in the same commit, and that file must end with a newline. CI (`.github/workflows/invariants.yml`) fails otherwise, and never rename an applied migration.
- No new runtime dependency in this stage. `@hpke/core` arrives in Stage 2.

---

### Task 1: Canonical encoding

Signed bytes must be unambiguous. `JSON.stringify` is not stable enough to sign over — key order and Unicode escaping vary — so this is a tagged, length-prefixed binary encoding.

**Files:**
- Create: `packages/shared/src/canonical.ts`
- Test: `packages/shared/test/canonical.test.ts`
- Modify: `packages/shared/src/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing
- Produces: `type CanonicalValue = string | number | null`, `canonicalEncode(values: readonly CanonicalValue[]): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/canonical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalEncode } from "../src/canonical.js";

describe("canonicalEncode", () => {
  it("is deterministic for the same input", () => {
    const a = canonicalEncode(["ken", 7, null]);
    const b = canonicalEncode(["ken", 7, null]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("distinguishes values that concatenate identically", () => {
    // Without length prefixes, ["ab","c"] and ["a","bc"] would both be "abc".
    const a = canonicalEncode(["ab", "c"]);
    const b = canonicalEncode(["a", "bc"]);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("distinguishes a null from the string 'null'", () => {
    expect(Array.from(canonicalEncode([null]))).not.toEqual(
      Array.from(canonicalEncode(["null"])),
    );
  });

  it("distinguishes a number from its decimal string", () => {
    expect(Array.from(canonicalEncode([7]))).not.toEqual(
      Array.from(canonicalEncode(["7"])),
    );
  });

  it("encodes multi-byte characters by UTF-8 byte length", () => {
    // "あ" is 3 UTF-8 bytes: tag(1) + length(4) + 3 = 8.
    expect(canonicalEncode(["あ"]).byteLength).toBe(8);
  });

  it("rejects a non-integer number", () => {
    expect(() => canonicalEncode([1.5])).toThrow(/integer/i);
  });

  it("rejects a number outside the safe integer range", () => {
    expect(() => canonicalEncode([Number.MAX_SAFE_INTEGER + 2])).toThrow(/integer/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/shared vitest run test/canonical.test.ts`
Expected: FAIL — cannot resolve `../src/canonical.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/canonical.ts`:

```ts
/**
 * Deterministic encoding for bytes that get signed.
 *
 * `JSON.stringify` is not signable: object key order and Unicode escaping are
 * not stable across implementations, and that instability is a well-known
 * source of signature-bypass bugs. This is a tagged, length-prefixed format,
 * so no two distinct value lists can produce the same bytes.
 */
export type CanonicalValue = string | number | null;

const TAG_STRING = 1;
const TAG_INT = 2;
const TAG_NULL = 3;

export function canonicalEncode(values: readonly CanonicalValue[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const value of values) {
    if (value === null) {
      parts.push(Uint8Array.of(TAG_NULL));
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`canonicalEncode: ${value} is not a safe integer`);
      }
      const buf = new Uint8Array(9);
      buf[0] = TAG_INT;
      new DataView(buf.buffer).setBigInt64(1, BigInt(value), false);
      parts.push(buf);
      continue;
    }
    const bytes = encoder.encode(value);
    const buf = new Uint8Array(5 + bytes.byteLength);
    buf[0] = TAG_STRING;
    new DataView(buf.buffer).setUint32(1, bytes.byteLength, false);
    buf.set(bytes, 5);
    parts.push(buf);
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
```

Add to `packages/shared/src/index.ts`, after the existing exports:

```ts
export * from "./canonical.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/shared vitest run test/canonical.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/canonical.ts packages/shared/test/canonical.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add canonical encoding for signed bytes"
```

---

### Task 2: Key record schemas and fingerprints

**Files:**
- Create: `packages/shared/src/keys.ts`
- Test: `packages/shared/test/keys.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `canonicalEncode` from Task 1
- Produces:
  - `HPKE_SUITE: "DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM"`
  - `MAX_ENCRYPTION_KEY_VALIDITY_MS: 2_592_000_000`
  - `IdentityRecord` / `EncryptionKeyRecord` zod schemas and `IdentityRecordType` / `EncryptionKeyRecordType` types
  - `identityTranscript(r: IdentityRecordType): Uint8Array`
  - `encryptionKeyTranscript(r: EncryptionKeyRecordType): Uint8Array`
  - `fingerprint(bytes: Uint8Array): Promise<string>` — returns `"SHA256:"` + 32 lowercase hex chars

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EncryptionKeyRecord, HPKE_SUITE, IdentityRecord,
  encryptionKeyTranscript, fingerprint, identityTranscript,
} from "../src/keys.js";

const identity = {
  v: 1 as const,
  address: "ken@agentcall.benree.tech",
  identity_pub: "BASE64URLPUBLICKEY",
};

const encKey = {
  v: 1 as const,
  address: "ken@agentcall.benree.tech",
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
});

describe("transcripts", () => {
  it("changes when any identity field changes", () => {
    const a = identityTranscript(identity);
    const b = identityTranscript({ ...identity, address: "sarah@agentcall.benree.tech" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("changes when the encryption epoch changes", () => {
    const a = encryptionKeyTranscript(encKey);
    const b = encryptionKeyTranscript({ ...encKey, epoch: 2 });
    expect(Array.from(a)).not.toEqual(Array.from(b));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/shared vitest run test/keys.test.ts`
Expected: FAIL — cannot resolve `../src/keys.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/keys.ts`:

```ts
import { z } from "zod";
import { canonicalEncode } from "./canonical.js";

/** The one HPKE suite this protocol version implements. Exact string, no spaces. */
export const HPKE_SUITE = "DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM" as const;

/** 30 days. A record claiming a longer window is rejected, not clamped. */
export const MAX_ENCRYPTION_KEY_VALIDITY_MS = 2_592_000_000;

// handle@host. The relay origin is part of the signed identity so a record
// published on one relay cannot be presented as valid on another.
const ADDRESS_RE = /^[a-z0-9][a-z0-9-]{1,30}@[a-z0-9.-]{1,253}$/;
const KEY_ID_RE = /^[0-9a-f]{32}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const IdentityRecord = z.object({
  v: z.literal(1),
  address: z.string().regex(ADDRESS_RE),
  identity_pub: z.string().regex(BASE64URL_RE).max(256),
});
export type IdentityRecordType = z.infer<typeof IdentityRecord>;

export const EncryptionKeyRecord = z.object({
  v: z.literal(1),
  address: z.string().regex(ADDRESS_RE),
  key_id: z.string().regex(KEY_ID_RE),
  suite: z.literal(HPKE_SUITE),
  pub: z.string().regex(BASE64URL_RE).max(256),
  epoch: z.number().int().nonnegative(),
  not_before: z.number().int().nonnegative(),
  not_after: z.number().int().nonnegative(),
  // SHA-256 of the previous epoch's transcript, so a client that sees epochs 5
  // and 7 knows it missed 6 rather than silently accepting a fork.
  prev: z.string().regex(KEY_ID_RE).nullable(),
}).refine((r) => r.not_after > r.not_before, {
  message: "not_after must be after not_before",
}).refine((r) => r.not_after - r.not_before <= MAX_ENCRYPTION_KEY_VALIDITY_MS, {
  message: "validity window must not exceed 30 days",
});
export type EncryptionKeyRecordType = z.infer<typeof EncryptionKeyRecord>;

// Field order is part of the signature. Never reorder these lists; adding a
// field means a new record version.
export function identityTranscript(r: IdentityRecordType): Uint8Array {
  return canonicalEncode(["agentcall/identity/v1", r.v, r.address, r.identity_pub]);
}

export function encryptionKeyTranscript(r: EncryptionKeyRecordType): Uint8Array {
  return canonicalEncode([
    "agentcall/encryption-key/v1", r.v, r.address, r.key_id, r.suite, r.pub,
    r.epoch, r.not_before, r.not_after, r.prev,
  ]);
}

/** Truncated to 128 bits: short enough to read aloud, long enough to pin. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SHA256:${hex}`;
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./keys.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/shared vitest run test/keys.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/keys.ts packages/shared/test/keys.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add identity and encryption key record schemas"
```

---

### Task 3: Sign and verify

Web Crypto only, so this module runs unchanged in Node and workerd.

**Files:**
- Create: `packages/shared/src/signing.ts`
- Test: `packages/shared/test/signing.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `generateIdentityKeyPair(): Promise<CryptoKeyPair>`
  - `generateEncryptionKeyPair(): Promise<CryptoKeyPair>`
  - `exportPublicKey(key: CryptoKey): Promise<string>` — base64url of raw SEC1 point
  - `importIdentityPublicKey(b64url: string): Promise<CryptoKey>`
  - `signTranscript(privateKey: CryptoKey, transcript: Uint8Array): Promise<string>` — base64url signature
  - `verifyTranscript(publicKey: CryptoKey, transcript: Uint8Array, signature: string): Promise<boolean>`
  - `keyIdFor(publicKeyB64url: string): Promise<string>` — 32 lowercase hex chars

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/signing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  exportPublicKey, generateEncryptionKeyPair, generateIdentityKeyPair,
  importIdentityPublicKey, keyIdFor, signTranscript, verifyTranscript,
} from "../src/signing.js";

const transcript = new TextEncoder().encode("hello");

describe("signing", () => {
  it("verifies a signature it produced", async () => {
    const kp = await generateIdentityKeyPair();
    const sig = await signTranscript(kp.privateKey, transcript);
    expect(await verifyTranscript(kp.publicKey, transcript, sig)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    const sig = await signTranscript(a.privateKey, transcript);
    expect(await verifyTranscript(b.publicKey, transcript, sig)).toBe(false);
  });

  it("rejects a signature over different bytes", async () => {
    const kp = await generateIdentityKeyPair();
    const sig = await signTranscript(kp.privateKey, transcript);
    const tampered = new TextEncoder().encode("hellp");
    expect(await verifyTranscript(kp.publicKey, tampered, sig)).toBe(false);
  });

  it("returns false rather than throwing on a malformed signature", async () => {
    const kp = await generateIdentityKeyPair();
    expect(await verifyTranscript(kp.publicKey, transcript, "!!!not-base64url!!!")).toBe(false);
  });

  it("round-trips a public key through export and import", async () => {
    const kp = await generateIdentityKeyPair();
    const exported = await exportPublicKey(kp.publicKey);
    const imported = await importIdentityPublicKey(exported);
    const sig = await signTranscript(kp.privateKey, transcript);
    expect(await verifyTranscript(imported, transcript, sig)).toBe(true);
  });

  it("exports an encryption public key as base64url", async () => {
    const kp = await generateEncryptionKeyPair();
    expect(await exportPublicKey(kp.publicKey)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives a stable 32-hex key id", async () => {
    const kp = await generateEncryptionKeyPair();
    const pub = await exportPublicKey(kp.publicKey);
    const a = await keyIdFor(pub);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyIdFor(pub)).toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/shared vitest run test/signing.test.ts`
Expected: FAIL — cannot resolve `../src/signing.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/signing.ts`:

```ts
// Web Crypto only: this module must run unchanged in Node and in workerd.
const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

// P-256 ECDH is the key material HPKE's DHKEM(P-256, HKDF-SHA256) uses. Stage 2
// hands these to @hpke/core; stage 1 only publishes the public half.
export function generateEncryptionKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export function importIdentityPublicKey(b64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(b64url) as BufferSource, ECDSA_PARAMS, true, ["verify"]);
}

export async function signTranscript(privateKey: CryptoKey, transcript: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN_PARAMS, privateKey, transcript as BufferSource);
  return toBase64Url(new Uint8Array(sig));
}

/**
 * Returns false rather than throwing on malformed input. A caller checking a
 * remote record must not have to distinguish "bad signature" from "bad
 * base64" — both mean do not trust this record.
 */
export async function verifyTranscript(
  publicKey: CryptoKey, transcript: Uint8Array, signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      SIGN_PARAMS, publicKey, fromBase64Url(signature) as BufferSource, transcript as BufferSource,
    );
  } catch {
    return false;
  }
}

export async function keyIdFor(publicKeyB64url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKeyB64url) as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { fromBase64Url, toBase64Url };
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./signing.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/shared vitest run test/signing.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the whole workspace still builds**

Run from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/signing.ts packages/shared/test/signing.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add P-256 sign, verify, and key export helpers"
```

---

### Task 4: Relay migration for key tables

**Files:**
- Create: `apps/relay/migrations/0010_key_publication.sql`
- Modify: `apps/relay/migrations/.immutable`
- Test: `apps/relay/test/keys.test.ts` (created here, extended in Task 5)

**Interfaces:**
- Consumes: nothing
- Produces: tables `identity_keys` and `encryption_keys`

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/keys.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/relay vitest run test/keys.test.ts`
Expected: FAIL — `no such table: identity_keys`.

- [ ] **Step 3: Write the migration**

Create `apps/relay/migrations/0010_key_publication.sql`:

```sql
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
```

Append `0010_key_publication.sql` to `apps/relay/migrations/.immutable`, keeping the trailing newline. The file must then read:

```
0001_init.sql
0002_agent_kind_nullable.sql
0003_cards.sql
0004_rosters.sql
0005_handle_recovery.sql
0006_tenancy_and_roster_lifecycle.sql
0007_roster_audit_events.sql
0008_roster_join_keys.sql
0009_org_invite_lifecycle.sql
0010_key_publication.sql
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/relay vitest run test/keys.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/migrations/0010_key_publication.sql apps/relay/migrations/.immutable apps/relay/test/keys.test.ts
git commit -m "feat(relay): add identity and encryption key tables"
```

---

### Task 5: Relay key publication and fetch endpoints

**Files:**
- Create: `apps/relay/src/keys.ts`
- Modify: `apps/relay/src/index.ts` (import and mount)
- Test: `apps/relay/test/keys.test.ts` (extend)

**Interfaces:**
- Consumes: `authenticateRequest` from `./tenant.js`; `IdentityRecord`, `EncryptionKeyRecord`, `identityTranscript`, `encryptionKeyTranscript`, `importIdentityPublicKey`, `verifyTranscript` from `@benree/agentcall-shared`
- Produces: `mountKeys(app: Hono<{ Bindings: Env }>): void`, and three routes:
  - `PUT /v1/keys/identity` — publish once; `409` if one already exists
  - `PUT /v1/keys/encryption` — signature-verified, epoch-monotonic
  - `GET /v1/keys/:handle` — `{ identity, encryption }`, or `404`

- [ ] **Step 1: Write the failing test**

Append to `apps/relay/test/keys.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import {
  encryptionKeyTranscript, exportPublicKey, generateEncryptionKeyPair,
  generateIdentityKeyPair, HPKE_SUITE, identityTranscript, keyIdFor, signTranscript,
} from "@benree/agentcall-shared";
import { registerHandle } from "./helpers.js";

const HOST = "agentcall.benree.tech";

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

    const second = await SELF.fetch(`https://${HOST}/v1/keys/identity`, {
      method: "PUT", headers: auth(who.handle, who.token), body,
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
```

If `apps/relay/test/helpers.ts` does not already export a `registerHandle(handle: string): Promise<string>` returning a token, add one there following the pattern the existing roster tests use, and include it in this task's commit.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/relay vitest run test/keys.test.ts`
Expected: FAIL — the new endpoints return 404.

- [ ] **Step 3: Write minimal implementation**

Create `apps/relay/src/keys.ts`:

```ts
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
```

In `apps/relay/src/index.ts`, add the import beside the other mount imports:

```ts
import { mountKeys } from "./keys.js";
```

and the mount call beside the others:

```ts
mountKeys(app);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/relay vitest run test/keys.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole relay suite**

Run: `pnpm -C apps/relay test`
Expected: all green — confirms the new mount did not shadow an existing route.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/keys.ts apps/relay/src/index.ts apps/relay/test/keys.test.ts apps/relay/test/helpers.ts
git commit -m "feat(relay): publish and serve signed key records"
```

---

### Task 6: CLI key generation and storage

**Files:**
- Create: `packages/cli/src/keys.ts`
- Modify: `packages/cli/src/paths.ts` (add `identityKeyFile`, `encryptionKeyFile`)
- Test: `packages/cli/test/keys.test.ts`

**Interfaces:**
- Consumes: `Paths` from `./paths.js`; `writeJsonAtomic` from `./json-store.js`; signing helpers from `@benree/agentcall-shared`
- Produces:
  - `type StoredKeys = { identity_pkcs8: string; identity_pub: string; encryption_pkcs8: string; encryption_pub: string; epoch: number }`
  - `generateAndSaveKeys(paths: Paths, epoch?: number): Promise<StoredKeys>`
  - `loadKeys(paths: Paths): StoredKeys`
  - `keysExist(paths: Paths): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/keys.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { generateAndSaveKeys, keysExist, loadKeys } from "../src/keys.js";

let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agentcall-keys-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("key storage", () => {
  it("reports no keys before generation", () => {
    expect(keysExist(getPaths(home))).toBe(false);
  });

  it("generates, saves, and reloads both key pairs", async () => {
    const paths = getPaths(home);
    const saved = await generateAndSaveKeys(paths);
    expect(saved.identity_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.encryption_pub).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(saved.epoch).toBe(1);
    expect(keysExist(paths)).toBe(true);
    expect(loadKeys(paths)).toEqual(saved);
  });

  it("writes the identity key file 0600", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    expect(statSync(paths.identityKeyFile).mode & 0o777).toBe(0o600);
  });

  it("writes the containing directory 0700", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
  });

  it("uses distinct identity and encryption keys", async () => {
    const saved = await generateAndSaveKeys(getPaths(home));
    expect(saved.identity_pub).not.toBe(saved.encryption_pub);
    expect(saved.identity_pkcs8).not.toBe(saved.encryption_pkcs8);
  });

  it("advances the epoch when asked", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    const rotated = await generateAndSaveKeys(paths, 2);
    expect(rotated.epoch).toBe(2);
    expect(loadKeys(paths).epoch).toBe(2);
  });

  it("refuses to load a key file with loose permissions", async () => {
    const paths = getPaths(home);
    await generateAndSaveKeys(paths);
    chmodSync(paths.identityKeyFile, 0o644);
    expect(() => loadKeys(paths)).toThrow(/permission/i);
  });

  it("throws a clear error when the key file is corrupt", () => {
    const paths = getPaths(home);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.identityKeyFile, "{ not json", { mode: 0o600 });
    expect(() => loadKeys(paths)).toThrow(/could not be read/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/cli vitest run test/keys.test.ts`
Expected: FAIL — cannot resolve `../src/keys.js`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/paths.ts`, add two fields to the `Paths` interface, after `configFile`:

```ts
  identityKeyFile: string; encryptionKeyFile: string;
```

and to the returned object in `getPaths`, after the `configFile` line:

```ts
    identityKeyFile: join(dir, "identity.key.json"),
    encryptionKeyFile: join(dir, "encryption.key.json"),
```

Create `packages/cli/src/keys.ts`:

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import {
  exportPublicKey, generateEncryptionKeyPair, generateIdentityKeyPair,
  toBase64Url,
} from "@benree/agentcall-shared";
import { writeJsonAtomic } from "./json-store.js";
import type { Paths } from "./paths.js";

const StoredKeysSchema = z.object({
  identity_pkcs8: z.string().min(1),
  identity_pub: z.string().min(1),
  encryption_pkcs8: z.string().min(1),
  encryption_pub: z.string().min(1),
  epoch: z.number().int().positive(),
});
export type StoredKeys = z.infer<typeof StoredKeysSchema>;

async function exportPrivate(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));
}

/**
 * Both key pairs live in one file so a partial write cannot leave an identity
 * without its encryption key. `writeJsonAtomic` already creates the directory
 * 0700 and the file 0600.
 */
export async function generateAndSaveKeys(paths: Paths, epoch = 1): Promise<StoredKeys> {
  const identity = await generateIdentityKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const keys: StoredKeys = {
    identity_pkcs8: await exportPrivate(identity.privateKey),
    identity_pub: await exportPublicKey(identity.publicKey),
    encryption_pkcs8: await exportPrivate(encryption.privateKey),
    encryption_pub: await exportPublicKey(encryption.publicKey),
    epoch,
  };
  writeJsonAtomic(paths.identityKeyFile, keys);
  return keys;
}

export function keysExist(paths: Paths): boolean {
  return existsSync(paths.identityKeyFile);
}

/**
 * Permissions are re-checked on every load, not only at write time: a key file
 * that became group- or world-readable after the fact is exactly as exposed as
 * one written that way.
 */
export function loadKeys(paths: Paths): StoredKeys {
  const mode = statSync(paths.identityKeyFile).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${paths.identityKeyFile} has permission ${mode.toString(8)}; expected 600. ` +
        `Run: chmod 600 ${paths.identityKeyFile}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.identityKeyFile, "utf8"));
  } catch {
    throw new Error(`${paths.identityKeyFile} could not be read as JSON.`);
  }
  const parsed = StoredKeysSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${paths.identityKeyFile} could not be read: unexpected contents.`);
  return parsed.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/cli vitest run test/keys.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full workspace check**

Run from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all green. `packages/cli/test/paths.test.ts` may assert the exact shape of `Paths`; if it fails, add the two new fields to its expectation and include that file in the commit.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/keys.ts packages/cli/src/paths.ts packages/cli/test/keys.test.ts
git commit -m "feat(cli): generate and store identity and encryption keys"
```

---

### Task 7: Publish keys from the CLI

**Files:**
- Modify: `packages/cli/src/api.ts` (add three functions)
- Test: `packages/cli/test/api.test.ts` (extend)

**Interfaces:**
- Consumes: `Auth`, `relayFetch`-style helpers already in `api.ts`; `StoredKeys` from `./keys.js`; record builders from `@benree/agentcall-shared`
- Produces:
  - `publishIdentityKey(relay: string, auth: Auth, keys: StoredKeys, host: string): Promise<void>`
  - `publishEncryptionKey(relay: string, auth: Auth, keys: StoredKeys, host: string, now?: number): Promise<void>`
  - `fetchKeys(relay: string, auth: Auth, handle: string): Promise<{ identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } }>`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/api.test.ts`:

```ts
import { generateAndSaveKeys } from "../src/keys.js";
import { fetchKeys, publishEncryptionKey, publishIdentityKey } from "../src/api.js";
import { getPaths } from "../src/paths.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("key publication", () => {
  const auth = { org: "acme", handle: "ken", token: "t0ken" };

  it("PUTs an identity record whose address carries the relay host", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateAndSaveKeys(getPaths(home));
      let seen: { url: string; body: string } | undefined;
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        seen = { url, body: String(init.body) };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await publishIdentityKey("https://relay.test", auth, keys, "relay.test");

      expect(seen?.url).toBe("https://relay.test/v1/keys/identity");
      const body = JSON.parse(seen!.body) as { record: { address: string; identity_pub: string } };
      expect(body.record.address).toBe("ken@relay.test");
      expect(body.record.identity_pub).toBe(keys.identity_pub);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("PUTs an encryption record with a signature the relay can verify", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-api-"));
    try {
      const keys = await generateAndSaveKeys(getPaths(home));
      let seen: string | undefined;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        seen = String(init.body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }));

      await publishEncryptionKey("https://relay.test", auth, keys, "relay.test", 1_754_000_000_000);

      const body = JSON.parse(seen!) as {
        record: { epoch: number; not_after: number; not_before: number; suite: string };
        signature: string;
      };
      expect(body.record.epoch).toBe(keys.epoch);
      expect(body.record.not_before).toBe(1_754_000_000_000);
      expect(body.record.not_after - body.record.not_before).toBeLessThanOrEqual(2_592_000_000);
      expect(body.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws a clear error when a handle has no published keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    try {
      await expect(fetchKeys("https://relay.test", auth, "nobody")).rejects.toThrow(/no published key/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/cli vitest run test/api.test.ts`
Expected: FAIL — `publishIdentityKey` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `packages/cli/src/api.ts`:

```ts
import {
  EncryptionKeyRecord, IdentityRecord, HPKE_SUITE, MAX_ENCRYPTION_KEY_VALIDITY_MS,
  encryptionKeyTranscript, keyIdFor, signTranscript,
  type EncryptionKeyRecordType, type IdentityRecordType,
} from "@benree/agentcall-shared";
import type { StoredKeys } from "./keys.js";
```

Append to the end of `packages/cli/src/api.ts`:

```ts
async function importIdentityPrivateKey(pkcs8B64url: string): Promise<CryptoKey> {
  const padded = pkcs8B64url.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (pkcs8B64url.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8", bytes as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

export async function publishIdentityKey(
  relay: string, auth: Auth, keys: StoredKeys, host: string,
): Promise<void> {
  const record: IdentityRecordType = IdentityRecord.parse({
    v: 1, address: `${auth.handle}@${host}`, identity_pub: keys.identity_pub,
  });
  const res = await relayFetch(
    relay, "/v1/keys/identity",
    { method: "PUT", headers: { "content-type": "application/json", ...authHeaders(auth) }, body: JSON.stringify({ record }) },
    RELAY_TIMEOUT_MS,
  );
  if (res.status === 409) {
    throw new ApiError(
      "A different identity key is already published for this handle. It cannot be replaced.",
      "invalid",
    );
  }
  if (!res.ok) throw new ApiError(`Could not publish the identity key (HTTP ${res.status}).`, "network");
}

export async function publishEncryptionKey(
  relay: string, auth: Auth, keys: StoredKeys, host: string, now: number = Date.now(),
): Promise<void> {
  const pub = keys.encryption_pub;
  const record: EncryptionKeyRecordType = EncryptionKeyRecord.parse({
    v: 1,
    address: `${auth.handle}@${host}`,
    key_id: await keyIdFor(pub),
    suite: HPKE_SUITE,
    pub,
    epoch: keys.epoch,
    not_before: now,
    not_after: now + MAX_ENCRYPTION_KEY_VALIDITY_MS,
    prev: null,
  });
  const signature = await signTranscript(
    await importIdentityPrivateKey(keys.identity_pkcs8),
    encryptionKeyTranscript(record),
  );
  const res = await relayFetch(
    relay, "/v1/keys/encryption",
    { method: "PUT", headers: { "content-type": "application/json", ...authHeaders(auth) }, body: JSON.stringify({ record, signature }) },
    RELAY_TIMEOUT_MS,
  );
  if (!res.ok) throw new ApiError(`Could not publish the encryption key (HTTP ${res.status}).`, "network");
}

export async function fetchKeys(
  relay: string, auth: Auth, handle: string,
): Promise<{ identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } }> {
  assertValidHandle(handle);
  const res = await relayFetch(
    relay, `/v1/keys/${handle}`, { headers: authHeaders(auth) }, RELAY_TIMEOUT_MS,
  );
  if (res.status === 404) {
    throw new ApiError(`${handle} has no published key. They need a newer agentcall.`, "unknown_handle");
  }
  if (!res.ok) throw new ApiError(`Could not fetch keys for ${handle} (HTTP ${res.status}).`, "network");
  const body = await res.json() as { identity?: unknown; encryption?: { record?: unknown; signature?: unknown } };
  const identity = IdentityRecord.safeParse(body.identity);
  const record = EncryptionKeyRecord.safeParse(body.encryption?.record);
  if (!identity.success || !record.success || typeof body.encryption?.signature !== "string") {
    throw new ApiError(`The relay returned a malformed key record for ${handle}.`, "invalid");
  }
  return { identity: identity.data, encryption: { record: record.data, signature: body.encryption.signature } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/cli vitest run test/api.test.ts`
Expected: PASS, including the 3 new tests.

- [ ] **Step 5: Run the full workspace check**

Run from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/api.ts packages/cli/test/api.test.ts
git commit -m "feat(cli): publish and fetch signed key records"
```

---

## Self-review

**Spec coverage.** Stage 1's spec requirements map as follows: two distinct keys → Task 6; ECDSA P-256 identity and P-256 encryption keys → Task 3; canonical encoding that is not `JSON.stringify` → Task 1; `IdentityRecord` and `EncryptionKeyRecord` including `epoch`, `not_before`, `not_after`, `prev` → Task 2; 30-day validity bound → Task 2 (schema) and Task 7 (construction); identity published once and not replaceable → Task 5; monotonic epoch enforced → Task 5; signature verified before storage → Task 5; `0600` file in a `0700` directory with permissions re-checked on load → Task 6.

Deferred to plan 1B, and deliberately not in this plan: pinning and the `known_peers` store, `agentcall verify`, `agentcall trust --reset`, doctor checks, hard-fail on pin change in non-interactive mode, transactional setup integration, and key rotation scheduling. Stage 1A publishes keys; nothing yet *trusts* them, which is why 1B must land before any Stage 2 work begins.

**Placeholder scan.** No TBDs. Every code step contains the code to write. Two conditional steps (the `helpers.ts` export in Task 5, the `paths.test.ts` expectation in Task 6) state the exact condition and the exact remedy rather than deferring a decision.

**Type consistency.** `StoredKeys` is defined in Task 6 and consumed in Task 7 with the same five fields. `keyIdFor` returns 32 lowercase hex in Task 3 and is validated by `KEY_ID_RE` in Task 2 and used in Task 7. `HPKE_SUITE` is the single source in Task 2 and referenced in Tasks 5 and 7. `encryptionKeyTranscript` has one signature across Tasks 2, 5, and 7. `toBase64Url` is exported from Task 3 and imported in Task 6.

One deliberate asymmetry: Task 6 stores `epoch` alongside the key material rather than deriving it, because the relay rejects a non-advancing epoch and the CLI must know what it last published without a network round trip.
