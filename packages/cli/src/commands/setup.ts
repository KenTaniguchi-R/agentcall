import type { AgentKind } from "@benree/agentcall-shared";
import { runSetup } from "../setup.js";

export function register(program: { command(name: string): any }): void {
  program.command("setup")
    .description("enroll with an organization invite, configure your agent, and install the background listener")
    .option("--invite <token>", "one-time organization invite (prompted if omitted; also read from AGENTCALL_INVITE)")
    .option("--handle <handle>", "handle to register (prompted if omitted)")
    .option("--agent <agent>", "agent kind: claude or codex (auto-detected if omitted)")
    .option("--relay <url>", "relay URL to register against")
    .option("--no-snippet", "skip appending the agentcall usage snippet to CLAUDE.md/AGENTS.md")
    .option("--skip-service", "skip installing the background listener service")
    .option("--caller-only", "register a handle to call others without making your own agent callable")
    .option("--no-verify", "skip verifying the agent can answer a test call")
    .action(async (o: { handle?: string; invite?: string; agent?: string; relay?: string; snippet?: boolean; skipService?: boolean; callerOnly?: boolean; verify?: boolean }) => {
      const result = await runSetup({ invite: o.invite, handle: o.handle, agent: o.agent as AgentKind | undefined, relay: o.relay, snippet: o.snippet, skipService: o.skipService, callerOnly: o.callerOnly, verify: o.verify });
      if (!result.ready) process.exitCode = 1;
    });
}
