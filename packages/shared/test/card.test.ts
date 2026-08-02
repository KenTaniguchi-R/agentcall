import { describe, expect, it } from "vitest";
import { CardTask, CardUpload, visibleTasks } from "../src/card.js";

const TASK = { id: "ask", name: "Ask", description: "Answer questions.", examples: [] };

describe("CardTask.keywords", () => {
  it("defaults to [] for a card stored before the field existed", () => {
    // This is the back-compat mechanism: .default([]) supplies the missing
    // field. (Zod's unknown-key stripping is a different property — it is what
    // let `tier` be removed — and is NOT what makes additions safe.)
    expect(CardTask.parse(TASK).keywords).toEqual([]);
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

  it("keeps parsing a whole CardUpload stored before the field existed", () => {
    const upload = CardUpload.parse({
      description: "d", agent_kind: "claude", tasks: [TASK], default_offer: ["ask"],
    });
    expect(upload.tasks[0]!.keywords).toEqual([]);
  });
});

const UPLOAD = CardUpload.parse({
  description: "d", agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [] },
    { id: "adr", name: "ADR", description: "Why.", examples: [] },
    { id: "payroll", name: "Payroll", description: "Secret.", examples: [] },
  ],
  default_offer: ["ask"],
  grants: { mia: ["adr"] },
});

describe("visibleTasks", () => {
  it("gives an anonymous viewer only default_offer", () => {
    expect(visibleTasks(UPLOAD, "").map((t) => t.id)).toEqual(["ask"]);
  });
  it("unions default_offer with the viewer's own grants", () => {
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr"]);
  });
  it("never leaks a task granted to someone else", () => {
    expect(visibleTasks(UPLOAD, "bob").map((t) => t.id)).toEqual(["ask"]);
  });
  it("returns tasks in card order, not grant order", () => {
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr"]);
  });
  // Regression: `grants` is a zod record inheriting Object.prototype, and
  // HANDLE_RE accepts "constructor". A bare grants[viewer] lookup returns the
  // Object constructor, which is not iterable and 500s the caller.
  it("does not hand back Object.prototype members for a viewer named constructor", () => {
    expect(visibleTasks(UPLOAD, "constructor").map((t) => t.id)).toEqual(["ask"]);
  });
});
