import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessFor } from "../src/access.js";
import { DEFAULT_POLICY, loadPolicy, loadUserPolicy, resolveTask, savePolicy, type Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

function linePaths(home: string) {
  return getLinePaths(getMachinePaths(home, home), "line");
}

// The managed ceiling is MACHINE-scoped and its real path is deliberately
// unredirectable (paths.ts), so a test cannot point AGENTCALL_HOME at it —
// it overrides the field on MachinePaths instead. The line's own policyFile
// stays per-line.
function managedLinePaths(home: string) {
  const m = getMachinePaths(home, home);
  return getLinePaths({ ...m, managedPolicyFile: join(home, "managed-policy.json") }, "line");
}

function missingManagedLinePaths(home: string) {
  const m = getMachinePaths(home, home);
  return getLinePaths({ ...m, managedPolicyFile: join(home, "missing-managed-policy.json") }, "line");
}

const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: [], keywords: [], threadable: true, skill: "",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], keywords: [], threadable: true, skill: "",
};
const TASKS = [ASK_TASK, intro, meet];
const ENG = "e".repeat(22);

const policy: Policy = {
  description: "",
  default_access: "allowed", callers: {
    ken: {},
    spammer: { access: "blocked" },
  },
  groups: { eng: { roster_id: ENG } },
};

describe("loadPolicy", () => {
  it("returns DEFAULT_POLICY when the file doesn't exist", () => {
    const p = linePaths(tempDir("agentcall-pol-"));
    expect(loadPolicy(p)).toEqual(DEFAULT_POLICY);
    // public is the level that reveals least: a fresh install grants nothing
    // beyond what any registered caller may already see.
    expect(DEFAULT_POLICY.default_access).toBe("allowed");
  });
  it("throws on a malformed policy file (fail closed, never silently default)", () => {
    const p = linePaths(tempDir("agentcall-pol-"));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, "{not json");
    expect(() => loadPolicy(p)).toThrow();
  });
  it("rejects unknown root and nested fields instead of silently stripping typos", () => {
    const cases = [
      { default_tests: [{ caller: "mia", expect_access: "allowed" }] },
      { default_access: "allowed", callers: { mia: { blok: true } } },
      { groups: { eng: { roster_id: ENG, acccess: "allowed" } } },
    ];
    for (const value of cases) {
      const p = linePaths(tempDir("agentcall-pol-"));
      mkdirSync(dirname(p.policyFile), { recursive: true });
      writeFileSync(p.policyFile, JSON.stringify(value));
      expect(() => loadPolicy(p)).toThrow(/user policy is invalid/);
    }
  });
  // The task menu is gone: a task is no longer individually granted, so there
  // are no grant entries left for the spec's "+" prefix to appear on.
  it("rejects a policy file that still carries the deleted task menu", () => {
    for (const value of [
      { default_offer: ["ask"] },
      { callers: { ken: { offer: ["schedule-meeting"] } } },
      { groups: { eng: { roster_id: ENG, offer: ["schedule-meeting"] } } },
    ]) {
      const p = linePaths(tempDir("agentcall-pol-"));
      mkdirSync(dirname(p.policyFile), { recursive: true });
      writeFileSync(p.policyFile, JSON.stringify(value));
      expect(() => loadPolicy(p)).toThrow(/user policy is invalid/);
    }
  });

  it("applies a managed access ceiling to the default, callers, and attested groups", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      ...policy, default_access: "allowed",
    }));
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({
      version: 1,
      max_clearance: "blocked",
    }));

    // An administrator ceiling can only close. It caps the values the owner
    // actually wrote — the default here — and what matters is the RESOLUTION:
    // `ken` has no explicit access, so nothing is written into their entry, and
    // they come back blocked through the capped default rather than through a
    // rewritten record.
    const effective = loadPolicy(p);
    expect(effective.default_access).toBe("blocked");
    expect(effective.callers.ken!.access).toBeUndefined();
    expect(accessFor(effective, "ken", [ENG])).toBe("blocked");
  });

  it("leaves clearances alone when the administrator sets no ceiling", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(policy));
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1 }));
    expect(accessFor(loadPolicy(p), "ken")).toBe("allowed");
  });

  it("makes managed caller blocks unoverridable without rewriting user policy", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(policy));
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({
      version: 1,
      blocked_callers: ["ken", "constructor"],
    }));

    const effective = loadPolicy(p);
    expect(accessFor(effective, "ken")).toBe("blocked");
    expect(accessFor(effective, "constructor")).toBe("blocked");
    expect(Object.hasOwn(effective.callers, "constructor")).toBe(true);
    expect(accessFor(loadUserPolicy(p), "ken")).toBe("allowed");
  });

  it("fails closed when a managed policy exists but is invalid", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1, max_clearance: "secret" }));
    expect(() => loadPolicy(p)).toThrow(/managed policy/i);
  });

  it("fails closed when a managed policy exists but cannot be read", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1 }));
    chmodSync(p.machine.managedPolicyFile, 0o000);
    try {
      expect(() => loadPolicy(p)).toThrow(/managed policy.*unreadable/i);
    } finally {
      chmodSync(p.machine.managedPolicyFile, 0o600);
    }
  });

  it("treats a missing managed policy as no administrator restriction", () => {
    const home = tempDir("agentcall-pol-");
    const p = missingManagedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify(policy));
    expect(loadPolicy(p)).toEqual(policy);
  });

  it("rejects an effective block union too large for the relay card", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    const callers = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [
      `user-${i}`,
      { access: "blocked" },
    ]));
    writeFileSync(p.policyFile, JSON.stringify({ callers }));

    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1, blocked_callers: ["user-0"] }));
    expect(() => loadPolicy(p)).not.toThrow();

    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1, blocked_callers: ["extra-user"] }));
    expect(() => loadPolicy(p)).toThrow(/at most 200.*enforced and published/i);
  });

  it("accepts assertions over default, named, blocked, and relay-attested clearances", () => {
    const p = linePaths(tempDir("agentcall-pol-"));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      ...policy,
      tests: [
        { caller: "ken", expect_access: "allowed" },
        { caller: "spammer", expect_access: "blocked" },
        { caller: "stranger", expect_access: "allowed" },
        { caller: "stranger", groups: ["eng"], expect_access: "allowed" },
      ],
    }));
    expect(() => loadPolicy(p)).not.toThrow();
  });

  it("rejects assertions with no expectation, an ungrantable one, or an unknown group", () => {
    const p = linePaths(tempDir("agentcall-pol-"));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({ tests: [{ caller: "ken" }] }));
    expect(() => loadPolicy(p)).toThrow(/user policy is invalid/);
    // `secret` means "never leaves"; no clearance grants it, so no assertion
    // can expect it either. Same structural exclusion as AccessSchema.
    writeFileSync(p.policyFile, JSON.stringify({
      tests: [{ caller: "ken", expect_access: "internal" }],
    }));
    expect(() => loadPolicy(p)).toThrow(/user policy is invalid/);
    writeFileSync(p.policyFile, JSON.stringify({
      tests: [{ caller: "ken", groups: ["missing"], expect_access: "allowed" }],
    }));
    expect(() => loadPolicy(p)).toThrow(/unknown groups.*missing/i);
  });

  it("fails closed when a user assertion does not match the effective clearance", () => {
    const p = linePaths(tempDir("agentcall-pol-"));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      tests: [{ caller: "ken", expect_access: "blocked" }],
    }));
    expect(() => loadPolicy(p)).toThrow(/user policy assertion 1.*expected blocked.*got allowed/i);
    // Raw loading remains available so CLI editing commands can repair a
    // failing assertion instead of being locked out by it.
    expect(loadUserPolicy(p).tests).toHaveLength(1);
  });

  it("evaluates user assertions after the managed clearance ceiling", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      tests: [{ caller: "ken", expect_access: "blocked" }],
    }));
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1, max_clearance: "allowed" }));
    expect(() => loadPolicy(p)).toThrow(/user policy assertion 1.*expected blocked.*got allowed/i);
  });

  it("lets managed assertions prove an administrator block survived user policy", () => {
    const home = tempDir("agentcall-pol-");
    const p = managedLinePaths(home);
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      default_access: "allowed", callers: { ken: { access: "allowed" } },
    }));
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({
      version: 1, blocked_callers: ["ken"], tests: [{ caller: "ken", expect_access: "blocked" }],
    }));
    expect(() => loadPolicy(p)).not.toThrow();

    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({
      version: 1, tests: [{ caller: "ken", expect_access: "blocked" }],
    }));
    expect(() => loadPolicy(p)).toThrow(/managed policy assertion 1/i);
  });
});

// resolveTask no longer consults a menu: a task is not individually granted,
// so the only questions left are "is this caller blocked" and "does the
// requested task exist on disk". What the answer may CONTAIN is decided later,
// by accessFor against the sensitivity of what the task read.
describe("resolveTask", () => {
  it("blocked caller -> blocked, offered stays empty (no task-list leak to blocked callers)", () => {
    expect(resolveTask(policy, TASKS, "spammer", "ask")).toEqual({ ok: false, code: "blocked", offered: [] });
  });
  it("lets an individual block outrank an attested group clearance", () => {
    expect(resolveTask(policy, TASKS, "spammer", "ask", [ENG]))
      .toEqual({ ok: false, code: "blocked", offered: [] });
  });
  it("resolves any task on disk for any caller who is not blocked", () => {
    expect(resolveTask(policy, TASKS, "stranger", "schedule-meeting"))
      .toMatchObject({ ok: true, task: { id: "schedule-meeting" } });
    expect(resolveTask(policy, TASKS, "ken", "owner-introduction"))
      .toMatchObject({ ok: true, task: { id: "owner-introduction" } });
  });
  it("needs no relay attestation to reach a task, only to raise clearance", () => {
    // The group grant used to expand a menu. It now only expands what the
    // reply may contain, so attestation is not a gate on task resolution.
    expect(resolveTask(policy, TASKS, "stranger", "schedule-meeting", [ENG]))
      .toMatchObject({ ok: true, task: { id: "schedule-meeting" } });
  });
  it("nonexistent task -> task_unknown with the tasks that do exist", () => {
    expect(resolveTask(policy, TASKS, "ken", "no-such-task")).toEqual({
      ok: false, code: "task_unknown", offered: ["ask", "owner-introduction", "schedule-meeting"],
    });
  });
  it("no task requested -> the built-in ask task", () => {
    expect(resolveTask(policy, TASKS, "stranger")).toMatchObject({ ok: true, task: { id: "ask" } });
  });
  it("no task requested -> ask even when other tasks exist, so a plain call never ambiguates", () => {
    expect(resolveTask(policy, [ASK_TASK, intro, meet], "x")).toMatchObject({ ok: true, task: { id: "ask" } });
  });
  // HANDLE_RE accepts "constructor", and a zod z.record / JSON.parse object
  // inherits Object.prototype, so an unguarded `callers[from]` finds the Object
  // constructor instead of undefined. resolveTask reaches that lookup through
  // accessFor's `ownEntry` guard (access.test.ts pins it directly); this
  // pins the outcome at the admission gate that actually uses it.
  it("treats a prototype-named caller as an ordinary, unblocked caller", () => {
    expect(resolveTask(policy, TASKS, "constructor")).toMatchObject({ ok: true, task: { id: "ask" } });
  });
  it("honours a real block entry for a prototype-named caller", () => {
    const withEntry: Policy = { ...policy, callers: { ...policy.callers, constructor: { access: "blocked" as const } } };
    expect(resolveTask(withEntry, TASKS, "constructor")).toEqual({ ok: false, code: "blocked", offered: [] });
  });
});

describe("savePolicy", () => {
  it("round-trips through loadPolicy", () => {
    const p = linePaths(tempDir("agentcall-pol-"));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    const pol: Policy = {
      description: "x", default_access: "allowed", callers: { ken: {} },
      groups: { eng: { roster_id: ENG } },
    };
    savePolicy(p, pol);
    expect(loadPolicy(p)).toEqual(pol);
  });
});
