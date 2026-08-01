# A2A Card Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a conformant A2A v1.0 AgentCard for every agentcall handle, with the spec's normative error envelope and version handling.

**Architecture:** A2A objects are produced by one-way projection functions in a new `packages/shared/src/a2a/` module — A2A is a *serialization* of our domain types, never the source of truth. The relay imports those projections and mounts new routes; the existing `/v1/card/:handle` endpoint stays untouched so nothing regresses. No task store, no operations, no SSE — those are Plan 2.

**Tech Stack:** TypeScript (ESM), zod, Hono, Cloudflare Workers + D1, vitest, `@cloudflare/vitest-pool-workers`.

**Spec:** [2026-08-01-a2a-adoption-design.md](../specs/2026-08-01-a2a-adoption-design.md)

## Global Constraints

- **A2A protocol version: `1.0`** — advertised in `protocolVersion` on both the card and each interface.
- **Protocol binding: `HTTP+JSON` only.** Do not advertise `JSONRPC` or `GRPC`.
- **Extension URI is a fixed identifier, not a per-deployment address:** `https://agentcall.benree.tech/ext/policy/v1`. It must not vary by relay host and need not resolve.
- **`grants` must never appear in any public payload.** Cards expose only the skills a caller may already invoke.
- **`agent_kind` must not appear in the public A2A contract.** It stays on the legacy `/v1/card/:handle` response.
- **Error bodies use AIP-193**: `error.code` is the numeric HTTP status. A2A-specific errors additionally carry a `google.rpc.ErrorInfo` in `error.details` with `domain: "a2a-protocol.org"`.
- **Protocol types live in `packages/shared`.** Never redefine an A2A shape inside `apps/relay`.
- **Build order:** `packages/cli` and `apps/relay` compile against the *built* `packages/shared`. Run `pnpm -r build` after changing shared before typechecking dependents.
- **`pnpm typecheck` does not cover `test/`** (`tsconfig.json` has `"include": ["src"]`). Only `pnpm -r test` proves a refactor is complete.
- **Stage files explicitly** (`git add <file> <file>`). Never `git add -A` or `git add .`.

---

### Task 1: A2A error model (§5.4 + AIP-193)

The nine A2A-specific errors, their HTTP statuses transcribed from spec §5.4, and the AIP-193 response envelope.

**Files:**
- Create: `packages/shared/src/a2a/errors.ts`
- Test: `packages/shared/test/a2a-errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `A2A_ERROR_DOMAIN: "a2a-protocol.org"`
  - `A2A_ERRORS: Record<A2AErrorKey, { reason: string; http: number; jsonrpc: number }>`
  - `type A2AErrorKey = "TaskNotFound" | "TaskNotCancelable" | "PushNotificationNotSupported" | "UnsupportedOperation" | "ContentTypeNotSupported" | "InvalidAgentResponse" | "ExtendedAgentCardNotConfigured" | "ExtensionSupportRequired" | "VersionNotSupported"`
  - `type Aip193Body = { error: { code: number; message: string; details?: unknown[] } }`
  - `a2aError(key: A2AErrorKey, message: string, metadata?: Record<string, string>): { status: number; body: Aip193Body }`
  - `standardError(status: number, message: string): { status: number; body: Aip193Body }`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/a2a-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { A2A_ERRORS, A2A_ERROR_DOMAIN, a2aError, standardError } from "../src/index.js";

describe("§5.4 error table", () => {
  it("maps every A2A error to its normative HTTP status", () => {
    expect(A2A_ERRORS.TaskNotFound.http).toBe(404);
    expect(A2A_ERRORS.TaskNotCancelable.http).toBe(409);
    expect(A2A_ERRORS.PushNotificationNotSupported.http).toBe(400);
    expect(A2A_ERRORS.UnsupportedOperation.http).toBe(400);
    expect(A2A_ERRORS.ContentTypeNotSupported.http).toBe(415);
    expect(A2A_ERRORS.InvalidAgentResponse.http).toBe(502);
    expect(A2A_ERRORS.ExtendedAgentCardNotConfigured.http).toBe(400);
    expect(A2A_ERRORS.ExtensionSupportRequired.http).toBe(400);
    expect(A2A_ERRORS.VersionNotSupported.http).toBe(400);
  });

  it("maps every A2A error to its JSON-RPC code", () => {
    expect(A2A_ERRORS.TaskNotFound.jsonrpc).toBe(-32001);
    expect(A2A_ERRORS.VersionNotSupported.jsonrpc).toBe(-32009);
  });

  it("derives reason as UPPER_SNAKE_CASE without the Error suffix", () => {
    expect(A2A_ERRORS.TaskNotFound.reason).toBe("TASK_NOT_FOUND");
    expect(A2A_ERRORS.ContentTypeNotSupported.reason).toBe("CONTENT_TYPE_NOT_SUPPORTED");
  });
});

describe("a2aError", () => {
  it("builds an AIP-193 body with a numeric code", () => {
    const { status, body } = a2aError("TaskNotFound", "task abc not found");
    expect(status).toBe(404);
    expect(body.error.code).toBe(404);
    expect(typeof body.error.code).toBe("number");
    expect(body.error.message).toBe("task abc not found");
  });

  it("includes a google.rpc.ErrorInfo detail", () => {
    const { body } = a2aError("TaskNotCancelable", "too late");
    expect(body.error.details).toEqual([
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "TASK_NOT_CANCELABLE",
        domain: A2A_ERROR_DOMAIN,
      },
    ]);
  });

  it("attaches optional metadata to the ErrorInfo", () => {
    const { body } = a2aError("UnsupportedOperation", "no", { offered: "ask,triage" });
    expect((body.error.details as any[])[0].metadata).toEqual({ offered: "ask,triage" });
  });
});

describe("standardError", () => {
  it("builds an AIP-193 body with no ErrorInfo detail", () => {
    const { status, body } = standardError(401, "unauthorized");
    expect(status).toBe(401);
    expect(body.error.code).toBe(401);
    expect(body.error.details).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/a2a-errors.test.ts`
Expected: FAIL — `No "A2A_ERRORS" export is defined on the module`

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/a2a/errors.ts`:

```ts
// Transcribed from A2A v1.0 spec §5.4 (Error Code Mappings). These values are
// normative — do not re-derive them from intuition. An earlier design draft
// guessed 501 for PushNotificationNotSupported; the spec says 400.
export const A2A_ERROR_DOMAIN = "a2a-protocol.org";

export const A2A_ERRORS = {
  TaskNotFound: { reason: "TASK_NOT_FOUND", http: 404, jsonrpc: -32001 },
  TaskNotCancelable: { reason: "TASK_NOT_CANCELABLE", http: 409, jsonrpc: -32002 },
  PushNotificationNotSupported: { reason: "PUSH_NOTIFICATION_NOT_SUPPORTED", http: 400, jsonrpc: -32003 },
  UnsupportedOperation: { reason: "UNSUPPORTED_OPERATION", http: 400, jsonrpc: -32004 },
  ContentTypeNotSupported: { reason: "CONTENT_TYPE_NOT_SUPPORTED", http: 415, jsonrpc: -32005 },
  InvalidAgentResponse: { reason: "INVALID_AGENT_RESPONSE", http: 502, jsonrpc: -32006 },
  ExtendedAgentCardNotConfigured: { reason: "EXTENDED_AGENT_CARD_NOT_CONFIGURED", http: 400, jsonrpc: -32007 },
  ExtensionSupportRequired: { reason: "EXTENSION_SUPPORT_REQUIRED", http: 400, jsonrpc: -32008 },
  VersionNotSupported: { reason: "VERSION_NOT_SUPPORTED", http: 400, jsonrpc: -32009 },
} as const;

export type A2AErrorKey = keyof typeof A2A_ERRORS;

export type Aip193Body = {
  error: { code: number; message: string; details?: unknown[] };
};

// §11.6: REST errors use AIP-193, where `code` is the HTTP status as a NUMBER.
// A string there is a conformance failure — the TCK parses it with int().
export function a2aError(
  key: A2AErrorKey,
  message: string,
  metadata?: Record<string, string>,
): { status: number; body: Aip193Body } {
  const spec = A2A_ERRORS[key];
  return {
    status: spec.http,
    body: {
      error: {
        code: spec.http,
        message,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: spec.reason,
            domain: A2A_ERROR_DOMAIN,
            ...(metadata ? { metadata } : {}),
          },
        ],
      },
    },
  };
}

// For §3.3.2 standard categories (auth, authz, validation, resource, system).
// These carry no ErrorInfo — they are not A2A-specific error types.
export function standardError(status: number, message: string): { status: number; body: Aip193Body } {
  return { status, body: { error: { code: status, message } } };
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/shared/src/index.ts` — append:

```ts
export * from "./a2a/errors.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run test/a2a-errors.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/a2a/errors.ts packages/shared/src/index.ts packages/shared/test/a2a-errors.test.ts
git commit -m "feat(a2a): transcribe the §5.4 error table and AIP-193 envelope"
```

---

### Task 2: A2A-Version negotiation

The TCK requires the server to reject an unsupported `A2A-Version` header with `VersionNotSupported` (400). An absent header means "assume the advertised version".

**Files:**
- Create: `packages/shared/src/a2a/version.ts`
- Test: `packages/shared/test/a2a-version.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `A2A_PROTOCOL_VERSION: "1.0"`
  - `A2A_VERSION_HEADER: "A2A-Version"`
  - `isSupportedA2AVersion(header: string | undefined | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/a2a-version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER, isSupportedA2AVersion } from "../src/index.js";

describe("A2A version negotiation", () => {
  it("advertises 1.0", () => {
    expect(A2A_PROTOCOL_VERSION).toBe("1.0");
    expect(A2A_VERSION_HEADER).toBe("A2A-Version");
  });

  it("accepts an absent header", () => {
    expect(isSupportedA2AVersion(undefined)).toBe(true);
    expect(isSupportedA2AVersion(null)).toBe(true);
    expect(isSupportedA2AVersion("")).toBe(true);
  });

  it("accepts the advertised version", () => {
    expect(isSupportedA2AVersion("1.0")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isSupportedA2AVersion("  1.0 ")).toBe(true);
  });

  it("rejects any other version", () => {
    for (const v of ["0.3", "1.1", "2.0", "banana"]) {
      expect(isSupportedA2AVersion(v)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/a2a-version.test.ts`
Expected: FAIL — `No "isSupportedA2AVersion" export is defined on the module`

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/a2a/version.ts`:

```ts
export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_VERSION_HEADER = "A2A-Version";

/**
 * An absent or empty header means the client did not negotiate, so we serve
 * the version we advertise. Anything else must match exactly — the spec
 * requires VersionNotSupportedError (400) otherwise, and silently processing
 * a request under a version we did not agree to is the failure mode that rule
 * exists to prevent.
 */
export function isSupportedA2AVersion(header: string | undefined | null): boolean {
  if (header === undefined || header === null) return true;
  const trimmed = header.trim();
  if (trimmed === "") return true;
  return trimmed === A2A_PROTOCOL_VERSION;
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/shared/src/index.ts` — append:

```ts
export * from "./a2a/version.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run test/a2a-version.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/a2a/version.ts packages/shared/src/index.ts packages/shared/test/a2a-version.test.ts
git commit -m "feat(a2a): validate the A2A-Version header"
```

---

### Task 3: AgentCard projection

One-way projection from our card view to an A2A `AgentCard`. Not a round-trip: the public representation is intentionally lossy (no `grants`, no `agent_kind`).

**Files:**
- Create: `packages/shared/src/a2a/card.ts`
- Test: `packages/shared/test/a2a-card.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `CardTaskType` from `packages/shared/src/card.ts`; `A2A_PROTOCOL_VERSION` from Task 2.
- Produces:
  - `AGENTCALL_POLICY_EXT: "https://agentcall.benree.tech/ext/policy/v1"`
  - `type A2AAgentCard` (structural type, exported)
  - `toAgentCard(input: { handle: string; description: string; tasks: CardTaskType[]; baseUrl: string }): A2AAgentCard`
  - `toDirectoryCard(input: { origin: string }): A2AAgentCard`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/a2a-card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AGENTCALL_POLICY_EXT, toAgentCard, toDirectoryCard } from "../src/index.js";

const TASKS = [
  { id: "ask", name: "Ask", description: "Answer a question.", examples: ["what owns billing?"] },
  { id: "triage", name: "Triage", description: "Triage an incident.", examples: [] },
];

const card = () =>
  toAgentCard({
    handle: "ken",
    description: "Ken's agent",
    tasks: TASKS,
    baseUrl: "https://agentcall.benree.tech/ken",
  });

describe("toAgentCard", () => {
  it("includes every field the TCK requires", () => {
    const c = card() as Record<string, unknown>;
    for (const f of [
      "name", "description", "version", "capabilities",
      "skills", "supportedInterfaces", "defaultInputModes", "defaultOutputModes",
    ]) {
      expect(c[f], `missing ${f}`).toBeDefined();
    }
  });

  it("names the card after the handle", () => {
    expect(card().name).toBe("ken");
  });

  it("declares exactly one HTTP+JSON interface at the handle's base URL", () => {
    expect(card().supportedInterfaces).toEqual([
      {
        url: "https://agentcall.benree.tech/ken",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "ken",
      },
    ]);
  });

  it("projects each task to an AgentSkill", () => {
    expect(card().skills[0]).toEqual({
      id: "ask",
      name: "Ask",
      description: "Answer a question.",
      tags: ["agentcall"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      examples: ["what owns billing?"],
    });
  });

  it("declares the policy extension with a fixed, host-independent URI", () => {
    expect(card().agentExtensions?.[0]?.uri).toBe(AGENTCALL_POLICY_EXT);
    expect(AGENTCALL_POLICY_EXT).toBe("https://agentcall.benree.tech/ext/policy/v1");
  });

  it("carries the handle in the extension params", () => {
    expect(card().agentExtensions?.[0]?.params).toEqual({ handle: "ken" });
  });

  it("does not advertise streaming or push in this plan", () => {
    expect(card().capabilities.streaming).toBe(false);
    expect(card().capabilities.pushNotifications).toBe(false);
  });

  // The two fields the spec forbids in any public payload.
  it("never leaks grants or agent_kind", () => {
    const serialized = JSON.stringify(card());
    expect(serialized).not.toContain("grants");
    expect(serialized).not.toContain("agent_kind");
  });
});

describe("toDirectoryCard", () => {
  it("describes the relay itself, not a person", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    expect(d.name).toBe("agentcall relay");
    expect(d.supportedInterfaces[0]!.url).toBe("https://agentcall.benree.tech");
    expect(d.supportedInterfaces[0]!.tenant).toBeUndefined();
  });

  it("advertises the handle-resolution skill", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    expect(d.skills.map((s) => s.id)).toContain("resolve-handle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/a2a-card.test.ts`
Expected: FAIL — `No "toAgentCard" export is defined on the module`

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/a2a/card.ts`:

```ts
import type { CardTaskType } from "../card.js";
import { A2A_PROTOCOL_VERSION } from "./version.js";

/**
 * A stable identifier, NOT a per-deployment address. It does not vary by relay
 * host and need not resolve. A self-hosted relay declares this same URI —
 * otherwise every deployment would advertise a different extension and no
 * client could recognize any of them.
 */
export const AGENTCALL_POLICY_EXT = "https://agentcall.benree.tech/ext/policy/v1";

const TEXT_MODES = ["text/plain"];

export type A2AAgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
  examples: string[];
};

export type A2AAgentInterface = {
  url: string;
  protocolBinding: "HTTP+JSON";
  protocolVersion: string;
  tenant?: string;
};

export type A2AAgentCard = {
  name: string;
  description: string;
  version: string;
  protocolVersion: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  supportedInterfaces: A2AAgentInterface[];
  agentExtensions?: { uri: string; description: string; required: boolean; params?: Record<string, string> }[];
};

function toSkill(task: CardTaskType): A2AAgentSkill {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    tags: ["agentcall"],
    inputModes: [...TEXT_MODES],
    outputModes: [...TEXT_MODES],
    examples: [...task.examples],
  };
}

/**
 * One-way projection. Deliberately lossy: `grants` never leaves the policy
 * engine, and `agent_kind` is implementation metadata that does not belong in
 * a public contract. Callers pass `tasks` ALREADY filtered to what this viewer
 * may invoke — this function does no authorization of its own.
 */
export function toAgentCard(input: {
  handle: string;
  description: string;
  tasks: CardTaskType[];
  baseUrl: string;
}): A2AAgentCard {
  return {
    name: input.handle,
    description: input.description,
    version: "1.0.0",
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: true },
    defaultInputModes: [...TEXT_MODES],
    defaultOutputModes: [...TEXT_MODES],
    skills: input.tasks.map(toSkill),
    supportedInterfaces: [
      {
        url: input.baseUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: input.handle,
      },
    ],
    agentExtensions: [
      {
        uri: AGENTCALL_POLICY_EXT,
        description: "agentcall per-caller task policy.",
        required: false,
        params: { handle: input.handle },
      },
    ],
  };
}

/**
 * The card at the ORIGIN well-known path. It describes the relay itself — the
 * directory/gateway agent — not any person. Per-handle cards are retrieved
 * from the registry, which is A2A's second sanctioned discovery mechanism.
 */
export function toDirectoryCard(input: { origin: string }): A2AAgentCard {
  return {
    name: "agentcall relay",
    description: "Directory of agentcall handles. Each handle publishes its own Agent Card.",
    version: "1.0.0",
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: [...TEXT_MODES],
    defaultOutputModes: [...TEXT_MODES],
    skills: [
      {
        id: "resolve-handle",
        name: "Resolve handle",
        description: "Resolve an agentcall handle to that agent's own Agent Card.",
        tags: ["agentcall", "directory"],
        inputModes: [...TEXT_MODES],
        outputModes: ["application/json"],
        examples: ["GET /v1/a2a/ken/agent-card.json"],
      },
    ],
    supportedInterfaces: [
      { url: input.origin, protocolBinding: "HTTP+JSON", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
  };
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/shared/src/index.ts` — append:

```ts
export * from "./a2a/card.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run test/a2a-card.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Build shared and run the whole package**

Run: `cd packages/shared && pnpm test && pnpm typecheck && pnpm build`
Expected: all green. The build is required — `apps/relay` compiles against `dist`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/a2a/card.ts packages/shared/src/index.ts packages/shared/test/a2a-card.test.ts
git commit -m "feat(a2a): project agentcall cards to A2A AgentCards"
```

---

### Task 4: Relay card routes

Mount the origin well-known directory card and the per-handle registry card, with the caching headers the TCK checks and version rejection.

**Files:**
- Create: `apps/relay/src/a2a.ts`
- Modify: `apps/relay/src/index.ts` (mount the routes; the existing `/v1/card/:handle` is left untouched)
- Test: `apps/relay/test/a2a-card.test.ts`

**Interfaces:**
- Consumes: `toAgentCard`, `toDirectoryCard`, `a2aError`, `standardError`, `isSupportedA2AVersion`, `A2A_VERSION_HEADER` from `@benree/agentcall-shared`; `CardUpload` from the same package.
- Produces: `mountA2A(app: Hono<{ Bindings: Env }>): void`, and these routes:
  - `GET /.well-known/agent-card.json`
  - `GET /v1/a2a/:handle/agent-card.json`

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/a2a-card.test.ts`. Follow the existing helpers in `apps/relay/test/helpers.ts` for seeding a card — read that file first and reuse its registration helper rather than inventing one.

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./apply-migrations.js";

const ORIGIN = "https://example.com";

async function seedCard(handle: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO handles (handle, token_hash) VALUES (?, ?)")
    .bind(handle, "x").run();
  await env.DB.prepare("INSERT OR REPLACE INTO cards (handle, card_json, updated_at) VALUES (?, ?, ?)")
    .bind(
      handle,
      JSON.stringify({
        description: "Ken's agent",
        agent_kind: "claude",
        tasks: [{ id: "ask", name: "Ask", description: "Answer a question.", examples: [] }],
        default_offer: ["ask"],
        grants: { someoneelse: ["secret-task"] },
      }),
      1,
    )
    .run();
}

beforeEach(async () => {
  await applyMigrations();
  await seedCard("ken");
});

describe("GET /.well-known/agent-card.json", () => {
  it("serves the relay directory card", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json<any>();
    expect(card.name).toBe("agentcall relay");
    expect(card.supportedInterfaces[0].protocolBinding).toBe("HTTP+JSON");
  });

  it("sets the caching headers the TCK checks", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/agent-card.json`);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("last-modified")).toBeTruthy();
  });
});

describe("GET /v1/a2a/:handle/agent-card.json", () => {
  it("serves a conformant card for a known handle", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json<any>();
    expect(card.name).toBe("ken");
    expect(card.skills.map((s: any) => s.id)).toEqual(["ask"]);
    expect(card.supportedInterfaces[0].url).toBe(`${ORIGIN}/v1/a2a/ken`);
    expect(card.supportedInterfaces[0].tenant).toBe("ken");
  });

  it("never exposes grants or agent_kind", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`);
    const body = await res.text();
    expect(body).not.toContain("grants");
    expect(body).not.toContain("secret-task");
    expect(body).not.toContain("agent_kind");
  });

  it("sets caching headers", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("returns an AIP-193 404 for an unknown handle", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/nobody/agent-card.json`);
    expect(res.status).toBe(404);
    const body = await res.json<any>();
    expect(body.error.code).toBe(404);
    expect(typeof body.error.code).toBe("number");
  });

  it("rejects an unsupported A2A-Version with VersionNotSupported", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, {
      headers: { "A2A-Version": "0.3" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error.details[0].reason).toBe("VERSION_NOT_SUPPORTED");
    expect(body.error.details[0].domain).toBe("a2a-protocol.org");
  });

  it("accepts the advertised A2A-Version", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/a2a/ken/agent-card.json`, {
      headers: { "A2A-Version": "1.0" },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay && pnpm vitest run test/a2a-card.test.ts`
Expected: FAIL — all requests 404, because the routes do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `apps/relay/src/a2a.ts`:

```ts
import type { Hono } from "hono";
// Type-only, so the index -> a2a -> index cycle is erased at compile time and
// never exists at runtime. Do not turn this into a value import.
import type { Env } from "./index.js";
import {
  A2A_VERSION_HEADER, CardUpload, a2aError, isSupportedA2AVersion,
  standardError, toAgentCard, toDirectoryCard,
} from "@benree/agentcall-shared";

// The card endpoint is public and cheap; a short TTL keeps the TCK's
// Cache-Control/ETag checks satisfied without making policy edits slow to
// propagate. `updated_at` supplies a real Last-Modified and a stable ETag.
const CARD_MAX_AGE = 300;

function cardHeaders(etagSource: string, updatedAtMs: number): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${CARD_MAX_AGE}`,
    ETag: `"${etagSource}"`,
    "Last-Modified": new Date(updatedAtMs).toUTCString(),
  };
}

export function mountA2A(app: Hono<{ Bindings: Env }>): void {
  app.get("/.well-known/agent-card.json", (c) => {
    const version = c.req.header(A2A_VERSION_HEADER);
    if (!isSupportedA2AVersion(version)) {
      const { status, body } = a2aError("VersionNotSupported", `unsupported A2A-Version: ${version}`);
      return c.json(body, status as 400);
    }
    const origin = new URL(c.req.url).origin;
    const card = toDirectoryCard({ origin });
    return c.json(card, 200, cardHeaders(`dir-${CARD_MAX_AGE}`, 0));
  });

  app.get("/v1/a2a/:handle/agent-card.json", async (c) => {
    const version = c.req.header(A2A_VERSION_HEADER);
    if (!isSupportedA2AVersion(version)) {
      const { status, body } = a2aError("VersionNotSupported", `unsupported A2A-Version: ${version}`);
      return c.json(body, status as 400);
    }

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.READ_RL.limit({ key: ip })).success) {
      const { status, body } = standardError(429, "rate limited");
      return c.json(body, status as 429);
    }

    const handle = c.req.param("handle");
    const row = await c.env.DB.prepare(
      "SELECT card_json, updated_at FROM cards WHERE handle = ?",
    ).bind(handle).first<{ card_json: string; updated_at: number }>();

    // §3.3.2 Resource category — a plain 404, NOT TaskNotFoundError, which is
    // an A2A-specific error about tasks and would be semantically wrong for a
    // missing agent. The same section requires that servers MUST NOT reveal
    // the existence of resources the client is not authorized to access and
    // SHOULD NOT distinguish "does not exist" from "not authorized", so an
    // unknown handle and a blocked caller must be indistinguishable here. Keep
    // the message generic for that reason.
    if (!row) {
      const { status, body } = standardError(404, "no such agent");
      return c.json(body, status as 404);
    }

    const upload = CardUpload.parse(JSON.parse(row.card_json));
    // Public view only in this plan: default_offer, never per-caller grants.
    // The authenticated extended view is GetExtendedAgentCard, which arrives
    // with the operations in Plan 2.
    const visible = new Set(upload.default_offer);
    const origin = new URL(c.req.url).origin;
    const card = toAgentCard({
      handle,
      description: upload.description,
      tasks: upload.tasks.filter((t) => visible.has(t.id)),
      baseUrl: `${origin}/v1/a2a/${handle}`,
    });

    return c.json(card, 200, cardHeaders(`${handle}-${row.updated_at}`, row.updated_at));
  });
}
```

- [ ] **Step 4: Mount the routes**

Modify `apps/relay/src/index.ts`. Add the import near the other imports:

```ts
import { mountA2A } from "./a2a.js";
```

Then, immediately after the `const app = new Hono<{ Bindings: Env }>()` line, add:

```ts
mountA2A(app);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/relay && pnpm vitest run test/a2a-card.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the full relay suite for regressions**

Run: `cd apps/relay && pnpm test`
Expected: all green — the legacy `/v1/card/:handle` tests in `test/card.test.ts` must still pass untouched.

- [ ] **Step 7: Commit**

```bash
git add apps/relay/src/a2a.ts apps/relay/src/index.ts apps/relay/test/a2a-card.test.ts
git commit -m "feat(relay): serve A2A agent cards at the well-known and registry paths"
```

---

### Task 5: TCK card-suite gate

Prove the card surface against the real conformance suite rather than only our own tests.

**Files:**
- Create: `scripts/tck.sh`
- Create: `docs/superpowers/plans/2026-08-01-a2a-card-surface-baseline.md` (the recorded run output)

**Interfaces:**
- Consumes: the routes from Task 4.
- Produces: a reproducible command and a recorded baseline.

- [ ] **Step 1: Write the runner script**

Create `scripts/tck.sh`:

```bash
#!/usr/bin/env bash
# Runs the A2A TCK against a locally-running relay.
#
# Pinned deliberately: the baseline is only comparable if both the suite and
# the spec it vendors stay fixed. Bump TCK_REF on purpose, never incidentally.
set -euo pipefail

TCK_REF="5996b79f9cefa6fc390980e383e358a66fb9e49e"
TCK_DIR="${TMPDIR:-/tmp}/a2a-tck"
SUT="${1:-http://localhost:8787}"

if [ ! -d "$TCK_DIR" ]; then
  git clone https://github.com/a2aproject/a2a-tck.git "$TCK_DIR"
fi
git -C "$TCK_DIR" fetch --depth 50 origin
git -C "$TCK_DIR" checkout --quiet "$TCK_REF"

cd "$TCK_DIR"
uv venv --quiet
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install --quiet -e .

./run_tck.py --sut-host "$SUT" --transport http_json --level must -- \
  tests/compatibility/agent_card
```

- [ ] **Step 2: Make it executable and commit the script**

```bash
chmod +x scripts/tck.sh
git add scripts/tck.sh
git commit -m "chore(a2a): pin and script the TCK card-suite run"
```

- [ ] **Step 3: Start the relay locally**

Run: `cd apps/relay && pnpm dev`
Expected: `wrangler dev` listening on `http://localhost:8787`. Leave it running in a second terminal.

- [ ] **Step 4: Seed a handle with a card**

The TCK needs a real card to fetch. In a second terminal, register a handle and publish a card against the local relay:

```bash
curl -s -X POST http://localhost:8787/v1/register \
  -H 'content-type: application/json' \
  -d '{"handle":"ken","agent_kind":"claude"}'
```

Capture the returned `token`, then:

```bash
curl -s -X PUT http://localhost:8787/v1/card \
  -H 'content-type: application/json' \
  -H 'X-AgentCall-Handle: ken' \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"description":"Ken'\''s agent","agent_kind":"claude","tasks":[{"id":"ask","name":"Ask","description":"Answer a question.","examples":[]}],"default_offer":["ask"],"grants":{}}'
```

Verify: `curl -s http://localhost:8787/v1/a2a/ken/agent-card.json | head -c 200`
Expected: JSON beginning `{"name":"ken"`

- [ ] **Step 5: Run the TCK card suite**

Run: `./scripts/tck.sh http://localhost:8787`
Expected: the `agent_card` MUST tests pass. `CARD-DISC-001`, `CARD-STRUCT-001`, `CARD-PROTO-001`, and `CARD-PROTO-002` must all be green — those are the four this plan is responsible for.

If `CARD-STRUCT-001` fails on schema validation, compare the emitted card against `specification/a2a.json` in the TCK checkout (`$TMPDIR/a2a-tck/specification/a2a.json`, the `"Agent Card"` definition) and fix `toAgentCard` — do not relax the test.

- [ ] **Step 6: Record the baseline**

Create `docs/superpowers/plans/2026-08-01-a2a-card-surface-baseline.md` containing: the exact command run, the TCK ref, the pass/fail counts, and the per-requirement table from `reports/compatibility.json`. This is the artifact the CI gate will compare against in Plan 3.

- [ ] **Step 7: Full repo verification**

Run from the repo root: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all green. Per CLAUDE.md this is required before the task is done, and `pnpm -r test` is the only thing that catches stale call sites in `test/`.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-a2a-card-surface-baseline.md
git commit -m "docs(a2a): record the TCK card-suite baseline"
```

---

## Out of scope for this plan

Deliberately excluded — each has its own home:

- **Task store and operations** (`message:send`, `GetTask`, `ListTasks`, `CancelTask`, SSE) — Plan 2.
- **`GetExtendedAgentCard`** — the authenticated per-caller card view. Plan 2, with the operations.
- **CLI as an A2A client**, and the TCK as a CI gate over the full suite — Plan 3.
- **Durable mailbox** and the transport decision (D.2) — [durable-offline-delivery](../specs/2026-08-01-durable-offline-delivery-requirements.md).
- **Push notifications, WebSocket binding, listener/spawn/tool-guard changes** — non-goals in the spec.
- **A2A-principal → agentcall-caller identity mapping**, and the endpoint-security release gate — both block *public* release, not this work. Build behind the existing route surface.
