import { describe, expect, it } from "vitest";
import { execVerb } from "../src/verbs.js";
import { type Policy } from "../src/policy.js";

// Rewritten 2026-08-07 with the clearance collapse. The `clearance`,
// `clearance-reset` and `clearance-default` verbs are gone: with one grantable
// level there is no amount to set, only whether the line answers. What survives
// is block/unblock plus the line-wide posture.
const base: Policy = { description: "", default_access: "allowed", callers: {} };

describe("execVerb", () => {
  describe("block", () => {
    it("records the block and reports it", () => {
      const { policy, lines } = execVerb(base, "block", "spammer");
      expect(policy.callers.spammer).toEqual({ access: "blocked" });
      expect(base.callers.spammer).toBeUndefined(); // pure: input untouched
      expect(lines.join("\n")).toContain("spammer is blocked.");
    });

    it("is idempotent", () => {
      const once = execVerb(base, "block", "spammer").policy;
      const twice = execVerb(once, "block", "spammer").policy;
      expect(twice.callers.spammer).toEqual({ access: "blocked" });
    });

    it("validates the handle", () => {
      expect(() => execVerb(base, "block", "Bad Handle")).toThrow(/handle/i);
      expect(() => execVerb(base, "block", "@acme/ken")).toThrow(/handle/i);
    });
  });

  describe("unblock", () => {
    it("drops the entry entirely rather than writing `allowed`", () => {
      // An entry matching the default is noise, and leaving one behind would
      // pin this caller against a later change of default_access.
      const blocked = execVerb(base, "block", "spammer").policy;
      const { policy, lines } = execVerb(blocked, "unblock", "spammer");
      expect(policy.callers.spammer).toBeUndefined();
      expect(lines.join("\n")).toContain("spammer is answered");
    });

    it("is a no-op on a caller with no entry, not an error", () => {
      expect(() => execVerb(base, "unblock", "nobody")).not.toThrow();
      expect(execVerb(base, "unblock", "nobody").policy.callers.nobody).toBeUndefined();
    });

    it("reports blocked when the line default still blocks them", () => {
      // Removing a named allow on a closed line leaves them blocked, and the
      // report has to say what they RESOLVE to rather than what was written.
      const closed: Policy = { ...base, default_access: "blocked" };
      const named = execVerb(closed, "block", "ken").policy;
      const { lines } = execVerb(named, "unblock", "ken");
      expect(lines.join("\n")).toContain("ken is blocked");
    });

  });

  describe("access-default", () => {
    it("closes the line", () => {
      const { policy, lines } = execVerb(base, "access-default", "blocked");
      expect(policy.default_access).toBe("blocked");
      expect(lines.join("\n")).toContain("Only named callers are answered.");
    });

    it("opens the line", () => {
      const closed = execVerb(base, "access-default", "blocked").policy;
      const { policy, lines } = execVerb(closed, "access-default", "allowed");
      expect(policy.default_access).toBe("allowed");
      expect(lines.join("\n")).toContain("Anyone registered is answered.");
    });

    it("refuses a level from the old lattice, and anything that is not an access at all", () => {
      for (const bad of ["public", "internal", "secret", "sooper", undefined]) {
        expect(() => execVerb(base, "access-default", bad as string))
          .toThrow(/allowed or blocked/);
      }
    });
  });

  // `policy.callers` is a JSON.parse'd / zod z.record object, so it inherits
  // Object.prototype — and HANDLE_RE accepts "constructor". Without an
  // own-property guard, every lookup below resolves to the Object constructor
  // and throws, making a caller with that handle impossible to block.
  describe("a caller named after an Object.prototype key", () => {
    it("can be blocked", () => {
      const { policy, lines } = execVerb(base, "block", "constructor");
      expect(policy.callers.constructor).toEqual({ access: "blocked" });
      expect(lines.join("\n")).toContain("constructor is blocked.");
    });

    it("can be unblocked", () => {
      // Object.hasOwn, not a bare lookup: `callers.constructor` resolves to the
      // INHERITED Object constructor once the own property is gone, so
      // `toBeUndefined()` would fail on a correct removal. That is the same trap
      // the production lookup guards against, showing up in the assertion.
      const blocked = execVerb(base, "block", "constructor").policy;
      const after = execVerb(blocked, "unblock", "constructor").policy;
      expect(Object.hasOwn(after.callers, "constructor")).toBe(false);
    });

    it("stays a no-op for unblock with no entry", () => {
      expect(execVerb(base, "unblock", "constructor").lines.join("\n"))
        .toContain("constructor is answered");
    });
  });
});
