import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVITY,
  DEFAULT_SKILL_SENSITIVITY,
  SENSITIVITIES,
  SensitivityMapSchema,
  classifyPath,
  classifySkill,
  combine,
  permits,
  readableSources,
  withFloor,
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
      const m = map({ sources: [{ path: "/work/repo", sensitivity: "shared" }] });
      expect(classifyPath(m, HOME, { home: HOME, cwd: HOME, realpath: noRealpath }))
        .toBe("secret");
    });
  });

  describe("classifyPath", () => {
    const m = map({
      sources: [
        { path: "/work/repo", sensitivity: "shared" },
        { path: "/work/repo/docs/public", sensitivity: "shared" },
        { path: "/work/repo/.env.d", sensitivity: "secret" },
      ],
    });
    const opts = { home: HOME, cwd: HOME, realpath: noRealpath };

    it("labels a path inside a declared source", () => {
      expect(classifyPath(m, "/work/repo/src/index.ts", opts)).toBe("shared");
    });

    it("labels the declared source itself", () => {
      expect(classifyPath(m, "/work/repo", opts)).toBe("shared");
    });

    it("lets a narrower rule declassify a subtree", () => {
      expect(classifyPath(m, "/work/repo/docs/public/readme.md", opts)).toBe("shared");
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
          { path: "/work/repo/docs/public", sensitivity: "shared" },
          { path: "/work/repo", sensitivity: "shared" },
        ],
      });
      expect(classifyPath(reversed, "/work/repo/docs/public/x.md", opts)).toBe("shared");
      expect(classifyPath(reversed, "/work/repo/src/x.ts", opts)).toBe("shared");
    });

    it("breaks a tie toward the more restrictive rule", () => {
      const tied = map({
        sources: [
          { path: "/work/repo", sensitivity: "shared" },
          { path: "/work/repo", sensitivity: "shared" },
        ],
      });
      expect(classifyPath(tied, "/work/repo/x", opts)).toBe("shared");
    });

    it("does not let a sibling share a prefix string", () => {
      expect(classifyPath(m, "/work/repository/secrets", opts)).toBe("secret");
    });

    it("expands a tilde in a declared source", () => {
      const tilde = map({ sources: [{ path: "~/notes", sensitivity: "shared" }] });
      expect(classifyPath(tilde, join(HOME, "notes", "a.md"), opts)).toBe("shared");
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
      const linked = map({ sources: [{ path: labelled, sensitivity: "shared" }] });
      expect(
        classifyPath(linked, join(labelled, "escape", "x"), { home: root, cwd: root, realpath: realpathSync }),
      ).toBe("secret");
    });
  });

  describe("classifySkill", () => {
    const m = map({ skills: { obsidian: "shared" } });

    it("labels a declared skill", () => {
      expect(classifySkill(m, "obsidian")).toBe("shared");
    });

    it("does not mistake an inherited Object property for a declaration", () => {
      // Same trap policy.ts:161-171 documents: zod's z.record output inherits
      // Object.prototype, so a bare lookup of "constructor" returns the Object
      // constructor and reads as a real entry.
      // Must fall to the skill default rather than resolving an inherited
      // property — what this pins is that it never returns something derived
      // from Object.prototype.
      expect(classifySkill(m, "toString")).toBe(DEFAULT_SKILL_SENSITIVITY);
      expect(SENSITIVITIES).toContain(classifySkill(m, "toString"));
    });

    it("treats an undeclared skill as internal, not secret", () => {
      // Skills default OPEN where MCP servers do not, and the asymmetry is
      // measured rather than assumed: everything a skill *does* — its
      // references/, its Read/Grep/Glob/LS — goes through the guard as ordinary
      // tool calls. Only the SKILL.md body bypasses it, so enabling a skill
      // discloses at most that skill's own prose, whereas an MCP server's I/O is
      // invisible to the guard entirely.
      // See docs/research/2026-08-06-skill-and-mcp-guard-reachability.md.
      expect(classifySkill(m, "some-skill-nobody-labelled")).toBe("shared");
    });
  });

  describe("the floor's skills carve-out", () => {
    // ~/.claude is `secret` for an INTEGRITY reason — "executable configuration;
    // cf. CVE-2025-59536" — which is about settings and hooks being written, not
    // about a skill's markdown being read. Longest-prefix-wins carves the skills
    // directory back out without weakening anything else under ~/.claude.
    const home = "/Users/owner";
    const opts = { home, cwd: home, realpath: (p: string) => p };
    const floored = withFloor(map({}), home);

    it("leaves a skill body readable", () => {
      expect(classifyPath(floored, "/Users/owner/.claude/skills/obsidian/SKILL.md", opts))
        .toBe("shared");
    });

    it("keeps the rest of ~/.claude secret", () => {
      expect(classifyPath(floored, "/Users/owner/.claude/settings.json", opts)).toBe("secret");
      expect(classifyPath(floored, "/Users/owner/.claude/hooks/x.sh", opts)).toBe("secret");
    });

    it("keeps ~/.claude.json secret — it is a file, not the skills directory", () => {
      expect(classifyPath(floored, "/Users/owner/.claude.json", opts)).toBe("secret");
    });

    it("does not carve anything out of the credential floor", () => {
      expect(classifyPath(floored, "/Users/owner/.ssh/id_ed25519", opts)).toBe("secret");
      expect(classifyPath(floored, "/Users/owner/.aws/credentials", opts)).toBe("secret");
      expect(classifyPath(floored, "/Users/owner/.zshrc", opts)).toBe("secret");
    });

    it("never advertises the carve-out as a readable source or a workdir", () => {
      // The carve-out is `internal`, so unlike the rest of the floor it is not
      // filtered out by `permits`. Without an explicit exclusion it becomes the
      // SHORTEST readable path on a fresh line and `workdirFor` spawns the agent
      // inside ~/.claude/skills. A skill is invoked by name, so its directory
      // never has to be advertised for it to work.
      const real = tempDir("home-");
      mkdirSync(join(real, ".claude", "skills"), { recursive: true });
      mkdirSync(join(real, "coding"), { recursive: true });
      const m = withFloor(map({ sources: [{ path: join(real, "coding"), sensitivity: "shared" }] }), real);

      expect(readableSources(m, real)).toEqual([join(real, "coding")]);
      expect(workdirFor(m, "/fallback", real)).toBe(join(real, "coding"));
    });
  });

  describe("combine", () => {
    it("returns shared only when everything is shared", () => {
      expect(combine("shared", "shared")).toBe("shared");
    });

    it("takes the most restrictive input — any secret wins", () => {
      expect(combine("shared", "secret")).toBe("secret");
      expect(combine("secret", "shared")).toBe("secret");
      expect(combine("shared", "secret", "shared")).toBe("secret");
    });

    it("returns public for no inputs, so an untouched run starts clean", () => {
      expect(combine()).toBe("shared");
    });
  });

  describe("permits", () => {
    // A function of the content alone since 2026-08-07. The caller's clearance
    // used to be the second argument; with one grantable level there was nothing
    // left to compare, and a caller who is not answered at all never reaches a
    // source (resolveAdmission refuses them before the agent spawns).
    it("lets shared content out", () => {
      expect(permits("shared")).toBe(true);
    });

    it("never permits secret — it means never leaves this machine", () => {
      expect(permits("secret")).toBe(false);
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
      expect(workdirFor(map({}), share)).toBe(share);
    });

    it("picks a source the caller is cleared for", () => {
      const d = dirs("repo", "share");
      const m = map({ sources: [{ path: d.repo, sensitivity: "shared" }] });
      expect(workdirFor(m, d.share)).toBe(d.repo);
    });

    // With one grantable level the old "richest source wins" tie-break is gone:
    // every shared source is equally reachable, so selection falls to the
    // documented tie-break — shortest path, then lexicographic — which is what
    // stops reordering sensitivity.json from silently moving the cwd.
    it("breaks a tie by shortest path, not by map order", () => {
      const d = dirs("open", "repo", "share");
      const m = map({
        sources: [
          { path: d.repo, sensitivity: "shared" },
          { path: d.open, sensitivity: "shared" },
        ],
      });
      expect(workdirFor(m, d.share)).toBe(d.open);
    });

    // `secret` is never grantable, so a secret source can never be a cwd — and
    // that is what keeps withFloor's ~/.ssh, ~/.agentcall and friends out of
    // this selection without a second exclusion list.
    it("never selects a secret source, including the built-in floor", () => {
      const d = dirs("vault", "share");
      const m = map({ sources: [{ path: d.vault, sensitivity: "secret" }] });
      expect(workdirFor(m, d.share)).toBe(d.share);
    });

    it("skips a labelled source that no longer exists on disk", () => {
      const d = dirs("share");
      const m = map({ sources: [{ path: join(d.root!, "deleted"), sensitivity: "shared" }] });
      expect(workdirFor(m, d.share)).toBe(d.share);
    });

    // Two equally-cleared sources must not depend on map order: an owner
    // reordering sensitivity.json would otherwise silently move the cwd.
    it("is deterministic when two sources tie, and independent of map order", () => {
      const d = dirs("bbb", "aaa", "share");
      const forward = map({ sources: [
        { path: d.bbb, sensitivity: "shared" },
        { path: d.aaa, sensitivity: "shared" },
      ] });
      const reversed = map({ sources: [
        { path: d.aaa, sensitivity: "shared" },
        { path: d.bbb, sensitivity: "shared" },
      ] });
      expect(workdirFor(forward, d.share)).toBe(workdirFor(reversed, d.share));
    });

    it("falls back when the fallback itself is the only thing that exists", () => {
      const d = dirs("share");
      const m = map({ sources: [{ path: join(d.root!, "gone"), sensitivity: "shared" }] });
      expect(workdirFor(m, d.share)).toBe(d.share);
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
      const m = map({ sources: [{ path: "src", sensitivity: "shared" }] });
      expect(workdirFor(m, d.share)).toBe(d.share);
    });

    // A file is a legitimate label — classifyPath handles them — but it cannot
    // be a cwd, and listing one as somewhere to "read files under" would
    // mislead the agent about what it can enumerate.
    it("never selects a file source, only a directory", () => {
      const d = dirs("share");
      const file = join(d.share!, "notes.md");
      writeFileSync(file, "hi\n");
      const m = map({ sources: [{ path: file, sensitivity: "shared" }] });
      expect(workdirFor(m, d.share)).toBe(d.share);
    });
  });
});
