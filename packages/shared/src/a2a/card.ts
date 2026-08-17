import type { CardTaskType } from "../card.js";
import { A2A_PROTOCOL_VERSION } from "./version.js";

/**
 * A stable identifier, NOT a per-deployment address. It does not vary by relay
 * host and need not resolve. A self-hosted relay declares this same URI —
 * otherwise every deployment would advertise a different extension and no
 * client could recognize any of them.
 *
 * Deliberately a literal rather than a template over HOSTED_RELAY_HOST, even
 * though the two spell the same host today. Deriving it would make a future
 * host change silently rewrite this URI, and every deployment that had not
 * upgraded in lockstep would stop recognizing the extension — exactly the
 * failure the paragraph above rules out. They are equal by coincidence, not by
 * rule, and this file is allowlisted out of the hosted-relay-host invariant for
 * that reason.
 *
 * #310 changed this value by hand, in the same commit that moved the host but
 * as a separate decision. Changing it is a protocol break; it was done while
 * the user count was zero, because it becomes permanent the moment anything
 * depends on it.
 */
export const AGENTCALL_POLICY_EXT = "https://agent-call.app/ext/policy/v1";
export const AGENTCALL_MAILBOX_EXT = "https://agent-call.app/ext/durable-mailbox/v1";

const TEXT_MODES = ["text/plain"];

export type A2AAgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
  examples: string[];
};

export type A2AAgentInterface = {
  url: string;
  protocolBinding: "HTTP+JSON";
  protocolVersion: string;
  tenant?: string;
};

export type A2AAgentExtension = {
  uri: string;
  description: string;
  required: boolean;
  params?: Record<string, string>;
};

export type A2AAgentCard = {
  name: string;
  description: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
    extensions?: A2AAgentExtension[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  supportedInterfaces: A2AAgentInterface[];
};

function toSkill(task: CardTaskType): A2AAgentSkill {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    tags: ["agentcall"],
    inputModes: [...TEXT_MODES],
    outputModes: [...TEXT_MODES],
    examples: [...task.examples],
  };
}

/**
 * One-way projection. Deliberately lossy: `grants` never leaves the policy
 * engine, and `agent_kind` is implementation metadata that does not belong in
 * a public contract. Callers pass `tasks` ALREADY filtered to what this viewer
 * may invoke — this function does no authorization of its own.
 */
export function toAgentCard(input: {
  handle: string;
  description: string;
  tasks: CardTaskType[];
  baseUrl: string;
  offlineDelivery?: boolean;
}): A2AAgentCard {
  return {
    name: input.handle,
    description: input.description,
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      // GetExtendedAgentCard is not implemented on this branch (Plan 2), so
      // this must not claim the extended-card capability yet.
      extendedAgentCard: false,
      extensions: [
        {
          uri: AGENTCALL_POLICY_EXT,
          description: "agentcall per-caller task policy.",
          required: false,
          params: { handle: input.handle },
        },
        ...(input.offlineDelivery ? [{
          uri: AGENTCALL_MAILBOX_EXT,
          description: "Encrypted durable delivery for temporarily offline installations.",
          required: false,
          params: { version: "durable-mailbox-v1" },
        }] : []),
      ],
    },
    defaultInputModes: [...TEXT_MODES],
    defaultOutputModes: [...TEXT_MODES],
    skills: input.tasks.map(toSkill),
    supportedInterfaces: [
      {
        url: input.baseUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
        // The handle is already the leading path segment of `baseUrl`; a
        // `tenant` here would double-specify it under A2A's
        // tenant-as-leading-path-segment reading.
      },
    ],
  };
}

/**
 * The card at the ORIGIN well-known path. It describes the relay itself — the
 * directory/gateway agent — not any person. Per-handle cards are retrieved
 * from the registry, which is A2A's second sanctioned discovery mechanism.
 */
export function toDirectoryCard(input: { origin: string }): A2AAgentCard {
  return {
    name: "agentcall relay",
    description: "Directory of agentcall handles. Each handle publishes its own Agent Card.",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: [...TEXT_MODES],
    defaultOutputModes: [...TEXT_MODES],
    skills: [
      {
        id: "resolve-handle",
        name: "Resolve handle",
        description: "Resolve an agentcall handle to that agent's own Agent Card.",
        tags: ["agentcall", "directory"],
        inputModes: [...TEXT_MODES],
        outputModes: ["application/json"],
        examples: ["GET /v1/a2a/ken/agent-card.json"],
      },
    ],
    supportedInterfaces: [
      { url: input.origin, protocolBinding: "HTTP+JSON", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
  };
}
