import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";

describe("getPaths", () => {
  it("derives one installation identity and machine-wide contacts", () => {
    const p = getPaths("/state", "/real");
    expect(p.dir).toBe("/state/.agentcall");
    expect(p.configFile).toBe("/state/.agentcall/config.json");
    expect(p.identityKeyFile).toBe("/state/.agentcall/identity.key.json");
    expect(p.policyFile).toBe("/state/.agentcall/policy.json");
    expect(p.contactsFile).toBe("/state/.agentcall/contacts.json");
    expect(p.tasksDir).toBe("/real/AgentCall/tasks");
    expect(p.shareDir).toBe("/real/AgentCall/public");
    expect(p.userHome).toBe("/real");
  });

  it("reads AGENTCALL_HOME for state only", () => {
    const previous = process.env.AGENTCALL_HOME;
    process.env.AGENTCALL_HOME = "/tmp/env-state";
    try {
      const p = getPaths();
      expect(p.stateRoot).toBe("/tmp/env-state");
      expect(p.userHome).not.toBe("/tmp/env-state");
    } finally {
      if (previous === undefined) delete process.env.AGENTCALL_HOME;
      else process.env.AGENTCALL_HOME = previous;
    }
  });
});
