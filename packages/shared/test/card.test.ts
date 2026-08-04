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
      description: "d", agent_kind: "claude", tasks: [TASK], default_offer: ["ask"],
    }).success).toBe(false);
  });
});

const UPLOAD = CardUpload.parse({
  description: "d", agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [], keywords: [] },
    { id: "adr", name: "ADR", description: "Why.", examples: [], keywords: [] },
    { id: "payroll", name: "Payroll", description: "Secret.", examples: [], keywords: [] },
  ],
  default_offer: ["ask"],
  // mia's grants are deliberately out of card order (payroll before adr):
  // with a single granted task, grant order and card order always coincide
  // and the "card order, not grant order" test below can't tell them apart.
  // With two, a grant-order implementation would produce ask, payroll, adr —
  // distinct from the card-order ask, adr, payroll both tests assert below.
  grants: { mia: ["payroll", "adr"] },
  group_grants: { ["g".repeat(22)]: ["adr"] },
  blocked: ["blocked-user"],
});

describe("visibleTasks", () => {
  it("gives an anonymous viewer only default_offer", () => {
    expect(visibleTasks(UPLOAD, "").map((t) => t.id)).toEqual(["ask"]);
  });
  it("unions default_offer with the viewer's own grants", () => {
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr", "payroll"]);
  });
  it("never leaks a task granted to someone else", () => {
    expect(visibleTasks(UPLOAD, "bob").map((t) => t.id)).toEqual(["ask"]);
  });
  it("unions only relay-attested group grants", () => {
    expect(visibleTasks(UPLOAD, "bob", ["g".repeat(22)]).map((t) => t.id)).toEqual(["ask", "adr"]);
    expect(visibleTasks(UPLOAD, "bob", ["x".repeat(22)]).map((t) => t.id)).toEqual(["ask"]);
  });
  it("lets an individual block outrank defaults and group grants", () => {
    expect(visibleTasks(UPLOAD, "blocked-user", ["g".repeat(22)])).toEqual([]);
  });
  it("rejects more than the bounded number of group grants", () => {
    const group_grants = Object.fromEntries(Array.from(
      { length: 51 }, (_, i) => [`${String(i).padStart(2, "0")}${"g".repeat(20)}`, ["ask"]],
    ));
    expect(CardUpload.safeParse({ ...UPLOAD, group_grants }).success).toBe(false);
  });
  it("returns tasks in card order, not grant order", () => {
    // mia's grants are ["payroll", "adr"] — grant order. A buggy
    // implementation that appended grants in THAT order (rather than
    // filtering the card's own task list) would produce
    // ["ask", "payroll", "adr"] here instead.
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr", "payroll"]);
  });
  // Regression: `grants` is a zod record inheriting Object.prototype, and
  // HANDLE_RE accepts "constructor". A bare grants[viewer] lookup returns the
  // Object constructor, which is not iterable and 500s the caller.
  it("does not hand back Object.prototype members for a viewer named constructor", () => {
    expect(visibleTasks(UPLOAD, "constructor").map((t) => t.id)).toEqual(["ask"]);
  });
});
