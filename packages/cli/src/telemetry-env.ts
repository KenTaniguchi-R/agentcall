/**
 * The answering Claude/Codex process is not AgentCall's telemetry process.
 * Never give it collector routing or credentials; a third-party CLI could
 * otherwise export a broader data set to the owner's AgentCall destination.
 */
export function agentChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const normalized = key.toUpperCase();
      return !normalized.startsWith("OTEL_") && !normalized.startsWith("AGENTCALL_OTEL");
    }),
  );
}
