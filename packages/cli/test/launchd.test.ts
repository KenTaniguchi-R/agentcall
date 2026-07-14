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
  it("uninstall removes the plist", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    mkdirSync(join(p.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(p.plistFile, "x");
    uninstallLaunchAgent(p, () => {});
    expect(existsSync(p.plistFile)).toBe(false);
  });
});
