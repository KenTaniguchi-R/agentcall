import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import {
  checkCredentialStorage,
  diagnoseInstallation,
  renderDoctorHuman,
} from "../src/doctor.js";
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

describe("diagnoseInstallation", () => {
  it("reports an unconfigured installation", async () => {
    const paths = getPaths(tempDir("agentcall-doctor-empty-"));
    const report = await diagnoseInstallation({ ...baseDeps, paths });
    expect(report.ok).toBe(false);
    expect(renderDoctorHuman(report)).toMatch(/config.*setup/i);
  });

  it("accepts a healthy caller-only installation without agent probes", async () => {
    const paths = configured(false);
    const report = await diagnoseInstallation({ ...baseDeps, paths });
    expect(report.ok).toBe(true);
    expect(report.notes.join("\n")).toMatch(/caller-only/i);
  });

  it("returns one structured report for tasks, effective policy, card drift, and runtime health", async () => {
    const paths = configured(true);
    const report = await diagnoseInstallation({ ...baseDeps, paths });
    expect(report.ok).toBe(true);
    expect(report.self).toMatchObject({
      tasks: [{ id: "ask", name: "Ask a question" }],
      policy: { default_access: "allowed", callers: [], assertions_passed: 0 },
      card: { status: "never-published" },
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "task validity", status: "pass" }),
      expect.objectContaining({ name: "effective policy", status: "pass" }),
      expect.objectContaining({ name: "card drift", status: "warning" }),
      expect.objectContaining({ name: "relay status", status: "pass", detail: "online" }),
    ]));
    expect(renderDoctorHuman(report)).toMatch(/Effective policy.*allowed/is);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("refuses legacy multi-line state", async () => {
    const paths = getPaths(tempDir("agentcall-doctor-legacy-"));
    mkdirSync(`${paths.dir}/lines/claude`, { recursive: true });
    const report = await diagnoseInstallation({ ...baseDeps, paths });
    expect(report.ok).toBe(false);
    expect(renderDoctorHuman(report)).toMatch(/legacy multi-line.*migration/i);
  });
});
