import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  workdirFor,
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

  // #372 deleted line and task `workdir`. The map already names the directory
  // the owner cares about — `defaultSensitivityMap` seeds the git repo `setup`
  // ran in — so a separate config field was a second source of truth that could
  // disagree with the thing actually enforced. The cwd is derived from the map
  // instead.
  describe("workdirFor", () => {
    // Real directories: the whole point is that a source naming a path that is
    // no longer there must not become a cwd, and only the filesystem knows.
    function dirs(...names: string[]) {
      const root = tempDir("agentcall-wd-");
      const made: Record<string, string> = {};
      for (const n of names) {
        made[n] = join(root, n);
        mkdirSync(made[n]!, { recursive: true });
      }
      return { root, ...made } as Record<string, string>;
    }

    it("falls back when the map names no source at all", () => {
      const { root } = dirs();
      const share = join(root, "share");
      mkdirSync(share);
      expect(workdirFor(map({}), "internal", share)).toBe(share);
    });

    it("picks a source the caller is cleared for", () => {
      const d = dirs("repo", "share");
      const m = map({ sources: [{ path: d.repo, sensitivity: "internal" }] });
      expect(workdirFor(m, "internal", d.share)).toBe(d.repo);
    });

    // The point of deriving cwd from clearance rather than from config. A
    // public caller spawned inside internal content would fill its context with
    // material it can only be refused on — a guaranteed-useless call.
    it("does not spawn a caller inside content above their clearance", () => {
      const d = dirs("repo", "share");
      const m = map({ sources: [{ path: d.repo, sensitivity: "internal" }] });
      expect(workdirFor(m, "public", d.share)).toBe(d.share);
    });

    it("prefers the richest source the caller may see, not merely the first", () => {
      const d = dirs("open", "repo", "share");
      const m = map({
        sources: [
          { path: d.open, sensitivity: "public" },
          { path: d.repo, sensitivity: "internal" },
        ],
      });
      expect(workdirFor(m, "internal", d.share)).toBe(d.repo);
      expect(workdirFor(m, "public", d.share)).toBe(d.open);
    });

    // `secret` is never grantable, so a secret source can never be a cwd — and
    // that is what keeps withFloor's ~/.ssh, ~/.agentcall and friends out of
    // this selection without a second exclusion list.
    it("never selects a secret source, including the built-in floor", () => {
      const d = dirs("vault", "share");
      const m = map({ sources: [{ path: d.vault, sensitivity: "secret" }] });
      expect(workdirFor(m, "internal", d.share)).toBe(d.share);
    });

    it("skips a labelled source that no longer exists on disk", () => {
      const d = dirs("share");
      const m = map({ sources: [{ path: join(d.root!, "deleted"), sensitivity: "internal" }] });
      expect(workdirFor(m, "internal", d.share)).toBe(d.share);
    });

    // Two equally-cleared sources must not depend on map order: an owner
    // reordering sensitivity.json would otherwise silently move the cwd.
    it("is deterministic when two sources tie, and independent of map order", () => {
      const d = dirs("bbb", "aaa", "share");
      const forward = map({ sources: [
        { path: d.bbb, sensitivity: "internal" },
        { path: d.aaa, sensitivity: "internal" },
      ] });
      const reversed = map({ sources: [
        { path: d.aaa, sensitivity: "internal" },
        { path: d.bbb, sensitivity: "internal" },
      ] });
      expect(workdirFor(forward, "internal", d.share)).toBe(workdirFor(reversed, "internal", d.share));
    });

    it("falls back when the fallback itself is the only thing that exists", () => {
      const d = dirs("share");
      const m = map({ sources: [{ path: join(d.root!, "gone"), sensitivity: "public" }] });
      expect(workdirFor(m, "public", d.share)).toBe(d.share);
    });

    // Carried over from resolveLineWorkdir's deleted "rejects a relative
    // workdir" test. The schema accepts any string, and a bare `statSync` on a
    // relative one resolves it against whatever directory the LISTENER happens
    // to be running in — so `code/api` in sensitivity.json could silently make
    // the spawn directory depend on how the service was launched.
    it("never selects a relative source, whose meaning depends on the listener's own cwd", () => {
      const d = dirs("share");
      // "src" deliberately: it EXISTS relative to this test process's cwd, so a
      // bare statSync resolves it and the entry would be selected. A relative
      // path that happened not to resolve would make this pass for the wrong
      // reason and prove nothing.
      expect(existsSync("src")).toBe(true);
      const m = map({ sources: [{ path: "src", sensitivity: "internal" }] });
      expect(workdirFor(m, "internal", d.share)).toBe(d.share);
    });

    // A file is a legitimate label — classifyPath handles them — but it cannot
    // be a cwd, and listing one as somewhere to "read files under" would
    // mislead the agent about what it can enumerate.
    it("never selects a file source, only a directory", () => {
      const d = dirs("share");
      const file = join(d.share!, "notes.md");
      writeFileSync(file, "hi\n");
      const m = map({ sources: [{ path: file, sensitivity: "internal" }] });
      expect(workdirFor(m, "internal", d.share)).toBe(d.share);
    });
  });
});
