import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installListenerService,
  listenerServiceFile,
} from "../src/listener-service.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

describe("background listener service", () => {
  it("installs and starts one user-level systemd service on Linux", () => {
    const home = tempDir("agentcall-systemd-");
    const machine = getPaths(home, home);
    const calls: string[][] = [];

    installListenerService(machine, {
      platform: "linux",
      execCmd: (command) => calls.push(command),
      extraPathDirs: ["/home/ken/.local/bin"],
    });

    const unitFile = listenerServiceFile(machine, "linux");
    expect(unitFile).toBe(join(home, ".config/systemd/user/agentcall-listener.service"));
    expect(existsSync(unitFile)).toBe(true);
    const unit = readFileSync(unitFile, "utf8");
    expect(unit).toContain("Description=AgentCall listener");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain('/dist/cli-entry.js" listen');
    expect(unit).not.toContain('/dist/index.js" listen');
    expect(unit).toContain(" listen");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(`Environment="HOME=${home}"`);
    expect(unit).toContain("/home/ken/.local/bin");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "agentcall-listener.service"],
      ["systemctl", "--user", "restart", "agentcall-listener.service"],
    ]);
  });

  it("repairs an existing systemd unit to owner-only permissions", () => {
    const home = tempDir("agentcall-systemd-");
    const machine = getPaths(home, home);
    const unitFile = listenerServiceFile(machine, "linux");
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(unitFile, "stale");
    chmodSync(unitFile, 0o666);

    installListenerService(machine, { platform: "linux", execCmd: () => {} });

    expect(statSync(unitFile).mode & 0o777).toBe(0o600);
  });
});
