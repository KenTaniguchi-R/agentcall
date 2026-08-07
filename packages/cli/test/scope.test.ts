import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCOPE,
  loadScope,
  ScopeSchema,
  defaultScope,
  isReadable,
  readableRoots,
  workdirFor,
} from "../src/scope.js";
import { tempDir, tempLine } from "./helpers.js";

const HOME = "/Users/owner";
const noRealpath = (p: string) => p;
const opts = { home: HOME, cwd: HOME, realpath: noRealpath };
const scope = (input: unknown) => ScopeSchema.parse(input);
const home = (extra: unknown = {}) =>
  scope({ roots: [HOME], ...(extra as object) });

describe("scope", () => {
  // The inversion (#412): a path is readable unless something denies it. The
  // previous model was "unlabelled is secret", which meant a fresh install
  // could read nothing and every new source type defaulted closed.
  describe("the default", () => {
    it("reads under a root without anything naming the path", () => {
      expect(isReadable(home(), "/Users/owner/coding/proj/src/index.ts", opts)).toBe(true);
    });

    it("refuses everything outside a root", () => {
      // The root is what keeps /etc, /var, other users' homes and mounted
      // volumes out without any of them appearing on a list. Without it this
      // model is not a simplification, it is `/`.
      expect(isReadable(home(), "/etc/passwd", opts)).toBe(false);
      expect(isReadable(home(), "/Users/someone-else/notes.md", opts)).toBe(false);
      expect(isReadable(home(), "/Volumes/backup/db.sql", opts)).toBe(false);
    });

    it("names $HOME as the only root on a fresh install", () => {
      expect(defaultScope(HOME)).toEqual({ roots: [HOME], denied: [] });
      expect(DEFAULT_SCOPE).toEqual({ roots: [], denied: [] });
    });

    it("refuses everything when no root is known", () => {
      // The misconfiguration path. An empty root list is not "allow all".
      expect(isReadable(DEFAULT_SCOPE, "/Users/owner/anything", opts)).toBe(false);
    });
  });

  describe("the built-in denylist", () => {
    it("refuses credential directories inside a root", () => {
      for (const p of [
        "/Users/owner/.ssh/id_ed25519",
        "/Users/owner/.aws/credentials",
        "/Users/owner/.gnupg/secring.gpg",
        "/Users/owner/.config/gcloud/creds.json",
        "/Users/owner/Library/Keychains/login.keychain",
        "/Users/owner/.agentcall/config.json",
        "/Users/owner/.codex/auth.json",
      ]) {
        expect(isReadable(home(), p, opts)).toBe(false);
      }
    });

    it("refuses shell startup files, which are a persistence surface", () => {
      for (const p of [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"]) {
        expect(isReadable(home(), join(HOME, p), opts)).toBe(false);
      }
    });

    it("refuses denied basenames anywhere under a root", () => {
      // Matched by NAME rather than by prefix — the one entry shape a prefix
      // rule cannot express, and why `.env` in any project is still refused.
      expect(isReadable(home(), "/Users/owner/coding/proj/.env", opts)).toBe(false);
      expect(isReadable(home(), "/Users/owner/deep/nested/key.pem", opts)).toBe(false);
      expect(isReadable(home(), "/Users/owner/x/id_rsa", opts)).toBe(false);
    });

    it("allows .env.example and friends, which are not secrets", () => {
      expect(isReadable(home(), "/Users/owner/proj/.env.example", opts)).toBe(true);
      expect(isReadable(home(), "/Users/owner/proj/.env.sample", opts)).toBe(true);
    });

    it("cannot be overridden by an owner naming a parent as a root", () => {
      // The denylist is not a default. Adding `~` or `~/.ssh` as a root does
      // not make a credential readable — that is what makes it a floor rather
      // than a starting point.
      const wide = scope({ roots: [HOME, "/Users/owner/.ssh"], denied: [] });
      expect(isReadable(wide, "/Users/owner/.ssh/id_rsa", opts)).toBe(false);
    });
  });

  describe("the skills exception", () => {
    // ~/.claude is denied for an INTEGRITY reason — settings and hooks being
    // written — which does not apply to a skill's markdown being read. Without
    // this, a skill's references/*.md are refused and skills that use them
    // break; the SKILL.md body itself never reaches the guard either way.
    it("allows a skill's own files", () => {
      expect(isReadable(home(), "/Users/owner/.claude/skills/some-skill/SKILL.md", opts)).toBe(true);
      expect(isReadable(home(), "/Users/owner/.claude/skills/some-skill/references/x.md", opts)).toBe(true);
    });

    it("keeps the rest of ~/.claude denied", () => {
      expect(isReadable(home(), "/Users/owner/.claude/settings.json", opts)).toBe(false);
      expect(isReadable(home(), "/Users/owner/.claude/hooks/x.sh", opts)).toBe(false);
      expect(isReadable(home(), "/Users/owner/.claude.json", opts)).toBe(false);
    });
  });

  describe("owner-declared denials", () => {
    it("refuses a subtree the owner named", () => {
      const s = home({ denied: ["/Users/owner/coding/acme/contracts"] });
      expect(isReadable(s, "/Users/owner/coding/acme/contracts/nda.md", opts)).toBe(false);
      expect(isReadable(s, "/Users/owner/coding/acme/README.md", opts)).toBe(true);
    });

    it("expands a tilde in a declared denial", () => {
      const s = home({ denied: ["~/journal"] });
      expect(isReadable(s, join(HOME, "journal", "2026.md"), opts)).toBe(false);
    });
  });

  describe("symlinks", () => {
    // The root check MUST apply to the RESOLVED path. Under the label model a
    // symlink out of a labelled tree landed on an unlabelled path and was
    // refused; here it would land on a path that is simply not denied, so if
    // the root were checked lexically this would become an escape from the
    // root itself — worse than anything the label model allowed.
    it("refuses a symlink that resolves outside every root", () => {
      const real = realpathSync(tempDir("scope-"));
      const root = join(real, "home");
      const outside = join(real, "elsewhere");
      mkdirSync(root); mkdirSync(outside);
      symlinkSync(outside, join(root, "escape"));
      const s = scope({ roots: [root] });
      expect(isReadable(s, join(root, "escape", "x"), { home: real, cwd: real, realpath: realpathSync }))
        .toBe(false);
    });

    it("refuses a symlink that resolves into the denylist", () => {
      const real = realpathSync(tempDir("scope-"));
      const secrets = join(real, ".ssh");
      mkdirSync(secrets, { recursive: true });
      symlinkSync(secrets, join(real, "link"));
      const s = scope({ roots: [real] });
      expect(isReadable(s, join(real, "link", "id_rsa"), { home: real, cwd: real, realpath: realpathSync }))
        .toBe(false);
    });
  });

  describe("readableRoots and workdirFor", () => {
    it("reports the roots, shortest first", () => {
      const d = tempDir("scope-");
      const a = join(d, "aa"); const b = join(d, "b");
      mkdirSync(a); mkdirSync(b);
      expect(readableRoots(scope({ roots: [a, b] }), d)).toEqual([b, a]);
    });

    it("skips a root that no longer exists rather than failing the call", () => {
      const d = tempDir("scope-");
      const real = join(d, "real"); mkdirSync(real);
      expect(readableRoots(scope({ roots: [join(d, "gone"), real] }), d)).toEqual([real]);
    });

    it("falls back when no root is usable", () => {
      expect(workdirFor(DEFAULT_SCOPE, "/fallback")).toBe("/fallback");
    });

    it("spawns in the first root", () => {
      const d = tempDir("scope-");
      const r = join(d, "r"); mkdirSync(r);
      expect(workdirFor(scope({ roots: [r] }), "/fallback", d)).toBe(r);
    });
  });

  describe("prefix boundaries", () => {
    it("does not let a sibling share a prefix string", () => {
      // /Users/owner/repository is not inside /Users/owner/repo. A plain
      // startsWith would say otherwise and silently widen every root.
      const s = scope({ roots: ["/Users/owner/repo"] });
      expect(isReadable(s, "/Users/owner/repo/src/x.ts", opts)).toBe(true);
      expect(isReadable(s, "/Users/owner/repository/secrets.ts", opts)).toBe(false);
    });

    it("is order-independent — the longest match wins, not the first", () => {
      // Ordering must never be able to widen access, because that failure is
      // invisible in review.
      const a = scope({ roots: [HOME], denied: ["/Users/owner/a", "/Users/owner/a/b/c"] });
      const b = scope({ roots: [HOME], denied: ["/Users/owner/a/b/c", "/Users/owner/a"] });
      for (const s of [a, b]) {
        expect(isReadable(s, "/Users/owner/a/x", opts)).toBe(false);
        expect(isReadable(s, "/Users/owner/other/x", opts)).toBe(true);
      }
    });
  });

  describe("loadScope", () => {
    it("returns the safe default when the file is absent", () => {
      // A fresh install has no scope. No roots means nothing is readable, which
      // is a refusal rather than a leak — the one place this model still fails
      // closed.
      expect(loadScope(tempLine())).toEqual(DEFAULT_SCOPE);
    });

    it("throws on a malformed file rather than falling back", () => {
      // A silent fallback would mean the owner's scope stopped applying without
      // anyone being told. Under a denylist that WIDENS, so it must be loud.
      const p = tempLine();
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.scopeFile, "{ not json");
      expect(() => loadScope(p)).toThrow(/scope is invalid/);
    });

    it("throws on a well-formed file with the wrong shape", () => {
      const p = tempLine();
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(p.scopeFile, JSON.stringify({ roots: "not-an-array" }));
      expect(() => loadScope(p)).toThrow(/scope is invalid/);
    });

    it("puts the scope beside the line's other config", () => {
      const p = tempLine();
      expect(p.scopeFile).toBe(join(p.dir, "scope.json"));
    });
  });

  describe("schema", () => {
    it("accepts an empty document and denies everything", () => {
      expect(scope({})).toEqual({ roots: [], denied: [] });
    });

    it("rejects unknown keys rather than ignoring them", () => {
      expect(() => scope({ sources: [{ path: "/x", sensitivity: "shared" }] })).toThrow();
      expect(() => scope({ skills: { "some-skill": "shared" } })).toThrow();
    });
  });
});
