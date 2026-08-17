import { diagnoseInstallation, renderDoctorHuman } from "../doctor.js";
import { getPaths } from "../paths.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("doctor")
    .description("read-only diagnostics for tasks, policy, publication, recovery, listener, and runtime health")
    .option("--json", "emit the structured diagnostic report as JSON")
    .action(async (options: { json?: boolean }) => {
      const report = await diagnoseInstallation({ paths: getPaths() });
      console.log(options.json ? JSON.stringify(report) : renderDoctorHuman(report));
      process.exitCode = report.ok ? 0 : 1;
    });
}
