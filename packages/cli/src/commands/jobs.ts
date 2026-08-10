import type { Command } from "commander";
import { sanitizeTerminalOutput, stringifyTerminalSafeJson, type A2ATaskStateType } from "@benree/agentcall-shared";
import { authOf, cancelAgentJob, getAgentJob, listAgentJobs } from "../api.js";
import { outboundInstallation } from "../outbound.js";
import { resolveAddress } from "../contacts.js";
import { getPaths } from "../paths.js";
import { relayUrl } from "../config.js";
import { fail } from "../errors.js";
import { decryptJobOutcome } from "../job-result.js";

function contextFor(address: string) {
  const machine = getPaths();
  const first = resolveAddress(machine, address);
  if (!first.ok) throw new Error(first.error);
  const installation = outboundInstallation(machine, first.org);
  const resolved = resolveAddress(machine, address, installation.config.org);
  if (!resolved.ok) throw new Error(resolved.error);
  return { installation, resolved };
}

export function register(program: Command): void {
  const jobs = program.command("jobs").description("retrieve and cancel durable calls");

  jobs.command("list")
    .argument("<address>", "contact name or @org/handle")
    .option("--state <state>", "A2A task state")
    .option("--json", "print machine-readable JSON")
    .action(async (address: string, options: { state?: A2ATaskStateType; json?: boolean }) => {
      try {
        const { installation, resolved } = contextFor(address);
        const result = await listAgentJobs(
          relayUrl(installation.config), resolved.handle, authOf(installation.config),
          { status: options.state },
        );
        if (options.json) console.log(stringifyTerminalSafeJson(result));
        else if (result.tasks.length === 0) console.log("No jobs.");
        else for (const task of result.tasks) {
          console.log(sanitizeTerminalOutput(`${task.id}\t${task.status.state}\t${task.status.timestamp}`));
        }
      } catch (error) { fail(error); }
    });

  jobs.command("get")
    .argument("<address>", "contact name or @org/handle")
    .argument("<task-id>", "durable task id")
    .option("--wait <seconds>", "wait up to this many seconds for a terminal result", "0")
    .option("--json", "print machine-readable JSON")
    .action(async (address: string, taskId: string, options: { wait: string; json?: boolean }) => {
      try {
        const waitSeconds = Number(options.wait);
        if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) {
          throw new Error("--wait must be an integer from 0 to 300 seconds.");
        }
        const { installation, resolved } = contextFor(address);
        const deadline = Date.now() + waitSeconds * 1_000;
        let task = await getAgentJob(
          relayUrl(installation.config), resolved.handle, taskId, authOf(installation.config), true,
        );
        const terminal = () => [
          "TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED",
        ].includes(task.status.state);
        while (!terminal() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
          task = await getAgentJob(
            relayUrl(installation.config), resolved.handle, taskId, authOf(installation.config), true,
          );
        }
        const outcome = await decryptJobOutcome(installation.paths, resolved.address, task);
        if (options.json) {
          console.log(stringifyTerminalSafeJson({ task, ...(outcome ? { outcome } : {}) }));
        } else if (outcome?.kind === "reply") {
          console.log(sanitizeTerminalOutput(outcome.text));
        } else if (outcome?.kind === "failure") {
          const detail = outcome.detail ? `: ${outcome.detail}` : "";
          console.log(sanitizeTerminalOutput(`${outcome.code}${detail}`));
        } else {
          console.log(sanitizeTerminalOutput(
            `${task.id}: ${task.metadata?.["agentcall.dev/terminalReason"] ?? task.status.state}`,
          ));
        }
      } catch (error) { fail(error); }
    });

  jobs.command("cancel")
    .argument("<address>", "contact name or @org/handle")
    .argument("<task-id>", "durable task id")
    .option("--json", "print machine-readable JSON")
    .action(async (address: string, taskId: string, options: { json?: boolean }) => {
      try {
        const { installation, resolved } = contextFor(address);
        const task = await cancelAgentJob(
          relayUrl(installation.config), resolved.handle, taskId, authOf(installation.config),
        );
        console.log(options.json
          ? stringifyTerminalSafeJson(task)
          : sanitizeTerminalOutput(`${task.id}: ${task.status.state}`));
      } catch (error) { fail(error); }
    });
}
