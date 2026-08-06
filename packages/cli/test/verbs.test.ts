import { describe, expect, it } from "vitest";
import { execVerb } from "../src/verbs.js";
import { type Policy } from "../src/policy.js";

const base: Policy = { description: "", default_clearance: "public", callers: {}, groups: {} };
const ENG = "e".repeat(22);

describe("execVerb", () => {
  it("clearance names a caller's level and reports what they resolve to", () => {
    const { policy, lines } = execVerb(base, "clearance", "ken", "internal");
    expect(policy.callers.ken).toEqual({ clearance: "internal", block: false });
    expect(base.callers.ken).toBeUndefined(); // pure: input untouched
    expect(lines.join("\n")).toContain("ken can be told internal content");
  });
  it("clearance is idempotent", () => {
    const once = execVerb(base, "clearance", "ken", "internal").policy;
    const twice = execVerb(once, "clearance", "ken", "internal").policy;
    expect(twice.callers.ken).toEqual({ clearance: "internal", block: false });
  });
  it("clearance overwrites rather than accumulating, so lowering one takes effect", () => {
    const raised = execVerb(base, "clearance", "ken", "internal").policy;
    const lowered = execVerb(raised, "clearance", "ken", "public").policy;
    expect(lowered.callers.ken!.clearance).toBe("public");
  });
  // `secret` means "never leaves this machine". Making it grantable from the
  // CLI would be a bypass any policy edit could hand out — the same structural
  // exclusion GrantableClearance makes in the schema.
  it("clearance refuses secret, and anything that is not a level at all", () => {
    expect(() => execVerb(base, "clearance", "ken", "secret")).toThrow(/public or internal/);
    expect(() => execVerb(base, "clearance", "ken", "sooper")).toThrow(/public or internal/);
    expect(() => execVerb(base, "clearance", "ken", undefined)).toThrow(/public or internal/);
  });
  it("clearance validates the handle", () => {
    expect(() => execVerb(base, "clearance", "Bad Handle", "public")).toThrow(/handle/i);
  });
  it("clearance --reset drops the level and the now-empty, unblocked entry", () => {
    const granted = execVerb(base, "clearance", "ken", "internal").policy;
    const { policy } = execVerb(granted, "clearance-reset", "ken");
    expect(policy.callers.ken).toBeUndefined();
  });
  it("clearance --reset on a caller with no entry is a no-op, not an error", () => {
    expect(() => execVerb(base, "clearance-reset", "ken")).not.toThrow();
  });
  it("clearance --default sets the level everyone registered gets", () => {
    const { policy, lines } = execVerb(base, "clearance-default", "internal");
    expect(policy.default_clearance).toBe("internal");
    expect(lines.join("\n")).toContain("Anyone registered can be told internal content.");
    expect(() => execVerb(base, "clearance-default", "secret")).toThrow(/public or internal/);
  });
  it("block sets the flag and survives a reset-to-empty; unblock clears it", () => {
    const blocked = execVerb(base, "block", "spammer").policy;
    expect(blocked.callers.spammer).toEqual({ block: true });
    const stillBlocked = execVerb(blocked, "clearance-reset", "spammer").policy;
    expect(stillBlocked.callers.spammer!.block).toBe(true); // blocked entry never dropped
    const un = execVerb(stillBlocked, "unblock", "spammer").policy;
    expect(un.callers.spammer).toBeUndefined();
  });
  it("block reports; clearance on a blocked caller still records the level but says so", () => {
    const blocked = execVerb(base, "block", "spammer").policy;
    const { policy, lines } = execVerb(blocked, "clearance", "spammer", "internal");
    expect(policy.callers.spammer).toEqual({ clearance: "internal", block: true });
    expect(lines.join("\n")).toContain("blocked");
  });
  // Report what the caller RESOLVES to, not what was just written: the line
  // default and any attested roster raise it. Printing the stored value would
  // tell an owner their edit did nothing when the default already covers it.
  it("reports the resolved level, so a redundant grant is not read as a change", () => {
    const withDefault: Policy = { ...base, default_clearance: "internal" };
    const { lines } = execVerb(withDefault, "clearance", "ken", "public");
    expect(lines.join("\n")).toContain("ken can be told internal content");
  });
  it("says rosters can raise a caller's level, since the report cannot show them", () => {
    const withGroup: Policy = { ...base, groups: { eng: { roster_id: ENG, clearance: "internal" } } };
    const { lines } = execVerb(withGroup, "clearance", "ken", "public");
    expect(lines.join("\n")).toContain("rosters they are attested in may raise this");
  });
  // `policy.callers` is a JSON.parse'd / zod z.record object, so it inherits
  // Object.prototype — and HANDLE_RE accepts "constructor". Without an
  // own-property guard, every lookup below resolves to the Object constructor
  // and throws, making a caller with that handle impossible to block.
  it("handles a caller named after an Object.prototype key", () => {
    const { policy, lines } = execVerb(base, "block", "constructor");
    expect(policy.callers.constructor).toEqual({ block: true });
    expect(lines.join("\n")).toContain("constructor is blocked.");
  });
  it("clearance works for a caller named after an Object.prototype key", () => {
    const { policy } = execVerb(base, "clearance", "constructor", "internal");
    expect(policy.callers.constructor).toEqual({ clearance: "internal", block: false });
  });
  it("reset/unblock stay no-ops for an Object.prototype-named caller with no entry", () => {
    expect(execVerb(base, "clearance-reset", "constructor").lines.join("\n"))
      .toContain("constructor can be told public content");
    expect(execVerb(base, "unblock", "constructor").lines.join("\n"))
      .toContain("constructor can be told public content");
  });
});
