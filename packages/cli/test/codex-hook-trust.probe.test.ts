import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexHookConfigArg, codexHookTrustArg, CODEX_GUARD_TRUST_VERIFIED_VERSION,
  buildSpawnSpec, GUARD_TIMEOUT_S,
} from "../src/runner.js";
import { checkCodexGuard } from "../src/verify.js";
import { createToolEventSpool } from "../src/tool-telemetry-spool.js";

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
      name: "codex tool telemetry", ok: true, detail: "trusted session lifecycle hooks",
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
      ).toBe(CODEX_GUARD_TRUST_VERIFIED_VERSION);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 200_000);

  it.skip("pairs the default production tool path before Codex telemetry is enabled", () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-codex-tool-work-"));
    const state = mkdtempSync(join(tmpdir(), "agentcall-codex-tool-state-"));
    const spool = createToolEventSpool("probe-tool-lifecycle", state)!;
    try {
      const spec = buildSpawnSpec(
        "codex",
        "Use the shell tool exactly once to run pwd, then reply with the single word done.",
        workdir,
        () => "codex",
        { caps: ["read"] },
        "probe-tool-lifecycle",
        "probe-line",
        undefined,
        undefined,
        spool.file,
      );
      spec.env = { ...spec.env, AGENTCALL_HOME: state };
      const result = spawnSync(spec.cmd, spec.args, {
        cwd: spec.cwd, env: spec.env, encoding: "utf8", timeout: 180_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const raw = readFileSync(spool.file, "utf8");
      const diagnostic = JSON.stringify({
        spool: raw,
        stdout: result.stdout.slice(-8_000),
        stderr: result.stderr.slice(-2_000),
      });
      expect(spool.collect(), `production hook payloads did not pair: ${diagnostic}`).toEqual([
        expect.objectContaining({
          callId: "probe-tool-lifecycle",
          toolCallId: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
          toolName: expect.any(String),
          outcome: "success",
        }),
      ]);
    } finally {
      spool.dispose();
      rmSync(state, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 200_000);

  it("removes bundled remote tools from fresh and resumed production spawns", () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentcall-codex-boundary-work-"));
    try {
      const prompt = [
        "Invoke functions.exec exactly once. Inside its V8 isolate run this script exactly:",
        "const forbidden = Object.keys(tools).filter((name) => name.includes('codex_apps') || name === 'web__run' || name === 'image_gen__imagegen').sort();",
        "const encoded = JSON.stringify(forbidden);",
        "await tools.exec_command({cmd: 'echo AGENTCALL-REMOTE-TOOLS ' + JSON.stringify(encoded)});",
        "Do not use a top-level tool. Report the command output verbatim.",
      ].join("\n");
      const spawnSpec = (spec: ReturnType<typeof buildSpawnSpec>) => {
        const result = spawnSync(spec.cmd, spec.args, {
          cwd: spec.cwd, env: spec.env, encoding: "utf8", timeout: 180_000,
        });
        expect(result.error).toBeUndefined();
        return result;
      };
      const specFor = (resume?: string) =>
        buildSpawnSpec(
          "codex", prompt, workdir, () => "codex", { caps: ["read"] },
          "probe-boundary", "probe-line", "internal", resume,
        );
      const eventsFrom = (spec: ReturnType<typeof buildSpawnSpec>) => {
        const result = spawnSpec(spec);
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim().split("\n").map((row) => JSON.parse(row));
      };
      const expectUnavailable = (events: any[]) => {
        const outputs = events
          .filter((event) => event.item?.type === "command_execution")
          .map((event) => event.item?.aggregated_output ?? "");
        const marker = outputs.find((output) => output.includes("AGENTCALL-REMOTE-TOOLS "));
        const eventSummary = events.map((event) => ({
          type: event.type,
          item_type: event.item?.type,
          text: event.item?.type === "agent_message" ? event.item.text : undefined,
          output: event.item?.type === "command_execution"
            ? String(event.item.aggregated_output ?? "").slice(0, 500)
            : undefined,
        }));
        expect(
          marker,
          `probe did not emit a machine-readable tool registry: ${JSON.stringify(eventSummary)}`,
        ).toBeTruthy();
        const encoded = marker!.match(/AGENTCALL-REMOTE-TOOLS (\[[^\n]*\])/)?.[1];
        expect(encoded, "probe emitted an invalid tool registry marker").toBeTruthy();
        expect(JSON.parse(encoded!)).toEqual([]);
      };

      // Fail-closed control: if Codex renames/removes the feature, strict config
      // must reject the spawn before a model turn rather than restore apps.
      const unknown = specFor();
      unknown.args = unknown.args.map((arg, index, args) =>
        arg === "apps" && args[index - 1] === "--disable" ? "agentcall_unknown_feature" : arg);
      expect(spawnSpec(unknown).status).not.toBe(0);

      const fresh = eventsFrom(specFor());
      expectUnavailable(fresh);
      const sessionId = fresh.find((event) => event.type === "thread.started")?.thread_id;
      expect(sessionId, "probe could not read the fresh session id").toBeTruthy();
      expectUnavailable(eventsFrom(specFor(sessionId)));
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 200_000);
});
