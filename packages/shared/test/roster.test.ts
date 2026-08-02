import { describe, expect, it } from "vitest";
import { CardTask, MAX_TASK_KEYWORDS, MAX_KEYWORD_LENGTH } from "../src/card.js";
import {
  BundleEntry, CreateRosterResponse, ExpelRosterRequest, IssueRosterJoinKeyRequest,
  JoinRosterRequest, ListRosterJoinKeysResponse, MAX_BUNDLE_BYTES, MAX_BUNDLE_TASKS_PER_CARD,
  MAX_ROSTER_MEMBERS, RevokeRosterJoinKeyRequest, ROSTER_ID_RE, RosterBundle,
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

describe("roster lifecycle protocol", () => {
  it("keeps keyed join and administrative authority separate", () => {
    expect(CreateRosterResponse.parse({
      roster_id: "a".repeat(22), join_key: `agjk_${"a".repeat(12)}_${"s".repeat(32)}`, admin_secret: "admin",
    })).toBeTruthy();
    expect(JoinRosterRequest.safeParse({ join_key: `agjk_${"a".repeat(12)}_${"s".repeat(32)}` }).success).toBe(true);
    expect(JoinRosterRequest.safeParse({ join_secret: "old-wire-shape" }).success).toBe(false);
  });

  it("validates lifecycle inputs", () => {
    expect(ExpelRosterRequest.safeParse({ admin_secret: "admin", handle: "valid-handle" }).success).toBe(true);
    expect(ExpelRosterRequest.safeParse({ admin_secret: "admin", handle: "INVALID" }).success).toBe(false);
    expect(IssueRosterJoinKeyRequest.parse({ admin_secret: "admin" })).toMatchObject({
      description: "", expires_in_days: 30, reusable: false,
    });
    expect(IssueRosterJoinKeyRequest.safeParse({ admin_secret: "admin", expires_in_days: 91 }).success).toBe(false);
    expect(RevokeRosterJoinKeyRequest.parse({ admin_secret: "admin", prefix: "a".repeat(12) }).evict).toBe(false);
    expect(RevokeRosterJoinKeyRequest.safeParse({ admin_secret: "admin", prefix: "not-a-prefix" }).success).toBe(false);
  });

  it("lists metadata without returning join key secrets", () => {
    const response = ListRosterJoinKeysResponse.parse({ keys: [{
      prefix: "a".repeat(12), description: "contractor", created_by: "tanaka", created_at: 1, expires_at: 2,
      reusable: false, used: true, revoked_at: null,
    }] });
    expect(response.keys[0]).not.toHaveProperty("join_key");
    expect(response.keys[0]).not.toHaveProperty("secret_hash");
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
