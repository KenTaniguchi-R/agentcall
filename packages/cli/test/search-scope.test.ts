import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A scope guard, in the spirit of the exact-hook-set test the Composio
// research doc calls out. The design deliberately shipped explicit search
// ONLY: proactive routing (a UserPromptSubmit hook that suggests a colleague
// as you type) needs its own false-positive discipline and its own spec.
//
// If you are here because this test failed, that is the point: adding
// proactive routing must be a deliberate decision that edits this assertion,
// not a side effect of another change.
describe("search scope", () => {
  it("registers no SessionStart or UserPromptSubmit behavior", () => {
    for (const f of ["../src/search.ts", "../src/searchRefresh.ts", "../src/rosters.ts"]) {
      const src = read(f);
      expect(src).not.toContain("SessionStart");
      expect(src).not.toContain("UserPromptSubmit");
    }
  });

  it("keeps the ranker free of network and filesystem access", () => {
    const src = read("../src/search.ts");
    // The privacy claim — the query never leaves the machine — is only as
    // good as this. Keep I/O in searchRefresh.ts and api.ts.
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("node:fs");
  });
});
