import type { Workdir } from "./config.js";
import type { Task } from "./tasks.js";

// The task section is behavior-shaping only — enforcement lives in the spawn
// envelope (runner.ts), which is fixed before this prompt is built. SKILL.md
// content is fenced between markers so the model can tell the owner's
// instructions from the caller's message.
//
// The workdir sentence is behavior-shaping too. It used to be backed by an OS
// sandbox that made it true regardless of what the model decided; with that
// gone, an agent holding the `read` cap can read outside its working
// directory if it chooses to. It's kept for the default share folder because
// stating the intent still steers behavior, and dropped when the owner has
// deliberately pointed the agent at a real project (see config.ts's Workdir).
export function buildPrompt(
  handle: string, from: string, message: string, task?: Task, workdir?: Workdir,
): string {
  const taskSection =
    task && task.id !== "ask"
      ? `You are performing the task "${task.name}" (${task.id}) for this call and must not perform any other task. ` +
        `The owner's instructions for this task follow between the markers.\n` +
        `<<TASK-INSTRUCTIONS>>\n${task.skill}\n<<END-TASK-INSTRUCTIONS>>\n`
      : "";
  const dirSection = workdir
    ? `Your working directory is ${workdir.dir}.` +
      (workdir.confined ? " Do not access anything outside it." : "") + " "
    : "";
  return (
    `You are ${handle}'s public agent, answering a one-shot call from "${from}" via agentcall. ` +
    `${dirSection}Answer helpfully and concisely. ${taskSection}` +
    `The caller's message follows after the divider.\n---\n${message}`
  );
}
