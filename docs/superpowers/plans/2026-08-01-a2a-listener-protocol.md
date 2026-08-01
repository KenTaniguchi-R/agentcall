# A2A Listener Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the callee side observably cancellable — the listener reports acceptance and start separately, and cancels a running agent only after the process is confirmed exited.

**Architecture:** Three new listener→relay frames and one relay→listener frame in the shared protocol; `runAgent` gains an `AbortSignal` and rejects with a `canceled` code from its existing `exit` handler; `SerialQueue` gains job identity so a job can be cancelled by `call_id`. Nothing in the relay changes — this plan makes the listener *capable* of the protocol the task store will speak in Plan 2b.

**Tech Stack:** TypeScript (ESM, NodeNext), zod, vitest, Node `child_process` with detached process groups.

**Spec:** [2026-08-01-a2a-task-store-design.md](../specs/2026-08-01-a2a-task-store-design.md)

## Plan decomposition

This spec is too large for one plan. Five sequential sub-plans, each producing working, testable software:

| # | Plan | Delivers |
|---|---|---|
| **2a** | **Listener protocol (this plan)** | new frames, abortable `runAgent`, keyed queue, `maxPending: 0` |
| 2b | Task store | DO SQLite schema, transitions, `dispatch_state`, idempotency, alarms/retention |
| 2c | A2A operations | `message:send`, `GetTask`, `ListTasks`, `CancelTask`, `GetExtendedAgentCard` |
| 2d | SSE | `message:stream`, `tasks/{id}:subscribe`, snapshot-first sequencing, backpressure |
| 2e | CLI cutover | CLI as A2A client, port invariant checklist, delete WSS caller path, TCK baseline, cost spike |

## Global Constraints

- **Protocol types live in `packages/shared`.** Never redefine a frame shape in `apps/relay` or `packages/cli` — import from `@benree/agentcall-shared`.
- **`maxPending: 0`.** The listener refuses a new call while one is running. Decided in the spec: with a 300s agent timeout against a 360s deadline measured from submission, any pending slot hands its occupant a truncated execution budget.
- **Cancellation is acknowledged only after the process is observed exited** — never when the signal is sent. Delivery is not cancellation.
- **`runAgent` settles on `exit`, not `close`**, and that must not change. A grandchild holding the stdout pipe open would hang the promise forever on `close`.
- ESM/NodeNext: relative imports carry the `.js` extension.
- Stage files explicitly (`git add <file> <file>`). Never `git add -A`.
- Test-first: write the failing test, watch it fail, then implement.
- `packages/cli` compiles against the **built** `packages/shared`. Run `pnpm -r build` after changing shared before typechecking or testing the CLI.

## Deliberately NOT in this plan

- **Policy re-check when a job starts.** The spec called for it, but it existed to close a staleness window created by queue wait. With `maxPending: 0` there is no wait — `resolveTask` already runs immediately before the job starts — so re-checking would be dead code. Recorded here so the omission is visible rather than looking like a miss.
- Any relay change. The relay still speaks `call_answer`; Plan 2b switches it.

---

### Task 1: Protocol frames

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/test/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CallAccepted` — `{ type: "call_accepted", call_id: string }`
  - `CallStarted` — `{ type: "call_started", call_id: string }`
  - `CancelCall` — `{ type: "cancel_call", call_id: string }`
  - `CallCancelled` — `{ type: "call_cancelled", call_id: string, phase: "pending" | "running" }`
  - `CallNotCancelled` — `{ type: "call_not_cancelled", call_id: string, reason: "already_terminal" | "unknown" | "too_late" }`
  - `ListenerToRelayFrame` gains `CallAccepted`, `CallStarted`, `CallCancelled`, `CallNotCancelled`
  - `RelayToListenerFrame` gains `CancelCall`
  - Types: `CallAcceptedType`, `CallStartedType`, `CancelCallType`, `CallCancelledType`, `CallNotCancelledType`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/protocol.test.ts`:

```ts
import {
  CallAccepted, CallStarted, CancelCall, CallCancelled, CallNotCancelled,
  ListenerToRelayFrame, RelayToListenerFrame,
} from "../src/index.js";

describe("cancellation and acknowledgement frames", () => {
  it("accepts the acknowledgement frames", () => {
    expect(CallAccepted.safeParse({ type: "call_accepted", call_id: "c1" }).success).toBe(true);
    expect(CallStarted.safeParse({ type: "call_started", call_id: "c1" }).success).toBe(true);
  });

  it("accepts cancel_call from the relay", () => {
    expect(CancelCall.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(true);
  });

  it("requires a phase on call_cancelled", () => {
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "running" }).success).toBe(true);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "pending" }).success).toBe(true);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1" }).success).toBe(false);
    expect(CallCancelled.safeParse({ type: "call_cancelled", call_id: "c1", phase: "elsewhere" }).success).toBe(false);
  });

  it("constrains call_not_cancelled reasons", () => {
    for (const reason of ["already_terminal", "unknown", "too_late"]) {
      expect(CallNotCancelled.safeParse({ type: "call_not_cancelled", call_id: "c1", reason }).success).toBe(true);
    }
    expect(CallNotCancelled.safeParse({ type: "call_not_cancelled", call_id: "c1", reason: "because" }).success).toBe(false);
  });

  it("routes the new frames through the right unions", () => {
    for (const f of [
      { type: "call_accepted", call_id: "c1" },
      { type: "call_started", call_id: "c1" },
      { type: "call_cancelled", call_id: "c1", phase: "running" },
      { type: "call_not_cancelled", call_id: "c1", reason: "too_late" },
    ]) {
      expect(ListenerToRelayFrame.safeParse(f).success, JSON.stringify(f)).toBe(true);
      expect(RelayToListenerFrame.safeParse(f).success, JSON.stringify(f)).toBe(false);
    }
    expect(RelayToListenerFrame.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(true);
    expect(ListenerToRelayFrame.safeParse({ type: "cancel_call", call_id: "c1" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/protocol.test.ts`
Expected: FAIL — `No "CallAccepted" export is defined on the module`

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/protocol.ts`, after the existing `CallFailed` definition, add:

```ts
// Acknowledgement splits in two because `call_answer` fired when the job
// STARTED, which left the relay unable to distinguish "frame never arrived"
// from "listener owns it but hasn't spawned yet". The task store needs that
// distinction to map SUBMITTED vs WORKING and to decide whether a cancel
// request must be negotiated with the listener at all.
export const CallAccepted = z.object({ type: z.literal("call_accepted"), call_id: z.string() });
export const CallStarted = z.object({ type: z.literal("call_started"), call_id: z.string() });

export const CancelCall = z.object({ type: z.literal("cancel_call"), call_id: z.string() });

// Sent ONLY after the pending closure was definitely removed, or the process
// group was observed exited. Acknowledging on signal-sent would let the relay
// publish a CANCELED task whose agent is still running on the callee's machine.
export const CallCancelled = z.object({
  type: z.literal("call_cancelled"),
  call_id: z.string(),
  phase: z.enum(["pending", "running"]),
});
export const CallNotCancelled = z.object({
  type: z.literal("call_not_cancelled"),
  call_id: z.string(),
  reason: z.enum(["already_terminal", "unknown", "too_late"]),
});
```

Then replace the two union declarations:

```ts
export const ListenerToRelayFrame = z.discriminatedUnion("type", [
  CallAnswer, CallResult, CallFailed,
  CallAccepted, CallStarted, CallCancelled, CallNotCancelled,
]);
export const RelayToListenerFrame = z.discriminatedUnion("type", [IncomingCall, CancelCall]);
```

And add the inferred types next to the existing ones:

```ts
export type CallAcceptedType = z.infer<typeof CallAccepted>;
export type CallStartedType = z.infer<typeof CallStarted>;
export type CancelCallType = z.infer<typeof CancelCall>;
export type CallCancelledType = z.infer<typeof CallCancelled>;
export type CallNotCancelledType = z.infer<typeof CallNotCancelled>;
```

`CallAnswer` stays for now — the relay still sends and expects it until Plan 2b. Do not delete it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm vitest run test/protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Build shared and verify the package**

Run: `cd packages/shared && pnpm test && pnpm typecheck && pnpm build`
Expected: all green. The build is required — `packages/cli` compiles against `dist`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/test/protocol.test.ts
git commit -m "feat(protocol): split listener acknowledgement and add cancellation frames"
```

---

### Task 2: Abortable `runAgent`

**Files:**
- Modify: `packages/cli/src/runner.ts`
- Test: `packages/cli/test/runner.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `runAgent(kind, prompt, workdir, timeoutMs?, specOverride?, envelope?, callId?, signal?: AbortSignal)` — rejects with `AgentRunError(message, "canceled")` when aborted. `AgentRunError`'s code union gains `"canceled"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/runner.test.ts`, inside the existing `runAgent (with a fake agent binary)` describe block:

This file builds spawn specs inline as object literals rather than via helpers — mirror that. Add these two local builders just inside the describe block, next to the existing inline specs:

```ts
// A child that never exits on its own, so only teardown can settle it.
const hangingSpec = () => ({
  cmd: "node", args: ["-e", "setInterval(() => {}, 1000)"], cwd: "/tmp", env: process.env,
});
// A child that prints one claude-shaped result and exits immediately.
const okSpec = (text: string) => ({
  cmd: "node",
  args: ["-e", `console.log(${JSON.stringify(JSON.stringify({ type: "result", result: text, session_id: "s" }))})`],
  cwd: "/tmp", env: process.env,
});
```

Then the tests:

```ts
it("rejects with canceled when the signal aborts", async () => {
  const ac = new AbortController();
  const p = runAgent("claude", "p", WORKDIR, 60_000, hangingSpec(), FULL_ACCESS_ENVELOPE, "c1", ac.signal);
  ac.abort();
  await expect(p).rejects.toMatchObject({ code: "canceled" });
});

it("only settles after the process has actually exited", async () => {
  const ac = new AbortController();
  const p = runAgent("claude", "p", WORKDIR, 60_000, hangingSpec(), FULL_ACCESS_ENVELOPE, "c1", ac.signal);
  let settled = false;
  void p.catch(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false);
  ac.abort();
  await p.catch(() => {});
  // Settling is driven by the child's `exit` event, so by the time the promise
  // rejects the spawned process is gone. That is what makes the listener's
  // cancellation acknowledgement honest.
  expect(settled).toBe(true);
});

it("ignores an abort that arrives after the agent already finished", async () => {
  const ac = new AbortController();
  const out = await runAgent("claude", "p", WORKDIR, 60_000, okSpec("done"), FULL_ACCESS_ENVELOPE, "c1", ac.signal);
  expect(out.text).toBe("done");
  ac.abort();                            // must not throw or produce an unhandled rejection
});
```

`WORKDIR` and `FULL_ACCESS_ENVELOPE` are already imported at the top of this file. Do not introduce a second fake-binary mechanism.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/runner.test.ts -t canceled`
Expected: FAIL — the promise never rejects, or `code` is not `"canceled"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/runner.ts`, extend `AgentRunError`'s code union to include `"canceled"` (find its declaration near the top of the file and add the member).

Then change the `runAgent` signature to accept a trailing signal:

```ts
export function runAgent(
  kind: AgentKind, prompt: string, workdir: string, timeoutMs: number = AGENT_TIMEOUT_MS, specOverride?: SpawnSpec,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown", signal?: AbortSignal,
): Promise<AgentOutput> {
```

Inside the promise, next to the existing `timedOut` flag, add `let canceled = false;`. After `escalate` is defined, wire the signal:

```ts
    // Cancellation reuses the existing teardown path: SIGTERM, grace, SIGKILL
    // against the whole process group. The promise still settles from the
    // `exit` handler below, which is what makes "cancelled" mean the process
    // is actually gone rather than that a signal was sent.
    const onAbort = () => {
      if (settled) return;
      canceled = true;
      escalate();
    };
    if (signal) {
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
```

In the `exit` handler, check `canceled` **before** `timedOut` — an abort that races the timeout should report as a cancellation:

```ts
      if (canceled) return reject(new AgentRunError("canceled", "canceled"));
      if (timedOut) return reject(new AgentRunError(`agent timed out after ${timeoutMs}ms`, "timeout"));
```

Finally, remove the listener in both settle paths so an abort after completion is inert. In the `error` and `exit` handlers, alongside the existing `clearTimeout` calls, add:

```ts
      if (signal) signal.removeEventListener("abort", onAbort);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/runner.test.ts`
Expected: PASS, including the pre-existing timeout and process-group tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runner.ts packages/cli/test/runner.test.ts
git commit -m "feat(runner): cancel a running agent, settling only on observed exit"
```

---

### Task 3: Keyed, cancellable queue

**Files:**
- Modify: `packages/cli/src/queue.ts`
- Test: `packages/cli/test/queue.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SerialQueue` constructor unchanged: `new SerialQueue(maxPending: number)`
  - `tryEnqueue(key: string, job: (signal: AbortSignal) => Promise<void>): boolean` — **signature changed**: jobs are keyed and receive a signal
  - `cancel(key: string): "pending" | "running" | "unknown"` — removes a pending job or aborts a running one
  - `pending`, `running`, `onIdle()` unchanged

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue.js";

const never = () => new Promise<void>(() => {});

describe("SerialQueue keyed cancellation", () => {
  it("reports unknown for a key it never saw", () => {
    expect(new SerialQueue(1).cancel("nope")).toBe("unknown");
  });

  it("removes a pending job without ever running it", async () => {
    const q = new SerialQueue(1);
    let secondRan = false;
    q.tryEnqueue("a", never);
    q.tryEnqueue("b", async () => { secondRan = true; });
    expect(q.cancel("b")).toBe("pending");
    await new Promise((r) => setTimeout(r, 10));
    expect(secondRan).toBe(false);
  });

  it("aborts a running job through its signal", async () => {
    const q = new SerialQueue(1);
    let aborted = false;
    q.tryEnqueue("a", (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      }));
    await new Promise((r) => setTimeout(r, 5));
    expect(q.cancel("a")).toBe("running");
    await q.onIdle();
    expect(aborted).toBe(true);
  });

  it("reports unknown once a job has finished", async () => {
    const q = new SerialQueue(1);
    q.tryEnqueue("a", async () => {});
    await q.onIdle();
    expect(q.cancel("a")).toBe("unknown");
  });

  it("refuses a second job when maxPending is 0", () => {
    const q = new SerialQueue(0);
    expect(q.tryEnqueue("a", never)).toBe(true);
    expect(q.tryEnqueue("b", never)).toBe(false);
  });

  it("still drains in order when capacity allows", async () => {
    const q = new SerialQueue(5);
    const order: string[] = [];
    for (const k of ["a", "b", "c"]) q.tryEnqueue(k, async () => { order.push(k); });
    await q.onIdle();
    expect(order).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/queue.test.ts`
Expected: FAIL — `q.cancel is not a function`.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `packages/cli/src/queue.ts`:

```ts
type Job = { key: string; run: (signal: AbortSignal) => Promise<void> };

export class SerialQueue {
  private jobs: Job[] = [];
  private active = false;
  private idleResolvers: Array<() => void> = [];
  private runningKey: string | undefined;
  private runningAbort: AbortController | undefined;

  constructor(private maxPending: number) {}

  get pending(): number { return this.jobs.length; }
  get running(): boolean { return this.active; }

  tryEnqueue(key: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.active && this.jobs.length >= this.maxPending) return false;
    this.jobs.push({ key, run });
    void this.drain();
    return true;
  }

  /**
   * Pending jobs are dropped outright — they never spawned, so there is
   * nothing to confirm. A running job is only *signalled* here; the caller
   * must wait for the job's own promise to settle before telling anyone the
   * work is cancelled, because the process is not gone until then.
   */
  cancel(key: string): "pending" | "running" | "unknown" {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i >= 0) { this.jobs.splice(i, 1); return "pending"; }
    if (this.runningKey === key) { this.runningAbort?.abort(); return "running"; }
    return "unknown";
  }

  onIdle(): Promise<void> {
    if (!this.active && this.jobs.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.runningKey = job.key;
      this.runningAbort = new AbortController();
      try { await job.run(this.runningAbort.signal); } catch { /* job errors are the job's problem */ }
      this.runningKey = undefined;
      this.runningAbort = undefined;
    }
    this.active = false;
    for (const r of this.idleResolvers.splice(0)) r();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/queue.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/queue.ts packages/cli/test/queue.test.ts
git commit -m "feat(queue): key jobs so a call can be cancelled by id"
```

---

### Task 4: Listener wiring

**Files:**
- Modify: `packages/cli/src/listener.ts`
- Test: `packages/cli/test/listener.test.ts`

**Interfaces:**
- Consumes: Task 1's frames, Task 2's `signal` parameter, Task 3's `tryEnqueue(key, job)` / `cancel(key)`.
- Produces: a listener that emits `call_accepted` on admission and `call_started` on spawn, handles `cancel_call`, and defaults to `maxPending: 0`.

- [ ] **Step 1: Write the failing test**

This file already provides `fakeRelay(onConn)` (returns a relay URL and hands you the server-side socket), `frames(ws, n)` (collects the next n frames the listener sends), `cfg`, `seedPolicy`, and `seedTask`. Use them; inject a fake agent via `deps.run` rather than spawning anything.

```ts
it("emits call_accepted before call_started", async () => {
  let sock!: WsSocket;
  const relay = await fakeRelay((ws) => { sock = ws; });
  const stop = startListener({
    ...baseDeps(relay),
    run: async () => ({ text: "ok", session_id: "s" }),
  });
  const got = frames(sock, 3);
  sock.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "amy", message: "hi" }));
  const types = (await got).map((f) => f.type);
  expect(types).toEqual(["call_accepted", "call_started", "call_result"]);
  stop();
});

it("refuses a second concurrent call because maxPending is 0", async () => {
  let sock!: WsSocket;
  const relay = await fakeRelay((ws) => { sock = ws; });
  const stop = startListener({
    ...baseDeps(relay),
    run: () => new Promise(() => {}),      // first call never finishes
  });
  const got = frames(sock, 3);
  sock.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "amy", message: "hi" }));
  sock.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "amy", message: "hi" }));
  const all = await got;
  expect(all.filter((f) => f.type === "call_failed" && f.code === "busy")).toHaveLength(1);
  stop();
});

it("acknowledges cancellation of a running call only after the agent exits", async () => {
  let sock!: WsSocket;
  let exited = false;
  const relay = await fakeRelay((ws) => { sock = ws; });
  const stop = startListener({
    ...baseDeps(relay),
    // Mirrors runAgent: settles only once teardown completes.
    run: (_k, _p, _w, _t, _s, _e, _c, signal?: AbortSignal) =>
      new Promise((_res, rej) => {
        signal?.addEventListener("abort", () => {
          setTimeout(() => { exited = true; rej(new AgentRunError("canceled", "canceled")); }, 10);
        }, { once: true });
      }),
  });
  const got = frames(sock, 3);
  sock.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "amy", message: "hi" }));
  await new Promise((r) => setTimeout(r, 20));
  sock.send(JSON.stringify({ type: "cancel_call", call_id: "c1" }));
  const all = await got;
  expect(all.find((f) => f.type === "call_cancelled")).toMatchObject({ phase: "running" });
  expect(exited).toBe(true);
  stop();
});

it("reports call_not_cancelled for an unknown call id", async () => {
  let sock!: WsSocket;
  const relay = await fakeRelay((ws) => { sock = ws; });
  const stop = startListener(baseDeps(relay));
  const got = frames(sock, 1);
  sock.send(JSON.stringify({ type: "cancel_call", call_id: "no-such-call" }));
  expect((await got)[0]).toMatchObject({ type: "call_not_cancelled", reason: "unknown" });
  stop();
});
```

Add one local helper next to the existing ones, matching however the existing tests assemble listener dependencies (config, paths, seeded policy and task) — extract it from whatever the first existing call-flow test in this file already does, so there is exactly one way to build deps:

```ts
function baseDeps(relay: string) {
  // Same shape the existing call-flow tests build: cfg, a tmp paths root with
  // seedPolicy/seedTask already applied, and the relay URL under test.
  return { config: { ...cfg, relay }, paths: seededPaths(), relay };
}
```

If the existing tests build deps inline rather than through a `seededPaths()` helper, hoist that inline setup into `baseDeps` and update those tests to call it — one construction path, not two.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/listener.test.ts`
Expected: FAIL — no `call_accepted` frame is ever sent.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/listener.ts`:

Change the queue construction (currently line 30) to default to zero:

```ts
  const queue = new SerialQueue(deps.maxPending ?? 0);
```

Handle the new inbound frame at the top of the `ws.on("message")` body, right after the `safeParseFrame` guard and before destructuring `call_id, from, message`:

```ts
      if (frame.type === "cancel_call") {
        const outcome = queue.cancel(frame.call_id);
        // A pending job never spawned, so removal IS the confirmation. A
        // running job is only signalled here — its own catch path sends
        // call_cancelled once runAgent settles, which happens on the child's
        // exit event.
        if (outcome === "pending") {
          send({ type: "call_cancelled", call_id: frame.call_id, phase: "pending" });
        } else if (outcome === "unknown") {
          send({ type: "call_not_cancelled", call_id: frame.call_id, reason: "unknown" });
        }
        return;
      }
```

`send` is currently declared inside the per-call scope. Hoist it above this block so the cancel branch can use it:

```ts
      const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };
```

and delete the later duplicate declaration.

Change the enqueue call to pass the key and accept the signal, and replace `call_answer` with the two new frames:

```ts
      const accepted = queue.tryEnqueue(call_id, async (signal) => {
        send({ type: "call_started", call_id });
        try {
          const out = await run(
            deps.config.agent_kind,
            buildPrompt(deps.config.handle, from, message, task, workdir),
            workdir.dir,
            timeoutMs,
            undefined,
            task.envelope,
            call_id,
            signal,
          );
          send({ type: "call_result", call_id, text: out.text, session_id: out.session_id, task: task.id });
          audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "ok", duration_ms: Date.now() - started });
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : "agent_error";
          // runAgent settles from the child's exit handler, so reaching here
          // with "canceled" means the process group is actually gone.
          if (code === "canceled") {
            send({ type: "call_cancelled", call_id, phase: "running" });
            audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "canceled", duration_ms: Date.now() - started });
            return;
          }
          send({ type: "call_failed", call_id, code, detail: "The agent hit an internal error while answering." });
          audit({
            call_id, from, message: message.slice(0, 500), task: task.id, status: code,
            duration_ms: Date.now() - started, error: String(e).slice(0, 2000),
          });
        }
      });
```

Immediately after that `tryEnqueue` call, before the existing busy handling, emit acceptance:

```ts
      if (accepted) send({ type: "call_accepted", call_id });
```

Leave the existing `if (!accepted) send({ type: "call_failed", ..., code: "busy" })` branch as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/listener.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole CLI package**

Run: `cd packages/cli && pnpm test`
Expected: all green. Existing tests that assert `call_answer` will need updating to `call_started` — update the assertion, do not reintroduce the frame.

- [ ] **Step 6: Full repo verification**

Run from the repo root: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all green. Per CLAUDE.md this is required before the task is done, and `pnpm -r test` is the only thing that catches stale call sites in `test/`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/listener.ts packages/cli/test/listener.test.ts
git commit -m "feat(listener): report acceptance and start separately, and cancel on request"
```

---

## Out of scope for this plan

- **Relay changes.** The relay still sends `incoming_call` and expects `call_answer`; it ignores the new frames until Plan 2b. The listener sending `call_started` instead of `call_answer` means the relay's `answered` status stops firing during the overlap — acceptable because there are zero live installs and Plan 2b follows immediately.
- Task store, A2A operations, SSE, CLI cutover, TCK baseline, cost spike — Plans 2b–2e.
- Policy re-check at job start — see *Deliberately NOT in this plan*.
