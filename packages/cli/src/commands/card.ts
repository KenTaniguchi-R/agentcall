import type { Command } from "commander";
import { ApiError, fetchCard } from "../api.js";
import { assertCallableLine, relayUrl } from "../config.js";
import { buildCardReport } from "../lint.js";
import { getMachinePaths } from "../paths.js";
import { resolveAddress } from "../contacts.js";
import { resolveLine, type LineContext } from "../line-context.js";
import { publishCard } from "../card.js";
import { sanitizeTerminalOutput } from "@benree/agentcall-shared";

const reviewOwnCard = (o: { line?: string }) => {
  let ctx: LineContext;
  try {
    ctx = resolveLine(getMachinePaths(), { line: o.line });
    assertCallableLine(ctx.config);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
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
    .option("--line <name>", "line to lint (defaults to the primary line)")
    .action(reviewOwnCard);
}

export function registerCard(program: Command): void {
  program
    .command("card")
    .description("show your own card with problems, another agent's menu, or publish yours (push)")
    .argument("[target]", "contact name or @org/handle to fetch, 'push' to publish, or omit to review your own card")
    .option("--line <name>", "line to use (defaults to the primary line)")
    .action(async (target: string | undefined, o: { line?: string }) => {
      const machine = getMachinePaths();
      if (target === undefined) {
        reviewOwnCard(o);
        return;
      }
      if (target === "push") {
        let ctx: LineContext;
        try {
          ctx = resolveLine(machine, { line: o.line });
          assertCallableLine(ctx.config);
        } catch (e) {
          console.error(String(e instanceof Error ? e.message : e));
          process.exitCode = 1;
          return;
        }
        await publishCard(ctx.config, ctx.paths);
        console.log("Card published.");
        return;
      }
      let ctx: LineContext;
      try {
        ctx = resolveLine(machine, { line: o.line });
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      const cfg = ctx.config;
      const parsed = resolveAddress(machine, target, relayUrl(cfg), cfg.org);
      if (!parsed.ok) {
        console.error(`${parsed.error} (or 'push')`);
        process.exitCode = 1;
        return;
      }
      try {
        const card = await fetchCard(
          relayUrl(cfg), parsed.handle,
          { org: cfg.org, handle: cfg.handle, token: cfg.token },
        );
        const description = sanitizeTerminalOutput(card.description);
        console.log(`${card.handle} (${card.agent_kind})${description ? ` — ${description}` : ""}`);
        for (const t of card.tasks) {
          console.log(`  ${t.id} — ${sanitizeTerminalOutput(t.description)}`);
          for (const ex of t.examples) console.log(`      e.g. ${sanitizeTerminalOutput(ex)}`);
        }
        console.log(`\nCall with: agentcall call ${target} --task <id> "<message>"`);
      } catch (e) {
        console.error(e instanceof ApiError ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}

export function register(program: Command): void {
  registerLint(program);
  registerCard(program);
}
