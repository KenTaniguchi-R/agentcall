import { existsSync } from "node:fs";
import { loadPolicy } from "../policy.js";
import { loadTasks } from "../tasks.js";
import { renderPolicyReport } from "../policy-report.js";
import { resolveLine, type LineContext } from "../line-context.js";
import { assertCallableLine, resolveLineWorkdir } from "../config.js";
import { getMachinePaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("policy")
    .description("show the effective per-caller and per-task capability policy")
    .option("--line <name>", "line to report on (defaults to the primary line)")
    .action((o: { line?: string }) => {
      let ctx: LineContext;
      try {
        ctx = resolveLine(getMachinePaths(), { line: o.line });
        assertCallableLine(ctx.config);
      } catch (e) {
        fail(e);
        return;
      }
      const cfg = ctx.config;
      try {
        const report = renderPolicyReport(loadPolicy(ctx.paths), loadTasks(ctx.paths), {
          agentKind: cfg.agent_kind,
          // Machine-scoped, not line-scoped: the administrator ceiling applies
          // to every line on this machine (see paths.ts).
          managed: existsSync(ctx.paths.machine.managedPolicyFile),
          defaultWorkdir: resolveLineWorkdir(cfg, ctx.paths).dir,
        });
        console.log(report.trimEnd());
      } catch (e) {
        fail(e);
      }
    });
}
