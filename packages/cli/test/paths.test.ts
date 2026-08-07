import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getLinePaths, getMachinePaths } from "../src/paths.js";

describe("getMachinePaths", () => {
  it("derives person-scoped paths from the state root", () => {
    const m = getMachinePaths("/state", "/state");
    expect(m.dir).toBe("/state/.agentcall");
    expect(m.personFile).toBe("/state/.agentcall/person.json");
    expect(m.contactsFile).toBe("/state/.agentcall/contacts.json");
    expect(m.knownPeersFile).toBe("/state/.agentcall/known_peers.json");
    expect(m.linesDir).toBe("/state/.agentcall/lines");
    expect(m.removedDir).toBe("/state/.agentcall/removed");
    expect(m.listenerLog).toBe("/state/.agentcall/listener.log");
  });

  it("keeps userHome independent of the state root", () => {
    const m = getMachinePaths("/tmp/test-state", "/Users/real");
    expect(m.stateRoot).toBe("/tmp/test-state");
    expect(m.userHome).toBe("/Users/real");
    expect(m.dir).toBe("/tmp/test-state/.agentcall");
  });


  it("reads AGENTCALL_HOME for the state root only", () => {
    const prev = process.env.AGENTCALL_HOME;
    process.env.AGENTCALL_HOME = "/tmp/env-state";
    try {
      const m = getMachinePaths();
      expect(m.stateRoot).toBe("/tmp/env-state");
      expect(m.userHome).not.toBe("/tmp/env-state");
    } finally {
      if (prev === undefined) delete process.env.AGENTCALL_HOME;
      else process.env.AGENTCALL_HOME = prev;
    }
  });
});

describe("getLinePaths", () => {
  it("puts line state under linesDir and authored content under AgentCall/<name>", () => {
    const m = getMachinePaths("/state", "/state");
    const l = getLinePaths(m, "codex");
    expect(l.name).toBe("codex");
    expect(l.dir).toBe("/state/.agentcall/lines/codex");
    expect(l.configFile).toBe(join(l.dir, "config.json"));
    expect(l.policyFile).toBe(join(l.dir, "policy.json"));
    expect(l.cardSnapshotFile).toBe(join(l.dir, "card.pushed.json"));
    expect(l.callsLog).toBe(join(l.dir, "calls.log"));
    expect(l.toolsLog).toBe(join(l.dir, "tools.log"));
    expect(l.tasksDir).toBe("/state/AgentCall/codex/tasks");
    expect(l.shareDir).toBe("/state/AgentCall/codex/public");
  });

  // The identity key is the trust root for an ADDRESS, and a line is exactly
  // one handle on one relay. If two lines shared an identity key file, line A
  // could sign key records for line B's address.
  it("gives each line its own identity key file", () => {
    const m = getMachinePaths("/state", "/state");
    const a = getLinePaths(m, "claude");
    const b = getLinePaths(m, "codex");
    expect(a.identityKeyFile).toBe("/state/.agentcall/lines/claude/identity.key.json");
    expect(b.identityKeyFile).toBe("/state/.agentcall/lines/codex/identity.key.json");
    expect(a.identityKeyFile).not.toBe(b.identityKeyFile);
  });

  it("carries the machine paths so a line can reach person-scoped state", () => {
    const m = getMachinePaths("/state", "/real");
    expect(getLinePaths(m, "claude").machine.userHome).toBe("/real");
  });
});
