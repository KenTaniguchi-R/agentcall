// Direct unit tests for the stages extracted from listener.ts's WebSocket
// message handler (issue #283). Each stage is reachable here without a
// WebSocketServer round trip — that reachability is the entire point of the
// extraction. listener.test.ts still owns the end-to-end wire-level coverage
// (accepted -> started -> result, audit log shape, etc.); these tests cover
// the crypto and admission logic in isolation.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HPKE_SUITE, RELAY_CALL_TIMEOUT_MS, keyIdFor, requestTranscript, transcriptHash,
  type E2EEResponsePayloadType, type EncryptionKeyRecordType,
} from "@benree/agentcall-shared";
import { generateIdentityKeys, type StoredKeys } from "../src/keys.js";
import { sealE2EERequest } from "../src/e2ee.js";
import { getLinePaths, getMachinePaths, type LinePaths, type MachinePaths } from "../src/paths.js";
import { saveContexts, type ContextBinding } from "../src/contexts.js";
import { ReplayDetectedError } from "../src/replay-store.js";
import {
  admitBinding, handleCancel, makeOutcomeSender, openInboundEnvelope, resolveAdmission,
} from "../src/listener-stages.js";
import { tempLine, tempMachine } from "./helpers.js";

let cryptoRoot: string;
let callerKeys: StoredKeys;
let listenerKeys: StoredKeys;

beforeAll(async () => {
  cryptoRoot = mkdtempSync(join(tmpdir(), "agentcall-listener-stages-crypto-"));
  const machine = getMachinePaths(cryptoRoot, cryptoRoot);
  callerKeys = await generateIdentityKeys(getLinePaths(machine, "caller"));
  listenerKeys = await generateIdentityKeys(getLinePaths(machine, "listener"));
});
afterAll(() => rmSync(cryptoRoot, { recursive: true, force: true }));

// Mirrors tempMachine/tempLine in helpers.ts, which were modeled on this file
// and listener.test.ts's own freshMachine/seededPaths; using them directly
// here (rather than keeping a local copy) is what gives every temp dir this
// file creates its auto-teardown.
function freshMachine(): MachinePaths {
  return tempMachine("agentcall-stages-");
}
function seededPaths(): LinePaths {
  return tempLine("claude", "agentcall-stages-");
}
function seedPolicy(paths: LinePaths, policy: object) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.policyFile, JSON.stringify(policy));
}
function seedTask(paths: LinePaths, id: string, frontmatter: string[], body = "do it\n") {
  const dir = join(paths.tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", body].join("\n"));
}

async function callerBundleFor(handle: string) {
  const record: EncryptionKeyRecordType = {
    v: 2, relay_origin: `${handle}@127.0.0.1`.slice(`${handle}@127.0.0.1`.indexOf("@") + 1), address: `${handle}@127.0.0.1`, key_id: await keyIdFor(callerKeys.encryption_pub),
    suite: HPKE_SUITE, pub: callerKeys.encryption_pub, epoch: callerKeys.epoch,
    not_before: 1, not_after: Date.now() + RELAY_CALL_TIMEOUT_MS, prev: null,
  };
  return {
    identity: { v: 2 as const, relay_origin: `${handle}@127.0.0.1`.slice(`${handle}@127.0.0.1`.indexOf("@") + 1), address: `${handle}@127.0.0.1`, identity_pub: callerKeys.identity_pub },
    encryption: { record, signature: "unused" },
  };
}

function fakePeer(address: string) {
  return {
    relay_origin: "relay.test",
    address, identity_pub: callerKeys.identity_pub, fingerprint: `SHA256:${"a".repeat(32)}`,
    first_seen_at: 1, highest_encryption_epoch: callerKeys.epoch, call_count: 1,
  };
}

async function buildEnvelope(opts: { from: string; to: string; message: string }) {
  const issuedAt = Date.now();
  const request = {
    v: 1 as const, direction: "request" as const, relay_origin: "127.0.0.1",
    from: `@acme/${opts.from}`, to: `@acme/${opts.to}`,
    request_id: crypto.randomUUID().replaceAll("-", ""),
    sender_identity_key_id: await keyIdFor(callerKeys.identity_pub),
    recipient_encryption_key_id: await keyIdFor(listenerKeys.encryption_pub),
    recipient_epoch: listenerKeys.epoch, issued_at: issuedAt,
    expires_at: issuedAt + RELAY_CALL_TIMEOUT_MS, message: opts.message,
  };
  const envelope = await sealE2EERequest(request, callerKeys, {
    pub: listenerKeys.encryption_pub, key_id: request.recipient_encryption_key_id, epoch: listenerKeys.epoch,
  });
  return { request, envelope };
}

describe("handleCancel", () => {
  it("confirms cancellation of a pending call", () => {
    const sent: unknown[] = [];
    handleCancel({ call_id: "c1" }, { cancel: () => "pending" }, (obj) => sent.push(obj));
    expect(sent).toEqual([{ type: "call_cancelled", call_id: "c1", phase: "pending" }]);
  });

  it("reports an unknown call as not cancelled", () => {
    const sent: unknown[] = [];
    handleCancel({ call_id: "c2" }, { cancel: () => "unknown" }, (obj) => sent.push(obj));
    expect(sent).toEqual([{ type: "call_not_cancelled", call_id: "c2", reason: "unknown" }]);
  });

  // A running job is only signalled (via AbortController, inside SerialQueue
  // itself) — its own catch path sends call_cancelled once runAgent settles.
  // Confirming here would be premature: the process is not gone yet.
  it("sends nothing for a running call", () => {
    const sent: unknown[] = [];
    handleCancel({ call_id: "c3" }, { cancel: () => "running" }, (obj) => sent.push(obj));
    expect(sent).toEqual([]);
  });
});

describe("openInboundEnvelope", () => {
  it("fetches keys, pins the peer, decrypts, and reserves the request against replay", async () => {
    const { envelope } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const bundle = await callerBundleFor("shusaku");
    const machine = freshMachine();
    const paths = getLinePaths(machine, "claude");
    let reserved: unknown;
    const result = await openInboundEnvelope(
      { relay: "http://127.0.0.1:9", org: "acme", handle: "ken", token: "tok", machine, paths, from: "shusaku", envelope },
      {
        fetchKeys: async () => bundle,
        verifyAndPinPeer: async (_m, address) => fakePeer(address),
        loadKeys: () => listenerKeys,
        reserveReplay: async (_m, reservation) => { reserved = reservation; return reservation; },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.envelope.request.message).toBe("hi");
    expect(result.envelope.relayOrigin).toBe("127.0.0.1");
    expect(result.envelope.fromAddress).toBe("@acme/shusaku");
    expect(result.envelope.toAddress).toBe("@acme/ken");
    expect(reserved).toMatchObject({ sender_fingerprint: `SHA256:${"a".repeat(32)}` });
  });

  it("fails closed when fetching the caller's keys throws, without pinning or reserving anything", async () => {
    const { envelope } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const machine = freshMachine();
    const paths = getLinePaths(machine, "claude");
    const result = await openInboundEnvelope(
      { relay: "http://127.0.0.1:9", org: "acme", handle: "ken", token: "tok", machine, paths, from: "shusaku", envelope },
      {
        fetchKeys: async () => { throw new Error("relay unreachable"); },
        verifyAndPinPeer: async () => { throw new Error("must not be called"); },
        loadKeys: () => listenerKeys,
        reserveReplay: async () => { throw new Error("must not be called"); },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(String(result.error)).toMatch(/relay unreachable/);
  });

  it("surfaces a replay rejection as ok:false rather than throwing", async () => {
    const { envelope } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const bundle = await callerBundleFor("shusaku");
    const machine = freshMachine();
    const paths = getLinePaths(machine, "claude");
    const result = await openInboundEnvelope(
      { relay: "http://127.0.0.1:9", org: "acme", handle: "ken", token: "tok", machine, paths, from: "shusaku", envelope },
      {
        fetchKeys: async () => bundle,
        verifyAndPinPeer: async (_m, address) => fakePeer(address),
        loadKeys: () => listenerKeys,
        reserveReplay: async () => { throw new ReplayDetectedError(); },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeInstanceOf(ReplayDetectedError);
  });

  it("fails closed when the envelope cannot be decrypted with the local keys", async () => {
    const { envelope } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const bundle = await callerBundleFor("shusaku");
    const machine = freshMachine();
    const paths = getLinePaths(machine, "claude");
    // Sealed for listenerKeys but opened with a different line's keys: the
    // envelope's key_id will not match the expected route.
    const wrongKeys = await generateIdentityKeys(getLinePaths(machine, "wrong"));
    const result = await openInboundEnvelope(
      { relay: "http://127.0.0.1:9", org: "acme", handle: "ken", token: "tok", machine, paths, from: "shusaku", envelope },
      {
        fetchKeys: async () => bundle,
        verifyAndPinPeer: async (_m, address) => fakePeer(address),
        loadKeys: () => wrongKeys,
        reserveReplay: async (_m, r) => r,
      },
    );
    expect(result.ok).toBe(false);
  });
});

describe("makeOutcomeSender", () => {
  it("seals and sends a reply outcome bound to the request transcript", async () => {
    const { request } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const bundle = await callerBundleFor("shusaku");
    const sent: unknown[] = [];
    let sealedPayload: E2EEResponsePayloadType | undefined;
    const trySendOutcome = makeOutcomeSender(
      {
        callId: "c1", relayOrigin: "127.0.0.1", fromAddress: "@acme/shusaku", toAddress: "@acme/ken",
        request, requestHash: await transcriptHash(requestTranscript(request)),
        localKeys: listenerKeys, callerBundle: bundle, send: (obj) => sent.push(obj),
      },
      async (payload) => { sealedPayload = payload; return { fake: "envelope" } as never; },
    );
    const err = await trySendOutcome({ kind: "reply", text: "the answer" });
    expect(err).toBeUndefined();
    expect(sent).toEqual([{
      type: "call_outcome", call_id: "c1", terminal: "completed", envelope: { fake: "envelope" },
    }]);
    expect(sealedPayload?.outcome).toEqual({ kind: "reply", text: "the answer" });
    expect(sealedPayload?.request_id).toBe(request.request_id);
    expect(sealedPayload?.recipient_encryption_key_id).toBe(bundle.encryption.record.key_id);
  });

  it("marks a failure outcome terminal: failed", async () => {
    const { request } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const bundle = await callerBundleFor("shusaku");
    const sent: unknown[] = [];
    const trySendOutcome = makeOutcomeSender(
      {
        callId: "c1", relayOrigin: "127.0.0.1", fromAddress: "@acme/shusaku", toAddress: "@acme/ken",
        request, requestHash: await transcriptHash(requestTranscript(request)),
        localKeys: listenerKeys, callerBundle: bundle, send: (obj) => sent.push(obj),
      },
      async () => ({ fake: "envelope" } as never),
    );
    await trySendOutcome({ kind: "failure", code: "busy" });
    expect(sent).toEqual([{ type: "call_outcome", call_id: "c1", terminal: "failed", envelope: { fake: "envelope" } }]);
  });

  it("returns the error detail and logs it, without sending, when sealing throws", async () => {
    const { request } = await buildEnvelope({ from: "shusaku", to: "ken", message: "hi" });
    const bundle = await callerBundleFor("shusaku");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sent: unknown[] = [];
      const trySendOutcome = makeOutcomeSender(
        {
          callId: "c1", relayOrigin: "127.0.0.1", fromAddress: "@acme/shusaku", toAddress: "@acme/ken",
          request, requestHash: await transcriptHash(requestTranscript(request)),
          localKeys: listenerKeys, callerBundle: bundle, send: (obj) => sent.push(obj),
        },
        async () => { throw new Error("response key expired before sealing"); },
      );
      const err = await trySendOutcome({ kind: "failure", code: "busy" });
      expect(err).toMatch(/response key expired/);
      expect(sent).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/could not seal outcome.*c1.*response key expired/i));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("resolveAdmission", () => {
  const workdir = { dir: "/tmp/default-workdir", confined: true };

  it("admits the default ask task for a caller with no policy configured", () => {
    const result = resolveAdmission({
      paths: seededPaths(), from: "shusaku", requestedTask: undefined, groups: [], workdir, agentKind: "claude",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.task.id).toBe("ask");
    expect(result.taskWorkdir).toEqual({ dir: "/tmp/default-workdir", confined: true });
  });

  it("never claims confinement for codex, even in the confined default workdir", () => {
    const result = resolveAdmission({
      paths: seededPaths(), from: "shusaku", requestedTask: undefined, groups: [], workdir, agentKind: "codex",
    });
    expect(result.ok && result.taskWorkdir.confined).toBe(false);
  });

  it("blocks a caller policy has denied, offering nothing", () => {
    const paths = seededPaths();
    seedPolicy(paths, { default_offer: ["ask"], callers: { spammer: { block: true } } });
    const result = resolveAdmission({
      paths, from: "spammer", requestedTask: undefined, groups: [], workdir, agentKind: "claude",
    });
    expect(result).toEqual({ ok: false, code: "blocked", offered: [] });
  });

  it("rejects a requested task that does not exist on disk", () => {
    const result = resolveAdmission({
      paths: seededPaths(), from: "shusaku", requestedTask: "no-such-task", groups: [], workdir, agentKind: "claude",
    });
    expect(result).toMatchObject({ ok: false, code: "task_unknown" });
  });

  it("rejects a real task the caller was never offered", () => {
    const paths = seededPaths();
    seedTask(paths, "secret", ["description: shh"]);
    seedPolicy(paths, { default_offer: ["ask"], callers: {} });
    const result = resolveAdmission({
      paths, from: "shusaku", requestedTask: "secret", groups: [], workdir, agentKind: "claude",
    });
    expect(result).toMatchObject({ ok: false, code: "task_not_offered" });
  });

  it("fails closed with policy_error, not a thrown exception, when the policy file is corrupt", () => {
    const paths = seededPaths();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.policyFile, "{not valid json");
    const result = resolveAdmission({
      paths, from: "shusaku", requestedTask: undefined, groups: [], workdir, agentKind: "claude",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== "policy_error") throw new Error("expected a policy_error failure");
    expect(result.error).toBeDefined();
  });
});

describe("admitBinding", () => {
  // 22 base64url characters, so it satisfies CONTEXT_ID_RE and survives
  // loadContexts' schema parse.
  const SEEDED_CTX = "ctx_AAAAAAAAAAAAAAAAAAAAAA";

  function seedBinding(paths: LinePaths, over: Partial<ContextBinding> = {}) {
    const binding: ContextBinding = {
      context_id: SEEDED_CTX, agent_session_id: "real-agent-session", caller: "shusaku", task: "ask",
      agent_kind: "claude", workdir: paths.shareDir, turns: 1, created_at: Date.now(), last_used_at: Date.now(),
      ...over,
    };
    saveContexts(paths, [binding]);
  }

  it("admits a fresh call with no context_id, minting nothing itself", () => {
    const paths = seededPaths();
    const result = admitBinding({
      paths, from: "shusaku", taskId: "ask", contextId: undefined,
      threadable: true, agentKind: "claude", codexCanThread: false, workdirDir: paths.shareDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding).toBeUndefined();
    expect(result.threadingAvailable).toBe(true);
  });

  it("resumes a binding that matches caller, task, agent_kind, and workdir", () => {
    const paths = seededPaths();
    seedBinding(paths);
    const result = admitBinding({
      paths, from: "shusaku", taskId: "ask", contextId: SEEDED_CTX,
      threadable: true, agentKind: "claude", codexCanThread: false, workdirDir: paths.shareDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.binding?.agent_session_id).toBe("real-agent-session");
  });

  it("refuses an unknown context_id", () => {
    const paths = seededPaths();
    const result = admitBinding({
      paths, from: "shusaku", taskId: "ask", contextId: SEEDED_CTX,
      threadable: true, agentKind: "claude", codexCanThread: false, workdirDir: paths.shareDir,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a binding whose caller does not match — indistinguishable from context_unknown", () => {
    const paths = seededPaths();
    seedBinding(paths, { caller: "someone-else" });
    const result = admitBinding({
      paths, from: "shusaku", taskId: "ask", contextId: SEEDED_CTX,
      threadable: true, agentKind: "claude", codexCanThread: false, workdirDir: paths.shareDir,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses to resume once the task has withdrawn threading, even with a matching binding", () => {
    const paths = seededPaths();
    seedBinding(paths);
    const result = admitBinding({
      paths, from: "shusaku", taskId: "ask", contextId: SEEDED_CTX,
      threadable: false, agentKind: "claude", codexCanThread: false, workdirDir: paths.shareDir,
    });
    expect(result.ok).toBe(false);
    expect(result.threadingAvailable).toBe(false);
  });

  it("refuses to resume a codex binding once codex threading evidence is withdrawn", () => {
    const paths = seededPaths();
    seedBinding(paths, { agent_kind: "codex" });
    const result = admitBinding({
      paths, from: "shusaku", taskId: "ask", contextId: SEEDED_CTX,
      threadable: true, agentKind: "codex", codexCanThread: false, workdirDir: paths.shareDir,
    });
    expect(result.ok).toBe(false);
  });
});
