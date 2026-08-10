import type { Command } from "commander";
import { assertCallable, loadInstallation, type Installation } from "../config.js";
import { buildCardReport } from "../lint.js";
import { getPaths } from "../paths.js";
import { publishCard } from "../card.js";
import { fail } from "../errors.js";

const reviewOwnCard = () => {
  let ctx: Installation;
  try {
    ctx = loadInstallation(getPaths());
    assertCallable(ctx.config);
  } catch (e) {
    fail(e);
    return;
  }
  const report = buildCardReport(ctx.config, ctx.paths);
  for (const line of report.menu) console.log(line);
  if (report.problems.length > 0) {
    console.log("\nProblems:");
    for (const p of report.problems) console.log(`  ✗ ${p}`);
  }
  if (report.notices.length > 0) {
    console.log("\nNotes:");
    for (const n of report.notices) console.log(`  ! ${n}`);
  }
  if (report.problems.length > 0) process.exitCode = 1;
};

export function registerLint(program: Command): void {
  program.command("lint")
    .description("validate tasks, effective policy assertions, and the published card")
    .action(reviewOwnCard);
}

export function registerCard(program: Command): void {
  program
    .command("card")
    .description("show your own card with problems, or publish it (push)")
    .argument("[action]", "'push' to publish, or omit to review your own card")
    .action(async (action: string | undefined) => {
      const machine = getPaths();
      if (action === undefined) {
        reviewOwnCard();
        return;
      }
      if (action === "push") {
        let ctx: Installation;
        try {
          ctx = loadInstallation(machine);
          assertCallable(ctx.config);
        } catch (e) {
          fail(e);
          return;
        }
        await publishCard(ctx.config, ctx.paths);
        console.log("Card published.");
        return;
      }
      fail(new Error(`Unknown card action "${action}". Use \`agentcall inspect ${action}\` for a peer, or \`agentcall card push\` to publish yours.`));
    });
}

export function register(program: Command): void {
  registerLint(program);
  registerCard(program);
}
