import type { Command } from "commander";
import { assertCallableLine } from "../config.js";
import { getMachinePaths } from "../paths.js";
import { resolveLine, type LineContext } from "../line-context.js";
import { execVerb, type Verb } from "../verbs.js";
import { loadUserPolicy, savePolicy, validatePolicy } from "../policy.js";
import { publishCard } from "../card.js";
import { fail } from "../errors.js";

async function runPolicyVerb(verb: Verb, a: string, b: string | undefined, opts: { line?: string }): Promise<void> {
  const machine = getMachinePaths();
  let ctx: LineContext;
  try {
    ctx = resolveLine(machine, { line: opts.line });
    assertCallableLine(ctx.config);
  } catch (e) {
    fail(e);
    return;
  }
  try {
    const { policy, lines } = execVerb(loadUserPolicy(ctx.paths), verb, a, b);
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
    fail(e);
  }
}

interface AccessOptions { line?: string }

export function register(program: Command): void {
  // `clearance` is gone (2026-08-07). With one grantable level there is no
  // amount to set — only whether the line answers — so block/unblock is the whole
  // per-caller surface, and `access --default` is the line-wide posture.
  program.command("access")
    .description("set whether callers are answered by default (and republish your card)")
    .requiredOption("--default <access>", "allowed or blocked")
    .option("--line <name>", "line to use (defaults to the primary line)")
    .action((o: AccessOptions & { default: string }) =>
      runPolicyVerb("access-default", o.default, undefined, o));
  program.command("block").description("refuse all calls from a handle")
    .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, o: { line?: string }) => runPolicyVerb("block", handle, undefined, o));
  program.command("unblock").description("lift a block")
    .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, o: { line?: string }) => runPolicyVerb("unblock", handle, undefined, o));
}
