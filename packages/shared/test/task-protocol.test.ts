import { describe, expect, it } from "vitest";
import {
  AgentCard, CardUpload, E2EEOutcome, E2EERequestPayload,
  ErrorCode, MAX_OFFERED_TASKS, TASK_ID_RE,
} from "../src/index.js";

const request = {
  v: 1 as const, direction: "request" as const, relay_origin: "relay.test",
  from: "@acme/alice", to: "@acme/ken", request_id: "1".repeat(32),
  sender_identity_key_id: "2".repeat(32), recipient_encryption_key_id: "3".repeat(32),
  recipient_epoch: 1, issued_at: 1, expires_at: 2, message: "hi",
};

describe("task fields inside encrypted payloads", () => {
  it("accepts a request payload with an optional task id", () => {
    const ok = E2EERequestPayload.safeParse({ ...request, task: "schedule-meeting" });
    expect(ok.success).toBe(true);
    const noTask = E2EERequestPayload.safeParse(request);
    expect(noTask.success).toBe(true);
  });
  it("rejects a malformed task id", () => {
    const bad = E2EERequestPayload.safeParse({ ...request, task: "Bad_Task!" });
    expect(bad.success).toBe(false);
  });
  it("carries task on a successful encrypted outcome", () => {
    expect(E2EEOutcome.safeParse({ kind: "reply", text: "t", task: "ask" }).success).toBe(true);
  });
  it("carries offered[] on an authenticated failure outcome", () => {
    expect(E2EEOutcome.safeParse({
      kind: "failure", code: "task_unknown", offered: ["ask"],
    }).success).toBe(true);
  });
  it("rejects an offered[] entry that isn't a valid task id (terminal-injection guard)", () => {
    const badFailed = E2EEOutcome.safeParse({
      kind: "failure", code: "task_unknown", offered: ["Bad\x1b[31mTask"],
    });
    expect(badFailed.success).toBe(false);
  });
  it("rejects offered[] longer than MAX_OFFERED_TASKS (unbounded relay payload guard)", () => {
    const tooMany = Array.from({ length: MAX_OFFERED_TASKS + 1 }, (_, i) => `task-${i}`);
    expect(E2EEOutcome.safeParse({
      kind: "failure", code: "task_unknown", offered: tooMany,
    }).success).toBe(false);
  });
  it("still accepts a valid offered[] list at or under the cap", () => {
    const okMany = Array.from({ length: MAX_OFFERED_TASKS }, (_, i) => `task-${i}`);
    expect(E2EEOutcome.safeParse({
      kind: "failure", code: "task_unknown", offered: okMany,
    }).success).toBe(true);
  });
  it("accepts the new error codes", () => {
    for (const code of ["blocked", "task_unknown", "canceled"]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
  // #379 deleted the task menu, and with it the only outcome that could report
  // "you may not have this task". Pinned as a rejection rather than dropped:
  // a code that silently starts parsing again would resurrect the concept with
  // no mechanism behind it.
  it("rejects task_not_offered, which nothing can emit since the menu was deleted", () => {
    expect(ErrorCode.safeParse("task_not_offered").success).toBe(false);
    expect(E2EEOutcome.safeParse({ kind: "failure", code: "task_not_offered" }).success).toBe(false);
  });
  it("keeps cancellation out of peer-authenticated failure outcomes", () => {
    expect(E2EEOutcome.safeParse({ kind: "failure", code: "canceled" }).success).toBe(false);
  });
});

describe("TASK_ID_RE", () => {
  it("accepts kebab-case ids and rejects uppercase/underscore/empty", () => {
    expect(TASK_ID_RE.test("schedule-meeting")).toBe(true);
    expect(TASK_ID_RE.test("ask")).toBe(true);
    expect(TASK_ID_RE.test("Bad")).toBe(false);
    expect(TASK_ID_RE.test("a_b")).toBe(false);
    expect(TASK_ID_RE.test("")).toBe(false);
  });
});

describe("card schemas", () => {
  const task = { id: "ask", name: "Ask", description: "Answer questions.", examples: [], keywords: [] };
  const upload = {
    description: "", agent_kind: "claude" as const, tasks: [task], blocked: [],
  };
  it("round-trips a current CardUpload", () => {
    expect(CardUpload.parse(upload)).toEqual(upload);
  });
  // The per-caller grant map went with #379's task menu. `blocked` is the only
  // handle-keyed field left on a card, and it is still held to the handle
  // shape — this is the same check, on the field that survived.
  it("rejects an invalid handle in the blocked list", () => {
    expect(CardUpload.safeParse({ ...upload, blocked: ["Bad Handle"] }).success).toBe(false);
  });
  it("rejects the removed tier field", () => {
    expect(CardUpload.safeParse({ ...upload, tasks: [{ ...task, tier: "T2" }] }).success).toBe(false);
  });
  it("round-trips an AgentCard (the relay's GET response shape)", () => {
    const card = AgentCard.parse({
      handle: "ken", description: "", agent_kind: "claude",
      tasks: [task], updated_at: 1752600000000,
    });
    expect(card.tasks).toHaveLength(1);
  });
});
