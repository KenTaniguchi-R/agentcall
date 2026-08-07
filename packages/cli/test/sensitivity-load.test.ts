import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVITY_MAP, defaultSensitivityMap, loadSensitivityMap } from "../src/sensitivity.js";
import { tempDir, tempLine } from "./helpers.js";
import type { LinePaths } from "../src/paths.js";

// tempLine builds the paths but does not create the line directory; anything
// writing a config file has to make it first.
function seed(p: LinePaths, contents: unknown): LinePaths {
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.sensitivityFile, typeof contents === "string" ? contents : JSON.stringify(contents));
  return p;
}

describe("loadSensitivityMap", () => {
  it("returns the safe default when the file is absent", () => {
    // A fresh install has no map. Empty sources means everything is secret,
    // which is a refusal to answer rather than a leak.
    const p = tempLine();
    expect(loadSensitivityMap(p)).toEqual(DEFAULT_SENSITIVITY_MAP);
  });

  it("reads a map the owner wrote", () => {
    const p = seed(tempLine(), {
      sources: [{ path: "/work/repo", sensitivity: "shared" }],
    });
    const m = loadSensitivityMap(p);
    expect(m.sources).toEqual([{ path: "/work/repo", sensitivity: "shared" }]);
  });

  it("throws on a malformed map rather than falling back", () => {
    // Same contract as loadUserPolicy: silently falling back to the default
    // would turn a typo into a policy change. Here the direction is the other
    // way round -- the default is restrictive -- but a silent fallback would
    // still mean the owner's map stopped applying without anyone being told.
    const p = seed(tempLine(), "{ not json");
    expect(() => loadSensitivityMap(p)).toThrow(/sensitivity map is invalid/);
  });

  it("throws on a well-formed file with an unknown sensitivity", () => {
    const p = seed(tempLine(), { sources: [{ path: "/x", sensitivity: "topsecret" }] });
    expect(() => loadSensitivityMap(p)).toThrow(/sensitivity map is invalid/);
  });

  it("puts the map beside the line's other config", () => {
    const p = tempLine();
    expect(p.sensitivityFile).toBe(join(p.dir, "sensitivity.json"));
  });
});

// The seed is deliberately OPEN as of 2026-08-07. It used to name only the git
// repository `setup` ran in, which left skills, MCP servers, notes and every
// other directory refused on a fresh install — the state that made the product
// answer "I can't share that" to most real questions.
//
// $HOME is now labelled `internal`, and the non-overridable floor
// (builtinSecretSources) is what keeps ~/.ssh, ~/.aws, ~/.agentcall and the
// shell rc files out of it. See
// docs/superpowers/specs/2026-08-07-open-default-design.md for what this gives
// up: the seed is credential-safe, not confidential.
describe("defaultSensitivityMap", () => {
  it("labels $HOME internal so a fresh line can answer from the owner's real context", () => {
    const home = tempDir("home-");
    expect(defaultSensitivityMap(join(home, "coding", "proj"), home).sources)
      .toEqual([{ path: home, sensitivity: "shared" }]);
  });

  it("labels $HOME regardless of where setup ran, including $HOME itself", () => {
    // The walk-up to a git repository is gone: the answer no longer depends on
    // cwd, so running `setup` in a subdirectory, in a repo, or in $HOME all
    // seed the same map. A stray .git in $HOME is no longer a special case
    // because $HOME is what gets labelled either way.
    const home = tempDir("home-");
    mkdirSync(join(home, ".git"), { recursive: true });
    expect(defaultSensitivityMap(home, home).sources)
      .toEqual([{ path: home, sensitivity: "shared" }]);
  });

  it("names nothing when no home is known", () => {
    // Fail closed rather than guess a root. Every production caller passes
    // paths.machine.userHome, so this is the misconfiguration path.
    const plain = tempDir("plain-");
    expect(defaultSensitivityMap(plain).sources).toEqual([]);
  });

  it("does not label a git repository as a separate source", () => {
    // Previously the repo root was named explicitly. It is now covered by the
    // $HOME label, and naming it again would be a second rule of equal effect
    // that could drift from the first.
    const home = tempDir("home-");
    const repo = join(home, "coding", "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(defaultSensitivityMap(repo, home).sources)
      .toEqual([{ path: home, sensitivity: "shared" }]);
  });
});
