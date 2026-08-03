import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { toJSONSchema } from "../packages/shared/node_modules/zod/index.js";
import * as protocol from "../packages/shared/dist/protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "docs/site/reference/protocol.mdx");

const groups = [
  ["Caller to relay", [["CallRequest", "Start or continue a call."]]],
  ["Relay to caller", [
    ["CallStatus", "Report lifecycle state."],
    ["CallReply", "Return a successful reply."],
    ["CallError", "Return a protocol error."],
  ]],
  ["Relay to listener", [
    ["IncomingCall", "Deliver an authenticated call."],
    ["CancelCall", "Request cancellation."],
  ]],
  ["Listener to relay", [
    ["CallAccepted", "Confirm ownership of queued work."],
    ["CallStarted", "Confirm the answering process started."],
    ["CallAnswer", "Legacy lifecycle acknowledgement."],
    ["CallResult", "Return successful text."],
    ["CallFailed", "Return an answering failure."],
    ["CallCancelled", "Confirm cancellation completed."],
    ["CallNotCancelled", "Explain why cancellation did not complete."],
  ]],
];

function renderType(schema) {
  if (schema.const !== undefined) return `\`${schema.const}\``;
  if (schema.enum) return schema.enum.map((value) => `\`${value}\``).join(" / ");
  if (schema.type === "array") return `${renderType(schema.items)}[]`;
  return schema.type ?? "unknown";
}

const lines = [
  "---",
  "title: Protocol frames",
  "description: Generated WebSocket frame shapes exchanged by callers, the relay, and listeners.",
  "---",
  "",
  "This page is generated from the built Zod schemas in `packages/shared/src/protocol.ts`. The [repository README](https://github.com/KenTaniguchi-R/agentcall#how-a-call-works) remains the authority on current runtime behavior.",
];

for (const [heading, schemas] of groups) {
  lines.push("", `## ${heading}`);
  for (const [exportName, purpose] of schemas) {
    // Protocol documentation describes accepted wire input. This matters for
    // fields such as IncomingCall.groups: Zod defaults it to [] after parsing,
    // so it is required in output but optional on the wire.
    const schema = toJSONSchema(protocol[exportName], { io: "input" });
    const frame = schema.properties.type.const;
    const required = new Set(schema.required ?? []);
    lines.push("", `### \`${frame}\``, "", purpose, "", "| Field | Type | Required |", "| --- | --- | --- |");
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      lines.push(`| \`${field}\` | ${renderType(fieldSchema)} | ${required.has(field) ? "yes" : "no"} |`);
    }
  }
}

lines.push(
  "",
  "## Important bounds",
  "",
  `- Messages are limited to ${protocol.MAX_MESSAGE_BYTES.toLocaleString("en-US")} bytes; replies to ${protocol.MAX_REPLY_BYTES.toLocaleString("en-US")} bytes.`,
  `- Conversation contexts expire after ${protocol.CONTEXT_TTL_MS / 60_000} minutes and allow at most ${protocol.MAX_CONTEXT_TURNS} turns.`,
  `- Each caller has a ${protocol.RATE_LIMIT_PER_HOUR}-call hourly budget.`,
  `- A listener accepts at most ${protocol.MAX_CALLER_GROUPS} relay-attested shared roster IDs per call.`,
  "- Optional W3C trace context is normalized and must match the correlation ID.",
  "",
  "The lifecycle migration is not complete: the listener emits `call_accepted` and `call_started`, while the currently deployed relay still recognizes the legacy `call_answer` acknowledgement for its caller-facing answered state.",
  "",
);

const generated = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) {
    console.error("Protocol reference is stale; run pnpm docs:generate and commit it");
    process.exit(1);
  }
} else {
  writeFileSync(output, generated);
}
