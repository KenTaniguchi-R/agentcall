import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, expandHome, fold, isAncestorOf, isInside } from "../src/path-canon.js";
import { tempDir } from "./helpers.js";

// These behaviours were extracted from guard.ts, where each one exists because
// a prefix-compare or a lexical-alias bug got through. They are tested here
// directly so the next caller (sensitivity.ts) inherits proof, not just code.
describe("path-canon", () => {
  describe("isInside", () => {
    it("treats a path as inside itself", () => {
      expect(isInside("/a/b", "/a/b")).toBe(true);
    });

    it("accepts a genuine descendant", () => {
      expect(isInside("/a/b/c/d", "/a/b")).toBe(true);
    });

    it("rejects a sibling that merely shares a prefix string", () => {
      // The whole reason relative() is used instead of startsWith: "/a/bc"
      // starts with "/a/b" as text but is not inside it.
      expect(isInside("/a/bc", "/a/b")).toBe(false);
    });

    it("rejects an ancestor", () => {
      expect(isInside("/a", "/a/b")).toBe(false);
    });

    it("treats every path as inside the filesystem root", () => {
      // resolve("/") is "/", so "/" + sep is "//", which prefixes nothing.
      // A prefix compare silently permits a search rooted at "/".
      expect(isInside("/a/b", "/")).toBe(true);
    });

    it("folds case, because the default macOS filesystem is case-insensitive", () => {
      expect(isInside("/Users/o/.SSH/id_rsa", "/users/o/.ssh")).toBe(true);
    });
  });

  describe("isAncestorOf", () => {
    it("reports a directory that contains the root", () => {
      // This is what stops Grep(path: "~") reaching ~/.ssh.
      expect(isAncestorOf("/a", "/a/b")).toBe(true);
    });

    it("does not report a path equal to the root", () => {
      expect(isAncestorOf("/a/b", "/a/b")).toBe(false);
    });

    it("does not report an unrelated sibling", () => {
      expect(isAncestorOf("/a/bc", "/a/b")).toBe(false);
    });
  });

  describe("expandHome", () => {
    it("expands a bare tilde", () => {
      expect(expandHome("~", "/home/o")).toBe("/home/o");
    });

    it("expands a tilde prefix", () => {
      expect(expandHome("~/notes", "/home/o")).toBe(join("/home/o", "notes"));
    });

    it("leaves a path that merely starts with the letters alone", () => {
      expect(expandHome("~notuser/x", "/home/o")).toBe("~notuser/x");
    });
  });

  describe("canonical", () => {
    it("resolves a symlink to its target", () => {
      const root = realpathSync(tempDir("canon-"));
      const real = join(root, "real");
      const link = join(root, "link");
      mkdirSync(real);
      symlinkSync(real, link);
      expect(canonical(link, root, root, realpathSync)).toBe(real);
    });

    it("resolves through a symlinked ancestor for a path that does not exist yet", () => {
      // realpath throws on a non-existent path. Resolving the longest existing
      // ancestor and re-appending the tail is what stops /tmp/link/new_key
      // (link -> secret dir) from being compared as text and allowed through.
      const root = realpathSync(tempDir("canon-"));
      const real = join(root, "secretdir");
      const link = join(root, "alias");
      mkdirSync(real);
      symlinkSync(real, link);
      expect(canonical(join(link, "new_key"), root, root, realpathSync))
        .toBe(join(real, "new_key"));
    });

    it("resolves a relative path against cwd, not home", () => {
      const root = realpathSync(tempDir("canon-"));
      const cwd = join(root, "work");
      mkdirSync(cwd);
      writeFileSync(join(cwd, "f.txt"), "");
      expect(canonical("f.txt", cwd, join(root, "home"), realpathSync))
        .toBe(join(cwd, "f.txt"));
    });

    it("returns an absolute path unchanged when nothing resolves", () => {
      const abs = `${sep}definitely${sep}not${sep}here${sep}x`;
      expect(canonical(abs, "/tmp", "/tmp", realpathSync)).toBe(abs);
    });
  });

  describe("fold", () => {
    it("lowercases so comparisons are case-insensitive", () => {
      expect(fold("/Users/O/.SSH")).toBe("/users/o/.ssh");
    });
  });
});
