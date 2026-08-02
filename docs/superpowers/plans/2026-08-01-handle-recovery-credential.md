# Handle Recovery Credential Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every handle a second, out-of-band credential so that losing `~/.agentcall/config.json` no longer means losing the handle forever.

**Architecture:** Two nullable columns on `handles` (`recovery_hash`, `recovery_redeemed_at`) plus three relay routes — `POST /v1/recovery/issue` (auth: token), `POST /v1/recovery/redeem` (auth: code), `GET /v1/recovery/state` (auth: token). Every credential transition is a single conditional `UPDATE ... RETURNING`, never a read-then-write. The code is Crockford base32, generated and validated in `packages/shared` so relay and CLI agree on one canonical form, and it is never written to disk by the CLI.

**Tech Stack:** TypeScript, ESM, pnpm workspace. Cloudflare Workers + Hono + D1 (`apps/relay`), zod schemas (`packages/shared`), commander CLI (`packages/cli`). Vitest everywhere; `@cloudflare/vitest-pool-workers` for the relay.

**Spec:** `docs/superpowers/specs/2026-08-01-handle-recovery-credential-design.md`
**Issue:** [#52](https://github.com/KenTaniguchi-R/agentcall/issues/52)

## Global Constraints

- **Protocol types live in `packages/shared`.** Add schemas to `packages/shared/src/protocol.ts` first; never duplicate a frame or request shape in `apps/relay` or `packages/cli` — import it.
- **TDD, strictly.** Write the failing test, run it and see it fail, then implement. This codebase was built test-first and stays that way.
- **Before calling any task done:** `pnpm -r build && pnpm -r typecheck && pnpm -r test` must pass from the repo root, **in that order**. `packages/cli` typechecks against `packages/shared`'s built `dist`, so building last checks the previous run's types.
- **Stage files explicitly** — `git add <file> <file>`. Never `git add -A` or `git add .`.
- **Rate-limit `period` must be 10 or 60 seconds.** Cloudflare's ratelimit bindings accept nothing else; an hourly window is not available at this layer.
- **The recovery code is never written to disk by the CLI**, and is printed through the `/dev/tty` path in `packages/cli/src/tty.ts`, not stdout.
- **Redeem returns byte-identical 401s** for unknown handle, wrong code, never-issued, and lost-race. It must not become a handle-enumeration oracle.
- Every relay test uses its own synthetic `cf-connecting-ip` and its own handle, per `apps/relay/test/helpers.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/recovery.ts` | **Create.** Crockford base32 alphabet, `generateRecoveryCode`, `normalizeRecoveryCode`. The single definition of what a code is. |
| `packages/shared/src/protocol.ts` | **Modify.** `RecoveryRedeemRequest`, `RecoveryRedeemResponse`, `RecoveryIssueResponse`, `RecoveryStateResponse`; extend `RegisterResponse`. |
| `packages/shared/src/index.ts` | **Modify.** Re-export `./recovery.js`. |
| `apps/relay/migrations/0005_handle_recovery.sql` | **Create.** Two nullable columns. |
| `apps/relay/src/recovery.ts` | **Create.** `mountRecovery(app)` — the three routes. Kept out of `index.ts`, matching `mountA2A` / `mountRoster`. |
| `apps/relay/src/index.ts` | **Modify.** Mount recovery; register issues a code; rotate gets compare-and-swap. |
| `apps/relay/wrangler.jsonc` | **Modify.** `RECOVER_RL` binding. |
| `apps/relay/src/host.ts` | **Create.** `RELAY_HOST`, so `recovery.ts` can build an address. It cannot be exported from `index.ts` — workerd rejects non-handler named exports of the entry module. |
| `packages/cli/src/api.ts` | **Modify.** `issueRecoveryCode`, `redeemRecoveryCode`, `getRecoveryState`. |
| `packages/cli/src/recoveryPrint.ts` | **Create.** `printRecoveryCode` + the `/dev/tty` writer. Its own module to avoid an `index.ts` ↔ `setup.ts` import cycle. |
| `packages/cli/src/index.ts` | **Modify.** `agentcall recovery issue` / `redeem` subcommands. |
| `packages/cli/src/setup.ts` | **Modify.** Print the code from register through the tty. |
| `packages/cli/src/doctor.ts` | **Modify.** Report never-issued and redeemed-at. |

---

### Task 1: The recovery code format

**Files:**
- Create: `packages/shared/src/recovery.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/recovery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RECOVERY_PREFIX: "agcr_"`
  - `generateRecoveryCode(): string` — display form, e.g. `agcr_JB6H-9K2M-QT4X-7NPW-5RZC-8EYD`
  - `normalizeRecoveryCode(input: string): string | null` — 24-char canonical body (no prefix, no hyphens, uppercase), or `null` if malformed. **This is the form that gets hashed.**

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/recovery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateRecoveryCode, normalizeRecoveryCode, RECOVERY_PREFIX } from "../src/recovery.js";

describe("generateRecoveryCode", () => {
  it("produces a prefixed, hyphen-grouped 24-char code", () => {
    const code = generateRecoveryCode();
    expect(code.startsWith(RECOVERY_PREFIX)).toBe(true);
    const body = code.slice(RECOVERY_PREFIX.length);
    expect(body.split("-")).toHaveLength(6);
    expect(body.replaceAll("-", "")).toHaveLength(24);
  });

  it("uses only the Crockford alphabet (no I, L, O, U)", () => {
    for (let i = 0; i < 50; i++) {
      const body = generateRecoveryCode().slice(RECOVERY_PREFIX.length).replaceAll("-", "");
      expect(body).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(seen.size).toBe(200);
  });
});

describe("normalizeRecoveryCode", () => {
  it("round-trips a generated code to a 24-char canonical body", () => {
    const code = generateRecoveryCode();
    const normalized = normalizeRecoveryCode(code);
    expect(normalized).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/);
  });

  it("accepts the code without prefix, without hyphens, and lowercased", () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code);
    const body = code.slice(RECOVERY_PREFIX.length);
    expect(normalizeRecoveryCode(body)).toBe(canonical);
    expect(normalizeRecoveryCode(body.replaceAll("-", ""))).toBe(canonical);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(`  ${code}  `)).toBe(canonical);
  });

  it("maps Crockford's confusable characters", () => {
    // I and L read as 1; O reads as 0. This is what makes a hand-copied
    // code survive being read off a sticky note.
    expect(normalizeRecoveryCode("I".repeat(24))).toBe("1".repeat(24));
    expect(normalizeRecoveryCode("i".repeat(24))).toBe("1".repeat(24));
    expect(normalizeRecoveryCode("L".repeat(24))).toBe("1".repeat(24));
    expect(normalizeRecoveryCode("O".repeat(24))).toBe("0".repeat(24));
    // Mixed into a real code, the confusables normalize in place.
    expect(normalizeRecoveryCode("IO" + "A".repeat(22))).toBe("10" + "A".repeat(22));
  });

  it("rejects malformed input", () => {
    expect(normalizeRecoveryCode("")).toBeNull();
    expect(normalizeRecoveryCode("agcr_")).toBeNull();
    expect(normalizeRecoveryCode("A".repeat(23))).toBeNull();
    expect(normalizeRecoveryCode("A".repeat(25))).toBeNull();
    // U is excluded from Crockford entirely and is not a confusable.
    expect(normalizeRecoveryCode("U".repeat(24))).toBeNull();
    expect(normalizeRecoveryCode("!".repeat(24))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/recovery.test.ts`
Expected: FAIL — cannot resolve `../src/recovery.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/recovery.ts`:

```ts
// Crockford base32: no I, L, O or U. I/L/O are decoded as their digit
// lookalikes so a hand-transcribed code survives; U is excluded outright
// (Crockford drops it to avoid accidental obscenities) and is therefore a
// hard rejection rather than a confusable.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CONFUSABLES: Record<string, string> = { I: "1", L: "1", O: "0" };

// 15 bytes = 120 bits = exactly 24 base32 characters, no padding.
const CODE_BYTES = 15;
const CODE_CHARS = 24;
const GROUP = 4;

/** Distinguishes a recovery code from the base64url handle token on sight,
 *  and gives secret-scanning a pattern to match. */
export const RECOVERY_PREFIX = "agcr_";

/** Display form: `agcr_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const groups = [];
  for (let i = 0; i < out.length; i += GROUP) groups.push(out.slice(i, i + GROUP));
  return RECOVERY_PREFIX + groups.join("-");
}

/**
 * Canonical 24-char body, or null if the input isn't a well-formed code.
 * THIS is what gets hashed — presentation (prefix, hyphens, case) is
 * cosmetic, so a code typed back in any of those forms still verifies.
 */
export function normalizeRecoveryCode(input: string): string | null {
  let body = input.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
  const prefix = RECOVERY_PREFIX.toUpperCase();
  if (body.startsWith(prefix)) body = body.slice(prefix.length);
  if (body.length !== CODE_CHARS) return null;
  let out = "";
  for (const ch of body) {
    const mapped = CONFUSABLES[ch] ?? ch;
    if (!ALPHABET.includes(mapped)) return null;
    out += mapped;
  }
  return out;
}
```

- [ ] **Step 4: Export it**

In `packages/shared/src/index.ts`, add alongside the existing re-exports:

```ts
export * from "./recovery.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run test/recovery.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Full verification**

Run from repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/recovery.ts packages/shared/src/index.ts packages/shared/test/recovery.test.ts
git commit -m "feat(shared): Crockford base32 recovery code format"
```

---

### Task 2: Protocol schemas

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/test/protocol.test.ts`

**Interfaces:**
- Consumes: `normalizeRecoveryCode` from Task 1 (for the `RecoveryRedeemRequest` refinement).
- Produces:
  - `RecoveryIssueResponse` = `{ recovery_code: string }`
  - `RecoveryRedeemRequest` = `{ handle: string, recovery_code: string }`
  - `RecoveryRedeemResponse` = `{ token: string, recovery_code: string, address: string }`
  - `RecoveryStateResponse` = `{ issued: boolean, redeemed_at: number | null }`
  - `RegisterResponse` gains `recovery_code: string`
  - Matching `...Type` exports for each.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/protocol.test.ts`:

```ts
import {
  RecoveryIssueResponse, RecoveryRedeemRequest, RecoveryRedeemResponse,
  RecoveryStateResponse, RegisterResponse, generateRecoveryCode,
} from "../src/index.js";

describe("recovery schemas", () => {
  it("RecoveryRedeemRequest accepts a valid handle and code", () => {
    const parsed = RecoveryRedeemRequest.safeParse({
      handle: "ken",
      recovery_code: generateRecoveryCode(),
    });
    expect(parsed.success).toBe(true);
  });

  it("RecoveryRedeemRequest rejects a malformed code", () => {
    expect(RecoveryRedeemRequest.safeParse({ handle: "ken", recovery_code: "nope" }).success).toBe(false);
    expect(RecoveryRedeemRequest.safeParse({ handle: "ken", recovery_code: "" }).success).toBe(false);
  });

  it("RecoveryRedeemRequest rejects an invalid handle", () => {
    expect(RecoveryRedeemRequest.safeParse({
      handle: "Bad_Handle", recovery_code: generateRecoveryCode(),
    }).success).toBe(false);
  });

  it("RecoveryRedeemResponse round-trips", () => {
    const value = { token: "t", recovery_code: generateRecoveryCode(), address: "ken@relay.test" };
    expect(RecoveryRedeemResponse.parse(value)).toEqual(value);
  });

  it("RecoveryIssueResponse round-trips", () => {
    const value = { recovery_code: generateRecoveryCode() };
    expect(RecoveryIssueResponse.parse(value)).toEqual(value);
  });

  it("RecoveryStateResponse allows a null redeemed_at", () => {
    expect(RecoveryStateResponse.parse({ issued: false, redeemed_at: null })).toEqual({
      issued: false, redeemed_at: null,
    });
    expect(RecoveryStateResponse.parse({ issued: true, redeemed_at: 1 }).redeemed_at).toBe(1);
  });

  it("RegisterResponse now carries a recovery_code", () => {
    const value = { token: "t", address: "ken@relay.test", recovery_code: generateRecoveryCode() };
    expect(RegisterResponse.parse(value)).toEqual(value);
    expect(RegisterResponse.safeParse({ token: "t", address: "ken@relay.test" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/protocol.test.ts`
Expected: FAIL — `RecoveryRedeemRequest` is not exported.

- [ ] **Step 3: Write the implementation**

In `packages/shared/src/protocol.ts`, add an import at the top:

```ts
import { normalizeRecoveryCode } from "./recovery.js";
```

Replace the existing `RegisterResponse` and add the new schemas beneath it:

```ts
export const RegisterResponse = z.object({
  token: z.string(),
  address: z.string(),
  // Issued unprompted at registration: most owners will never run
  // `agentcall recovery issue`, so this is their only copy unless they ask
  // for another.
  recovery_code: z.string(),
});

// Validated through normalizeRecoveryCode rather than a regex so there is
// exactly one definition of a well-formed code, shared by relay and CLI.
const RecoveryCode = z.string().refine((s) => normalizeRecoveryCode(s) !== null, {
  message: "malformed recovery code",
});

export const RecoveryIssueResponse = z.object({ recovery_code: RecoveryCode });

export const RecoveryRedeemRequest = z.object({
  handle: z.string().regex(HANDLE_RE),
  recovery_code: RecoveryCode,
});

export const RecoveryRedeemResponse = z.object({
  token: z.string(),
  recovery_code: RecoveryCode,
  address: z.string(),
});

export const RecoveryStateResponse = z.object({
  issued: z.boolean(),
  redeemed_at: z.number().nullable(),
});

export type RecoveryIssueResponseType = z.infer<typeof RecoveryIssueResponse>;
export type RecoveryRedeemRequestType = z.infer<typeof RecoveryRedeemRequest>;
export type RecoveryRedeemResponseType = z.infer<typeof RecoveryRedeemResponse>;
export type RecoveryStateResponseType = z.infer<typeof RecoveryStateResponse>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/test/protocol.test.ts
git commit -m "feat(shared): recovery request/response schemas"
```

---

### Task 3: Migration, and register issues a code

**Files:**
- Create: `apps/relay/migrations/0005_handle_recovery.sql`
- Modify: `apps/relay/src/auth.ts`, `apps/relay/src/index.ts:40-56`
- Test: `apps/relay/test/register.test.ts`

**Interfaces:**
- Consumes: `generateRecoveryCode` (Task 1), `RegisterResponse` (Task 2).
- Produces:
  - `handles.recovery_hash TEXT` (nullable), `handles.recovery_redeemed_at INTEGER` (nullable)
  - `POST /v1/register` response gains `recovery_code`
  - `verifyHandleToken` unchanged in this task.

- [ ] **Step 1: Write the failing test**

Append to `apps/relay/test/register.test.ts`:

```ts
it("returns a recovery code and stores its hash", async () => {
  const res = await register({ handle: "reco", agent_kind: "claude" }, "203.0.113.40");
  expect(res.status).toBe(200);
  const json = await res.json<{ token: string; address: string; recovery_code: string }>();
  expect(json.recovery_code.startsWith("agcr_")).toBe(true);

  const row = await env.DB.prepare(
    "SELECT recovery_hash, recovery_redeemed_at FROM handles WHERE handle = ?",
  ).bind("reco").first<{ recovery_hash: string | null; recovery_redeemed_at: number | null }>();
  // The hash is stored, never the code itself.
  expect(row?.recovery_hash).toHaveLength(64);
  expect(row?.recovery_hash).not.toContain(json.recovery_code);
  expect(row?.recovery_redeemed_at).toBeNull();
});

it("issues a different recovery code per handle", async () => {
  const a = await (await register({ handle: "reco-a" }, "203.0.113.41")).json<{ recovery_code: string }>();
  const b = await (await register({ handle: "reco-b" }, "203.0.113.42")).json<{ recovery_code: string }>();
  expect(a.recovery_code).not.toBe(b.recovery_code);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay && pnpm vitest run test/register.test.ts`
Expected: FAIL — `recovery_code` is undefined and `recovery_hash` is not a column.

- [ ] **Step 3: Write the migration**

Create `apps/relay/migrations/0005_handle_recovery.sql`:

```sql
-- A second, out-of-band credential that can authenticate a token rotation
-- when the token itself is gone. Nullable on purpose: every handle
-- registered before this migration has no code, and `recovery_hash IS NULL`
-- is the state `agentcall doctor` reports so an existing owner can mint one
-- while they still hold their token. That nullability is also the trap —
-- redeem MUST reject NULL explicitly before any hash comparison.
ALTER TABLE handles ADD COLUMN recovery_hash TEXT;
ALTER TABLE handles ADD COLUMN recovery_redeemed_at INTEGER;
```

Unlike `0002`, this needs no table rebuild: SQLite takes `ADD COLUMN` directly for a nullable column with no default.

- [ ] **Step 4: Implement**

In `apps/relay/src/auth.ts`, re-export the generator so relay code has one import site for credential minting:

```ts
export { generateRecoveryCode, normalizeRecoveryCode } from "@benree/agentcall-shared";
```

In `apps/relay/src/index.ts`, update the import and the register handler:

```ts
import { generateToken, generateRecoveryCode, sha256Hex, verifyHandleToken } from "./auth.js";
```

```ts
  const token = generateToken();
  const recoveryCode = generateRecoveryCode();
  try {
    await c.env.DB.prepare(
      "INSERT INTO handles (handle, token_hash, agent_kind, created_at, recovery_hash) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      handle, await sha256Hex(token), agent_kind ?? null, Date.now(),
      await sha256Hex(normalizeRecoveryCode(recoveryCode)!),
    ).run();
  } catch {
    return c.json({ error: "handle taken" }, 409);
  }
  return c.json({ token, address: `${handle}@${RELAY_HOST}`, recovery_code: recoveryCode });
```

The `!` on `normalizeRecoveryCode` is safe because `generateRecoveryCode` always emits a well-formed code — but hashing the *normalized* form (not the display form) is mandatory, or a code typed back without hyphens will never verify.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/relay && pnpm vitest run test/register.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/migrations/0005_handle_recovery.sql apps/relay/src/auth.ts apps/relay/src/index.ts apps/relay/test/register.test.ts
git commit -m "feat(relay): issue a recovery code at registration"
```

---

### Task 4: Compare-and-swap on token rotate

This is the pre-existing bug the spec folds in: `/v1/token/rotate` verifies, then runs an unconditional `UPDATE`. Two concurrent rotations both succeed and the first caller's token is silently dead. Redeem needs identical discipline, so rotate is fixed first and the pattern is established.

**Files:**
- Modify: `apps/relay/src/index.ts:80-91`
- Test: `apps/relay/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `/v1/token/rotate` returns 401 when it loses the race, rather than a dead token.

- [ ] **Step 1: Write the failing test**

Append to `apps/relay/test/auth.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

async function rotate(handle: string, token: string) {
  return SELF.fetch("https://relay.test/v1/token/rotate", {
    method: "POST",
    headers: { ...wsAuth(handle, token), "cf-connecting-ip": `rot-${handle}` },
  });
}

describe("POST /v1/token/rotate concurrency", () => {
  it("only one of two concurrent rotations succeeds", async () => {
    const token = await registerHandle("rot-race");
    const [a, b] = await Promise.all([rotate("rot-race", token), rotate("rot-race", token)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("the winning rotation's token actually works", async () => {
    const token = await registerHandle("rot-live");
    const res = await rotate("rot-live", token);
    expect(res.status).toBe(200);
    const next = (await res.json<{ token: string }>()).token;
    // The new token authenticates; the old one no longer does.
    expect((await rotate("rot-live", next)).status).toBe(200);
    expect((await rotate("rot-live", token)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay && pnpm vitest run test/auth.test.ts`
Expected: FAIL on the first case — both rotations return 200.

- [ ] **Step 3: Implement**

Replace the body of the `/v1/token/rotate` handler in `apps/relay/src/index.ts` (keep the existing comment block above it):

```ts
app.post("/v1/token/rotate", async (c) => {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
  if (!(await c.env.REGISTER_RL.limit({ key: `rotate:${handle}` })).success) {
    return c.json({ error: "rate limited" }, 429);
  }
  const next = generateToken();
  // Compare-and-swap, not read-then-write: the verify above and this UPDATE
  // are separate round trips, so two concurrent rotations could both pass
  // the check and both write, leaving the first caller holding a token that
  // is already dead. Conditioning on the hash we authenticated against means
  // exactly one wins; the loser gets the same 401 as a bad token.
  const prevHash = await sha256Hex(token);
  const res = await c.env.DB.prepare(
    "UPDATE handles SET token_hash = ? WHERE handle = ? AND token_hash = ? RETURNING handle",
  ).bind(await sha256Hex(next), handle, prevHash).first();
  if (!res) return c.json({ error: "unauthorized" }, 401);
  return c.json({ token: next });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/relay && pnpm vitest run test/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/index.ts apps/relay/test/auth.test.ts
git commit -m "fix(relay): make token rotation race-free with compare-and-swap"
```

---

### Task 5: `RECOVER_RL` binding

**Files:**
- Modify: `apps/relay/wrangler.jsonc`, `apps/relay/src/index.ts` (the `Env` type)

**Interfaces:**
- Produces: `Env.RECOVER_RL: RateLimit`, namespace_id `1005`.

- [ ] **Step 1: Add the binding**

In `apps/relay/wrangler.jsonc`, append to the `ratelimits` array:

```jsonc
    // Recovery issue/redeem/state. Redeem authenticates an offline-guessable
    // credential against a known handle, so it must not share REGISTER_RL's
    // budget. Checked on BOTH a handle key and an IP key at the call site:
    // one key alone lets an attacker grind many handles from one IP, or one
    // handle from many IPs. 3/60s is the tightest the binding allows —
    // `period` accepts only 10 or 60.
    { "name": "RECOVER_RL", "namespace_id": "1005", "simple": { "limit": 3, "period": 60 } }
```

- [ ] **Step 2: Add it to the Env type**

In `apps/relay/src/index.ts`, inside `export type Env`:

```ts
  // Recovery issue/redeem/state — see wrangler.jsonc. Deliberately separate
  // from REGISTER_RL: this endpoint checks a credential.
  RECOVER_RL: RateLimit;
```

- [ ] **Step 3: Verify it typechecks and nothing regressed**

Run: `cd apps/relay && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/relay/wrangler.jsonc apps/relay/src/index.ts
git commit -m "feat(relay): add RECOVER_RL rate-limit binding"
```

---

### Task 6: `/v1/recovery/issue` and `/v1/recovery/state`

**Files:**
- Create: `apps/relay/src/recovery.ts`
- Modify: `apps/relay/src/index.ts` (mount it)
- Test: `apps/relay/test/recovery-issue.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 5), `generateRecoveryCode` / `normalizeRecoveryCode` (Task 1), `sha256Hex`, `verifyHandleToken`.
- Produces: `mountRecovery(app: Hono<{ Bindings: Env }>): void`, exported from `apps/relay/src/recovery.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/recovery-issue.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

function issue(handle: string, token: string, ip = `iss-${handle}`) {
  return SELF.fetch("https://relay.test/v1/recovery/issue", {
    method: "POST",
    headers: { ...wsAuth(handle, token), "cf-connecting-ip": ip },
  });
}

function state(handle: string, token: string, ip = `st-${handle}`) {
  return SELF.fetch("https://relay.test/v1/recovery/state", {
    headers: { ...wsAuth(handle, token), "cf-connecting-ip": ip },
  });
}

describe("POST /v1/recovery/issue", () => {
  it("mints a code and replaces the previous hash", async () => {
    const token = await registerHandle("iss-one");
    const before = await env.DB.prepare("SELECT recovery_hash FROM handles WHERE handle = ?")
      .bind("iss-one").first<{ recovery_hash: string }>();

    const res = await issue("iss-one", token);
    expect(res.status).toBe(200);
    const { recovery_code } = await res.json<{ recovery_code: string }>();
    expect(recovery_code.startsWith("agcr_")).toBe(true);

    const after = await env.DB.prepare("SELECT recovery_hash FROM handles WHERE handle = ?")
      .bind("iss-one").first<{ recovery_hash: string }>();
    expect(after?.recovery_hash).not.toBe(before?.recovery_hash);
  });

  it("401s without a valid token", async () => {
    await registerHandle("iss-auth");
    expect((await issue("iss-auth", "wrong-token")).status).toBe(401);
    expect((await issue("nobody-here", "wrong-token")).status).toBe(401);
  });
});

describe("GET /v1/recovery/state", () => {
  it("reports issued=true and a null redeemed_at for a fresh handle", async () => {
    const token = await registerHandle("st-fresh");
    const res = await state("st-fresh", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issued: true, redeemed_at: null });
  });

  it("reports issued=false for a handle predating the migration", async () => {
    const token = await registerHandle("st-legacy");
    await env.DB.prepare("UPDATE handles SET recovery_hash = NULL WHERE handle = ?").bind("st-legacy").run();
    expect(await (await state("st-legacy", token)).json()).toEqual({ issued: false, redeemed_at: null });
  });

  it("never returns the hash", async () => {
    const token = await registerHandle("st-secret");
    const body = await (await state("st-secret", token)).text();
    expect(body).not.toContain("recovery_hash");
    expect(body.length).toBeLessThan(100);
  });

  it("401s without a valid token", async () => {
    await registerHandle("st-auth");
    expect((await state("st-auth", "wrong-token")).status).toBe(401);
  });
});

describe("RECOVER_RL", () => {
  // Both keys are charged per request, so exceeding either one alone is
  // enough to trip. Four requests against a limit of 3 — deliberately only
  // one over, so this does not depend on a long burst landing inside one
  // ambient 60s window the way register.test.ts's known flake does.
  it("trips on the handle key when one handle is hit from many IPs", async () => {
    const token = await registerHandle("rl-handle");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await issue("rl-handle", token, `rl-ip-${i}`));
    expect(results.some((r) => r.status === 429)).toBe(true);
  });

  it("trips on the IP key when one IP hits many handles", async () => {
    const tokens = await Promise.all([0, 1, 2, 3].map((i) => registerHandle(`rl-ip-h${i}`)));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await issue(`rl-ip-h${i}`, tokens[i], "rl-shared-ip"));
    expect(results.some((r) => r.status === 429)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay && pnpm vitest run test/recovery-issue.test.ts`
Expected: FAIL — both routes 404.

- [ ] **Step 3: Implement**

Create `apps/relay/src/recovery.ts`:

```ts
import type { Hono } from "hono";
import { generateRecoveryCode, normalizeRecoveryCode, sha256Hex, verifyHandleToken } from "./auth.js";
import type { Env } from "./index.js";

type App = Hono<{ Bindings: Env }>;

function auth(c: { req: { header(k: string): string | undefined } }): { handle: string; token: string } {
  return {
    handle: c.req.header("X-AgentCall-Handle") ?? "",
    token: (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, ""),
  };
}

// Charged on BOTH keys: an IP-only limit lets one attacker grind many
// handles, and a handle-only limit lets a botnet grind one handle. Both are
// consumed per request so neither dimension is free.
async function limited(c: any, handle: string): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const byHandle = await c.env.RECOVER_RL.limit({ key: `h:${handle}` });
  const byIp = await c.env.RECOVER_RL.limit({ key: `i:${ip}` });
  return !byHandle.success || !byIp.success;
}

export function mountRecovery(app: App): void {
  app.post("/v1/recovery/issue", async (c) => {
    const { handle, token } = auth(c);
    if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
    if (await limited(c, handle)) return c.json({ error: "rate limited" }, 429);

    const code = generateRecoveryCode();
    // Conditioned on the token hash we just authenticated against, for the
    // same reason rotate is: verify-then-write is two round trips, and a
    // concurrent rotation between them would otherwise bind a recovery code
    // to a credential that no longer exists.
    const row = await c.env.DB.prepare(
      "UPDATE handles SET recovery_hash = ? WHERE handle = ? AND token_hash = ? RETURNING handle",
    ).bind(await sha256Hex(normalizeRecoveryCode(code)!), handle, await sha256Hex(token)).first();
    if (!row) return c.json({ error: "unauthorized" }, 401);
    return c.json({ recovery_code: code });
  });

  app.get("/v1/recovery/state", async (c) => {
    const { handle, token } = auth(c);
    if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
    if (await limited(c, handle)) return c.json({ error: "rate limited" }, 429);

    const row = await c.env.DB.prepare(
      "SELECT recovery_hash, recovery_redeemed_at FROM handles WHERE handle = ?",
    ).bind(handle).first<{ recovery_hash: string | null; recovery_redeemed_at: number | null }>();
    // Booleans and a timestamp only — never the hash. A caller holding the
    // token could mint a fresh code anyway, so this leaks nothing new, but
    // returning the stored hash would leak something it can't undo.
    return c.json({ issued: row?.recovery_hash != null, redeemed_at: row?.recovery_redeemed_at ?? null });
  });
}
```

In `apps/relay/src/index.ts`, alongside the existing mounts:

```ts
import { mountRecovery } from "./recovery.js";
```
```ts
mountRecovery(app);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/relay && pnpm vitest run test/recovery-issue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/recovery.ts apps/relay/src/index.ts apps/relay/test/recovery-issue.test.ts
git commit -m "feat(relay): recovery issue and state endpoints"
```

---

### Task 7: `/v1/recovery/redeem` — the NULL trap and the identical 401s

The most security-sensitive task in the plan. Two invariants matter more than the happy path: a `NULL` `recovery_hash` must never match anything, and every failure must be indistinguishable from every other.

**Files:**
- Modify: `apps/relay/src/recovery.ts`
- Test: `apps/relay/test/recovery-redeem.test.ts`

**Interfaces:**
- Consumes: everything from Task 6.
- Produces: `POST /v1/recovery/redeem` → `{ token, recovery_code, address }`.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/recovery-redeem.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateRecoveryCode } from "@benree/agentcall-shared";
import { registerHandle, wsAuth } from "./helpers.js";

async function registerFull(handle: string) {
  const res = await SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `reg-${handle}` },
    body: JSON.stringify({ handle, agent_kind: "claude" }),
  });
  expect(res.status).toBe(200);
  return res.json<{ token: string; address: string; recovery_code: string }>();
}

function redeem(handle: string, code: string, ip = `rd-${handle}`) {
  return SELF.fetch("https://relay.test/v1/recovery/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ handle, recovery_code: code }),
  });
}

describe("POST /v1/recovery/redeem", () => {
  it("returns a working new token and a fresh code", async () => {
    const reg = await registerFull("rd-happy");
    const res = await redeem("rd-happy", reg.recovery_code);
    expect(res.status).toBe(200);
    const out = await res.json<{ token: string; recovery_code: string; address: string }>();
    expect(out.address).toBe("rd-happy@agentcall.benree.tech");
    expect(out.recovery_code).not.toBe(reg.recovery_code);

    // The new token authenticates.
    const check = await SELF.fetch("https://relay.test/v1/recovery/state", {
      headers: { ...wsAuth("rd-happy", out.token), "cf-connecting-ip": "rd-check" },
    });
    expect(check.status).toBe(200);
  });

  it("invalidates the redeemed code", async () => {
    const reg = await registerFull("rd-once");
    expect((await redeem("rd-once", reg.recovery_code)).status).toBe(200);
    expect((await redeem("rd-once", reg.recovery_code, "rd-once-2")).status).toBe(401);
  });

  it("kills the old token", async () => {
    const reg = await registerFull("rd-old");
    await redeem("rd-old", reg.recovery_code);
    const check = await SELF.fetch("https://relay.test/v1/recovery/state", {
      headers: { ...wsAuth("rd-old", reg.token), "cf-connecting-ip": "rd-old-chk" },
    });
    expect(check.status).toBe(401);
  });

  it("records recovery_redeemed_at", async () => {
    const reg = await registerFull("rd-stamp");
    await redeem("rd-stamp", reg.recovery_code);
    const row = await env.DB.prepare("SELECT recovery_redeemed_at FROM handles WHERE handle = ?")
      .bind("rd-stamp").first<{ recovery_redeemed_at: number | null }>();
    expect(typeof row?.recovery_redeemed_at).toBe("number");
  });

  // THE NULL TRAP. A handle registered before the migration has
  // recovery_hash NULL. If NULL ever compares equal to anything, every such
  // handle is redeemable by any stranger.
  it("never redeems a handle whose recovery_hash is NULL", async () => {
    await registerHandle("rd-null");
    await env.DB.prepare("UPDATE handles SET recovery_hash = NULL WHERE handle = ?").bind("rd-null").run();
    expect((await redeem("rd-null", generateRecoveryCode())).status).toBe(401);
    // And the row is untouched — a failed redeem must not mint a credential.
    const row = await env.DB.prepare("SELECT recovery_hash FROM handles WHERE handle = ?")
      .bind("rd-null").first<{ recovery_hash: string | null }>();
    expect(row?.recovery_hash).toBeNull();
  });

  it("returns byte-identical 401s for every failure mode", async () => {
    const reg = await registerFull("rd-oracle");
    await env.DB.prepare("UPDATE handles SET recovery_hash = NULL WHERE handle = ?").bind("rd-oracle").run();

    const wrongCode = await redeem("rd-oracle", generateRecoveryCode(), "rd-o1");
    const unknownHandle = await redeem("no-such-handle", generateRecoveryCode(), "rd-o2");

    expect(wrongCode.status).toBe(401);
    expect(unknownHandle.status).toBe(401);
    expect(await wrongCode.text()).toBe(await unknownHandle.text());
    void reg;
  });

  it("400s on a malformed code without touching the database", async () => {
    await registerFull("rd-bad");
    expect((await redeem("rd-bad", "not-a-code")).status).toBe(400);
  });

  it("only one of two concurrent redemptions succeeds", async () => {
    const reg = await registerFull("rd-race");
    const [a, b] = await Promise.all([
      redeem("rd-race", reg.recovery_code, "rd-race-1"),
      redeem("rd-race", reg.recovery_code, "rd-race-2"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay && pnpm vitest run test/recovery-redeem.test.ts`
Expected: FAIL — the route 404s.

- [ ] **Step 3: Implement**

Add to `mountRecovery` in `apps/relay/src/recovery.ts`, and extend the imports at the top of that file:

```ts
import { RecoveryRedeemRequest } from "@benree/agentcall-shared";
```

```ts
  app.post("/v1/recovery/redeem", async (c) => {
    const body = RecoveryRedeemRequest.safeParse(await c.req.json().catch(() => null));
    // A malformed code is a client bug, not a guess, and is rejected before
    // any database work. It is the one failure that does NOT return 401 —
    // it reveals nothing about whether the handle exists.
    if (!body.success) return c.json({ error: "invalid request" }, 400);
    const { handle, recovery_code } = body.data;

    if (await limited(c, handle)) return c.json({ error: "rate limited" }, 429);

    const normalized = normalizeRecoveryCode(recovery_code);
    if (normalized === null) return c.json({ error: "invalid request" }, 400);

    const nextToken = generateToken();
    const nextCode = generateRecoveryCode();
    // Everything hangs on this one statement.
    //
    // `recovery_hash = ?` in SQL is NEVER true when the column is NULL —
    // that is exactly the property this relies on, and it is why the
    // never-issued case cannot be redeemed even though its "expected" value
    // is absent. Do not "fix" this into `IS NOT DISTINCT FROM` or an
    // IFNULL-defaulted comparison.
    //
    // It is also the compare-and-swap: two concurrent redemptions of the
    // same code both pass a read-then-write check, but only one can match
    // the hash here, because the winner overwrites it in the same statement.
    const row = await c.env.DB.prepare(
      "UPDATE handles SET token_hash = ?, recovery_hash = ?, recovery_redeemed_at = ? " +
        "WHERE handle = ? AND recovery_hash = ? RETURNING handle",
    ).bind(
      await sha256Hex(nextToken),
      await sha256Hex(normalizeRecoveryCode(nextCode)!),
      Date.now(),
      handle,
      await sha256Hex(normalized),
    ).first();

    // One response for unknown handle, wrong code, never-issued, and
    // lost-race. Distinguishing them would turn this into the handle
    // enumeration oracle that /v1/status was before it required auth.
    if (!row) return c.json({ error: "unauthorized" }, 401);
    return c.json({ token: nextToken, recovery_code: nextCode, address: `${handle}@${RELAY_HOST}` });
  });
```

`RELAY_HOST` is not exported from `index.ts` (workerd rejects non-handler named exports of the entry module — see the comment there). Move the constant into a new `apps/relay/src/host.ts`:

```ts
export const RELAY_HOST = "agentcall.benree.tech";
```

and import it from both `index.ts` and `recovery.ts`. `generateToken` also needs adding to `recovery.ts`'s import from `./auth.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/relay && pnpm vitest run test/recovery-redeem.test.ts`
Expected: PASS, all nine cases — most importantly the NULL trap and the identical-401 case.

- [ ] **Step 5: Full relay verification**

Run: `cd apps/relay && pnpm typecheck && pnpm test`
Expected: PASS. `register.test.ts`'s burst test is a known pre-existing flake (see CLAUDE.md); if it fails, re-run to confirm that is what you are seeing before investigating.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/recovery.ts apps/relay/src/host.ts apps/relay/src/index.ts apps/relay/test/recovery-redeem.test.ts
git commit -m "feat(relay): recovery redeem with CAS and null-hash rejection"
```

---

### Task 8: CLI API client

**Files:**
- Modify: `packages/cli/src/api.ts`
- Test: `packages/cli/test/api.test.ts`

**Interfaces:**
- Consumes: the three relay routes.
- Produces:
  - `issueRecoveryCode(relay, auth: { handle, token }, opts?): Promise<{ recovery_code: string }>`
  - `redeemRecoveryCode(relay, handle, code, opts?): Promise<{ token: string; recovery_code: string; address: string }>`
  - `getRecoveryState(relay, auth: { handle, token }, opts?): Promise<{ issued: boolean; redeemed_at: number | null }>`
  - `registerHandle`'s return type gains `recovery_code?: string` — **optional**, deliberately. The wire schema `RegisterResponse` (Task 2) requires it, because a current relay must always send one; the CLI's local type does not, because a current CLI may be pointed at a relay that predates the migration. `registerHandle` casts rather than zod-parses, so absence surfaces as `undefined` at runtime with no error, and callers must guard.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/api.test.ts`, matching the mocked-fetch style already used there:

```ts
import { getRecoveryState, issueRecoveryCode, redeemRecoveryCode } from "../src/api.js";

describe("recovery api", () => {
  it("issueRecoveryCode sends auth headers and returns the code", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ recovery_code: "agcr_AAAA-AAAA-AAAA-AAAA-AAAA-AAAA" }), { status: 200 }),
    );
    const out = await issueRecoveryCode("https://relay.test", { handle: "ken", token: "tok" });
    expect(out.recovery_code).toBe("agcr_AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/v1/recovery/issue");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as any).headers.Authorization).toBe("Bearer tok");
    fetchMock.mockRestore();
  });

  it("redeemRecoveryCode posts handle + code and needs no token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "new", recovery_code: "agcr_x", address: "ken@relay.test" }), { status: 200 }),
    );
    const out = await redeemRecoveryCode("https://relay.test", "ken", "agcr_old");
    expect(out.token).toBe("new");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      handle: "ken", recovery_code: "agcr_old",
    });
    expect((init as any).headers.Authorization).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("redeemRecoveryCode turns a 401 into a clear ApiError", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    await expect(redeemRecoveryCode("https://relay.test", "ken", "agcr_bad")).rejects.toThrow(
      /recovery code was not accepted/i,
    );
    fetchMock.mockRestore();
  });

  it("getRecoveryState returns issued and redeemed_at", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ issued: false, redeemed_at: null }), { status: 200 }),
    );
    expect(await getRecoveryState("https://relay.test", { handle: "ken", token: "t" })).toEqual({
      issued: false, redeemed_at: null,
    });
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/api.test.ts`
Expected: FAIL — the functions are not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/api.ts`, update `registerHandle`'s return type to include `recovery_code: string`, then append:

```ts
export async function issueRecoveryCode(
  relay: string, auth: { handle: string; token: string }, opts: { timeoutMs?: number } = {},
): Promise<{ recovery_code: string }> {
  const res = await relayFetch(
    relay,
    "/v1/recovery/issue",
    { method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle } },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many recovery requests — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Could not issue a recovery code (${res.status}).`, "network");
  return (await res.json()) as { recovery_code: string };
}

// No Authorization header: the code IS the credential, and this is the one
// command that has to work with no local config at all.
export async function redeemRecoveryCode(
  relay: string, handle: string, code: string, opts: { timeoutMs?: number } = {},
): Promise<{ token: string; recovery_code: string; address: string }> {
  assertValidHandle(handle);
  const res = await relayFetch(
    relay,
    "/v1/recovery/redeem",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, recovery_code: code }),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  // The relay deliberately can't tell you which of these it was.
  if (res.status === 401) {
    throw new ApiError(
      "That recovery code was not accepted. It may be wrong, already used, or issued for a different handle.",
      "invalid",
    );
  }
  if (res.status === 400) throw new ApiError("That doesn't look like a recovery code (expected `agcr_...`).", "invalid");
  if (res.status === 429) throw new ApiError("Too many recovery attempts — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Recovery failed (${res.status}).`, "network");
  return (await res.json()) as { token: string; recovery_code: string; address: string };
}

export async function getRecoveryState(
  relay: string, auth: { handle: string; token: string }, opts: { timeoutMs?: number } = {},
): Promise<{ issued: boolean; redeemed_at: number | null }> {
  const res = await relayFetch(
    relay,
    "/v1/recovery/state",
    { headers: { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle } },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (!res.ok) throw new ApiError(`Could not read recovery state (${res.status}).`, "network");
  return (await res.json()) as { issued: boolean; redeemed_at: number | null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/api.ts packages/cli/test/api.test.ts
git commit -m "feat(cli): recovery api client functions"
```

---

### Task 9: `agentcall recovery issue` / `redeem`

**Files:**
- Create: `packages/cli/src/recoveryPrint.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/recovery-cmd.test.ts` (create)

**Interfaces:**
- Consumes: Task 8's API functions, `saveConfig`/`loadConfig`.
- Produces: `printRecoveryCode(code: string, write?: (s: string) => void): void`, exported from `packages/cli/src/recoveryPrint.ts`, plus a `recovery` command group with `issue` and `redeem` subcommands.

`printRecoveryCode` lives in its own module rather than `index.ts` because Task 10
needs it from `setup.ts`, and `index.ts` already imports `runSetup` from `setup.ts`
(`index.ts:7`) — putting it in `index.ts` would create an import cycle.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/recovery-cmd.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { printRecoveryCode } from "../src/recoveryPrint.js";

describe("printRecoveryCode", () => {
  it("prints the code with a save-it warning", () => {
    const lines: string[] = [];
    printRecoveryCode("agcr_AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", (s) => lines.push(s));
    const out = lines.join("\n");
    expect(out).toContain("agcr_AAAA-BBBB-CCCC-DDDD-EEEE-FFFF");
    expect(out).toMatch(/save/i);
    // The user must know it is not stored for them.
    expect(out).toMatch(/not (been )?saved|won't be shown again|only copy/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/recovery-cmd.test.ts`
Expected: FAIL — `printRecoveryCode` is not exported.

- [ ] **Step 3: Implement**

Create `packages/cli/src/recoveryPrint.ts`:

```ts
import { openSync } from "node:fs";
import { WriteStream } from "node:tty";

// Writes to the controlling terminal rather than stdout, so
// `agentcall setup | tee setup.log` cannot put a live credential in a log
// file. Falls back to stderr when there is no tty (CI), which is still not
// the piped stdout stream.
function ttyWrite(line: string): void {
  try {
    const out = new WriteStream(openSync("/dev/tty", "w"));
    out.write(line + "\n");
    out.end();
  } catch {
    process.stderr.write(line + "\n");
  }
}

export function printRecoveryCode(code: string, write: (s: string) => void = ttyWrite): void {
  write("");
  write("  Recovery code:  " + code);
  write("");
  write("  Save this in your password manager now. It is the only way back in");
  write("  if you lose ~/.agentcall/config.json, and it has NOT been saved to");
  write("  disk — storing it next to your token would defeat the point.");
  write("  You can mint a fresh one any time with `agentcall recovery issue`.");
  write("");
}
```

Then in `packages/cli/src/index.ts`, add the imports:

```ts
import { issueRecoveryCode, redeemRecoveryCode } from "./api.js";
import { printRecoveryCode } from "./recoveryPrint.js";
```

and the commands:

```ts
const recovery = program
  .command("recovery")
  .description("manage the recovery code that can rebuild a lost handle credential");

recovery
  .command("issue")
  .description("mint a fresh recovery code, invalidating any previous one")
  .action(async () => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const { recovery_code } = await issueRecoveryCode(relayUrl(cfg), {
        handle: cfg.handle, token: cfg.token,
      });
      printRecoveryCode(recovery_code);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

recovery
  .command("redeem")
  .description("rebuild your local credential from a recovery code, when the token is gone")
  .argument("<code>", "the agcr_... code you saved")
  .requiredOption("--handle <handle>", "the handle to recover")
  .option("--relay <url>", "relay the handle is registered on")
  .action(async (code: string, opts: { handle: string; relay?: string }) => {
    const paths = getPaths();
    // Deliberately does NOT loadConfig: the whole point is that there may be
    // no config to load. An existing one is overwritten only on success.
    const relay = opts.relay ?? relayUrl();
    try {
      const out = await redeemRecoveryCode(relay, opts.handle, code);
      saveConfig(paths, { handle: opts.handle, token: out.token, relay });
      console.log(`Recovered ${out.address}. Wrote ${paths.configFile}.`);
      console.log("Your previous token is now dead. Re-run `agentcall setup` to make this install callable again.");
      printRecoveryCode(out.recovery_code);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });
```

Note `saveConfig` writes a caller-only config (no `agent_kind`) — recovery restores the *credential*, not the agent setup, and the printed hint says so.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/recovery-cmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the code never reaches disk**

Add to `packages/cli/test/recovery-cmd.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config.js";

it("a recovered config contains no recovery code", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentcall-reco-"));
  const paths = { dir, configFile: join(dir, "config.json") } as any;
  saveConfig(paths, { handle: "ken", token: "tok", relay: "https://relay.test" });
  for (const f of readdirSync(dir)) {
    expect(readFileSync(join(dir, f), "utf8")).not.toContain("agcr_");
  }
});
```

Run: `cd packages/cli && pnpm vitest run test/recovery-cmd.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/recoveryPrint.ts packages/cli/src/index.ts packages/cli/test/recovery-cmd.test.ts
git commit -m "feat(cli): agentcall recovery issue and redeem"
```

---

### Task 10: `setup` prints the code, `doctor` reports its state

**Files:**
- Modify: `packages/cli/src/setup.ts`, `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/setup.test.ts`, `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `printRecoveryCode` (Task 9), `getRecoveryState` (Task 8), `registerHandle`'s new `recovery_code` (Task 8).
- Produces: `DoctorDeps` gains an optional `getRecoveryStateFn?: typeof getRecoveryState` test seam, matching the existing `getStatusFn` / `callFn` pattern.

- [ ] **Step 1: Write the failing doctor test**

Append to `packages/cli/test/doctor.test.ts`, following the existing `runDoctor` harness in that file:

`baseDeps` is an existing **const object** in that file (line 31), spread as
`{ ...baseDeps, paths: p, log: ... }`. Follow that exact shape — it is not a function.
`p` comes from the same temp-home setup the surrounding tests already use.

```ts
it("warns when no recovery code has ever been issued", async () => {
  const lines: string[] = [];
  const p = writeConfigFixture();   // same helper the neighbouring tests use for `paths: p`
  await runDoctor({
    ...baseDeps,
    paths: p,
    log: (l) => lines.push(l),
    getRecoveryStateFn: async () => ({ issued: false, redeemed_at: null }),
  });
  const out = lines.join("\n");
  expect(out).toMatch(/recovery/i);
  expect(out).toMatch(/agentcall recovery issue/);
});

it("reports a redemption date when the code has been used", async () => {
  const lines: string[] = [];
  const p = writeConfigFixture();
  await runDoctor({
    ...baseDeps,
    paths: p,
    log: (l) => lines.push(l),
    getRecoveryStateFn: async () => ({ issued: true, redeemed_at: Date.UTC(2026, 6, 4) }),
  });
  const out = lines.join("\n");
  expect(out).toContain("2026-07-04");
  expect(out).toMatch(/wasn't you|was not you/i);
});

it("stays quiet when a code is issued and unredeemed", async () => {
  const lines: string[] = [];
  const p = writeConfigFixture();
  await runDoctor({
    ...baseDeps,
    paths: p,
    log: (l) => lines.push(l),
    getRecoveryStateFn: async () => ({ issued: true, redeemed_at: null }),
  });
  expect(lines.join("\n")).not.toMatch(/agentcall recovery issue/);
});
```

Substitute whatever the surrounding tests in that file call their temp-home/paths
setup for `writeConfigFixture()` — read lines 40-70 of `doctor.test.ts` and copy the
pattern verbatim rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/doctor.test.ts`
Expected: FAIL — `getRecoveryStateFn` is not part of `DoctorDeps`.

- [ ] **Step 3: Implement the doctor check**

In `packages/cli/src/doctor.ts`, add to `DoctorDeps`:

```ts
  getRecoveryStateFn?: typeof getRecoveryState;
```

and import `getRecoveryState` from `./api.js`. Then, immediately after the existing `relay status` report block:

```ts
  // Reports only what is observable. Whether the owner actually KEPT their
  // code is not, which is why there is no "have you saved it?" nag here.
  try {
    const state = await (deps.getRecoveryStateFn ?? getRecoveryState)(
      relayUrl(cfg), { handle: cfg.handle, token: cfg.token },
    );
    if (!state.issued) {
      report({
        name: "recovery code",
        ok: true,
        detail: "never issued",
        hint: "run `agentcall recovery issue` — without one, losing config.json loses the handle",
      });
    } else if (state.redeemed_at !== null) {
      const when = new Date(state.redeemed_at).toISOString().slice(0, 10);
      report({
        name: "recovery code",
        ok: true,
        detail: `redeemed on ${when}`,
        hint: "if that wasn't you, run `agentcall recovery issue` now",
      });
    }
  } catch {
    /* an unreachable relay is already reported by the status check above */
  }
```

Both cases use `ok: true` with a hint: per the ladder semantics documented on `runDoctor`, a `!` warning is a check that could not be proven, and neither of these is a failure that should turn the run red.

- [ ] **Step 4: Run doctor tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing setup test**

Append to `packages/cli/test/setup.test.ts`, matching how that file already stubs `registerHandle`:

**`runSetup` has no `registerFn` seam and takes no `paths`.** It reads `SetupOpts`
(`setup.ts:22-38`), resolves paths internally via `getPaths()` (which honours
`process.env.AGENTCALL_HOME`), and the tests stand up a real local HTTP server via the
file's existing `fakeRelay()` helper. Follow that, and **first extend `fakeRelay`'s
response body to include `recovery_code`** — it currently returns only
`{ token, address }`:

```ts
res.end(JSON.stringify({
  token: "tok-123",
  address: `${parsed.handle}@agentcall.benree.tech`,
  recovery_code: "agcr_TEST-TEST-TEST-TEST-TEST-TEST",
}));
```

Then add, in the style of the surrounding cases:

```ts
it("prints the recovery code returned by register", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  try {
    const relay = await fakeRelay();
    const printed: string[] = [];
    await runSetup({
      verify: false, handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true,
      writeRecovery: (s: string) => printed.push(s),
    });
    expect(printed.join("\n")).toContain("agcr_TEST-TEST-TEST-TEST-TEST-TEST");
  } finally {
    delete process.env.AGENTCALL_HOME;
  }
});

it("never writes the recovery code into config.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  try {
    const relay = await fakeRelay();
    await runSetup({
      verify: false, handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true,
      writeRecovery: () => {},
    });
    expect(readFileSync(getPaths(home).configFile, "utf8")).not.toContain("agcr_");
  } finally {
    delete process.env.AGENTCALL_HOME;
  }
});

it("prints nothing when the relay is too old to return a code", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  try {
    const relay = await fakeRelayWithoutRecovery();  // responds { token, address } only
    const printed: string[] = [];
    await runSetup({
      verify: false, handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true,
      writeRecovery: (s: string) => printed.push(s),
    });
    expect(printed.join("\n")).not.toContain("undefined");
  } finally {
    delete process.env.AGENTCALL_HOME;
  }
});
```

Add `fakeRelayWithoutRecovery` alongside the existing `fakeRelay` / `fakeRelay409`
helpers, returning the pre-migration body. This case matters: `api.ts:registerHandle`
*casts* the JSON rather than zod-parsing it, so a new CLI against an un-upgraded relay
gets `recovery_code === undefined` at runtime with no error — and would print the word
"undefined" as someone's recovery code.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/setup.test.ts`
Expected: FAIL — `writeRecovery` is not a recognised dep and no code is printed.

- [ ] **Step 7: Implement in setup**

**`printRecoveryCode` and `ttyWrite` must live in their own module, not `index.ts`.**
`index.ts` already imports `runSetup` from `setup.ts` (`index.ts:7`), so importing back
from `index.ts` would be a cycle. Move both functions out of `index.ts` (where Task 9
put them) into `packages/cli/src/recoveryPrint.ts`, and import from there in
`index.ts`, `setup.ts`, and `test/recovery-cmd.test.ts`. Do this as part of this step —
Task 9's tests must keep passing, so update that import too.

In `packages/cli/src/setup.ts`, add to `SetupOpts` under its existing "Test seams"
comment:

```ts
  writeRecovery?: (s: string) => void;
```

Then, after the config is saved and the address is reported:

```ts
  // A relay predating the recovery migration returns no code. Casting rather
  // than parsing in api.ts means that arrives as `undefined`, so guard it —
  // printing "Recovery code: undefined" would be worse than printing nothing.
  if (registered.recovery_code) {
    printRecoveryCode(registered.recovery_code, opts.writeRecovery);
  }
```

`registered` is whatever local the existing code binds the `registerHandle` result to;
if setup took the idempotent path and skipped registration entirely (see the comment at
`setup.ts:142-147`), there is no new code to print and this block is correctly skipped.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/setup.test.ts test/doctor.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/src/doctor.ts packages/cli/src/recoveryPrint.ts packages/cli/src/index.ts packages/cli/test/setup.test.ts packages/cli/test/doctor.test.ts packages/cli/test/recovery-cmd.test.ts
git commit -m "feat(cli): print recovery code at setup, report its state in doctor"
```

---

### Task 11: Documentation and close-out

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update the README**

Add a short section under the existing credential/setup material, covering: what the code is, that it is printed once at setup and re-mintable with `agentcall recovery issue`, how to use `agentcall recovery redeem <code> --handle <handle>`, and the honest warning that it is a second full-authority credential — anyone who obtains it can take the handle.

Also state plainly that **redeeming does not restore agent configuration**, only the credential; the owner re-runs `agentcall setup` to become callable again.

- [ ] **Step 2: Update the CHANGELOG**

Add an entry under the unreleased heading describing the new commands, the new endpoints, and the rotate concurrency fix as a separate bullet — it is a bug fix, not part of the feature.

- [ ] **Step 3: Full verification**

Run from repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all pass. Re-run once if `apps/relay/test/register.test.ts`'s burst test fails — that flake is documented in CLAUDE.md and is wall-clock dependent.

- [ ] **Step 4: Apply the migration to production D1**

The migration must be applied before the deployed Worker starts selecting `recovery_hash`.

```bash
cd apps/relay && pnpm wrangler d1 migrations apply agentcall --remote
```

Confirm the columns exist before deploying:

```bash
pnpm wrangler d1 execute agentcall --remote --command "PRAGMA table_info(handles);"
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: recovery credential"
```

---

## Deferred, deliberately

Recorded here so a reader does not mistake them for oversights:

- **Handle release and reclamation (#16)** and the incarnation problem — cards, roster members, live WebSocket attachments and A2A tasks all key off the bare handle. Documented in the [#16 comment](https://github.com/KenTaniguchi-R/agentcall/issues/16); larger than this work.
- **Inactivity-based reclaim.** Needs a policy decision about what counts as abandoned.
- **Any change to `idFromName` addressing.**
- **A master code across #44 lines.** Registration is per line, so each line gets its own code. A single code covering every line would be a single point of failure and a third credential concept.
