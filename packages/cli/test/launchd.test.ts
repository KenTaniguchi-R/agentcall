import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { plistContent, installLaunchAgent, isLaunchAgentInstalled, launchAgentFile, LAUNCH_LABEL, uninstallLaunchAgent } from "../src/launchd.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

describe("plistContent", () => {
  it("renders a valid-looking plist", () => {
    const m = getPaths("/Users/ken", "/Users/ken");
    const xml = plistContent("/usr/local/bin/node", "/g/agentcall/dist/index.js", m);
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("tech.benree.agentcall.listener");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/g/agentcall/dist/index.js</string>");
    expect(xml).toContain("<string>listen</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain(m.listenerLog);
    expect(xml).toContain("<key>HOME</key>");
  });

  it("escapes filesystem paths as XML element content", () => {
    const p = getPaths("/Users/Ken & Lee <admin>", "/Users/Ken & Lee <admin>");
    const xml = plistContent(
      "/opt/Node & Co/bin/node",
      "/Applications/Agent <Call>/dist/index.js",
      p,
      ["/custom/bin > system"],
    );

    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("<string>/opt/Node &amp; Co/bin/node</string>");
    expect(xml).toContain("<string>/Applications/Agent &lt;Call&gt;/dist/index.js</string>");
    expect(xml).toContain("<key>HOME</key><string>/Users/Ken &amp; Lee &lt;admin&gt;</string>");
    expect(xml).toContain("/custom/bin &gt; system:");
  });

  it("rejects path characters that XML 1.0 cannot represent", () => {
    const p = getPaths("/Users/ken", "/Users/ken");

    expect(() => plistContent("/opt/node\u0001bin/node", "/agentcall/dist/index.js", p))
      .toThrow(/XML 1\.0 cannot represent/);
  });
});

describe("plistContent PATH", () => {
  it("prepends extraPathDirs and the node bin's dir, ahead of the base dirs, deduped", () => {
    const m = getPaths("/Users/ken", "/Users/ken");
    const xml = plistContent("/Users/x/.local/bin/node", "/g/agentcall/dist/index.js", m, [
      "/Users/x/.local/bin",
    ]);
    const match = xml.match(/<key>PATH<\/key><string>([^<]+)<\/string>/);
    expect(match).not.toBeNull();
    const dirs = match![1]!.split(":");
    // deduped: extraPathDirs and dirname(nodeBin) are the same dir here
    expect(dirs).toEqual(["/Users/x/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  });

  it("always includes the node binary's directory, even without extraPathDirs", () => {
    const m = getPaths("/Users/ken", "/Users/ken");
    const xml = plistContent("/opt/local/bin/node", "/g/agentcall/dist/index.js", m);
    const match = xml.match(/<key>PATH<\/key><string>([^<]+)<\/string>/);
    expect(match![1]!.split(":")).toEqual([
      "/opt/local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ]);
  });
});

describe("install/uninstall", () => {
  it("writes plist and calls launchctl bootstrap", () => {
    const home = tempDir("agentcall-ld-");
    const m = getPaths(home, home);
    const calls: string[][] = [];
    installLaunchAgent(m, (cmd) => { calls.push(cmd); });
    expect(existsSync(launchAgentFile(m))).toBe(true);
    expect(calls.some((c) => c[1] === "bootout")).toBe(true);
    expect(calls.some((c) => c[1] === "bootstrap")).toBe(true);
    expect(readFileSync(launchAgentFile(m), "utf8")).toContain("agentcall");
  });
  it("forwards extraPathDirs into the written plist", () => {
    const home = tempDir("agentcall-ld-");
    const m = getPaths(home, home);
    installLaunchAgent(m, () => {}, ["/Users/x/.local/bin"]);
    const xml = readFileSync(launchAgentFile(m), "utf8");
    expect(xml).toContain("<string>/Users/x/.local/bin:");
  });
  // Regression: bootout of a running (KeepAlive) listener returns before
  // launchd finishes tearing it down, so an immediate bootstrap fails with
  // "Input/output error" and setup dies — install must retry briefly.
  it("retries bootstrap while launchd finishes tearing down the old instance", () => {
    const home = tempDir("agentcall-ld-");
    const m = getPaths(home, home);
    let bootstraps = 0;
    installLaunchAgent(
      m,
      (cmd) => {
        if (cmd[1] === "bootstrap" && ++bootstraps < 3) throw new Error("Bootstrap failed: 5: Input/output error");
      },
      [],
      () => {},
    );
    expect(bootstraps).toBe(3);
  });

  it("gives up with an error after repeated bootstrap failures", () => {
    const home = tempDir("agentcall-ld-");
    const m = getPaths(home, home);
    expect(() =>
      installLaunchAgent(
        m,
        (cmd) => {
          if (cmd[1] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
        },
        [],
        () => {},
      ),
    ).toThrow(/Bootstrap failed/);
  });

  it("uninstall removes the plist", () => {
    const home = tempDir("agentcall-ld-");
    const m = getPaths(home, home);
    mkdirSync(join(m.userHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(launchAgentFile(m), "x");
    uninstallLaunchAgent(m, () => {});
    expect(existsSync(launchAgentFile(m))).toBe(false);
  });
});

// This module is the only thing that should know the listener is a macOS
// LaunchAgent — callers ask whether it's installed rather than building a
// plist path themselves; the platform-neutral listener module now selects
// this adapter on macOS and the systemd sibling on Linux.
describe("isLaunchAgentInstalled", () => {
  it("reports false before install and true once the plist exists", () => {
    const home = tempDir("agentcall-ld-");
    const m = getPaths(home, home);
    expect(isLaunchAgentInstalled(m)).toBe(false);
    mkdirSync(join(m.userHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(launchAgentFile(m), "x");
    expect(isLaunchAgentInstalled(m)).toBe(true);
  });

  it("derives the plist path from home and the launchd label", () => {
    expect(launchAgentFile(getPaths("/tmp/fakehome", "/tmp/fakehome")))
      .toBe(`/tmp/fakehome/Library/LaunchAgents/${LAUNCH_LABEL}.plist`);
  });
});

describe("plist uses the real home, not the state root", () => {
  it("sets HOME to userHome so the spawned agent finds its credentials", () => {
    const m = getPaths("/tmp/state", "/Users/real");
    const xml = plistContent("/usr/bin/node", "/pkg/dist/index.js", m);
    expect(xml).toContain("<key>HOME</key><string>/Users/real</string>");
    expect(xml).not.toContain("<string>/tmp/state</string>");
  });

  it("writes the plist under userHome's LaunchAgents", () => {
    const m = getPaths("/tmp/state", "/Users/real");
    expect(launchAgentFile(m)).toBe(
      "/Users/real/Library/LaunchAgents/tech.benree.agentcall.listener.plist",
    );
  });

  it("logs to the machine-scoped listener log", () => {
    const m = getPaths("/tmp/state", "/Users/real");
    expect(plistContent("/usr/bin/node", "/pkg/dist/index.js", m))
      .toContain("<key>StandardOutPath</key><string>/tmp/state/.agentcall/listener.log</string>");
  });

  it("runs `listen` with no line argument — one process serves every line", () => {
    const m = getPaths("/tmp/state", "/Users/real");
    const xml = plistContent("/usr/bin/node", "/pkg/dist/index.js", m);
    expect(xml).toContain("<string>listen</string>");
    expect(xml).not.toContain("--line");
  });
});
