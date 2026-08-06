import { describe, expect, it } from "vitest";
import {
  ClearancePolicySchema,
  DEFAULT_CLEARANCE,
  clearanceFor,
} from "../src/clearance.js";

function policy(input: unknown) {
  return ClearancePolicySchema.parse(input);
}

describe("clearance", () => {
  it("defaults to public, the level that reveals least", () => {
    expect(DEFAULT_CLEARANCE).toBe("public");
    expect(clearanceFor(policy({}), "someone@acme")).toBe("public");
  });

  it("grants a named caller their clearance", () => {
    const p = policy({ callers: { "ken@acme": { clearance: "internal" } } });
    expect(clearanceFor(p, "ken@acme")).toBe("internal");
  });

  it("leaves an unnamed caller at the default", () => {
    const p = policy({ callers: { "ken@acme": { clearance: "internal" } } });
    expect(clearanceFor(p, "someone@acme")).toBe("public");
  });

  describe("blocking", () => {
    it("beats every grant, including a group's", () => {
      // Individual denial is the strongest rule. Group membership can expand a
      // clearance, never resurrect a caller the owner explicitly blocked.
      const p = policy({
        callers: { "ken@acme": { clearance: "internal", block: true } },
        groups: { eng: { roster_id: "ros_abcdefghijklmnopqrstuvwx", clearance: "internal" } },
      });
      expect(clearanceFor(p, "ken@acme", ["ros_abcdefghijklmnopqrstuvwx"])).toBe("blocked");
    });

    it("blocks even with no clearance named", () => {
      const p = policy({ callers: { "ken@acme": { block: true } } });
      expect(clearanceFor(p, "ken@acme")).toBe("blocked");
    });
  });

  describe("groups", () => {
    const roster = "ros_abcdefghijklmnopqrstuvwx";
    const p = policy({
      groups: { eng: { roster_id: roster, clearance: "internal" } },
    });

    it("raises clearance when the group is attested", () => {
      expect(clearanceFor(p, "ken@acme", [roster])).toBe("internal");
    });

    it("does not apply without attestation", () => {
      // The roster id must be attested by the relay. An un-attested claim is
      // caller-supplied and must not raise anything.
      expect(clearanceFor(p, "ken@acme", [])).toBe("public");
      expect(clearanceFor(p, "ken@acme", ["ros_zzzzzzzzzzzzzzzzzzzzzzzz"])).toBe("public");
    });

    it("takes the most permissive applicable grant", () => {
      const many = policy({
        default_clearance: "public",
        callers: { "ken@acme": { clearance: "public" } },
        groups: { eng: { roster_id: roster, clearance: "internal" } },
      });
      expect(clearanceFor(many, "ken@acme", [roster])).toBe("internal");
    });
  });

  describe("prototype safety", () => {
    // These pin the OUTCOME for prototype-shaped handles; they do not prove the
    // `Object.hasOwn` guard is load-bearing today, and mutation testing
    // confirms it is not: with a bare `record[key]`, "constructor" resolves to
    // the Object constructor, whose `.block` and `.clearance` are both
    // undefined, so the result is "public" either way.
    //
    // The guard stays because it stops being cosmetic the moment a field is
    // added whose name exists on Object.prototype, or whose absence is read as
    // anything other than falsy — which is exactly how policy.ts:161-171
    // describes the same trap being missed the first time. These assertions are
    // the regression net for that future change.
    it("resolves a prototype-shaped handle to the default clearance", () => {
      const p = policy({ callers: { "ken@acme": { clearance: "internal" } } });
      expect(clearanceFor(p, "constructor")).toBe("public");
      expect(clearanceFor(p, "toString")).toBe("public");
      expect(clearanceFor(p, "hasOwnProperty")).toBe("public");
    });

    it("never resolves a prototype-shaped handle to blocked", () => {
      const p = policy({ callers: { "ken@acme": { block: true } } });
      expect(clearanceFor(p, "valueOf")).toBe("public");
    });
  });

  describe("schema", () => {
    it("refuses to grant `secret`, which means never leaves", () => {
      // Making the top of the lattice grantable would turn it into a bypass
      // that any policy edit could hand out. It is structurally unavailable.
      expect(() => policy({ callers: { "ken@acme": { clearance: "secret" } } })).toThrow();
      expect(() => policy({ default_clearance: "secret" })).toThrow();
      expect(() => policy({ groups: { eng: { roster_id: "ros_abcdefghijklmnopqrstuvwx", clearance: "secret" } } }))
        .toThrow();
    });

    it("rejects unknown keys rather than ignoring them", () => {
      expect(() => policy({ default_clearence: "internal" })).toThrow();
    });

    it("accepts an empty document and means public", () => {
      const p = policy({});
      expect(p.default_clearance).toBe("public");
      expect(p.callers).toEqual({});
      expect(p.groups).toEqual({});
    });
  });
});
