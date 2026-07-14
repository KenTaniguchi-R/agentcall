import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plistContent, installLaunchAgent, uninstallLaunchAgent } from "../src/launchd.js";
import { getPaths } from "../src/paths.js";

describe("plistContent", () => {
  it("renders a valid-looking plist", () => {
    const p = getPaths("/Users/ken");
    const xml = plistContent("/usr/local/bin/node", "/g/agentcall/dist/index.js", p);
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("tech.benree.agentcall.listener");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/g/agentcall/dist/index.js</string>");
    expect(xml).toContain("<string>listen</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain(p.listenerLog);
    expect(xml).toContain("<key>HOME</key>");
  });
});

describe("plistContent PATH", () => {
  it("prepends extraPathDirs and the node bin's dir, ahead of the base dirs, deduped", () => {
    const p = getPaths("/Users/ken");
    const xml = plistContent("/Users/x/.local/bin/node", "/g/agentcall/dist/index.js", p, [
      "/Users/x/.local/bin",
    ]);
    const match = xml.match(/<key>PATH<\/key><string>([^<]+)<\/string>/);
    expect(match).not.toBeNull();
    const dirs = match![1]!.split(":");
    // deduped: extraPathDirs and dirname(nodeBin) are the same dir here
    expect(dirs).toEqual(["/Users/x/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  });

  it("always includes the node binary's directory, even without extraPathDirs", () => {
    const p = getPaths("/Users/ken");
    const xml = plistContent("/opt/local/bin/node", "/g/agentcall/dist/index.js", p);
    const match = xml.match(/<key>PATH<\/key><string>([^<]+)<\/string>/);
    expect(match![1]!.split(":")).toEqual([
      "/opt/local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ]);
  });
});

describe("install/uninstall", () => {
  it("writes plist and calls launchctl bootstrap", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    const calls: string[][] = [];
    installLaunchAgent(p, (cmd) => { calls.push(cmd); });
    expect(existsSync(p.plistFile)).toBe(true);
    expect(calls.some((c) => c[1] === "bootout")).toBe(true);
    expect(calls.some((c) => c[1] === "bootstrap")).toBe(true);
    expect(readFileSync(p.plistFile, "utf8")).toContain("agentcall");
  });
  it("forwards extraPathDirs into the written plist", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    installLaunchAgent(p, () => {}, ["/Users/x/.local/bin"]);
    const xml = readFileSync(p.plistFile, "utf8");
    expect(xml).toContain("<string>/Users/x/.local/bin:");
  });
  // Regression: bootout of a running (KeepAlive) listener returns before
  // launchd finishes tearing it down, so an immediate bootstrap fails with
  // "Input/output error" and setup dies — install must retry briefly.
  it("retries bootstrap while launchd finishes tearing down the old instance", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    let bootstraps = 0;
    installLaunchAgent(
      p,
      (cmd) => {
        if (cmd[1] === "bootstrap" && ++bootstraps < 3) throw new Error("Bootstrap failed: 5: Input/output error");
      },
      [],
      () => {},
    );
    expect(bootstraps).toBe(3);
  });

  it("gives up with an error after repeated bootstrap failures", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    expect(() =>
      installLaunchAgent(
        p,
        (cmd) => {
          if (cmd[1] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
        },
        [],
        () => {},
      ),
    ).toThrow(/Bootstrap failed/);
  });

  it("uninstall removes the plist", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    mkdirSync(join(p.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(p.plistFile, "x");
    uninstallLaunchAgent(p, () => {});
    expect(existsSync(p.plistFile)).toBe(false);
  });
});
