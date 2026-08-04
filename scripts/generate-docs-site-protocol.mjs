import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { toJSONSchema } from "../packages/shared/node_modules/zod/index.js";
import * as protocol from "../packages/shared/dist/protocol.js";
import * as e2ee from "../packages/shared/dist/e2ee.js";
import * as room from "../packages/shared/dist/room.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "docs/site/reference/protocol.mdx");

const groups = [
  ["Caller to relay", [[e2ee.EncryptedCallRequest, "Send an encrypted call payload."]]],
  ["Relay to caller", [
    [protocol.CallStatus, "Report unauthenticated lifecycle metadata."],
    [protocol.RelayCallError, "Return an unauthenticated relay-operational error."],
    [e2ee.EncryptedCallOutcome, "Return an encrypted, authenticated peer outcome."],
  ]],
  ["Relay to listener", [
    [e2ee.EncryptedIncomingCall, "Deliver an encrypted call with relay-attested routing metadata."],
    [protocol.CancelCall, "Request cancellation."],
  ]],
  ["Listener to relay", [
    [protocol.CallAccepted, "Confirm ownership of queued work."],
    [protocol.CallStarted, "Confirm the answering process started."],
    [e2ee.EncryptedCallOutcome, "Return an encrypted, authenticated peer outcome."],
    [protocol.CallRejected, "Reject an invalid encrypted request."],
    [protocol.CallCancelled, "Confirm cancellation completed."],
    [protocol.CallNotCancelled, "Explain why cancellation did not complete."],
  ]],
];

function renderType(schema) {
  if (schema.const !== undefined) return `\`${schema.const}\``;
  if (schema.enum) return schema.enum.map((value) => `\`${value}\``).join(" / ");
  if (schema.anyOf) return schema.anyOf.map(renderType).join(" / ");
  if (schema.oneOf) return schema.oneOf.map(renderType).join(" / ");
  if (schema.type === "array") return `${renderType(schema.items)}[]`;
  return schema.type ?? "unknown";
}

const lines = [
  "---",
  "title: Protocol frames",
  "description: Generated WebSocket frame shapes exchanged by callers, the relay, and listeners.",
  "---",
  "",
  "This page is generated from the built Zod schemas in `packages/shared/src/protocol.ts`, `packages/shared/src/e2ee.ts`, and `packages/shared/src/room.ts`. The [repository README](https://github.com/KenTaniguchi-R/agentcall#how-a-call-works) remains the authority on current runtime behavior.",
];

for (const [heading, schemas] of groups) {
  lines.push("", `## ${heading}`);
  for (const [wireSchema, purpose] of schemas) {
    // Protocol documentation describes accepted wire input. This matters for
    // fields such as IncomingCall.groups: Zod defaults it to [] after parsing,
    // so it is required in output but optional on the wire.
    const schema = toJSONSchema(wireSchema, { io: "input" });
    const frame = schema.properties.type.const;
    const required = new Set(schema.required ?? []);
    lines.push("", `### \`${frame}\``, "", purpose, "", "| Field | Type | Required |", "| --- | --- | --- |");
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      lines.push(`| \`${field}\` | ${renderType(fieldSchema)} | ${required.has(field) ? "yes" : "no"} |`);
    }
  }
}

lines.push("", "## Accountless Room HTTP protocol");
for (const [heading, wireSchema, purpose] of [
  ["Create request", room.RoomCreateRequest, "Create a bounded 2–6-person accountless Room."],
  ["Create response", room.RoomCreateResponse, "Return the host capability and independent single-use invitations exactly once."],
  ["Join request", room.RoomJoinRequest, "Redeem one invitation with a participant secret and signing-key possession proof."],
  ["Join response", room.RoomJoinResponse, "Return session-local membership; the capability appears only on first issuance."],
  ["Room action request", room.RoomMutationRequest, "Perform a capability-authenticated lifecycle action; only moderation actions use the optional target."],
  ["Room action response", room.RoomMutationResponse, "Return the current bounded Room membership view without credential hashes."],
]) {
  const schema = toJSONSchema(wireSchema, { io: "input" });
  const required = new Set(schema.required ?? []);
  lines.push("", `### ${heading}`, "", purpose, "", "| Field | Type | Required |", "| --- | --- | --- |");
  for (const [field, fieldSchema] of Object.entries(schema.properties)) {
    lines.push(`| \`${field}\` | ${renderType(fieldSchema)} | ${required.has(field) ? "yes" : "no"} |`);
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
  `- An encrypted WebSocket frame is limited to ${e2ee.MAX_E2EE_WIRE_BYTES.toLocaleString("en-US")} bytes.`,
  "- Optional W3C trace context is normalized and must match the correlation ID.",
  "",
  "Call messages, task and context identifiers, successful replies, peer failure details, and offered-task lists exist only inside signed HPKE envelopes. Routing and lifecycle metadata remain visible to the relay.",
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
