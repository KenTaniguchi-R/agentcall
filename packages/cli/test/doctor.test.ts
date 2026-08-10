import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { checkCredentialStorage, runDoctor } from "../src/doctor.js";
import { getPaths } from "../src/paths.js";
import { defaultScope } from "../src/scope.js";
import { tempDir } from "./helpers.js";

const installRoot = tempDir("agentcall-cli-install-");
const entry = join(installRoot, "agentcall.js");
const bin = join(installRoot, "agentcall");
writeFileSync(entry, "#!/usr/bin/env node\n");
symlinkSync(entry, bin);

const baseDeps = {
  platform: "darwin" as const,
  inspectListenerServiceFn: () => ({ kind: "launchd" as const, installed: true, running: true }),
  getStatusFn: async () => ({ online: true }),
  getRecoveryStatusFn: async () => ({ issued: true, generation: 2, recovery_public_id: "agr_aaaaaaaaaaaaaaaa" }),
  verifyFns: { resolveBin: () => "/fake/bin/claude", runFn: async () => ({ text: "OK" }), execFn: () => {} },
  callFn: async () => ({ type: "call_reply", call_id: "c1", text: "hi", task: "ask" }) as never,
  guardFn: async () => ({ output: "blocked", home: tempDir("agentcall-guard-") }),
  guardBinaryFn: async () => true,
  keyHealthFn: async () => [],
  pkgFn: () => ({ name: "@benree/agentcall", version: "0.4.0", bin: { agentcall: "./bin/agentcall.js" } }),
  selfPathFn: () => entry,
  whichFn: () => [bin],
};

function configured(callable = true) {
  const root = tempDir("agentcall-doctor-");
  const paths = getPaths(root, root);
  saveConfig(paths, {
    org: "acme", handle: "ken", token: "t", relay: "https://relay.example",
    ...(callable ? { agent_kind: "claude" as const } : {}),
  });
  writeFileSync(paths.scopeFile, JSON.stringify(defaultScope(root)));
  return paths;
}

describe("credential storage", () => {
  it("accepts a 600 config in a 700 state directory", () => {
    const paths = configured(false);
    expect(checkCredentialStorage(paths, "darwin").ok).toBe(true);
  });

  it("rejects broad config permissions", () => {
    const paths = configured(false);
    chmodSync(paths.configFile, 0o644);
    expect(checkCredentialStorage(paths, "darwin").ok).toBe(false);
  });
});

describe("runDoctor", () => {
  it("reports an unconfigured installation", async () => {
    const output: string[] = [];
    const paths = getPaths(tempDir("agentcall-doctor-empty-"));
    expect(await runDoctor({ ...baseDeps, paths, log: (line) => output.push(line) })).toBe(1);
    expect(output.join("\n")).toMatch(/config.*setup/i);
  });

  it("accepts a healthy caller-only installation without agent probes", async () => {
    const output: string[] = [];
    const paths = configured(false);
    expect(await runDoctor({ ...baseDeps, paths, log: (line) => output.push(line) })).toBe(0);
    expect(output.join("\n")).toMatch(/caller-only/i);
  });

  it("runs the callable installation ladder once", async () => {
    const output: string[] = [];
    const paths = configured(true);
    expect(await runDoctor({ ...baseDeps, paths, log: (line) => output.push(line) })).toBe(0);
    expect(output.join("\n")).toMatch(/relay status.*online/i);
    expect(output.join("\n")).not.toMatch(/line claude/);
  });

  it("refuses legacy multi-line state", async () => {
    const paths = getPaths(tempDir("agentcall-doctor-legacy-"));
    mkdirSync(`${paths.dir}/lines/claude`, { recursive: true });
    const output: string[] = [];
    expect(await runDoctor({ ...baseDeps, paths, log: (line) => output.push(line) })).toBe(1);
    expect(output.join("\n")).toMatch(/legacy multi-line.*migration/i);
  });
});
