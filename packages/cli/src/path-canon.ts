// Path comparison primitives shared by every filesystem boundary in the CLI.
//
// Extracted verbatim from guard.ts, where each of these exists because a
// lexical shortcut got through review once. They are shared rather than
// duplicated so a second boundary (sensitivity.ts) cannot reintroduce the bug
// the first one already fixed — a prefix compare and a lexical alias are both
// silent failures, and silence is the wrong failure mode for a security floor.
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// The default macOS filesystem is case-INsensitive — ~/.SSH opens ~/.ssh.
// Linux is commonly case-sensitive; folding can over-match there, which is the
// safe direction for a floor shared by both supported platforms.
export const fold = (p: string): string => p.toLowerCase();

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

// realpath throws on a path that does not exist yet — a Write target, a
// dangling symlink. Resolving the longest EXISTING ancestor and re-appending
// the unresolved tail is what stops `/tmp/link/new_key` (link -> ~/.ssh) from
// being compared as text and allowed.
export function canonical(
  p: string,
  cwd: string,
  home: string,
  realpath: (p: string) => string,
): string {
  const expanded = expandHome(p, home);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return resolve(realpath(cur), ...[...tail].reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the root, nothing resolvable
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

// relative() rather than startsWith(): resolve("/") is "/", so "/" + sep is
// "//", which prefixes nothing — a prefix compare silently permits a search
// rooted at the filesystem root. It also stops "/a/bc" counting as inside
// "/a/b".
export function isInside(target: string, root: string): boolean {
  const rel = relative(fold(root), fold(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// A search rooted at `target` reaches `root` when `target` is above it.
// This is what stops Grep(path: "~") and Grep(path: "/").
export function isAncestorOf(target: string, root: string): boolean {
  const rel = relative(fold(target), fold(root));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
