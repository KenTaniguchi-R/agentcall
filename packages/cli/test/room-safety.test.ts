import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOM_SAFETY_CONTRACT_VERSION,
  ROOM_SAFE_CANCELLATION,
  PASSING_ROOM_SAFETY_SURFACES,
  buildRoomSafeSpawnContract,
  buildRoomSafetyProbeSpawn,
  roomSafetySupport,
  runRoomSafeAgent,
  type RoomSafetyEvidence,
} from "../src/room-safety.js";

const passingEvidence: RoomSafetyEvidence = {
  contractVersion: ROOM_SAFETY_CONTRACT_VERSION,
  agent: "claude",
  cliVersion: "2.1.220",
  platform: "darwin",
  arch: "arm64",
  probedAt: "2026-08-03T00:00:00.000Z",
  command: ["claude", "--version"],
  surfaces: PASSING_ROOM_SAFETY_SURFACES,
};

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("Room safety adapter support", () => {
  it("fails closed when the exact agent, version, OS, and architecture have no probe evidence", () => {
    expect(roomSafetySupport({
      agent: "claude",
      cliVersion: "99.0.0",
      platform: "darwin",
      arch: "arm64",
    })).toEqual({
      supported: false,
      reason: "no Room safety evidence for claude 99.0.0 on darwin/arm64",
    });
  });

  it("supports only an exact tuple backed by complete passing evidence", () => {
    expect(roomSafetySupport({
      agent: "claude",
      cliVersion: "2.1.220",
      platform: "darwin",
      arch: "arm64",
    }, [passingEvidence])).toEqual({ supported: true, evidence: passingEvidence });
  });

  it("ships the exact live-probed Claude tuple and leaves Codex unsupported", () => {
    expect(roomSafetySupport({
      agent: "claude",
      cliVersion: "2.1.220",
      platform: "darwin",
      arch: "arm64",
    }, undefined, new Date("2026-08-04T03:40:00.000Z")).supported).toBe(true);
    expect(roomSafetySupport({
      agent: "codex",
      cliVersion: "0.146.0",
      platform: "darwin",
      arch: "arm64",
    })).toEqual({
      supported: false,
      reason: "no Room safety evidence for codex 0.146.0 on darwin/arm64",
    });
  });

  it("rejects malformed evidence that has no reproducible probe command", () => {
    expect(roomSafetySupport({
      agent: "claude",
      cliVersion: "2.1.220",
      platform: "darwin",
      arch: "arm64",
    }, [{ ...passingEvidence, command: [] }], new Date("2026-08-04T03:00:00.000Z"))).toEqual({
      supported: false,
      reason: "Room safety evidence has no probe command",
    });
  });

  it("rejects future-dated or older-than-90-day evidence", () => {
    const tuple = {
      agent: "claude" as const,
      cliVersion: "2.1.220",
      platform: "darwin" as const,
      arch: "arm64",
    };
    expect(roomSafetySupport(tuple, [passingEvidence], new Date("2026-08-02T23:00:00.000Z"))).toEqual({
      supported: false,
      reason: "Room safety evidence has an invalid probe timestamp",
    });
    expect(roomSafetySupport(tuple, [passingEvidence], new Date("2026-11-03T03:00:00.000Z"))).toEqual({
      supported: false,
      reason: "Room safety evidence is stale (older than 90 days)",
    });
  });

  it("names the failed surface instead of treating partial evidence as support", () => {
    const failed = {
      ...passingEvidence,
      surfaces: { ...passingEvidence.surfaces, outside_workdir_read: false },
    };
    expect(roomSafetySupport({
      agent: "claude",
      cliVersion: "2.1.220",
      platform: "darwin",
      arch: "arm64",
    }, [failed])).toEqual({
      supported: false,
      reason: "Room safety evidence failed: outside_workdir_read",
    });
  });

  it("rejects not_applicable for every mandatory safety surface", () => {
    const malformed = {
      ...passingEvidence,
      surfaces: { ...passingEvidence.surfaces, outside_workdir_read: "not_applicable" },
    } as unknown as RoomSafetyEvidence;
    expect(roomSafetySupport({
      agent: "claude",
      cliVersion: "2.1.220",
      platform: "darwin",
      arch: "arm64",
    }, [malformed])).toEqual({
      supported: false,
      reason: "Room safety evidence cannot mark outside_workdir_read as not_applicable",
    });
  });

  it("builds a tool-free Claude spawn with an explicit environment and cancellation contract", () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-room-safe-test-"));
    const contract = buildRoomSafeSpawnContract({
      agent: "claude",
      platform: "darwin",
      arch: "arm64",
      evidenceCatalog: [passingEvidence],
      prompt: "PROMPT",
      workdir,
      resolveBin: () => "/abs/claude",
      readVersion: () => "2.1.220 (Claude Code)",
      env: {
        HOME: "/Users/test",
        TMPDIR: "/private/tmp",
        LANG: "en_US.UTF-8",
        USER: "test",
        ANTHROPIC_AUTH_TOKEN: "auth-token",
        UNRELATED_SECRET: "must-not-pass",
        CLAUDE_CONFIG_DIR: "/attacker/config",
      },
    });

    expect(contract.spawn).toEqual({
      cmd: "/abs/claude",
      args: [
        "-p", "PROMPT", "--output-format", "json",
        "--permission-mode", "dontAsk", "--tools", "",
        "--safe-mode", "--no-session-persistence",
        "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--no-chrome", "--disable-slash-commands",
      ],
      cwd: workdir,
      env: {
        HOME: "/Users/test",
        TMPDIR: "/private/tmp",
        LANG: "en_US.UTF-8",
        USER: "test",
        ANTHROPIC_AUTH_TOKEN: "auth-token",
      },
    });
    expect(contract.cancellation).toBe(ROOM_SAFE_CANCELLATION);
  });

  it("rejects a workdir that already contains files or instructions", () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-room-unsafe-test-"));
    writeFileSync(join(workdir, "CLAUDE.md"), "malicious instructions");
    expect(() => buildRoomSafeSpawnContract({
      agent: "claude",
      platform: "darwin",
      arch: "arm64",
      evidenceCatalog: [passingEvidence],
      prompt: "PROMPT",
      workdir,
      resolveBin: () => "/abs/claude",
      readVersion: () => "2.1.220 (Claude Code)",
      env: { HOME: "/Users/test" },
    })).toThrow("Room safe workdir must be an empty directory");
  });

  it("builds the same candidate spawn for a live probe before that tuple is allowlisted", () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-room-probe-test-"));
    const spawn = buildRoomSafetyProbeSpawn({
      agent: "claude",
      prompt: "PROBE",
      workdir,
      resolveBin: () => "/abs/claude",
      env: { HOME: "/Users/test", UNRELATED_SECRET: "must-not-pass" },
    });
    expect(spawn.cmd).toBe("/abs/claude");
    expect(spawn.cwd).toBe(workdir);
    expect(spawn.args).toContain("--safe-mode");
    expect(spawn.args).toContain("--no-session-persistence");
    expect(spawn.args.slice(spawn.args.indexOf("--tools"), spawn.args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(spawn.env).toEqual({ HOME: "/Users/test" });
  });

  it("rejects an attempt to inject an inherited session into the Room adapter", () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-room-resume-test-"));
    expect(() => buildRoomSafetyProbeSpawn({
      agent: "claude",
      prompt: "PROBE",
      workdir,
      resolveBin: () => "/abs/claude",
      env: { HOME: "/Users/test" },
      resume: "attacker-session",
    } as Parameters<typeof buildRoomSafetyProbeSpawn>[0] & { resume: string })).toThrow(
      "Room safe mode does not accept inherited sessions",
    );
  });

  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "kills the full process tree through the non-forgeable Room executor",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agentcall-room-executor-test-"));
      const binDir = join(root, "bin");
      const workdir = join(root, "empty-workdir");
      const marker = join(root, "grandchild.pid");
      const wrapper = join(binDir, "claude");
      const previousPath = process.env.PATH;
      mkdirSync(binDir, { recursive: true });
      mkdirSync(workdir);
      writeFileSync(wrapper, [
        `#!${process.execPath}`,
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'if (process.argv[2] === "--version") { console.log("2.1.220 (Claude Code)"); process.exit(0); }',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1e6)"], { stdio: "inherit" });',
        `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
        'setTimeout(() => {}, 1e6);',
      ].join("\n"));
      chmodSync(wrapper, 0o755);

      try {
        const controller = new AbortController();
        process.env.PATH = binDir;
        const running = runRoomSafeAgent({
          agent: "claude",
          prompt: "PROBE",
          workdir,
          env: { HOME: "/Users/test", PATH: binDir },
          timeoutMs: 10_000,
          signal: controller.signal,
        });
        process.env.PATH = previousPath;
        expect(await waitUntil(() => existsSync(marker))).toBe(true);
        const grandchildPid = Number(readFileSync(marker, "utf8"));
        controller.abort();
        await expect(running).rejects.toMatchObject({ code: "canceled" });
        expect(await waitUntil(() => {
          try { process.kill(grandchildPid, 0); return false; } catch { return true; }
        })).toBe(true);
      } finally {
        process.env.PATH = previousPath;
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
