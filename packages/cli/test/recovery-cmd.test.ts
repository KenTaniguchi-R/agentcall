import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { printRecoveryCode } from "../src/recoveryPrint.js";
import { saveConfig } from "../src/config.js";

describe("printRecoveryCode", () => {
  it("prints the code with a save-it warning", () => {
    const lines: string[] = [];
    printRecoveryCode("agcr_AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", (s) => lines.push(s));
    const out = lines.join("\n");
    expect(out).toContain("agcr_AAAA-BBBB-CCCC-DDDD-EEEE-FFFF");
    expect(out).toMatch(/save/i);
    // The user must know it is not stored for them.
    expect(out).toMatch(/not (been )?saved|won't be shown again|only copy/i);
  });

  it("a recovered config contains no recovery code", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentcall-reco-"));
    const paths = { dir, configFile: join(dir, "config.json") } as any;
    saveConfig(paths, { handle: "ken", token: "tok", relay: "https://relay.test" });
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain("agcr_");
    }
  });
});
