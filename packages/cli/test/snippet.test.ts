import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSnippet, SNIPPET } from "../src/snippet.js";
import { tempDir } from "./helpers.js";

function tempFile() { return join(tempDir("agentcall-sn-"), "CLAUDE.md"); }

describe("appendSnippet", () => {
  it("creates the file and appends once", () => {
    const file = tempFile();
    expect(appendSnippet(file)).toBe("appended");
    expect(appendSnippet(file)).toBe("already_present");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("agentcall call");
    expect(content.match(/<!-- agentcall -->/g)?.length).toBe(1);
  });

  it("mentions the contacts workflow", () => {
    expect(SNIPPET).toContain("agentcall contacts list");
    expect(SNIPPET).toContain("agentcall contacts add");
    expect(SNIPPET).toContain("agentcall inspect");
  });

  it("replaces a stale marker block in place, leaving surrounding content", () => {
    const file = tempFile();
    const stale = "<!-- agentcall -->\nold instructions\n<!-- /agentcall -->\n";
    writeFileSync(file, `# My rules\n\n${stale}\n# More rules\n`);
    expect(appendSnippet(file)).toBe("updated");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("# My rules");
    expect(content).toContain("# More rules");
    expect(content).not.toContain("old instructions");
    expect(content).toContain("agentcall contacts list");
    expect(content.match(/<!-- agentcall -->/g)?.length).toBe(1);
    expect(appendSnippet(file)).toBe("already_present");
  });

  it("leaves a file with an unclosed marker block untouched", () => {
    const file = tempFile();
    const before = "# rules\n<!-- agentcall -->\nno end marker\n";
    writeFileSync(file, before);
    expect(appendSnippet(file)).toBe("already_present");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
