import { describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";

function commandTree(command: { name(): string; alias(): string; description(): string; commands: Array<any>; options: Array<{ flags: string; description: string }> }): unknown {
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
});
