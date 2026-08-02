import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../src/json-store.js";

describe("writeJsonAtomic", () => {
  it("leaves the previous file intact when serialization fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentcall-json-store-"));
    const file = join(dir, "config.json");
    writeFileSync(file, "original\n");
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => writeJsonAtomic(file, circular)).toThrow(/circular/i);
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });
});
