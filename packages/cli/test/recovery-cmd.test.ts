import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { printRecoveryCode } from "../src/recoveryPrint.js";
import { saveConfig } from "../src/config.js";
import { redeemRecoveryCode } from "../src/api.js";
import { getPaths } from "../src/paths.js";

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
});

// Recursively lists every file under `dir`. The config dir currently holds
// just config.json, but a test that only checked one hardcoded filename
// would silently miss a sibling file added later — walk it instead.
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe("recovery redeem does not persist the recovery code", () => {
  let server: Server;
  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("drives the real redeemRecoveryCode client against a stub relay, then saves the config the way `recovery redeem`'s action does, and asserts the code never lands on disk", async () => {
    const RECOVERY_CODE = "agcr_TEST-TEST-TEST-TEST-TEST-TEST";
    const relay = await new Promise<string>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "new-tok", recovery_code: RECOVERY_CODE, address: "ken@relay.test" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    const out = await redeemRecoveryCode(relay, "ken", "agcr_OLD-CODE-USED-ONCE-XXXX-YYYY");
    // Sanity check that the stub is wired correctly and the client really
    // does receive a fresh recovery_code back from redeem.
    expect(out.recovery_code).toBe(RECOVERY_CODE);

    const home = mkdtempSync(join(tmpdir(), "agentcall-reco-"));
    const paths = getPaths(home);
    // Mirrors exactly what `recovery redeem`'s action in packages/cli/src/index.ts
    // does on success: `saveConfig(paths, { handle: opts.handle, token: out.token, relay })`.
    // Deliberately picks fields rather than spreading `...out`, which would
    // leak `recovery_code` into config.json.
    saveConfig(paths, { handle: "ken", token: out.token, relay });

    const files = walkFiles(paths.dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toContain("agcr_");
    }
  });
});
