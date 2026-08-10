import { loadPolicy } from "../policy.js";
import { loadTasks } from "../tasks.js";
import { renderPolicyReport } from "../policy-report.js";
import { assertCallable, loadInstallation, type Installation } from "../config.js";
import { loadScope, readableRoots, workdirFor } from "../scope.js";
import { getPaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("policy")
    .description("show the effective caller-access policy, tasks, and read scope")
    .action(() => {
      let ctx: Installation;
      try {
        ctx = loadInstallation(getPaths());
        assertCallable(ctx.config);
      } catch (e) {
        fail(e);
        return;
      }
      const cfg = ctx.config;
      try {
        const scope = loadScope(ctx.paths);
        const report = renderPolicyReport(loadPolicy(ctx.paths), loadTasks(ctx.paths), {
          agentKind: cfg.agent_kind,
          defaultWorkdir: workdirFor(scope, ctx.paths.shareDir, ctx.paths.userHome),
          readableRoots: readableRoots(scope, ctx.paths.userHome),
        });
        console.log(report.trimEnd());
      } catch (e) {
        fail(e);
      }
    });
}
