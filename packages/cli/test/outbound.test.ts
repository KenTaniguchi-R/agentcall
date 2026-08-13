import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { outboundInstallation } from "../src/outbound.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

describe("outboundInstallation", () => {
  it("returns the installation for its organization", () => {
    const paths = getPaths(tempDir("agentcall-outbound-"));
    saveConfig(paths, { org: "acme", handle: "ken", token: "t", relay: "https://r.example" });
    expect(outboundInstallation(paths, "acme").config.handle).toBe("ken");
  });

  it("refuses cross-organization calls", () => {
    const paths = getPaths(tempDir("agentcall-outbound-"));
    saveConfig(paths, { org: "acme", handle: "ken", token: "t", relay: "https://r.example" });
    expect(() => outboundInstallation(paths, "other")).toThrow(/only calls within its own organization/i);
  });

  it("reports setup when no installation exists", () => {
    const paths = getPaths(tempDir("agentcall-outbound-"));
    expect(() => outboundInstallation(paths, "acme")).toThrow(/setup/);
  });
});
