import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SensitivityMapSchema,
  builtinSecretSources,
  classifyPath,
  withFloor,
} from "../src/sensitivity.js";

const HOME = "/home/o";
const opts = { home: HOME, cwd: HOME, realpath: (p: string) => p };

function floored(input: unknown) {
  return withFloor(SensitivityMapSchema.parse(input), HOME);
}

// The floor is what lets guard.ts's separate denylist be deleted rather than
// kept beside the label mechanism. Expressing those paths as built-in `secret`
// rules means longest-prefix-wins protects them even when an owner labels a
// parent directory, which "unlabelled is secret" alone would not.
describe("sensitivity floor", () => {
  it("names the paths that must never leave, wherever they sit", () => {
    const paths = builtinSecretSources(HOME).map((s) => s.path);
    for (const expected of [".ssh", ".aws", ".gnupg", ".agentcall", ".claude", ".codex"]) {
      expect(paths).toContain(join(HOME, expected));
    }
    expect(builtinSecretSources(HOME).every((s) => s.sensitivity === "secret")).toBe(true);
  });

  it("keeps a floored path secret when the owner labels its parent internal", () => {
    // The case that makes this necessary. Without the floor, labelling ~ as
    // internal would classify ~/.ssh/id_rsa as internal and hand it to any
    // internal-cleared caller.
    const m = floored({ sources: [{ path: "~", sensitivity: "shared" }] });
    expect(classifyPath(m, join(HOME, ".ssh", "id_rsa"), opts)).toBe("secret");
  });

  it("still labels the rest of the parent as the owner asked", () => {
    const m = floored({ sources: [{ path: "~", sensitivity: "shared" }] });
    expect(classifyPath(m, join(HOME, "notes", "a.md"), opts)).toBe("shared");
  });

  it("wins a tie against an explicit label on the same path", () => {
    // An owner naming ~/.ssh internal outright is either a mistake or an
    // attack on their own config; the floor is not overridable from the map.
    const m = floored({ sources: [{ path: "~/.ssh", sensitivity: "shared" }] });
    expect(classifyPath(m, join(HOME, ".ssh", "id_rsa"), opts)).toBe("secret");
  });

  it("covers floored single files as well as directories", () => {
    const m = floored({ sources: [{ path: "~", sensitivity: "shared" }] });
    expect(classifyPath(m, join(HOME, ".netrc"), opts)).toBe("secret");
    expect(classifyPath(m, join(HOME, ".claude.json"), opts)).toBe("secret");
  });

  it("leaves an unfloored map's own rules intact", () => {
    const m = floored({ sources: [{ path: "/work/repo", sensitivity: "shared" }] });
    expect(classifyPath(m, "/work/repo/src/x.ts", opts)).toBe("shared");
  });

  it("is idempotent, so applying it twice cannot change a verdict", () => {
    const once = floored({ sources: [{ path: "~", sensitivity: "shared" }] });
    const twice = withFloor(once, HOME);
    expect(classifyPath(twice, join(HOME, ".ssh", "id_rsa"), opts)).toBe("secret");
    expect(classifyPath(twice, join(HOME, "notes"), opts)).toBe("shared");
  });
});
