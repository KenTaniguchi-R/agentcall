import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpawnSpec, } from "../src/runner.js";
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
      name: "codex tool telemetry", ok: true, detail: "trusted session lifecycle hooks",
    });
  }, 20_000);



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
        buildSpawnSpec({
          kind: "codex", prompt, workdir, resolveBin: () => "codex",
          callId: "probe-boundary", lineName: "probe-line", resume,
        });
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
