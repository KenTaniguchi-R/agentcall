import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVITY,
  SensitivityMapSchema,
  classifyMcp,
  classifyPath,
  classifySkill,
  combine,
  permits,
} from "../src/sensitivity.js";
import { tempDir } from "./helpers.js";

const HOME = "/home/o";
const noRealpath = (p: string) => p; // identity: no symlinks in the lexical tests

function map(input: unknown) {
  return SensitivityMapSchema.parse(input);
}

describe("sensitivity", () => {
  describe("the default", () => {
    it("is secret, which is the entire design", () => {
      expect(DEFAULT_SENSITIVITY).toBe("secret");
    });

    it("classifies an unlabelled path as secret", () => {
      const m = map({});
      expect(classifyPath(m, "/anywhere/at/all", { home: HOME, cwd: HOME, realpath: noRealpath }))
        .toBe("secret");
    });

    it("classifies $HOME itself as secret when nothing names it", () => {
      const m = map({ sources: [{ path: "/work/repo", sensitivity: "internal" }] });
      expect(classifyPath(m, HOME, { home: HOME, cwd: HOME, realpath: noRealpath }))
        .toBe("secret");
    });
  });

  describe("classifyPath", () => {
    const m = map({
      sources: [
        { path: "/work/repo", sensitivity: "internal" },
        { path: "/work/repo/docs/public", sensitivity: "public" },
        { path: "/work/repo/.env.d", sensitivity: "secret" },
      ],
    });
    const opts = { home: HOME, cwd: HOME, realpath: noRealpath };

    it("labels a path inside a declared source", () => {
      expect(classifyPath(m, "/work/repo/src/index.ts", opts)).toBe("internal");
    });

    it("labels the declared source itself", () => {
      expect(classifyPath(m, "/work/repo", opts)).toBe("internal");
    });

    it("lets a narrower rule declassify a subtree", () => {
      expect(classifyPath(m, "/work/repo/docs/public/readme.md", opts)).toBe("public");
    });

    it("lets a narrower rule restrict a subtree", () => {
      expect(classifyPath(m, "/work/repo/.env.d/prod", opts)).toBe("secret");
    });

    it("is order-independent — the longest matching prefix wins, not the first", () => {
      // The spike harness used first-match-wins, which silently shadows a
      // carve-out if the broad rule is listed first. Ordering must not be able
      // to widen access by accident.
      const reversed = map({
        sources: [
          { path: "/work/repo/docs/public", sensitivity: "public" },
          { path: "/work/repo", sensitivity: "internal" },
        ],
      });
      expect(classifyPath(reversed, "/work/repo/docs/public/x.md", opts)).toBe("public");
      expect(classifyPath(reversed, "/work/repo/src/x.ts", opts)).toBe("internal");
    });

    it("breaks a tie toward the more restrictive rule", () => {
      const tied = map({
        sources: [
          { path: "/work/repo", sensitivity: "public" },
          { path: "/work/repo", sensitivity: "internal" },
        ],
      });
      expect(classifyPath(tied, "/work/repo/x", opts)).toBe("internal");
    });

    it("does not let a sibling share a prefix string", () => {
      expect(classifyPath(m, "/work/repository/secrets", opts)).toBe("secret");
    });

    it("expands a tilde in a declared source", () => {
      const tilde = map({ sources: [{ path: "~/notes", sensitivity: "internal" }] });
      expect(classifyPath(tilde, join(HOME, "notes", "a.md"), opts)).toBe("internal");
    });

    it("resolves a symlink that points out of a labelled tree", () => {
      // A lexical compare would call this internal: the path is textually
      // inside the labelled dir, but it resolves somewhere unlabelled.
      const root = realpathSync(tempDir("sens-"));
      const labelled = join(root, "repo");
      const outside = join(root, "elsewhere");
      mkdirSync(labelled);
      mkdirSync(outside);
      symlinkSync(outside, join(labelled, "escape"));
      const linked = map({ sources: [{ path: labelled, sensitivity: "internal" }] });
      expect(
        classifyPath(linked, join(labelled, "escape", "x"), { home: root, cwd: root, realpath: realpathSync }),
      ).toBe("secret");
    });
  });

  describe("classifyMcp and classifySkill", () => {
    const m = map({ mcp: { jira: "internal" }, skills: { obsidian: "internal" } });

    it("labels a declared server", () => {
      expect(classifyMcp(m, "jira")).toBe("internal");
    });

    it("labels a declared skill", () => {
      expect(classifySkill(m, "obsidian")).toBe("internal");
    });

    it("treats an undeclared server as secret", () => {
      expect(classifyMcp(m, "gmail")).toBe("secret");
    });

    it("does not mistake an inherited Object property for a declaration", () => {
      // Same trap policy.ts:161-171 documents: zod's z.record output inherits
      // Object.prototype, so a bare lookup of "constructor" returns the Object
      // constructor and reads as a real entry.
      expect(classifyMcp(m, "constructor")).toBe("secret");
      expect(classifySkill(m, "toString")).toBe("secret");
    });
  });

  describe("combine", () => {
    it("returns public only when everything is public", () => {
      expect(combine("public", "public")).toBe("public");
    });

    it("takes the most restrictive input", () => {
      expect(combine("public", "internal")).toBe("internal");
      expect(combine("internal", "secret")).toBe("secret");
      expect(combine("public", "secret", "internal")).toBe("secret");
    });

    it("returns public for no inputs, so an untouched run starts clean", () => {
      expect(combine()).toBe("public");
    });
  });

  describe("permits", () => {
    it("lets a clearance read at or below itself", () => {
      expect(permits("internal", "public")).toBe(true);
      expect(permits("internal", "internal")).toBe(true);
    });

    it("refuses content above the clearance", () => {
      expect(permits("internal", "secret")).toBe(false);
      expect(permits("public", "internal")).toBe(false);
    });

    it("never permits secret, even to a secret clearance", () => {
      // secret means "never leaves". It is not a clearance anyone can hold —
      // otherwise the top of the lattice would be a grantable bypass.
      expect(permits("secret", "secret")).toBe(false);
    });
  });

  describe("SensitivityMapSchema", () => {
    it("rejects an unknown sensitivity", () => {
      expect(() => map({ sources: [{ path: "/x", sensitivity: "topsecret" }] })).toThrow();
    });

    it("rejects unknown keys rather than ignoring them", () => {
      expect(() => map({ sourcez: [] })).toThrow();
    });

    it("defaults every section so an empty file is valid and means secret", () => {
      const m = map({});
      expect(m.sources).toEqual([]);
      expect(m.mcp).toEqual({});
      expect(m.skills).toEqual({});
    });
  });
});
