import { describe, expect, it } from "vitest";
import { CardTask, CardUpload, visibleTasks } from "../src/card.js";

const TASK = { id: "ask", name: "Ask", description: "Answer questions.", examples: [], keywords: [] };

describe("CardTask.keywords", () => {
  it("requires the current keyword field", () => {
    const { keywords: _, ...withoutKeywords } = TASK;
    expect(CardTask.safeParse(withoutKeywords).success).toBe(false);
  });

  it("round-trips supplied keywords", () => {
    expect(CardTask.parse({ ...TASK, keywords: ["auth", "migration"] }).keywords)
      .toEqual(["auth", "migration"]);
  });

  it("rejects a keyword longer than 40 characters", () => {
    expect(CardTask.safeParse({ ...TASK, keywords: ["a".repeat(41)] }).success).toBe(false);
  });

  it("rejects an empty-string keyword", () => {
    expect(CardTask.safeParse({ ...TASK, keywords: [""] }).success).toBe(false);
  });

  it("rejects a 21st keyword", () => {
    const many = Array.from({ length: 21 }, (_, i) => `k${i}`);
    expect(CardTask.safeParse({ ...TASK, keywords: many }).success).toBe(false);
  });

  it("requires the complete current upload shape", () => {
    expect(CardUpload.safeParse({
      description: "d", agent_kind: "claude", tasks: [TASK],
    }).success).toBe(false);
  });

  it("defaults legacy uploads to mailbox disabled and round-trips explicit opt-in", () => {
    const legacy = CardUpload.parse({
      description: "d", agent_kind: "claude", tasks: [TASK], blocked: [],
    });
    expect(legacy.offline_delivery).toEqual({ enabled: false });
    expect(CardUpload.parse({
      ...legacy, offline_delivery: { enabled: true },
    }).offline_delivery).toEqual({ enabled: true });
  });

  // #379 deleted the per-caller menu from the card. A file still carrying it
  // must fail rather than parse with the menu silently ignored — a card that
  // quietly drops `grants` would advertise every task to callers the owner
  // believed were restricted.
  it("rejects an upload still carrying the deleted task menu", () => {
    const base = { description: "d", agent_kind: "claude", tasks: [TASK], blocked: [] };
    for (const menu of [
      { default_offer: ["ask"] },
      { grants: { mia: ["ask"] } },
      { group_grants: { ["g".repeat(22)]: ["ask"] } },
    ]) {
      expect(CardUpload.safeParse({ ...base, ...menu }).success).toBe(false);
    }
  });
});

const UPLOAD = CardUpload.parse({
  description: "d", agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [], keywords: [] },
    { id: "adr", name: "ADR", description: "Why.", examples: [], keywords: [] },
    { id: "payroll", name: "Payroll", description: "Secret.", examples: [], keywords: [] },
  ],
  blocked: ["blocked-user"],
});

describe("visibleTasks", () => {
  // The whole rule after #379: blocked sees nothing, everyone else sees
  // everything. A task is no longer individually granted, so there is no
  // per-viewer difference left for the card to encode — what an ANSWER may
  // contain is decided on the callee's machine, by clearance, and is never
  // published here.
  it("gives every unblocked viewer the whole task list", () => {
    for (const viewer of ["", "mia", "bob"]) {
      expect(visibleTasks(UPLOAD, viewer).map((t) => t.id)).toEqual(["ask", "adr", "payroll"]);
    }
  });
  it("gives a blocked viewer nothing at all", () => {
    expect(visibleTasks(UPLOAD, "blocked-user")).toEqual([]);
  });
  it("returns tasks in card order", () => {
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr", "payroll"]);
  });
  // Regression, kept from the menu era: HANDLE_RE accepts "constructor", and
  // the old `grants[viewer]` lookup handed back the Object constructor — not
  // iterable, 500ing the endpoint. There is no record lookup left to trip on,
  // and this pins that a prototype-shaped viewer stays an ordinary one.
  it("treats a viewer named constructor as an ordinary viewer", () => {
    expect(visibleTasks(UPLOAD, "constructor").map((t) => t.id)).toEqual(["ask", "adr", "payroll"]);
  });
});
