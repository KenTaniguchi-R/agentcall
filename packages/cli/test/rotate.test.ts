import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadInstallation, saveConfig } from "../src/config.js";
import { rotateCredential } from "../src/commands/rotate.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

const base = { org: "acme", handle: "ken", token: "old", relay: "https://r.example", agent_kind: "claude" as const };

describe("rotateCredential", () => {
  it("atomically replaces the installation token", async () => {
    const paths = getPaths(tempDir("agentcall-rotate-"));
    saveConfig(paths, base);
    await rotateCredential(loadInstallation(paths), { rotate: async () => ({ token: "new" }) });
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).token).toBe("new");
  });

  it("explains how a callable installation picks up the credential", async () => {
    const paths = getPaths(tempDir("agentcall-rotate-"));
    saveConfig(paths, base);
    const output: string[] = [];
    await rotateCredential(loadInstallation(paths), {
      rotate: async () => ({ token: "new" }), log: (line) => output.push(line), platform: "linux",
    });
    expect(output.join(" ")).toMatch(/reconnect/i);
    expect(output.join(" ")).toContain("systemctl --user restart agentcall-listener.service");
  });

  it("omits listener guidance for caller-only installations", async () => {
    const paths = getPaths(tempDir("agentcall-rotate-"));
    saveConfig(paths, { ...base, agent_kind: undefined });
    const output: string[] = [];
    await rotateCredential(loadInstallation(paths), { rotate: async () => ({ token: "new" }), log: (line) => output.push(line) });
    expect(output.join(" ")).not.toMatch(/listener|reconnect/i);
  });
});
