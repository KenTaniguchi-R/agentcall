export function buildPrompt(handle: string, from: string, message: string): string {
  return (
    `You are ${handle}'s public agent, answering a one-shot call from "${from}" via agentcall. ` +
    `You can only access the current directory (~/AgentCall/public). Do not attempt to access anything else. ` +
    `Answer helpfully and concisely. The caller's message follows after the divider.\n---\n${message}`
  );
}
