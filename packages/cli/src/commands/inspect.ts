import type { Command } from "commander";
import { sanitizeTerminalOutput, stringifyTerminalSafeJson } from "@benree/agentcall-shared";
import { fail } from "../errors.js";
import { inspectPeer, inspectionExitCode, type PeerInspection } from "../peer-inspection.js";
import { getPaths } from "../paths.js";

const safe = (value: string) => sanitizeTerminalOutput(value);

export function renderInspection(result: PeerInspection): string {
  const lines = [result.address];
  if (result.contact) lines.push(`Contact: ${safe(result.contact.name)}${result.contact.note ? ` — ${safe(result.contact.note)}` : ""}`);
  lines.push(`Availability: ${result.availability.state}${result.availability.detail ? ` — ${safe(result.availability.detail)}` : ""}`);
  lines.push(`Identity: ${result.identity.state}${"detail" in result.identity ? ` — ${safe(result.identity.detail)}` : ""}`);
  if ("pinned_fingerprint" in result.identity && result.identity.pinned_fingerprint) {
    lines.push(`Pinned fingerprint: ${result.identity.pinned_fingerprint}`);
  }
  if ("served_fingerprint" in result.identity && result.identity.served_fingerprint) {
    lines.push(`Served fingerprint: ${result.identity.served_fingerprint}`);
  }
  if (result.identity.state === "unseen") lines.push("Compare the served fingerprint out of band before relying on this identity.");
  if (result.identity.state === "changed") lines.push(`Refusing to trust the replacement. Compare it out of band, then run: agentcall trust --reset ${result.address}`);

  if (result.card.state === "available") {
    const description = safe(result.card.value.description);
    lines.push(`Card: ${result.card.value.handle} (${result.card.value.agent_kind})${description ? ` — ${description}` : ""}`);
    for (const task of result.card.value.tasks) {
      lines.push(`  ${task.id} — ${safe(task.description)}`);
      for (const example of task.examples) lines.push(`      e.g. ${safe(example)}`);
    }
  } else {
    lines.push(`Card: ${result.card.state}${result.card.state === "unavailable" ? ` — ${safe(result.card.detail)}` : ""}`);
  }
  lines.push(`Next: ${result.next_command}`);
  return lines.join("\n");
}

export function register(program: Command): void {
  program.command("inspect")
    .description("inspect one peer's address, trust state, availability, and offered tasks")
    .argument("<address>", "contact name or @org/handle")
    .option("--json", "print the structured inspection result")
    .action(async (address: string, options: { json?: boolean }) => {
      try {
        const result = await inspectPeer(address, getPaths());
        console.log(options.json ? stringifyTerminalSafeJson(result) : renderInspection(result));
        process.exitCode = inspectionExitCode(result);
      } catch (error) {
        fail(error);
      }
    });
}
