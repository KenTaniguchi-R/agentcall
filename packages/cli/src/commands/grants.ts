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

interface ClearanceOptions { line?: string; default?: string; reset?: boolean }

// One command, three forms, because there is exactly one thing to set and
// three scopes to set it at. Which form was used is decided here rather than
// in verbs.ts, so execVerb stays a pure function of an unambiguous verb.
async function clearanceVerb(
  handle: string | undefined, level: string | undefined, o: ClearanceOptions,
): Promise<void> {
  if (o.default !== undefined) {
    if (handle !== undefined) {
      fail(new Error("clearance --default sets the line default and takes no handle."));
      return;
    }
    await runPolicyVerb("clearance-default", o.default, undefined, o);
    return;
  }
  if (handle === undefined) {
    fail(new Error("clearance needs a handle, or --default <level>."));
    return;
  }
  await runPolicyVerb(o.reset ? "clearance-reset" : "clearance", handle, o.reset ? undefined : level, o);
}

export function register(program: Command): void {
  program.command("clearance")
    .description("set how much a caller may be told (and republish your card)")
    .argument("[handle]", "caller handle; omit when using --default")
    .argument("[level]", "public or internal; omit when using --reset")
    .option("--default <level>", "set the level anyone registered gets, instead of one caller")
    .option("--reset", "drop a caller's own level, returning them to the line default")
    .option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string | undefined, level: string | undefined, o: ClearanceOptions) =>
      clearanceVerb(handle, level, o));
  program.command("block").description("refuse all calls from a handle")
    .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, o: { line?: string }) => runPolicyVerb("block", handle, undefined, o));
  program.command("unblock").description("lift a block")
    .argument("<handle>").option("--line <name>", "line to use (defaults to the primary line)")
    .action((handle: string, o: { line?: string }) => runPolicyVerb("unblock", handle, undefined, o));
}
