import { describe, expect, it } from "vitest";
import { execVerb } from "../src/verbs.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";

const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], tier: "T1", envelope: { caps: ["read"] }, skill: "",
};
const TASKS = [ASK_TASK, meet];
const base: Policy = { description: "", default_offer: ["ask"], callers: {} };

describe("execVerb", () => {
  it("allow grants a task and reports the caller's effective menu", () => {
    const { policy, lines } = execVerb(base, TASKS, "allow", "ken", "schedule-meeting");
    expect(policy.callers.ken).toEqual({ offer: ["schedule-meeting"], block: false });
    expect(base.callers.ken).toBeUndefined(); // pure: input untouched
    expect(lines.join("\n")).toContain("ken can now: ask, schedule-meeting");
  });
  it("allow is idempotent", () => {
    const once = execVerb(base, TASKS, "allow", "ken", "schedule-meeting").policy;
    const twice = execVerb(once, TASKS, "allow", "ken", "schedule-meeting").policy;
    expect(twice.callers.ken!.offer).toEqual(["schedule-meeting"]);
  });
  it("allow on a task with no manifest on disk is a hard error naming the fix", () => {
    expect(() => execVerb(base, TASKS, "allow", "ken", "ghost-task"))
      .toThrow(/agentcall task new ghost-task/);
  });
  it("allow validates the handle", () => {
    expect(() => execVerb(base, TASKS, "allow", "Bad Handle", "ask")).toThrow(/handle/i);
  });
  it("revoke removes a grant and drops an empty, unblocked caller entry", () => {
    const granted = execVerb(base, TASKS, "allow", "ken", "schedule-meeting").policy;
    const { policy } = execVerb(granted, TASKS, "revoke", "ken", "schedule-meeting");
    expect(policy.callers.ken).toBeUndefined();
  });
  it("revoke of a nonexistent grant is a no-op, not an error", () => {
    expect(() => execVerb(base, TASKS, "revoke", "ken", "schedule-meeting")).not.toThrow();
  });
  it("block sets the flag and survives revoke-to-empty; unblock clears it", () => {
    const blocked = execVerb(base, TASKS, "block", "spammer").policy;
    expect(blocked.callers.spammer).toEqual({ offer: [], block: true });
    const stillBlocked = execVerb(blocked, TASKS, "revoke", "spammer", "anything").policy;
    expect(stillBlocked.callers.spammer!.block).toBe(true); // blocked entry never dropped
    const un = execVerb(stillBlocked, TASKS, "unblock", "spammer").policy;
    expect(un.callers.spammer).toBeUndefined();
  });
  it("offer/unoffer edit default_offer and report the public menu", () => {
    const { policy, lines } = execVerb(base, TASKS, "offer", "schedule-meeting");
    expect(policy.default_offer).toEqual(["ask", "schedule-meeting"]);
    expect(lines.join("\n")).toContain("Offered to anyone: ask, schedule-meeting");
    const { policy: p2 } = execVerb(policy, TASKS, "unoffer", "schedule-meeting");
    expect(p2.default_offer).toEqual(["ask"]);
  });
  it("offer on a missing task is a hard error", () => {
    expect(() => execVerb(base, TASKS, "offer", "ghost-task")).toThrow(/agentcall task new ghost-task/);
  });
  it("block reports; allow on a blocked caller still records the grant but says so", () => {
    const blocked = execVerb(base, TASKS, "block", "spammer").policy;
    const { policy, lines } = execVerb(blocked, TASKS, "allow", "spammer", "schedule-meeting");
    expect(policy.callers.spammer).toEqual({ offer: ["schedule-meeting"], block: true });
    expect(lines.join("\n")).toContain("blocked");
  });
  // `policy.callers` is a JSON.parse'd / zod z.record object, so it inherits
  // Object.prototype — and HANDLE_RE accepts "constructor". Without an
  // own-property guard, every lookup below resolves to the Object constructor
  // and throws, making a caller with that handle impossible to block.
  it("handles a caller named after an Object.prototype key", () => {
    const { policy, lines } = execVerb(base, TASKS, "block", "constructor");
    expect(policy.callers.constructor).toEqual({ offer: [], block: true });
    expect(lines.join("\n")).toContain("constructor is blocked.");
  });
  it("allow works for a caller named after an Object.prototype key", () => {
    const { policy } = execVerb(base, TASKS, "allow", "constructor", "schedule-meeting");
    expect(policy.callers.constructor).toEqual({ offer: ["schedule-meeting"], block: false });
  });
  it("revoke/unblock stay no-ops for an Object.prototype-named caller with no entry", () => {
    expect(execVerb(base, TASKS, "revoke", "constructor", "ask").lines.join("\n"))
      .toContain("constructor has no grants.");
    expect(execVerb(base, TASKS, "unblock", "constructor").lines.join("\n"))
      .toContain("constructor is not blocked.");
  });

  it("allow's printed menu drops a dangling policy id with no manifest on disk", () => {
    const dangling: Policy = { description: "", default_offer: ["ask", "gone"], callers: {} };
    const { lines } = execVerb(dangling, TASKS, "allow", "ken", "schedule-meeting");
    expect(lines.join("\n")).not.toContain("gone");
    expect(lines.join("\n")).toContain("ken can now: ask, schedule-meeting");
  });
  it("offer's printed menu drops a dangling policy id with no manifest on disk", () => {
    const dangling: Policy = { description: "", default_offer: ["ask", "gone"], callers: {} };
    const { lines } = execVerb(dangling, TASKS, "offer", "schedule-meeting");
    expect(lines.join("\n")).not.toContain("gone");
    expect(lines.join("\n")).toContain("Offered to anyone: ask, schedule-meeting");
  });
});
