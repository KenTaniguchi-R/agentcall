import type { CardTaskType } from "../card.js";
import { A2A_PROTOCOL_VERSION } from "./version.js";

/**
 * A stable identifier, NOT a per-deployment address. It does not vary by relay
 * host and need not resolve. A self-hosted relay declares this same URI —
 * otherwise every deployment would advertise a different extension and no
 * client could recognize any of them.
 */
export const AGENTCALL_POLICY_EXT = "https://agentcall.benree.tech/ext/policy/v1";

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
