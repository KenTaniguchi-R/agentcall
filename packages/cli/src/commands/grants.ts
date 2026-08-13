import type { Command } from "commander";
import { assertCallable, loadInstallation, type Installation } from "../config.js";
import { getPaths } from "../paths.js";
import { execVerb, type Verb } from "../verbs.js";
import { loadUserPolicy, savePolicy, validatePolicy } from "../policy.js";
import { publishCard } from "../card.js";
import { fail } from "../errors.js";

async function runPolicyVerb(verb: Verb, a: string, b?: string): Promise<void> {
  const machine = getPaths();
  let ctx: Installation;
  try {
    ctx = loadInstallation(machine);
    assertCallable(ctx.config);
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
      console.error(`Warning: policy saved locally, but the card publication failed (${String(e)}). Run \`agentcall admin card publish\` later.`);
    }
  } catch (e) {
    fail(e);
  }
}

export function register(program: Command): void {
  // `clearance` is gone (2026-08-07). With one grantable level there is no
  // amount to set — only whether the line answers — so block/unblock is the whole
  // per-caller surface, and `access --default` is the line-wide posture.
  program.command("access")
    .description("set default access or durable offline delivery (and republish your card)")
    .option("--default <access>", "allowed or blocked")
    .option("--offline <state>", "enabled or disabled")
    .action((o: { default?: string; offline?: string }) => {
      if ((o.default === undefined) === (o.offline === undefined)) {
        fail("Choose exactly one of --default or --offline.");
        return;
      }
      return o.default !== undefined
        ? runPolicyVerb("access-default", o.default)
        : runPolicyVerb("offline-delivery", o.offline!);
    });
  program.command("block").description("refuse all calls from a handle")
    .argument("<handle>").action((handle: string) => runPolicyVerb("block", handle));
  program.command("unblock").description("lift a block")
    .argument("<handle>").action((handle: string) => runPolicyVerb("unblock", handle));
}
