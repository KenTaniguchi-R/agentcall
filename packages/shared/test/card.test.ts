import { describe, expect, it } from "vitest";
import { CardTask, CardUpload } from "../src/card.js";

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
