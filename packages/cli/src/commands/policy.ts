import { loadPolicy } from "../policy.js";
import { loadTasks } from "../tasks.js";
import { renderPolicyReport } from "../policy-report.js";
import { resolveLine, type LineContext } from "../line-context.js";
import { assertCallableLine } from "../config.js";
import { loadScope, readableRoots, workdirFor } from "../scope.js";
import { getMachinePaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("policy")
    .description("show the effective caller-access policy, tasks, and read scope")
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
        const scope = loadScope(ctx.paths);
        const report = renderPolicyReport(loadPolicy(ctx.paths), loadTasks(ctx.paths), {
          agentKind: cfg.agent_kind,
          defaultWorkdir: workdirFor(scope, ctx.paths.shareDir, ctx.paths.machine.userHome),
          readableRoots: readableRoots(scope, ctx.paths.machine.userHome),
        });
        console.log(report.trimEnd());
      } catch (e) {
        fail(e);
      }
    });
}
