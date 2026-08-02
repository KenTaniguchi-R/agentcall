import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy, loadUserPolicy, offeredFor, resolveTask, savePolicy, type Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import { getPaths } from "../src/paths.js";

const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: [], keywords: [], envelope: { caps: ["read"] }, threadable: true, skill: "",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], keywords: [], envelope: { caps: ["read", "fetch"] }, threadable: true, skill: "",
};
const TASKS = [ASK_TASK, intro, meet];
const ENG = "e".repeat(22);

const policy: Policy = {
  description: "",
  default_offer: ["ask", "owner-introduction"],
  callers: {
    ken: { offer: ["schedule-meeting"], block: false },
    spammer: { offer: [], block: true },
  },
  groups: { eng: { roster_id: ENG, offer: ["schedule-meeting"] } },
};

// HANDLE_RE accepts "constructor", and a zod z.record / JSON.parse object
// inherits Object.prototype — so an unguarded `callers[from]` lookup finds the
// Object constructor instead of undefined. These lock in that such a caller is
// treated as an ordinary, unknown caller.
describe("Object.prototype-named callers", () => {
  it("offeredFor treats an unknown prototype-named caller as an ordinary caller", () => {
    expect(offeredFor(policy, "constructor")).toEqual(["ask", "owner-introduction"]);
  });
  it("offeredFor honours a real entry for a prototype-named caller", () => {
    const withEntry: Policy = { ...policy, callers: { ...policy.callers, constructor: { offer: [], block: true } } };
    expect(offeredFor(withEntry, "constructor")).toBe("blocked");
  });
  it("resolveTask still resolves a default task for a prototype-named caller", () => {
    const r = resolveTask(policy, TASKS, "constructor");
    expect(r.ok).toBe(true);
  });
});

describe("loadPolicy", () => {
  it("returns DEFAULT_POLICY when the file doesn't exist", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    expect(loadPolicy(p)).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.default_offer).toEqual(["ask"]);
  });
  it("throws on a malformed policy file (fail closed, never silently default)", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, "{not json");
    expect(() => loadPolicy(p)).toThrow();
  });
  it("accepts +-prefixed offer entries (spec syntax) by stripping the prefix", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask"], callers: { ken: { offer: ["+schedule-meeting"] } },
    }));
    expect(offeredFor(loadPolicy(p), "ken")).toEqual(["ask", "schedule-meeting"]);
  });

  it("applies a managed task ceiling to defaults, callers, and attested groups", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-pol-"));
    const p = { ...getPaths(home), managedPolicyFile: join(home, "managed-policy.json") };
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(policy));
    writeFileSync(p.managedPolicyFile, JSON.stringify({
      version: 1,
      allowed_tasks: ["ask", "schedule-meeting"],
    }));

    const effective = loadPolicy(p);
    expect(effective.default_offer).toEqual(["ask"]);
    expect(effective.callers.ken.offer).toEqual(["schedule-meeting"]);
    expect(effective.groups.eng.offer).toEqual(["schedule-meeting"]);
    expect(offeredFor(effective, "ken")).toEqual(["ask", "schedule-meeting"]);
  });

  it("makes managed caller blocks unoverridable without rewriting user policy", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-pol-"));
    const p = { ...getPaths(home), managedPolicyFile: join(home, "managed-policy.json") };
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(policy));
    writeFileSync(p.managedPolicyFile, JSON.stringify({
      version: 1,
      blocked_callers: ["ken", "constructor"],
    }));

    const effective = loadPolicy(p);
    expect(offeredFor(effective, "ken")).toBe("blocked");
    expect(offeredFor(effective, "constructor")).toBe("blocked");
    expect(Object.hasOwn(effective.callers, "constructor")).toBe(true);
    expect(offeredFor(loadUserPolicy(p), "ken")).toEqual([
      "ask", "owner-introduction", "schedule-meeting",
    ]);
  });

  it("fails closed when a managed policy exists but is invalid", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-pol-"));
    const p = { ...getPaths(home), managedPolicyFile: join(home, "managed-policy.json") };
    writeFileSync(p.managedPolicyFile, JSON.stringify({ version: 1, allowed_tasks: "ask" }));
    expect(() => loadPolicy(p)).toThrow(/managed policy/i);
  });

  it("fails closed when a managed policy exists but cannot be read", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-pol-"));
    const p = { ...getPaths(home), managedPolicyFile: join(home, "managed-policy.json") };
    writeFileSync(p.managedPolicyFile, JSON.stringify({ version: 1 }));
    chmodSync(p.managedPolicyFile, 0o000);
    try {
      expect(() => loadPolicy(p)).toThrow(/managed policy.*unreadable/i);
    } finally {
      chmodSync(p.managedPolicyFile, 0o600);
    }
  });

  it("treats a missing managed policy as no administrator restriction", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-pol-"));
    const p = { ...getPaths(home), managedPolicyFile: join(home, "missing-managed-policy.json") };
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(policy));
    expect(loadPolicy(p)).toEqual(policy);
  });

  it("rejects an effective block union too large for the relay card", () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-pol-"));
    const p = { ...getPaths(home), managedPolicyFile: join(home, "managed-policy.json") };
    mkdirSync(dirname(p.policyFile), { recursive: true });
    const callers = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [
      `user-${i}`,
      { offer: [], block: true },
    ]));
    writeFileSync(p.policyFile, JSON.stringify({ default_offer: ["ask"], callers }));

    writeFileSync(p.managedPolicyFile, JSON.stringify({ version: 1, blocked_callers: ["user-0"] }));
    expect(() => loadPolicy(p)).not.toThrow();

    writeFileSync(p.managedPolicyFile, JSON.stringify({ version: 1, blocked_callers: ["extra-user"] }));
    expect(() => loadPolicy(p)).toThrow(/at most 200.*enforced and published/i);
  });
});

describe("offeredFor", () => {
  it("returns default_offer for unknown callers", () => {
    expect(offeredFor(policy, "stranger")).toEqual(["ask", "owner-introduction"]);
  });
  it("adds per-caller grants to the default offer", () => {
    expect(offeredFor(policy, "ken")).toEqual(["ask", "owner-introduction", "schedule-meeting"]);
  });
  it("returns 'blocked' for blocked callers", () => {
    expect(offeredFor(policy, "spammer")).toBe("blocked");
  });
  it("unions grants from relay-attested groups", () => {
    expect(offeredFor(policy, "stranger", [ENG])).toEqual(["ask", "owner-introduction", "schedule-meeting"]);
  });
  it("ignores unknown and un-attested groups", () => {
    expect(offeredFor(policy, "stranger", ["x".repeat(22)])).toEqual(["ask", "owner-introduction"]);
    expect(offeredFor(policy, "stranger")).toEqual(["ask", "owner-introduction"]);
  });
  it("lets an individual block outrank an attested group grant", () => {
    expect(offeredFor(policy, "spammer", [ENG])).toBe("blocked");
  });
});

describe("resolveTask", () => {
  it("blocked caller -> blocked, offered stays empty (no menu leak to blocked callers)", () => {
    expect(resolveTask(policy, TASKS, "spammer", "ask")).toEqual({ ok: false, code: "blocked", offered: [] });
  });
  it("explicit granted task resolves", () => {
    const r = resolveTask(policy, TASKS, "ken", "schedule-meeting");
    expect(r).toMatchObject({ ok: true, task: { id: "schedule-meeting" } });
  });
  it("explicit group-granted task resolves only with relay attestation", () => {
    expect(resolveTask(policy, TASKS, "stranger", "schedule-meeting", [ENG]))
      .toMatchObject({ ok: true, task: { id: "schedule-meeting" } });
    expect(resolveTask(policy, TASKS, "stranger", "schedule-meeting"))
      .toMatchObject({ ok: false, code: "task_not_offered" });
  });
  it("explicit existing-but-ungranted task -> task_not_offered with the caller's menu", () => {
    expect(resolveTask(policy, TASKS, "stranger", "schedule-meeting")).toEqual({
      ok: false, code: "task_not_offered", offered: ["ask", "owner-introduction"],
    });
  });
  it("explicit nonexistent task -> task_unknown with the caller's menu", () => {
    expect(resolveTask(policy, TASKS, "ken", "no-such-task")).toEqual({
      ok: false, code: "task_unknown", offered: ["ask", "owner-introduction", "schedule-meeting"],
    });
  });
  it("no task requested -> falls back to ask when offered", () => {
    expect(resolveTask(policy, TASKS, "stranger")).toMatchObject({ ok: true, task: { id: "ask" } });
  });
  it("no task requested, single non-ask offer -> that task", () => {
    const p: Policy = { description: "", default_offer: ["owner-introduction"], callers: {}, groups: {} };
    expect(resolveTask(p, TASKS, "x")).toMatchObject({ ok: true, task: { id: "owner-introduction" } });
  });
  it("no task requested, multiple offers, no ask -> task_not_offered (caller must pick)", () => {
    const p: Policy = { description: "", default_offer: ["owner-introduction", "schedule-meeting"], callers: {}, groups: {} };
    expect(resolveTask(p, TASKS, "x")).toEqual({
      ok: false, code: "task_not_offered", offered: ["owner-introduction", "schedule-meeting"],
    });
  });
  it("offered ids with no matching task on disk are dropped from the menu", () => {
    const p: Policy = { description: "", default_offer: ["ask", "deleted-task"], callers: {}, groups: {} };
    expect(resolveTask(p, TASKS, "x", "deleted-task")).toEqual({
      ok: false, code: "task_unknown", offered: ["ask"],
    });
  });
  it("invite-only policy (empty default_offer, no callers) -> task_not_offered with an empty menu", () => {
    const p: Policy = { description: "", default_offer: [], callers: {}, groups: {} };
    expect(resolveTask(p, TASKS, "x")).toEqual({
      ok: false, code: "task_not_offered", offered: [],
    });
  });
});

describe("savePolicy", () => {
  it("round-trips through loadPolicy", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    const pol: Policy = {
      description: "x", default_offer: ["ask"], callers: { ken: { offer: ["a-task"], block: false } },
      groups: { eng: { roster_id: ENG, offer: ["a-task"] } },
    };
    savePolicy(p, pol);
    expect(loadPolicy(p)).toEqual(pol);
  });
});
