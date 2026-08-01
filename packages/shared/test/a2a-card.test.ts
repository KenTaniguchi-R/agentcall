import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENTCALL_POLICY_EXT, toAgentCard, toDirectoryCard } from "../src/index.js";

// Vendored, minimal copy of the "Agent Card" / "Agent Interface" definitions
// from the pinned A2A TCK's specification/a2a.json (see fixtures file header
// for the exact ref). `additionalProperties: false` there means ANY key not
// in this list makes the card fail strict validation for a real A2A client —
// this is the permanent regression test for that: it must fail if anyone
// reintroduces an out-of-schema field (e.g. top-level `protocolVersion` or
// `agentExtensions`).
const SCHEMA_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/a2a-card-schema.json", import.meta.url),
);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_FIXTURE_PATH, "utf8")) as {
  definitions: Record<string, { additionalProperties: boolean; properties: string[] }>;
};

function assertOnlyAllowedKeys(obj: unknown, definitionName: string): void {
  const def = SCHEMA.definitions[definitionName];
  if (!def) throw new Error(`no such vendored definition: ${definitionName}`);
  expect(def.additionalProperties, `${definitionName} must enforce additionalProperties: false`).toBe(false);
  const allowed = new Set(def.properties);
  const actual = Object.keys(obj as Record<string, unknown>);
  const unknownKeys = actual.filter((k) => !allowed.has(k));
  expect(unknownKeys, `${definitionName}: out-of-schema keys ${JSON.stringify(unknownKeys)}`).toEqual([]);
}

const TASKS = [
  { id: "ask", name: "Ask", description: "Answer a question.", examples: ["what owns billing?"] },
  { id: "triage", name: "Triage", description: "Triage an incident.", examples: [] },
];

const card = () =>
  toAgentCard({
    handle: "ken",
    description: "Ken's agent",
    tasks: TASKS,
    baseUrl: "https://agentcall.benree.tech/ken",
  });

describe("toAgentCard", () => {
  it("includes every field the TCK requires", () => {
    const c = card() as Record<string, unknown>;
    for (const f of [
      "name", "description", "version", "capabilities",
      "skills", "supportedInterfaces", "defaultInputModes", "defaultOutputModes",
    ]) {
      expect(c[f], `missing ${f}`).toBeDefined();
    }
  });

  it("names the card after the handle", () => {
    expect(card().name).toBe("ken");
  });

  it("declares exactly one HTTP+JSON interface at the handle's base URL", () => {
    expect(card().supportedInterfaces).toEqual([
      {
        url: "https://agentcall.benree.tech/ken",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ]);
  });

  it("does not set tenant on the per-handle interface — the handle is already the base path", () => {
    expect(card().supportedInterfaces[0]!.tenant).toBeUndefined();
  });

  it("projects each task to an AgentSkill", () => {
    expect(card().skills[0]).toEqual({
      id: "ask",
      name: "Ask",
      description: "Answer a question.",
      tags: ["agentcall"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      examples: ["what owns billing?"],
    });
  });

  it("declares the policy extension with a fixed, host-independent URI, under capabilities.extensions", () => {
    expect(card().capabilities.extensions?.[0]?.uri).toBe(AGENTCALL_POLICY_EXT);
    expect(AGENTCALL_POLICY_EXT).toBe("https://agentcall.benree.tech/ext/policy/v1");
  });

  it("carries the handle in the extension params", () => {
    expect(card().capabilities.extensions?.[0]?.params).toEqual({ handle: "ken" });
  });

  it("does not advertise streaming or push in this plan", () => {
    expect(card().capabilities.streaming).toBe(false);
    expect(card().capabilities.pushNotifications).toBe(false);
  });

  it("does not advertise extendedAgentCard — GetExtendedAgentCard is not implemented on this branch", () => {
    expect(card().capabilities.extendedAgentCard).toBe(false);
  });

  // The two fields the spec forbids in any public payload.
  it("never leaks grants or agent_kind", () => {
    const serialized = JSON.stringify(card());
    expect(serialized).not.toContain("grants");
    expect(serialized).not.toContain("agent_kind");
  });
});

describe("toDirectoryCard", () => {
  it("describes the relay itself, not a person", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    expect(d.name).toBe("agentcall relay");
    expect(d.supportedInterfaces[0]!.url).toBe("https://agentcall.benree.tech");
    expect(d.supportedInterfaces[0]!.tenant).toBeUndefined();
  });

  it("advertises the handle-resolution skill", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    expect(d.skills.map((s) => s.id)).toContain("resolve-handle");
  });
});

describe("schema conformance (vendored A2A v1.0 'Agent Card' / 'Agent Interface' key sets)", () => {
  it("toAgentCard's top level has no keys outside 'Agent Card'", () => {
    assertOnlyAllowedKeys(card(), "Agent Card");
  });

  it("toAgentCard's capabilities has no keys outside 'Agent Capabilities'", () => {
    assertOnlyAllowedKeys(card().capabilities, "Agent Capabilities");
  });

  it("toAgentCard's capabilities.extensions entries have no keys outside 'Agent Extension'", () => {
    for (const ext of card().capabilities.extensions ?? []) {
      assertOnlyAllowedKeys(ext, "Agent Extension");
    }
  });

  it("toAgentCard's supportedInterfaces entries have no keys outside 'Agent Interface'", () => {
    for (const iface of card().supportedInterfaces) {
      assertOnlyAllowedKeys(iface, "Agent Interface");
    }
  });

  it("toDirectoryCard's top level has no keys outside 'Agent Card'", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    assertOnlyAllowedKeys(d, "Agent Card");
  });

  it("toDirectoryCard's capabilities has no keys outside 'Agent Capabilities'", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    assertOnlyAllowedKeys(d.capabilities, "Agent Capabilities");
  });

  it("toDirectoryCard's supportedInterfaces entries have no keys outside 'Agent Interface'", () => {
    const d = toDirectoryCard({ origin: "https://agentcall.benree.tech" });
    for (const iface of d.supportedInterfaces) {
      assertOnlyAllowedKeys(iface, "Agent Interface");
    }
  });
});
