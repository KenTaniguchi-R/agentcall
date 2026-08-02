import { describe, expect, it } from "vitest";
import { CardTask, MAX_TASK_KEYWORDS, MAX_KEYWORD_LENGTH } from "../src/card.js";
import {
  BundleEntry, MAX_BUNDLE_BYTES, MAX_BUNDLE_TASKS_PER_CARD, MAX_ROSTER_MEMBERS,
  ROSTER_ID_RE, RosterBundle,
} from "../src/roster.js";
import { MAX_TASK_ID_LENGTH } from "../src/protocol.js";

const ENTRY = {
  handle: "tanaka", agent_kind: "claude", updated_at: 1, truncated: false,
  tasks: [{ id: "adr", name: "ADR", description: "Why.", keywords: ["auth"] }],
};

describe("roster ids", () => {
  it("accepts a generated-shape id", () => {
    expect(ROSTER_ID_RE.test("aBc-123_xyzQRS0987")).toBe(true);
  });
  it("rejects a too-short id, a path traversal, and a slash", () => {
    for (const bad of ["short", "../etc/passwd", "a/b", ""]) {
      expect(ROSTER_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe("RosterBundle", () => {
  it("round-trips", () => {
    const b = RosterBundle.parse({ roster_id: "a".repeat(22), entries: [ENTRY], skipped: 0 });
    expect(b.entries[0]!.tasks[0]!.keywords).toEqual(["auth"]);
  });
  it("rejects an entry with more than MAX_BUNDLE_TASKS_PER_CARD tasks", () => {
    const tasks = Array.from({ length: MAX_BUNDLE_TASKS_PER_CARD + 1 }, (_, i) => ({
      id: `t${i}`, name: "N", description: "D", keywords: [],
    }));
    expect(RosterBundle.safeParse({
      roster_id: "a".repeat(22), entries: [{ ...ENTRY, tasks }], skipped: 0,
    }).success).toBe(false);
  });
  it("rejects more than MAX_ROSTER_MEMBERS entries", () => {
    const entries = Array.from({ length: MAX_ROSTER_MEMBERS + 1 }, (_, i) => ({
      ...ENTRY, handle: `h${i}`,
    }));
    expect(RosterBundle.safeParse({ roster_id: "a".repeat(22), entries, skipped: 0 }).success).toBe(false);
  });
  it("carries no `examples` field — they are deliberately not indexed", () => {
    const parsed = BundleEntry.parse(ENTRY);
    expect("examples" in parsed.tasks[0]!).toBe(false);
  });
});

describe("the bounds are arithmetic, not hope", () => {
  // This is the guard the spec calls for: raising MAX_CARD_TASKS or any card
  // field cap later must fail HERE rather than blow the response budget in
  // production. MAX_BUNDLE_BYTES is a design ceiling asserted by test, not a
  // runtime check that truncates a response.
  it("worst-case bundle stays under MAX_BUNDLE_BYTES", () => {
    const shape = CardTask.shape;
    const maxName = shape.name.maxLength ?? 0;
    const maxDescription = shape.description.maxLength ?? 0;
    const worstTask = MAX_TASK_ID_LENGTH + maxName + maxDescription + MAX_TASK_KEYWORDS * MAX_KEYWORD_LENGTH; // id + name + description + keywords
    const worst = MAX_ROSTER_MEMBERS * MAX_BUNDLE_TASKS_PER_CARD * worstTask;
    expect(worst).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
  });
});
