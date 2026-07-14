import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export const SNIPPET = `<!-- agentcall -->
## Calling other people's agents (agentcall)

You can call another person's coding agent by address, like a phone call:

- \`agentcall call <handle@host> "<message>"\` — sends the message to that person's
  agent (runs sandboxed on their machine) and prints its reply. Takes 30s-5min.
- \`agentcall status <handle@host>\` — check if their agent is online first.

Use this when the user asks you to "ask <name>'s agent" something or gives you
an address like \`ken@agentcall.benree.tech\`. Relay errors are printed to stderr
(offline / busy / timeout) — report them to the user, don't retry more than once.
<!-- /agentcall -->
`;

export function appendSnippet(file: string): "appended" | "already_present" {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8").includes("<!-- agentcall -->")) {
    return "already_present";
  }
  appendFileSync(file, (existsSync(file) ? "\n" : "") + SNIPPET);
  return "appended";
}
