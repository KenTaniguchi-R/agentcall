import { describe, expect, it } from "vitest";
import { AccessPolicySchema, accessFor, DEFAULT_ACCESS } from "../src/access.js";

// Collapsed from a three-level clearance on 2026-08-07. The old tests asserted
// that a group could RAISE a caller from `public` to `internal`; with one
// grantable level there is no amount to raise, so the axis a group changes is
// whether the line answers at all. See
// docs/superpowers/specs/2026-08-07-open-default-design.md.
const policy = (input: unknown) => AccessPolicySchema.parse(input);

const ROSTER = "rst_0123456789abcdef";
const OTHER = "rst_fedcba9876543210";

describe("access", () => {
  it("answers anyone by default — the organization is the boundary", () => {
    expect(DEFAULT_ACCESS).toBe("allowed");
    expect(accessFor(policy({}), "sota")).toBe("allowed");
  });

  it("honours a line that is closed by default", () => {
    expect(accessFor(policy({ default_access: "blocked" }), "sota")).toBe("blocked");
  });

  describe("a named caller", () => {
    it("is blocked when the owner says so", () => {
      const p = policy({ callers: { sota: { access: "blocked" } } });
      expect(accessFor(p, "sota")).toBe("blocked");
    });

    it("is answered even on a line that is closed by default", () => {
      const p = policy({ default_access: "blocked", callers: { sota: { access: "allowed" } } });
      expect(accessFor(p, "sota")).toBe("allowed");
      expect(accessFor(p, "someone-else")).toBe("blocked");
    });

    it("beats every roster rule, in both directions", () => {
      // The whole point of naming someone: it is the owner's most specific
      // statement, so no group they belong to can override it either way.
      const blocked = policy({
        callers: { sota: { access: "blocked" } },
        groups: { team: { roster_id: ROSTER, access: "allowed" } },
      });
      expect(accessFor(blocked, "sota", [ROSTER])).toBe("blocked");

      const allowed = policy({
        default_access: "blocked",
        callers: { sota: { access: "allowed" } },
        groups: { team: { roster_id: ROSTER, access: "blocked" } },
      });
      expect(accessFor(allowed, "sota", [ROSTER])).toBe("allowed");
    });
  });

  describe("rosters", () => {
    const p = policy({
      default_access: "blocked",
      groups: { team: { roster_id: ROSTER, access: "allowed" } },
    });

    it("opens a line the default closes, for attested members", () => {
      expect(accessFor(p, "sota", [ROSTER])).toBe("allowed");
    });

    it("does nothing without attestation", () => {
      // attestedGroups are roster ids the RELAY vouched for. A caller-supplied
      // claim never reaches this parameter, so an unattested caller stays at the
      // default no matter what they assert.
      expect(accessFor(p, "sota")).toBe("blocked");
      expect(accessFor(p, "sota", [OTHER])).toBe("blocked");
    });

    it("lets a blocked roster win over an allowed one", () => {
      // Two attested rosters disagreeing resolves to the safe side. Unlike the
      // old clearance union, which took the most PERMISSIVE grant, access takes
      // the most restrictive — because the thing being decided is now "answer
      // at all", where the cautious direction is to refuse.
      const both = policy({
        groups: {
          team: { roster_id: ROSTER, access: "allowed" },
          contractors: { roster_id: OTHER, access: "blocked" },
        },
      });
      expect(accessFor(both, "sota", [ROSTER, OTHER])).toBe("blocked");
    });
  });

  describe("prototype safety", () => {
    // z.record output inherits Object.prototype, and the handle pattern happily
    // accepts "constructor" — so a bare `callers[handle]` resolves to the Object
    // constructor and reads as a caller entry that is not there.
    const p = policy({ callers: { sota: { access: "blocked" } } });

    it("resolves a prototype-shaped handle to the default", () => {
      expect(accessFor(p, "constructor")).toBe("allowed");
      expect(accessFor(p, "toString")).toBe("allowed");
    });

    it("never resolves a prototype-shaped handle to a stale block", () => {
      expect(accessFor(p, "hasOwnProperty")).not.toBe("blocked");
    });
  });

  describe("schema", () => {
    it("rejects a level from the old lattice", () => {
      // `public`/`internal`/`secret` are not access values. Failing loudly here
      // is what stops a policy file written against the old model from parsing
      // into something that looks configured and is not.
      expect(() => policy({ default_access: "internal" })).toThrow();
      expect(() => policy({ callers: { sota: { access: "secret" } } })).toThrow();
    });

    it("rejects unknown keys rather than ignoring them", () => {
      expect(() => policy({ default_clearance: "public" })).toThrow();
      expect(() => policy({ callers: { sota: { block: true } } })).toThrow();
    });

    it("accepts an empty document and means allowed", () => {
      const p = policy({});
      expect(p.default_access).toBe("allowed");
      expect(accessFor(p, "anyone")).toBe("allowed");
    });
  });
});
