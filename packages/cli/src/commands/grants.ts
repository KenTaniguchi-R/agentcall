import type { Command } from "commander";
import { assertCallableLine } from "../config.js";
import { getMachinePaths } from "../paths.js";
import { resolveLine, type LineContext } from "../lineContext.js";
import { loadTasks } from "../tasks.js";
import { execVerb, type Verb } from "../verbs.js";
import { loadUserPolicy, savePolicy, validatePolicy } from "../policy.js";
import { publishCard } from "../card.js";

async function runPolicyVerb(verb: Verb, a: string, b: string | undefined, opts: { line?: string }): Promise<void> {
  const machine = getMachinePaths();
  let ctx: LineContext;
  try {
    ctx = resolveLine(machine, { line: opts.line });
    assertCallableLine(ctx.config);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
    return;
  }
  try {
    const { policy, lines } = execVerb(loadUserPolicy(ctx.paths), loadTasks(ctx.paths), verb, a, b);
    validatePolicy(ctx.paths, policy);
    savePolicy(ctx.paths, policy);
    for (const line of lines) console.log(line);
    try {
      await publishCard(ctx.config, ctx.paths);
      console.log("Card updated.");
    } catch (e) {
      console.error(`Warning: policy saved locally, but the card push failed (${String(e)}). Run \`agentcall card push\` later.`);
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
  }
}

export function register(program: Command): void {
  program.command("allow").description("grant a caller an extra task (and republish your card)")
    .argument("<handle>").argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, taskId: string, o: { line?: string }) => runPolicyVerb("allow", handle, taskId, o));
  program.command("revoke").description("remove a caller's task grant")
    .argument("<handle>").argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, taskId: string, o: { line?: string }) => runPolicyVerb("revoke", handle, taskId, o));
  program.command("block").description("refuse all calls from a handle")
    .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, o: { line?: string }) => runPolicyVerb("block", handle, undefined, o));
  program.command("unblock").description("lift a block")
    .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, o: { line?: string }) => runPolicyVerb("unblock", handle, undefined, o));
  program.command("offer").description("offer a task to any registered caller")
    .argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((taskId: string, o: { line?: string }) => runPolicyVerb("offer", taskId, undefined, o));
  program.command("unoffer").description("stop offering a task publicly")
    .argument("<task-id>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((taskId: string, o: { line?: string }) => runPolicyVerb("unoffer", taskId, undefined, o));
}
