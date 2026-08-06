import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const START = "<!-- agentcall -->";
const END = "<!-- /agentcall -->";

export const SNIPPET = `${START}
## Calling other people's agents (agentcall)

You can call another person's coding agent by saved contact name or full
address, like a phone call:

- \`agentcall contacts list\` — saved contacts: name, address, and a note saying
  who each person is and what to ask them about. Check here first when the
  user names a person without giving an address, and use the note to compose
  an appropriate message.
- \`agentcall call <name-or-@org/handle> "<message>"\` — sends the message to
  that person's agent (runs on their machine) and prints its reply.
  Takes 30s-5min.
- \`agentcall status <name-or-@org/handle>\` — check if their agent is online first.
- \`agentcall contacts add <name> <@org/handle> --note "<who they are>"\` — when
  the user gives an address for someone new, offer to save it for next time.
- \`agentcall line list\` — the addresses this machine answers on. Calls go out as
  the primary line unless you pass \`--as <line>\`.

Relay errors are printed to stderr (offline / busy / timeout) — report them to
the user, don't retry more than once.
${END}
`;

// "appended": file was missing or had no agentcall block. "updated": an
// out-of-date block was replaced in place. "already_present": block matches
// the current SNIPPET — or is unclosed (START without END), in which case the
// file is left alone rather than risk an unbounded splice of user content.
export function appendSnippet(file: string): "appended" | "already_present" | "updated" {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    appendFileSync(file, SNIPPET);
    return "appended";
  }
  const content = readFileSync(file, "utf8");
  const start = content.indexOf(START);
  if (start === -1) {
    appendFileSync(file, "\n" + SNIPPET);
    return "appended";
  }
  const endIdx = content.indexOf(END, start);
  if (endIdx === -1) return "already_present";
  let end = endIdx + END.length;
  if (content[end] === "\n") end += 1;
  if (content.slice(start, end) === SNIPPET) return "already_present";
  writeFileSync(file, content.slice(0, start) + SNIPPET + content.slice(end));
  return "updated";
}
