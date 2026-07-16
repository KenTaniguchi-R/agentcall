import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEphemeralDir, preferDurableBin, resolveExtraPathDirs, runSetup, warnIfOutsideLaunchdPath } from "../src/setup.js";
import { getPaths } from "../src/paths.js";

let server: Server;
afterEach(() => {
  server?.close();
  server409?.close();
});

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

// Simulates a relay that always 409s registration, as if the handle were
// already taken there (which it would be, on a genuine re-run) — used to
// prove a second runSetup call reuses the saved config instead of
// re-registering.
let server409: Server;
function fakeRelay409(): Promise<string> {
  return new Promise((resolve) => {
    server409 = createServer((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "handle taken" }));
    });
    server409.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server409.address() as { port: number }).port}`));
  });
}

function fakeRelayRecording(requests: { method?: string; url?: string; body?: string }[]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "tok-123", address: "ken@agentcall.benree.tech", ok: true }));
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

  it("re-running setup with the same handle reuses the saved config instead of re-registering", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
      const p = getPaths(home);
      const firstCfg = JSON.parse(readFileSync(p.configFile, "utf8"));

      // Second run points at a relay that 409s every register call — if
      // runSetup still tried to register, this run would throw. It must
      // instead detect the existing config.json (same handle) and reuse it.
      const badRelay = await fakeRelay409();
      await runSetup({ handle: "ken", agent: "claude", relay: badRelay, snippet: false, skipLaunchd: true });

      const secondCfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(secondCfg).toEqual(firstCfg);
      expect(secondCfg.token).toBe("tok-123");
      expect(existsSync(p.srtFile)).toBe(true);
      expect(existsSync(p.publicDir)).toBe(true);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  // Regression: re-running setup used to run agent detection (and its
  // "Which should agentcall use?" prompt) before the reuse check, then
  // ignore the answer in favor of the saved config's agent_kind.
  it("re-running setup with a saved config asks no questions at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });

      const asked: string[] = [];
      await runSetup({
        relay,
        snippet: false,
        skipLaunchd: true,
        hasBin: () => true, // both claude and codex on PATH — would normally prompt
        io: { ask: async (q) => { asked.push(q); return "claude"; } },
      });
      expect(asked).toEqual([]);
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

  it("seeds policy.json + tasks dir and publishes the card", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const requests: { method?: string; url?: string; body?: string }[] = [];
      const relay = await fakeRelayRecording(requests);
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
      const p = getPaths(home);
      expect(existsSync(p.tasksDir)).toBe(true);
      const policy = JSON.parse(readFileSync(p.policyFile, "utf8"));
      expect(policy.default_offer).toEqual(["ask"]);
      const cardPut = requests.find((r) => r.method === "PUT" && r.url === "/v1/card");
      expect(cardPut).toBeDefined();
      expect(JSON.parse(cardPut!.body!)).toMatchObject({ agent_kind: "claude", default_offer: ["ask"] });
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("does not overwrite an existing policy.json on re-run", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
      const p = getPaths(home);
      const custom = { description: "custom", default_offer: ["ask"], callers: { mia: { offer: ["x"], block: false } } };
      writeFileSync(p.policyFile, JSON.stringify(custom));
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
      expect(JSON.parse(readFileSync(p.policyFile, "utf8"))).toEqual(custom);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });
});

describe("setup progress output", () => {
  it("prints a progress line before registering with the relay", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "ken9", agent: "claude", relay, snippet: false, skipLaunchd: true });
      expect(logs.some((l) => l.includes("Registering ken9"))).toBe(true);
    } finally {
      spy.mockRestore();
      delete process.env.AGENTCALL_HOME;
    }
  });
});

describe("warnIfOutsideLaunchdPath", () => {
  it("prints one short line with a copy-pasteable symlink fix", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    try {
      warnIfOutsideLaunchdPath("claude", () => "/Users/x/.local/bin/claude");
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ln -s /Users/x/.local/bin/claude /opt/homebrew/bin/claude");
    expect(errors[0]!.length).toBeLessThan(200);
  });

  it("stays silent when the binary is inside launchd's search path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      warnIfOutsideLaunchdPath("claude", () => "/opt/homebrew/bin/claude");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
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
  it("excludes ephemeral temp dirs so session-scoped shims never get baked into the plist PATH", () => {
    // Regression: setup run inside a cmux session resolved `claude` to a shim
    // under $TMPDIR/cmux-cli-shims/<uuid>/; that dir got written into the
    // LaunchAgent's PATH and shadowed the real binary after the session died.
    const resolveBin = (name: string) =>
      name === "claude"
        ? "/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude"
        : name === "npx"
          ? "/Users/x/.local/bin/npx"
          : null;
    expect(resolveExtraPathDirs(["claude", "npx"], resolveBin)).toEqual(["/Users/x/.local/bin"]);
  });
});

describe("isEphemeralDir", () => {
  it("flags dirs under the OS temp root and the macOS per-user temp tree", () => {
    expect(isEphemeralDir(join(tmpdir(), "cmux-cli-shims", "AA8B8E91"))).toBe(true);
    expect(isEphemeralDir("/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91")).toBe(true);
    expect(isEphemeralDir("/private/var/folders/89/xx/T/anything")).toBe(true);
    expect(isEphemeralDir("/tmp/some-bin")).toBe(true);
    expect(isEphemeralDir("/private/tmp/some-bin")).toBe(true);
  });
  it("leaves durable install dirs alone", () => {
    expect(isEphemeralDir("/Users/x/.local/bin")).toBe(false);
    expect(isEphemeralDir("/opt/homebrew/bin")).toBe(false);
    expect(isEphemeralDir("/usr/local/bin")).toBe(false);
    // "/tmpfoo" must not match a "/tmp" prefix check done without a separator
    expect(isEphemeralDir("/tmpfoo/bin")).toBe(false);
  });
});

describe("preferDurableBin", () => {
  it("skips ephemeral matches and returns the first durable one", () => {
    expect(
      preferDurableBin([
        "/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude",
        "/Users/x/.local/bin/claude",
      ]),
    ).toBe("/Users/x/.local/bin/claude");
  });
  it("falls back to the first match when every candidate is ephemeral", () => {
    expect(preferDurableBin(["/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude"])).toBe(
      "/var/folders/89/xx/T/cmux-cli-shims/AA8B8E91/claude",
    );
  });
  it("returns null for no candidates", () => {
    expect(preferDurableBin([])).toBe(null);
  });
});
