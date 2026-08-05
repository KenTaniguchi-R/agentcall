import { describe, expect, it } from "vitest";
import {
  E2EECallerFrame, E2EEListenerToRelayFrame, E2EERelayToCallerFrame, E2EERelayToListenerFrame,
  E2EERequestPayload, E2EEOutcome,
  formatAddress, HANDLE_RE, MAX_MESSAGE_BYTES, parseAddress, parseKeyAddress, safeParseFrame,
  RegisterRequest, MAX_DETAIL_LENGTH, sanitizeDetail, sanitizeTerminalOutput,
  sanitizeTerminalCell, stringifyTerminalSafeJson,
  CallAccepted, CallStarted, CancelCall, CallCancelled, CallNotCancelled,
  AGENT_KINDS, AgentKindSchema,
  TASK_ID_RE, MAX_TASK_ID_LENGTH,
  CORRELATION_ID_RE, normalizeTraceparent, CallStatus,
  CONTEXT_ID_RE, ErrorCode,
  CONTEXT_TTL_MS, MAX_CONTEXT_TURNS, MAX_CONTEXTS, RATE_LIMIT_PER_HOUR,
  RecoveryIssueRequest, RecoveryRedeemRequest, RecoveryReceipt,
} from "../src/index.js";

const requestEnvelope = {
  v: 1 as const, direction: "request" as const, relay_origin: "relay.test",
  from: "alice@relay.test", to: "ken@relay.test", key_id: "a".repeat(32),
  epoch: 1, enc: "A", ct: "B",
};

const innerRequest = {
  v: 1 as const, direction: "request" as const, relay_origin: "relay.test",
  from: "alice@relay.test", to: "ken@relay.test", request_id: "1".repeat(32),
  sender_identity_key_id: "2".repeat(32), recipient_encryption_key_id: "3".repeat(32),
  recipient_epoch: 1, issued_at: 1, expires_at: 2, message: "hi",
};

describe("handle rules", () => {
  it("accepts valid handles", () => {
    for (const h of ["ken", "a1", "my-agent-01"]) expect(HANDLE_RE.test(h)).toBe(true);
  });
  it("rejects invalid handles", () => {
    for (const h of ["K", "-a", "a", "a".repeat(32), "a_b", "a b", ""]) expect(HANDLE_RE.test(h)).toBe(false);
  });
});

describe("recovery protocol", () => {
  const digest = "a".repeat(64);
  const request = {
    org: "acme", handle: "alice", generation: 1,
    current_recovery_proof: "proof-" + "x".repeat(40),
    operation_id: "A".repeat(22), client_token_digest: digest,
    client_public_id: `act_${digest.slice(0, 16)}`,
    successor_recovery_digest: "b".repeat(64),
    successor_recovery_public_id: `agr_${"b".repeat(16)}`,
  };

  it("strictly validates issue and redeem payloads", () => {
    expect(RecoveryIssueRequest.safeParse({
      expected_generation: 0,
      successor_recovery_digest: digest,
      successor_recovery_public_id: `agr_${digest.slice(0, 16)}`,
    }).success).toBe(true);
    expect(RecoveryRedeemRequest.safeParse(request).success).toBe(true);
    expect(RecoveryRedeemRequest.safeParse({ ...request, token: "secret" }).success).toBe(false);
  });

  it("keeps proofs out of public receipts", () => {
    const receipt = RecoveryReceipt.parse({
      org: "acme", handle: "alice", operation_id: request.operation_id,
      consumed_generation: 1, recovery_generation: 2,
      client_public_id: request.client_public_id,
      recovery_public_id: request.successor_recovery_public_id,
      committed_at: 1, eviction_confirmed: true,
    });
    expect(JSON.stringify(receipt)).not.toContain("proof");
  });
});

describe("task id bounds", () => {
  it("MAX_TASK_ID_LENGTH matches TASK_ID_RE", () => {
    // A MAX_TASK_ID_LENGTH-character id (all a's) must match.
    expect(TASK_ID_RE.test("a".repeat(MAX_TASK_ID_LENGTH))).toBe(true);
    // One character longer must not match.
    expect(TASK_ID_RE.test("a".repeat(MAX_TASK_ID_LENGTH + 1))).toBe(false);
  });
});

describe("address grammar", () => {
  it("splits @org/handle", () => {
    expect(parseKeyAddress("@acme/ken")).toEqual({ org: "acme", handle: "ken" });
  });

  it("round-trips through formatAddress", () => {
    expect(parseKeyAddress(formatAddress("acme", "ken"))).toEqual({ org: "acme", handle: "ken" });
    expect(formatAddress("acme", "ken")).toBe("@acme/ken");
  });

  // The whole point of the format: an address is a registry key, so nothing
  // that looks like a host may parse. A DNS-shaped address promises resolution
  // this system does not implement.
  it("rejects every host-shaped form", () => {
    expect(parseKeyAddress("ken@agentcall.benree.tech")).toBeNull();
    expect(parseKeyAddress("ken@acme.agentcall.agent-call.app")).toBeNull();
    expect(parseKeyAddress("ken@acme")).toBeNull();
    expect(parseKeyAddress("@acme.corp/ken")).toBeNull();
    expect(parseKeyAddress("@acme/ken.tech")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseKeyAddress("ken")).toBeNull();
    expect(parseKeyAddress("@acme/")).toBeNull();
    expect(parseKeyAddress("@/ken")).toBeNull();
    expect(parseKeyAddress("acme/ken")).toBeNull();
    expect(parseKeyAddress("@ACME/ken")).toBeNull();
    expect(parseKeyAddress("@acme/KEN")).toBeNull();
    expect(parseKeyAddress("@acme/ken/extra")).toBeNull();
    expect(parseKeyAddress("")).toBeNull();
  });

  // Leading and trailing whitespace is the paste hazard: addresses are copied
  // out of chat and docs. Reject rather than trim, so a mis-scoped address can
  // never be silently normalised into a valid one.
  it("rejects surrounding whitespace rather than trimming", () => {
    expect(parseKeyAddress(" @acme/ken")).toBeNull();
    expect(parseKeyAddress("@acme/ken ")).toBeNull();
  });

  it("enforces the org length cap so the address stays short", () => {
    expect(parseKeyAddress(`@${"a".repeat(20)}/ken`)).not.toBeNull();
    expect(parseKeyAddress(`@${"a".repeat(21)}/ken`)).toBeNull();
  });
});

describe("frames", () => {
  it("round-trips an encrypted call_request", () => {
    const f = { type: "call_request", envelope: requestEnvelope, correlation_id: "a".repeat(32) };
    expect(safeParseFrame(E2EECallerFrame, JSON.stringify(f))).toEqual(f);
  });
  it("rejects unknown type via safeParseFrame", () => {
    expect(safeParseFrame(E2EECallerFrame, JSON.stringify({ type: "nope" }))).toBeNull();
    expect(safeParseFrame(E2EECallerFrame, "not json")).toBeNull();
  });
  it("relay->caller errors are explicitly relay-originated", () => {
    expect(safeParseFrame(E2EERelayToCallerFrame, JSON.stringify({
      type: "call_error", origin: "relay", code: "offline",
    }))).not.toBeNull();
    expect(safeParseFrame(E2EERelayToCallerFrame, JSON.stringify({
      type: "call_error", code: "offline",
    }))).toBeNull();
  });
  it("exposes size constants", () => {
    expect(MAX_MESSAGE_BYTES).toBe(64_000);
  });
});

describe("call correlation", () => {
  const correlationId = "1".repeat(32);
  const parentId = "2".repeat(16);
  const matching = `00-${correlationId}-${parentId}-01`;

  it("accepts bounded lowercase non-zero correlation ids", () => {
    expect(CORRELATION_ID_RE.test(correlationId)).toBe(true);
    expect(CORRELATION_ID_RE.test("0".repeat(32))).toBe(false);
    expect(CORRELATION_ID_RE.test("A".repeat(32))).toBe(false);
  });

  it("keeps only a valid version-00 traceparent matching correlation_id", () => {
    expect(normalizeTraceparent(correlationId, matching)).toBe(matching);
    expect(normalizeTraceparent(correlationId, `00-${"3".repeat(32)}-${parentId}-01`)).toBeUndefined();
    expect(normalizeTraceparent(correlationId, `00-${correlationId}-${"0".repeat(16)}-01`)).toBeUndefined();
    expect(normalizeTraceparent(correlationId, `01-${correlationId}-${parentId}-01`)).toBeUndefined();
    expect(normalizeTraceparent(correlationId, `${matching}x`)).toBeUndefined();
    expect(normalizeTraceparent(correlationId, 42)).toBeUndefined();
  });

  it("ignores invalid optional traceparent without rejecting a valid call", () => {
    const parsed = E2EECallerFrame.parse({
      type: "call_request", envelope: requestEnvelope, correlation_id: correlationId,
      traceparent: `00-${"3".repeat(32)}-${parentId}-01`,
    });
    expect(parsed).toMatchObject({ correlation_id: correlationId });
    expect(parsed).not.toHaveProperty("traceparent");
  });

  it("keeps correlation fields optional on operational status frames", () => {
    expect(CallStatus.safeParse({ type: "call_status", state: "ringing" }).success).toBe(true);
    expect(CallStatus.safeParse({
      type: "call_status", state: "ringing", call_id: "c1", correlation_id: correlationId,
    }).success).toBe(true);
  });
});

// sanitizeTerminalOutput deliberately keeps \n and \t so a multi-line agent
// reply stays readable. A single-line field in an aligned listing cannot
// afford either: a newline forges a whole extra row, and a tab shifts every
// column after it. sanitizeTerminalCell is that stricter variant.
describe("sanitizeTerminalCell", () => {
  it("strips the newline that would forge an extra row in a listing", () => {
    const forged = sanitizeTerminalCell("contractor\nactive  member  2099-01-01  spoofed");
    expect(forged).not.toContain("\n");
    expect(forged).toContain("contractor");
  });

  it("strips tabs, which would shift every column in a tab-delimited row", () => {
    expect(sanitizeTerminalCell("a\tb")).toBe("a b");
  });

  it("still strips what sanitizeTerminalOutput strips - ESC, C1, CR and bidi", () => {
    // Erase-line plus carriage-return is the pair that hides an already-printed row.
    const erasing = sanitizeTerminalCell("\u001b[2K\rgone");
    expect(erasing).not.toContain("\u001b");
    expect(erasing).not.toContain("\r");
    expect(sanitizeTerminalCell("\u009b31m")).not.toContain("\u009b");
    expect(sanitizeTerminalCell("real \u202espoof")).toBe("real  spoof");
  });

  it("leaves ordinary text, including non-ASCII, alone", () => {
    expect(sanitizeTerminalCell("contractor ok")).toBe("contractor ok");
  });

  it("is strictly stronger than sanitizeTerminalOutput on the same input", () => {
    const input = "one\ntwo";
    expect(sanitizeTerminalOutput(input)).toContain("\n");
    expect(sanitizeTerminalCell(input)).toBe("one two");
  });
});

describe("detail bounds and sanitization", () => {
  it("sanitizeDetail strips the ESC that makes a CSI/OSC sequence dangerous", () => {
    const out = sanitizeDetail("\u001b[31mred\u001b[0m\u001b]0;pwned");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("red");
  });

  it("sanitizeDetail strips 8-bit C1 introducers, not just ESC", () => {
    expect(sanitizeDetail("\u009b31m")).not.toContain("\u009b");
  });

  it("sanitizeDetail neutralizes carriage-return line overwriting", () => {
    expect(sanitizeDetail("real error\rFAKE SUCCESS")).not.toContain("\r");
  });

  it("sanitizeDetail replaces controls with a space so words don't run together", () => {
    expect(sanitizeDetail("line one\nline two")).toBe("line one line two");
  });

  it("sanitizeDetail leaves ordinary text (including non-ASCII) alone", () => {
    expect(sanitizeDetail("agent failed — 日本語 ok")).toBe("agent failed — 日本語 ok");
  });

  it("sanitizeDetail neutralizes Unicode bidi formatting", () => {
    expect(sanitizeDetail("real \u202espoof")).toBe("real  spoof");
  });

  it("sanitizeDetail truncates to MAX_DETAIL_LENGTH without splitting a surrogate pair", () => {
    expect(sanitizeDetail("x".repeat(MAX_DETAIL_LENGTH + 50)).length).toBe(MAX_DETAIL_LENGTH);
    // An astral char straddling the cut must be dropped whole, never halved.
    const straddling = "a".repeat(MAX_DETAIL_LENGTH - 1) + "😀";
    const cut = sanitizeDetail(straddling);
    expect(cut.length).toBe(MAX_DETAIL_LENGTH - 1);
    expect(/[\ud800-\udfff]/.test(cut)).toBe(false);
  });

  it("sanitized output always satisfies the encrypted failure detail bound", () => {
    const hostile = ("\u001b[2J" + "y".repeat(50)).repeat(100);
    const detail = sanitizeDetail(hostile);
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH);
  });
});

describe("terminal reply sanitization", () => {
  it("preserves line feeds and tabs while neutralizing all other C0/C1 controls", () => {
    const out = sanitizeTerminalOutput("one\n\ttwo\u001b[2J\rFAKE\u009b31m");
    expect(out).toContain("one\n\ttwo");
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
  });

  it("neutralizes bidi overrides and isolates without changing ordinary Unicode", () => {
    expect(sanitizeTerminalOutput("日本語 \u202espoof \u2066isolate")).toBe("日本語  spoof  isolate");
  });

  it("neutralizes every prohibited C0/C1, DEL, and Unicode Bidi_Control code point", () => {
    const codePoints = [
      ...Array.from({ length: 0x09 }, (_, i) => i),
      ...Array.from({ length: 0x1f - 0x0b + 1 }, (_, i) => 0x0b + i),
      ...Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => 0x7f + i),
      0x061c, 0x200e, 0x200f,
      ...Array.from({ length: 0x202e - 0x202a + 1 }, (_, i) => 0x202a + i),
      ...Array.from({ length: 0x2069 - 0x2066 + 1 }, (_, i) => 0x2066 + i),
    ];
    const prohibited = codePoints.map((codePoint) => String.fromCodePoint(codePoint));
    const out = sanitizeTerminalOutput(`safe\t\n${prohibited.join("")}done`);

    expect(out).toContain("safe\t\n");
    expect(out).toContain("done");
    for (const char of prohibited) expect(out).not.toContain(char);
  });

  it("Unicode-escapes JSON characters that JSON.stringify leaves terminal-active", () => {
    const value = { text: "esc\u001b c1\u009b bidi\u202e" };
    const json = stringifyTerminalSafeJson(value);
    expect(json).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe("RegisterRequest", () => {
  it("parses with and without agent_kind (absent = caller-only)", () => {
    const invite = "i".repeat(40);
    expect(RegisterRequest.parse({ invite, handle: "ken", agent_kind: "claude" }))
      .toEqual({ invite, handle: "ken", agent_kind: "claude" });
    expect(RegisterRequest.parse({ invite, handle: "solo" })).toEqual({ invite, handle: "solo" });
  });

  it("requires an invite and does not accept a client-selected organization", () => {
    expect(RegisterRequest.safeParse({ handle: "ken" }).success).toBe(false);
    expect(RegisterRequest.safeParse({ org: "acme", handle: "ken" }).success).toBe(false);
  });
  it("still rejects invalid agent kinds", () => {
    expect(RegisterRequest.safeParse({ invite: "i".repeat(40), handle: "ken", agent_kind: "vim" }).success).toBe(false);
  });
});

describe("AgentKind", () => {
  it("exposes the known agent kinds", () => {
    expect(AGENT_KINDS).toEqual(["claude", "codex"]);
  });

  it("accepts a known kind and rejects an unknown one", () => {
    expect(AgentKindSchema.parse("codex")).toBe("codex");
    expect(AgentKindSchema.safeParse("hermes").success).toBe(false);
  });
});

describe("cancellation and acknowledgement frames", () => {
  it("accepts the acknowledgement frames", () => {
    expect(CallAccepted.safeParse({ type: "call_accepted", call_id: "c1" }).success).toBe(true);
    expect(CallStarted.safeParse({ type: "call_started", call_id: "c1" }).success).toBe(true);
  });

  it("accepts cancel_call from the relay", () => {
    expect(CancelCall.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(true);
  });

  it("requires a phase on call_cancelled", () => {
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "running" }).success).toBe(true);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "pending" }).success).toBe(true);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1" }).success).toBe(false);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "elsewhere" }).success).toBe(false);
  });

  it("constrains call_not_cancelled reasons", () => {
    for (const reason of ["already_terminal", "unknown", "too_late"]) {
      expect(CallNotCancelled.safeParse({ type: "call_not_cancelled", call_id: "c1", reason }).success).toBe(true);
    }
    expect(CallNotCancelled.safeParse({ type: "call_not_cancelled", call_id: "c1", reason: "because" }).success).toBe(false);
  });

  it("routes the new frames through the right unions", () => {
    for (const f of [
      { type: "call_accepted", call_id: "c1" },
      { type: "call_started", call_id: "c1" },
      { type: "call_cancelled", call_id: "c1", phase: "running" },
      { type: "call_not_cancelled", call_id: "c1", reason: "too_late" },
    ]) {
      expect(E2EEListenerToRelayFrame.safeParse(f).success, JSON.stringify(f)).toBe(true);
      expect(E2EERelayToListenerFrame.safeParse(f).success, JSON.stringify(f)).toBe(false);
    }
    expect(E2EERelayToListenerFrame.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(true);
    expect(E2EEListenerToRelayFrame.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(false);
  });
});

describe("context_id", () => {
  const good = "ctx_AAAAAAAAAAAAAAAAAAAAAA"; // 22 base64url chars

  it("accepts a minted id", () => {
    expect(CONTEXT_ID_RE.test(good)).toBe(true);
    // Exercises the full base64url alphabet: upper, lower, digit, - and _.
    expect(CONTEXT_ID_RE.test("ctx_aB3-_xxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("rejects wrong prefix, wrong length, and non-base64url characters", () => {
    expect(CONTEXT_ID_RE.test("AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(CONTEXT_ID_RE.test("sess_AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAAAAA")).toBe(false);  // 21
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAAAAAAA")).toBe(false); // 23
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAAAA+/")).toBe(false);
    expect(CONTEXT_ID_RE.test("ctx_AAAAAAAAAAAAAAAAAA\nAA")).toBe(false);
  });

  // The old MAX_SESSION_ID_LENGTH cap allowed any string up to 256 bytes.
  // A consumed field gets a shape, not a size limit.
  it("rejects a 256-char string the old length cap allowed", () => {
    expect(E2EERequestPayload.safeParse({ ...innerRequest, context_id: "x".repeat(256) }).success).toBe(false);
  });

  it("round-trips inside encrypted request/reply payloads and stays optional", () => {
    expect(E2EERequestPayload.safeParse({ ...innerRequest, context_id: good }).success).toBe(true);
    expect(E2EERequestPayload.safeParse(innerRequest).success).toBe(true);
    expect(E2EEOutcome.safeParse({ kind: "reply", text: "ok", context_id: good }).success).toBe(true);
  });

  it("adds context_unknown to the error codes", () => {
    expect(ErrorCode.safeParse("context_unknown").success).toBe(true);
  });

  it("exports threading bounds and the raised rate limit", () => {
    expect(CONTEXT_TTL_MS).toBe(1_800_000);
    expect(MAX_CONTEXT_TURNS).toBe(10);
    expect(MAX_CONTEXTS).toBe(100);
    expect(RATE_LIMIT_PER_HOUR).toBe(30);
  });
});
