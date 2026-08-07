import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { loadLineConfig, saveLineConfig } from "../src/lines.js";
import { createRecoveryPrompter, runRecoveryIssue, runRecoveryRedeem } from "../src/commands/recovery.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentcall-recovery-"));
  roots.push(root);
  const machine = getMachinePaths(root, root);
  const paths = getLinePaths(machine, "main");
  const config = { org: "acme", handle: "alice", token: "old-token", relay: "https://relay.test", agent_kind: "claude" as const };
  saveLineConfig(paths, config);
  return { paths, config };
}
// #346: the paths for a line whose config.json is genuinely gone, the exact
// scenario `agentcall recovery redeem` (without `--resume`) exists to recover
// from. No saveLineConfig call, so `target.config` is undefined and the redeem
// path has no local source for agent_kind at all — only the relay's receipt.
function fixtureNoConfig() {
  const root = mkdtempSync(join(tmpdir(), "agentcall-recovery-"));
  roots.push(root);
  const machine = getMachinePaths(root, root);
  const paths = getLinePaths(machine, "main");
  return { paths };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("recovery issue", () => {
  it("shows the proof only through the secret sink and commits after acknowledgement", async () => {
    const { paths, config } = fixture();
    const shown: string[] = [];
    let called = false;
    const result = await runRecoveryIssue({ name: "main", paths, config }, {
      randomSecret: () => "successor-proof-" + "x".repeat(32),
      displaySecret: (value) => shown.push(value),
      ask: async () => "SAVED",
      status: async () => ({ issued: true, generation: 2, recovery_public_id: "agr_cccccccccccccccc" }),
      issue: async (_relay, _auth, request) => {
        called = true;
        expect(request.expected_generation).toBe(2);
        expect(request.successor_recovery_digest).toMatch(/^[0-9a-f]{64}$/);
        return { generation: 3, recovery_public_id: request.successor_recovery_public_id };
      },
      log: () => {},
    });
    expect(called).toBe(true);
    expect(shown).toEqual(["successor-proof-" + "x".repeat(32)]);
    expect(result).toEqual({ generation: 3 });
  });

  it("does not contact the relay without explicit acknowledgement", async () => {
    const { paths, config } = fixture();
    await expect(runRecoveryIssue({ name: "main", paths, config }, {
      randomSecret: () => "proof-" + "x".repeat(40), displaySecret: () => {},
      ask: async () => "no", issue: async () => { throw new Error("must not call"); }, log: () => {},
      status: async () => ({ issued: false, generation: 0 }),
    })).rejects.toThrow(/SAVED/);
  });
});

describe("recovery redeem", () => {
  it("fails closed instead of reading a proof from piped stdin when no TTY exists", async () => {
    const ask = createRecoveryPrompter(() => { throw new Error("no controlling tty"); });
    await expect(ask("Recovery proof: ")).rejects.toThrow("no controlling tty");
  });

  it("persists the candidate before commit, never persists proofs, then installs the confirmed token", async () => {
    const { paths, config } = fixture();
    const successor = "successor-" + "s".repeat(40);
    const current = "current-" + "c".repeat(40);
    const generated = ["candidate-" + "t".repeat(40), successor, "A".repeat(22)];
    await runRecoveryRedeem({ name: "main", paths, config, generation: 1 }, {
      randomSecret: () => generated.shift()!, displaySecret: () => {},
      ask: async (question) => question.includes("SAVED") ? "SAVED" : current,
      redeem: async (_relay, request) => {
        expect(existsSync(paths.recoveryPendingFile)).toBe(true);
        const disk = readFileSync(paths.recoveryPendingFile, "utf8");
        expect(disk).toContain("candidate-");
        expect(disk).not.toContain(current);
        expect(disk).not.toContain(successor);
        return {
          org: "acme", handle: "alice", operation_id: request.operation_id,
          consumed_generation: 1, recovery_generation: 2,
          client_public_id: request.client_public_id,
          recovery_public_id: request.successor_recovery_public_id,
          committed_at: 1, eviction_confirmed: true, agent_kind: "claude" as const,
        };
      }, log: () => {},
    });
    expect(existsSync(paths.recoveryPendingFile)).toBe(false);
    expect(loadLineConfig(paths)).toMatchObject({ token: "candidate-" + "t".repeat(40), agent_kind: "claude" });
  });

  it("resumes a lost response with the same candidate and user-supplied proofs", async () => {
    const { paths, config } = fixture();
    const candidate = "candidate-" + "t".repeat(40);
    const successor = "successor-" + "s".repeat(40);
    const current = "current-" + "c".repeat(40);
    const generated = [candidate, successor, "B".repeat(22)];
    await expect(runRecoveryRedeem({ name: "main", paths, config, generation: 4 }, {
      randomSecret: () => generated.shift()!, displaySecret: () => {},
      ask: async (question) => question.includes("SAVED") ? "SAVED" : current,
      redeem: async () => { throw new Error("response lost"); }, log: () => {},
    })).rejects.toThrow("response lost");
    expect(existsSync(paths.recoveryPendingFile)).toBe(true);

    const answers = [current, successor];
    let candidateSeen = "";
    await runRecoveryRedeem({ name: "main", paths, config, resume: true }, {
      randomSecret: () => { throw new Error("must not regenerate"); }, displaySecret: () => {},
      ask: async () => answers.shift()!,
      redeem: async (_relay, request) => {
        candidateSeen = request.client_token_digest;
        return {
          org: "acme", handle: "alice", operation_id: request.operation_id,
          consumed_generation: 4, recovery_generation: 5,
          client_public_id: request.client_public_id,
          recovery_public_id: request.successor_recovery_public_id,
          committed_at: 2, eviction_confirmed: false, agent_kind: "claude" as const,
        };
      }, log: () => {},
    });
    expect(candidateSeen).toMatch(/^[0-9a-f]{64}$/);
    expect(loadLineConfig(paths).token).toBe(candidate);
    expect(existsSync(paths.recoveryPendingFile)).toBe(false);
  });

  it("recovers a callable line's agent_kind from the receipt when config.json is genuinely gone (regression #346)", async () => {
    // #346: this is the documented scenario -- "if the line token is lost" --
    // not the "still have config.json, just rotating credentials" case the
    // two tests above cover. Before the fix, this path built a LineConfig with
    // no agent_kind at all, silently turning a callable line into caller-only:
    // `agentcall listen` would then refuse to start with "no callable lines."
    const { paths } = fixtureNoConfig();
    const generated = ["candidate-" + "t".repeat(40), "successor-" + "s".repeat(40), "D".repeat(22)];
    const current = "current-" + "c".repeat(40);
    await runRecoveryRedeem({
      name: "main", paths, org: "acme", handle: "alice", relay: "https://relay.test", generation: 1,
    }, {
      randomSecret: () => generated.shift()!, displaySecret: () => {},
      ask: async (question) => question.includes("SAVED") ? "SAVED" : current,
      redeem: async (_relay, request) => ({
        org: "acme", handle: "alice", operation_id: request.operation_id,
        consumed_generation: 1, recovery_generation: 2,
        client_public_id: request.client_public_id,
        recovery_public_id: request.successor_recovery_public_id,
        committed_at: 3, eviction_confirmed: true, agent_kind: "claude" as const,
      }), log: () => {},
    });
    expect(loadLineConfig(paths)).toMatchObject({
      org: "acme", handle: "alice", token: "candidate-" + "t".repeat(40), agent_kind: "claude",
    });
  });

  it("recovers a caller-only line as caller-only, not silently callable, when config.json is gone (regression #346)", async () => {
    // The other half of #346: a relay-reported null must not turn into a
    // fabricated agent_kind either. Absence in LineConfig, not a null value,
    // is what the rest of the CLI already treats as "caller-only."
    const { paths } = fixtureNoConfig();
    const generated = ["candidate-" + "t".repeat(40), "successor-" + "s".repeat(40), "E".repeat(22)];
    const current = "current-" + "c".repeat(40);
    await runRecoveryRedeem({
      name: "main", paths, org: "acme", handle: "bob", relay: "https://relay.test", generation: 1,
    }, {
      randomSecret: () => generated.shift()!, displaySecret: () => {},
      ask: async (question) => question.includes("SAVED") ? "SAVED" : current,
      redeem: async (_relay, request) => ({
        org: "acme", handle: "bob", operation_id: request.operation_id,
        consumed_generation: 1, recovery_generation: 2,
        client_public_id: request.client_public_id,
        recovery_public_id: request.successor_recovery_public_id,
        committed_at: 3, eviction_confirmed: true, agent_kind: null,
      }), log: () => {},
    });
    const recovered = loadLineConfig(paths);
    expect(recovered.agent_kind).toBeUndefined();
    expect(recovered).toMatchObject({ org: "acme", handle: "bob", token: "candidate-" + "t".repeat(40) });
  });

  it("rejects a pending file whose operation_id is in-length but out-of-charset, without contacting the relay", async () => {
    const { paths, config } = fixture();
    writeFileSync(paths.recoveryPendingFile, JSON.stringify({
      org: "acme", handle: "alice", relay: "https://relay.test", generation: 1,
      operation_id: "invalid.op.id.with.dots", // 24 chars: in-bounds, but "." is outside RECOVERY_OPERATION_ID_RE
      candidate_token: "candidate-" + "t".repeat(40),
      candidate_token_digest: "a".repeat(64),
      client_public_id: "act_" + "a".repeat(16),
      successor_recovery_digest: "b".repeat(64),
      successor_recovery_public_id: "agr_" + "b".repeat(16),
    }));
    await expect(runRecoveryRedeem({ name: "main", paths, config, resume: true }, {
      ask: async () => { throw new Error("must reject before prompting"); },
      redeem: async () => { throw new Error("must not contact relay"); }, log: () => {},
    })).rejects.toThrow(/corrupt/);
  });

  it("refuses to resume a pending operation from a different relay", async () => {
    const { paths, config } = fixture();
    const generated = ["candidate-" + "t".repeat(40), "successor-" + "s".repeat(40), "C".repeat(22)];
    await expect(runRecoveryRedeem({ name: "main", paths, config, generation: 1 }, {
      randomSecret: () => generated.shift()!, displaySecret: () => {},
      ask: async (question) => question.includes("SAVED") ? "SAVED" : "current-" + "c".repeat(40),
      redeem: async () => { throw new Error("response lost"); }, log: () => {},
    })).rejects.toThrow("response lost");
    saveLineConfig(paths, { ...config, relay: "https://other-relay.test" });

    await expect(runRecoveryRedeem({ name: "main", paths, config, resume: true }, {
      ask: async () => { throw new Error("must reject before prompting"); },
      redeem: async () => { throw new Error("must not contact relay"); }, log: () => {},
    })).rejects.toThrow(/different recovery target/);
  });
});
