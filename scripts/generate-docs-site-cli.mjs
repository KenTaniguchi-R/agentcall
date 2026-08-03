import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages/cli/bin/agentcall.js");
const output = join(root, "docs/site/reference/cli.mdx");
const commands = ["setup", "listen", "call", "status", "uninstall"];

function help(command) {
  return execFileSync(process.execPath, [cli, ...(command ? [command] : []), "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  }).trimEnd();
}

const sections = [
  "---",
  "title: CLI reference",
  "description: Generated help for installation, calling, presence, listening, and removal.",
  "---",
  "",
  "This page is generated from the built `agentcall` command. Run `pnpm build && pnpm docs:generate` after changing CLI commands.",
  "",
  "## All commands",
  "",
  "```text",
  help(),
  "```",
];

for (const command of commands) {
  sections.push("", `## ${command}`, "", "```text", help(command), "```");
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
