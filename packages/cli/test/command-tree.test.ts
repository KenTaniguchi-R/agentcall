import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";

function commandTree(command: { name(): string; alias(): string; description(): string; commands: readonly any[]; options: readonly { flags: string; description: string }[] }): unknown {
  return {
    name: command.name(),
    alias: command.alias(),
    description: command.description(),
    options: command.options.map((option) => ({ flags: option.flags, description: option.description })),
    commands: command.commands.map(commandTree),
  };
}

describe("CLI command tree", () => {
  it("pins command paths, aliases, descriptions, and options", () => {
    expect(commandTree(createProgram())).toMatchSnapshot();
  });

  it("keeps diagnostics read-only and makes remote publication explicitly administrative", () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).not.toEqual(expect.arrayContaining(["lint", "policy", "card", "keys"]));

    const doctor = program.commands.find((command) => command.name() === "doctor")!;
    expect(doctor.options.map((option) => option.long)).toEqual(["--json"]);
    expect(doctor.commands).toHaveLength(0);

    const admin = program.commands.find((command) => command.name() === "admin")!;
    expect(admin.commands.map((command) => [
      command.name(),
      command.commands.map((child) => child.name()),
    ])).toEqual([
      ["card", ["publish"]],
      ["keys", ["publish"]],
    ]);
  });

  it("groups durable task retrieval under one jobs noun", () => {
    const jobs = createProgram().commands.find((command) => command.name() === "jobs")!;
    expect(jobs.commands.map((command) => command.name())).toEqual(["list", "get", "cancel"]);
  });
});

describe("--version", () => {
  // It reported 0.4.0 from a source literal while the published package had
  // moved on, so `agentcall --version` named a release whose command surface it
  // no longer had (#354). The value now comes from the manifest npm publishes;
  // this asserts the two cannot separate again.
  it("reports the version npm actually publishes", () => {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    const published = JSON.parse(readFileSync(manifest, "utf8")).version;

    expect(createProgram().version()).toBe(published);
    expect(published).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("ships the same version from every public package, because they release together", () => {
    const read = (relative: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")).version;

    expect(read("../../shared/package.json")).toBe(read("../package.json"));
  });
});
