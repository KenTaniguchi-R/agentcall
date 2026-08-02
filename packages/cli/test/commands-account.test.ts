import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Deps, Io } from "../src/commands/deps.js";
import { saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";

vi.mock("../src/setup.js", async () => {
  const actual = await vi.importActual<typeof import("../src/setup.js")>("../src/setup.js");
  return { ...actual, runSetup: vi.fn() };
});
vi.mock("../src/doctor.js", async () => {
  const actual = await vi.importActual<typeof import("../src/doctor.js")>("../src/doctor.js");
  return { ...actual, runDoctor: vi.fn() };
});
vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { ...actual, rotateToken: vi.fn() };
});
vi.mock("../src/launchd.js", async () => {
  const actual = await vi.importActual<typeof import("../src/launchd.js")>("../src/launchd.js");
  return {
    ...actual,
    installLaunchAgent: vi.fn(),
    isLaunchAgentInstalled: vi.fn(),
    uninstallLaunchAgent: vi.fn(),
  };
});
vi.mock("../src/listener.js", async () => {
  const actual = await vi.importActual<typeof import("../src/listener.js")>("../src/listener.js");
  return { ...actual, startListener: vi.fn() };
});

import { doctor, listen, rotate, setup, uninstall } from "../src/commands/account.js";
import { runSetup } from "../src/setup.js";
import { runDoctor } from "../src/doctor.js";
import { rotateToken, ApiError } from "../src/api.js";
import { installLaunchAgent, isLaunchAgentInstalled, uninstallLaunchAgent } from "../src/launchd.js";
import { startListener } from "../src/listener.js";

function fakeIo(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines, errors,
    log: (s) => lines.push(s),
    error: (s) => errors.push(s),
    ask: async () => "",
  };
}

let dir: string;
let deps: Deps & { io: ReturnType<typeof fakeIo> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-account-"));
  deps = { paths: getPaths(dir), io: fakeIo() };
  vi.mocked(runSetup).mockReset();
  vi.mocked(runDoctor).mockReset();
  vi.mocked(rotateToken).mockReset();
  vi.mocked(installLaunchAgent).mockReset();
  vi.mocked(isLaunchAgentInstalled).mockReset();
  vi.mocked(uninstallLaunchAgent).mockReset();
  vi.mocked(startListener).mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("setup", () => {
  it("throws (for run() to set exit 1) when runSetup resolves ready: false", async () => {
    vi.mocked(runSetup).mockResolvedValue({ ready: false });

    await expect(setup(deps, {})).rejects.toBeInstanceOf(Error);
    // ExitOnly: the failure was already reported by runSetup itself.
    expect(deps.io.lines).toEqual([]);
    expect(deps.io.errors).toEqual([]);
  });

  it("does not throw when runSetup resolves ready: true", async () => {
    vi.mocked(runSetup).mockResolvedValue({ ready: true });

    await expect(setup(deps, {})).resolves.toBeUndefined();
  });

  it("forwards options to runSetup", async () => {
    vi.mocked(runSetup).mockResolvedValue({ ready: true });

    await setup(deps, { handle: "ken", agent: "claude", relay: "https://r.test", callerOnly: true });

    expect(vi.mocked(runSetup).mock.calls[0][0]).toMatchObject({
      handle: "ken", agent: "claude", relay: "https://r.test", callerOnly: true,
    });
  });
});

describe("doctor", () => {
  it("sets process.exitCode to whatever runDoctor returns, without coercing to 0/1", async () => {
    // runDoctor's return type is a plain number, not a 0|1 union; this pins
    // that the command forwards it verbatim rather than routing it through
    // run()'s throw-to-exit-1 convention.
    vi.mocked(runDoctor).mockResolvedValue(2);

    await doctor(deps);

    expect(process.exitCode).toBe(2);
  });

  it("sets exit 0 when runDoctor reports success", async () => {
    vi.mocked(runDoctor).mockResolvedValue(0);

    await doctor(deps);

    expect(process.exitCode).toBe(0);
  });
});

describe("rotate", () => {
  it("saves the new token and reports success without restarting an uninstalled listener", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "old", relay: "https://r.test", agent_kind: "claude" });
    vi.mocked(rotateToken).mockResolvedValue({ token: "new" });
    vi.mocked(isLaunchAgentInstalled).mockReturnValue(false);

    await rotate(deps);

    expect(deps.io.lines).toEqual([
      "Token rotated for ken. The old token no longer works.",
      "Restart `agentcall listen` so it picks up the new token.",
    ]);
    expect(installLaunchAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("restarts an installed background listener with the new token", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "old", relay: "https://r.test", agent_kind: "claude" });
    vi.mocked(rotateToken).mockResolvedValue({ token: "new" });
    vi.mocked(isLaunchAgentInstalled).mockReturnValue(true);

    await rotate(deps);

    expect(installLaunchAgent).toHaveBeenCalledWith(deps.paths);
    expect(deps.io.lines).toEqual([
      "Token rotated for ken. The old token no longer works.",
      "Background listener restarted with the new token.",
    ]);
  });

  it("throws (for run() to set exit 1) rather than swallowing an ApiError itself", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "old", relay: "https://r.test", agent_kind: "claude" });
    vi.mocked(rotateToken).mockRejectedValue(new ApiError("relay unreachable", "network"));

    await expect(rotate(deps)).rejects.toThrow("relay unreachable");
  });
});

describe("listen", () => {
  it("starts the listener for a callable config and logs the relay it's connecting to", () => {
    vi.useFakeTimers();
    try {
      saveConfig(deps.paths, { handle: "ken", token: "tok", relay: "https://r.test", agent_kind: "claude" });
      vi.mocked(startListener).mockReturnValue({ stop: vi.fn() });

      listen(deps);

      expect(deps.io.lines).toEqual(["agentcall listener starting for ken -> https://r.test"]);
      expect(vi.mocked(startListener).mock.calls[0][0]).toMatchObject({
        relay: "https://r.test", paths: deps.paths,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the config is caller-only (not callable)", () => {
    saveConfig(deps.paths, { handle: "ken", token: "tok", relay: "https://r.test" });

    expect(() => listen(deps)).toThrow(/caller-only/);
    expect(startListener).not.toHaveBeenCalled();
  });
});

describe("uninstall", () => {
  it("without --purge leaves the config directory in place", () => {
    saveConfig(deps.paths, { handle: "ken", token: "tok", relay: "https://r.test" });

    uninstall(deps, {});

    expect(uninstallLaunchAgent).toHaveBeenCalledWith(deps.paths);
    expect(existsSync(deps.paths.dir)).toBe(true);
    expect(deps.io.lines).toEqual(["agentcall listener removed."]);
  });

  it("with --purge deletes the config directory", () => {
    saveConfig(deps.paths, { handle: "ken", token: "tok", relay: "https://r.test" });

    uninstall(deps, { purge: true });

    expect(existsSync(deps.paths.dir)).toBe(false);
    expect(deps.io.lines).toEqual(["agentcall listener removed. Config purged."]);
  });
});
