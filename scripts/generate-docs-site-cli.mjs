import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { createProgram } from "../packages/cli/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages/cli/bin/agentcall.js");
const output = join(root, "docs/site/reference/cli.mdx");

function commandPaths(command, parents = []) {
  return command.commands.flatMap((child) => {
    const path = [...parents, child.name()];
    return [path, ...commandPaths(child, path)];
  });
}

function help(command = []) {
  return execFileSync(process.execPath, [cli, ...command, "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  }).trimEnd();
}

const sections = [
  "---",
  "title: CLI reference",
  "description: Complete generated help for every AgentCall command and nested subcommand.",
  "---",
  "",
  "This page is generated recursively from the built `agentcall` command tree. Run `pnpm build && pnpm docs:generate` after changing any command, option, argument, or description.",
  "",
  "## All commands",
  "",
  "```text",
  help(),
  "```",
];

for (const command of commandPaths(createProgram())) {
  const path = command.join(" ");
  sections.push("", `## ${path}`, "", "```text", help(command), "```");
}

sections.push("");
const generated = sections.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) {
    console.error("CLI reference is stale; run pnpm docs:generate and commit it");
    process.exit(1);
  }
} else {
  writeFileSync(output, generated);
}
