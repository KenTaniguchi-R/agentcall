import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexHookConfigArg, codexHookTrustArg, CODEX_HOOK_TRUST_VERIFIED_VERSION,
  GUARD_TIMEOUT_S,
} from "../src/runner.js";
import { checkCodexGuard } from "../src/verify.js";

// Env-gated OFF by default. This launches a real authenticated Codex and is
// deliberately excluded from CI:
//
//   AGENTCALL_PROBE_CODEX_HOOKS=1 pnpm --filter @benree/agentcall test
//
// It proves behavior argv assertions cannot: AgentCall's exact session-hook
// trust grant runs that hook, without granting trust to an unrelated hook that
// survives --ignore-user-config via $CODEX_HOME/hooks.json.
const enabled = process.env.AGENTCALL_PROBE_CODEX_HOOKS === "1";

describe.skipIf(!enabled)("codex exact-hook trust", () => {
  it("doctor discovers the production session hook as enabled and trusted", async () => {
    expect(await checkCodexGuard(process.cwd())).toMatchObject({
      name: "codex tool telemetry", ok: true, detail: "trusted session hook",
    });
  }, 20_000);

  it("runs the trusted session hook but not an unrelated user hook", () => {
    const probedVersion = execFileSync("codex", ["--version"], { encoding: "utf8" })
      .match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    const codexHome = mkdtempSync(join(tmpdir(), "agentcall-codex-hook-home-"));
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-codex-hook-work-"));
    try {
      const ownMarker = join(codexHome, "agentcall-hook-ran");
      const foreignMarker = join(codexHome, "foreign-hook-ran");
      const ownCommand = `/usr/bin/touch ${ownMarker}`;
      const foreignCommand = `/usr/bin/touch ${foreignMarker}`;

      // Reuse the normal Codex login without copying or modifying it. Everything
      // else is isolated in the temporary home.
      const auth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
      expect(existsSync(auth), "live probe requires an authenticated codex").toBe(true);
      symlinkSync(auth, join(codexHome, "auth.json"));
      writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{
          type: "command", command: foreignCommand, timeout: GUARD_TIMEOUT_S,
        }] }] },
      }));

      const common = [
        "exec", "--ignore-user-config", "--sandbox", "read-only", "--cd", workdir,
        "--skip-git-repo-check", "--json",
      ];
      const prompt = "Use the shell tool once to run pwd, then reply with the single word done.";

      // Positive discovery control: in this isolated home the blanket bypass
      // is safe and must run the planted user hook. Without this control, an
      // absent foreign marker in the treatment could mean hooks.json was never
      // loaded, making the exact-trust assertion vacuous.
      execFileSync("codex", [...common, "--dangerously-bypass-hook-trust", prompt], {
        encoding: "utf8", timeout: 180_000,
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      expect(existsSync(foreignMarker), "control did not discover the planted user hook").toBe(true);
      unlinkSync(foreignMarker);

      const hookConfig = codexHookConfigArg(ownCommand);
      const trustConfig = codexHookTrustArg(ownCommand);
      const first = execFileSync("codex", [
        ...common, "-c", hookConfig, "-c", trustConfig, prompt,
      ], {
        encoding: "utf8", timeout: 180_000,
        env: { ...process.env, CODEX_HOME: codexHome },
      });

      expect(existsSync(ownMarker), "the exact trusted session hook did not execute").toBe(true);
      expect(existsSync(foreignMarker), "the trust grant leaked to an unrelated user hook").toBe(false);

      const sessionId = first.split("\n")
        .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
        .map((event: any) => event.thread_id ?? event.session_id)
        .filter(Boolean)
        .at(-1);
      expect(sessionId, "probe could not read the treatment session id").toBeTruthy();
      unlinkSync(ownMarker);

      execFileSync("codex", [
        "exec", "resume", String(sessionId), "--ignore-user-config",
        "--skip-git-repo-check", "--json", "-c", hookConfig, "-c", trustConfig,
        "-c", `sandbox_mode="read-only"`, prompt,
      ], {
        encoding: "utf8", timeout: 180_000, cwd: workdir,
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      expect(existsSync(ownMarker), "the exact trusted hook did not execute on resume").toBe(true);
      expect(existsSync(foreignMarker), "resume leaked trust to the planted user hook").toBe(false);
      expect(
        probedVersion,
        "probe passed on a new codex-cli release; re-audit normalization before updating the verified version",
      ).toBe(CODEX_HOOK_TRUST_VERIFIED_VERSION);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 200_000);
});
