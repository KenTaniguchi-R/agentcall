import { describe, expect, it } from "vitest";
import { AGENTCALL_POLICY_EXT, toAgentCard, toDirectoryCard } from "../src/index.js";

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
        tenant: "ken",
      },
    ]);
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

  it("declares the policy extension with a fixed, host-independent URI", () => {
    expect(card().agentExtensions?.[0]?.uri).toBe(AGENTCALL_POLICY_EXT);
    expect(AGENTCALL_POLICY_EXT).toBe("https://agentcall.benree.tech/ext/policy/v1");
  });

  it("carries the handle in the extension params", () => {
    expect(card().agentExtensions?.[0]?.params).toEqual({ handle: "ken" });
  });

  it("does not advertise streaming or push in this plan", () => {
    expect(card().capabilities.streaming).toBe(false);
    expect(card().capabilities.pushNotifications).toBe(false);
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
