import { describe, expect, it } from "vitest";
import { AccessPolicySchema, accessFor, DEFAULT_ACCESS } from "../src/access.js";

const policy = (input: unknown) => AccessPolicySchema.parse(input);

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
      expect(() => policy({ groups: {} })).toThrow();
    });

    it("accepts an empty document and means allowed", () => {
      const p = policy({});
      expect(p.default_access).toBe("allowed");
      expect(accessFor(p, "anyone")).toBe("allowed");
    });
  });
});
