import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSnippet, SNIPPET } from "../src/snippet.js";

describe("appendSnippet", () => {
  it("creates the file and appends once", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agentcall-sn-")), "CLAUDE.md");
    expect(appendSnippet(file)).toBe("appended");
    expect(appendSnippet(file)).toBe("already_present");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("agentcall call");
    expect(content.match(/<!-- agentcall -->/g)?.length).toBe(1);
    expect(SNIPPET).toContain("agentcall status");
  });
});
