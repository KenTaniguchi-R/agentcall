import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExtraPathDirs, runSetup } from "../src/setup.js";
import { getPaths } from "../src/paths.js";

let server: Server;
afterEach(() => server?.close());

function fakeRelay(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { handle } = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "tok-123", address: `${handle}@agentcall.benree.tech` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

describe("runSetup", () => {
  it("registers, writes config + srt.json, creates public dir (non-interactive)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg).toMatchObject({ handle: "ken", token: "tok-123", agent_kind: "claude", relay });
      expect(existsSync(p.srtFile)).toBe(true);
      expect(existsSync(p.publicDir)).toBe(true);
      const srt = JSON.parse(readFileSync(p.srtFile, "utf8"));
      // srt.ts denies reads to the whole home dir by default and re-allows
      // only specific paths (see srt.ts's rationale comment), so ~/.ssh is
      // protected implicitly rather than by being named in a denylist.
      expect(srt.filesystem.denyRead).toContain("~");
      expect(JSON.stringify(srt.filesystem.allowRead)).not.toContain(".ssh");
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("prompts for a missing handle via io.ask", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      const asked: string[] = [];
      await runSetup({
        agent: "claude",
        relay,
        snippet: false,
        skipLaunchd: true,
        io: { ask: async (q) => { asked.push(q); return "asked-handle"; } },
      });
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg.handle).toBe("asked-handle");
      expect(asked.length).toBeGreaterThan(0);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("detects the agent kind via injectable hasBin when --agent is omitted", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({
        handle: "ken2",
        relay,
        snippet: false,
        skipLaunchd: true,
        hasBin: (name) => name === "codex",
      });
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg.agent_kind).toBe("codex");
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("throws a friendly error when neither agent is found", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await expect(
        runSetup({ handle: "ken3", relay, snippet: false, skipLaunchd: true, hasBin: () => false }),
      ).rejects.toThrow(/claude|codex/i);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("passes resolved agent/npx bin dirs as extraPathDirs to installLaunchAgent", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      let captured: string[] | undefined;
      await runSetup({
        handle: "ken4",
        agent: "claude",
        relay,
        snippet: false,
        resolveBin: (name) =>
          name === "claude" || name === "npx" ? `/Users/x/.local/bin/${name}` : null,
        installLaunchAgentFn: (_p, _execCmd, extraPathDirs) => {
          captured = extraPathDirs;
        },
      });
      expect(captured).toEqual(["/Users/x/.local/bin"]);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });
});

describe("resolveExtraPathDirs", () => {
  it("returns unique dirnames of resolved bins, skipping unresolved ones", () => {
    const resolveBin = (name: string) =>
      name === "claude" ? "/Users/x/.local/bin/claude" : name === "npx" ? "/Users/x/.local/bin/npx" : null;
    expect(resolveExtraPathDirs(["claude", "npx"], resolveBin)).toEqual(["/Users/x/.local/bin"]);
  });
  it("falls back to [] when nothing resolves", () => {
    expect(resolveExtraPathDirs(["claude", "npx"], () => null)).toEqual([]);
  });
});
