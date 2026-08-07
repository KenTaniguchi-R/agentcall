import { loadPolicy } from "../policy.js";
import { loadTasks } from "../tasks.js";
import { renderPolicyReport } from "../policy-report.js";
import { resolveLine, type LineContext } from "../line-context.js";
import { assertCallableLine } from "../config.js";
import { loadSensitivityMap, withFloor, workdirFor } from "../sensitivity.js";
import { getMachinePaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("policy")
    .description("show the effective per-caller clearance policy and the tasks it covers")
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
          // Derived from the sensitivity map since #372, at `internal` — the
          // most permissive grantable clearance, so this is the best case. A
          // caller cleared only for `public` may land somewhere narrower, which
          // is the point of deriving it per caller rather than configuring it.
          defaultWorkdir: workdirFor(
            withFloor(loadSensitivityMap(ctx.paths), ctx.paths.machine.userHome),
            ctx.paths.shareDir,
          ),
        });
        console.log(report.trimEnd());
      } catch (e) {
        fail(e);
      }
    });
}
