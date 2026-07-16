import type { Task } from "./tasks.js";

// The task section is behavior-shaping only — enforcement lives in the
// spawn envelope (runner.ts) and srt config (srt.ts), which were fixed
// before this prompt was built. SKILL.md content is fenced between markers
// so the model can tell the owner's instructions from the caller's message.
export function buildPrompt(handle: string, from: string, message: string, task?: Task): string {
  const taskSection =
    task && task.id !== "ask"
      ? `You are performing the task "${task.name}" (${task.id}) for this call and must not perform any other task. ` +
        `The owner's instructions for this task follow between the markers.\n` +
        `<<TASK-INSTRUCTIONS>>\n${task.skill}\n<<END-TASK-INSTRUCTIONS>>\n`
      : "";
  return (
    `You are ${handle}'s public agent, answering a one-shot call from "${from}" via agentcall. ` +
    `You can only access the current directory (~/AgentCall/public). Do not attempt to access anything else. ` +
    `Answer helpfully and concisely. ${taskSection}The caller's message follows after the divider.\n---\n${message}`
  );
}
