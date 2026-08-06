import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVITY_MAP, loadSensitivityMap } from "../src/sensitivity.js";
import { tempLine } from "./helpers.js";
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
      sources: [{ path: "/work/repo", sensitivity: "internal" }],
      mcp: { jira: "internal" },
    });
    const m = loadSensitivityMap(p);
    expect(m.sources).toEqual([{ path: "/work/repo", sensitivity: "internal" }]);
    expect(m.mcp).toEqual({ jira: "internal" });
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
