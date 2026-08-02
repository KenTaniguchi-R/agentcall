import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_THREADING_VERIFIED_VERSION } from "../src/runner.js";

// Env-gated OFF by default. CLAUDE.md forbids live agent spawns in CI; this is
// the single deliberate exception, and it only runs when a human sets the flag:
//
//   AGENTCALL_PROBE_CODEX=1 pnpm test codex-resume-sandbox
//
// It needs a real, authenticated codex on PATH.
const enabled = process.env.AGENTCALL_PROBE_CODEX === "1";

describe.skipIf(!enabled)("codex sandbox on resume", () => {
  it("honours -c sandbox_mode=read-only when resuming", () => {
    const probedVersion = execFileSync("codex", ["--version"], { encoding: "utf8" })
      .match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    const dir = mkdtempSync(join(tmpdir(), "agentcall-probe-"));
    const target = join(dir, "written-by-agent.txt");

    // Turn 1: workspace-write, so this session is RECORDED as writable.
    const first = execFileSync("codex", [
      "exec", "--ignore-user-config", "--sandbox", "workspace-write",
      "--cd", dir, "--skip-git-repo-check", "--json",
      "Reply with the single word: ready",
    ], { encoding: "utf8", timeout: 180_000 });

    const sessionId = first.split("\n")
      .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .map((e: any) => e.thread_id ?? e.session_id)
      .filter(Boolean)
      .at(-1);
    expect(sessionId, "probe could not read a session id from turn 1").toBeTruthy();

    // Turn 2: resume the writable session, downgraded to read-only via -c.
    // If the override holds, the write is refused.
    execFileSync("codex", [
      "exec", "resume", String(sessionId),
      "--ignore-user-config", "--skip-git-repo-check", "--json",
      "-c", `sandbox_mode="read-only"`,
      `Create a file at ${target} containing the word hello. If you cannot, say why.`,
    ], { encoding: "utf8", timeout: 180_000 });

    expect(
      existsSync(target),
      "-c sandbox_mode did NOT confine the resumed session — codex threading must ship disabled",
    ).toBe(false);
    expect(
      probedVersion,
      "probe passed on a new codex-cli release; update CODEX_THREADING_VERIFIED_VERSION and rerun before shipping",
    ).toBe(CODEX_THREADING_VERIFIED_VERSION);
  }, 400_000);
});
