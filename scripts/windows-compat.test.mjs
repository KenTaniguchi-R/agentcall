import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("native Windows CI keeps the engines and unsupported-platform contracts explicit", () => {
  const workflow = read(".github/workflows/ci.yml");
  const cliPackage = JSON.parse(read("packages/cli/package.json"));

  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  windows-compat:/m);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /node: \[20, 22, 24\]/);
  assert.match(workflow, /shell: pwsh/);
  assert.match(workflow, /pnpm --filter @benree\/agentcall-relay test/);
  assert.match(workflow, /pnpm --filter @benree\/agentcall test:windows/);
  assert.match(workflow, /#251/);
  assert.match(workflow, /--force/);
  assert.match(workflow, /agentcall\.cmd/);
  assert.match(workflow, /\$ErrorActionPreference = "Continue"/);
  assert.match(workflow, /\$ErrorActionPreference = \$previousErrorAction/);
  assert.match(workflow, /\$global:LASTEXITCODE = 0/);
  assert.equal(typeof cliPackage.scripts["test:windows"], "string");
  assert.equal(cliPackage.os.includes("win32"), false);
});

test("the compatibility inventory names every required blocker and manual probe", () => {
  const inventory = read("docs/windows-compatibility.md");
  for (const phrase of [
    "npm `os` metadata",
    "managed-policy paths",
    "fixture shebangs and executable bits",
    "Windows ACLs",
    "listener supervision",
    "process-tree teardown",
    "`.cmd` / `.exe` discovery",
    "PowerShell quoting",
    "setup",
    "foreground listen",
    "inbound call",
    "cancellation",
    "timeout",
    "status",
    "uninstall",
    "#251",
  ]) {
    assert.match(inventory, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});
