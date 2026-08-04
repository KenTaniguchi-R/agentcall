import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonStore, writeJsonAtomic } from "../src/json-store.js";
import { tempDir } from "./helpers.js";

describe("writeJsonAtomic", () => {
  it("leaves the previous file intact when serialization fails", () => {
    const dir = tempDir("agentcall-json-store-");
    const file = join(dir, "config.json");
    writeFileSync(file, "original\n");
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => writeJsonAtomic(file, circular)).toThrow(/circular/i);
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });
});

describe("readJsonStore", () => {
  it("uses the explicit missing-file policy", () => {
    const dir = tempDir("agentcall-json-store-");
    const value = readJsonStore(join(dir, "missing.json"), { parse: (raw) => raw as string[] }, {
      missing: () => ["default"],
      corrupt: () => { throw new Error("unexpected corruption"); },
    });
    expect(value).toEqual(["default"]);
  });

  it("requires an explicit corruption policy and passes the detail to it", () => {
    const dir = tempDir("agentcall-json-store-");
    const file = join(dir, "broken.json");
    writeFileSync(file, "not json\n");
    const value = readJsonStore(file, { parse: (raw) => raw as string[] }, {
      missing: () => [],
      corrupt: (detail) => [`recovered: ${detail.length > 0 ? "json" : "unknown"}`],
    });
    expect(value).toEqual(["recovered: json"]);
  });
});
