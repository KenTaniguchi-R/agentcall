# Capability, resource, and autonomy policy

> **Historical document — not current documentation.** This is a dated
> decision record that describes the intended replacement for the task-grant
> model as of 2026-08-02. It is deliberately *not* updated when behavior
> changes; [README.md](../../../README.md) remains the authority on current
> behavior.

**Date:** 2026-08-02

**Status:** Decided

**Issue:** [#192](https://github.com/KenTaniguchi-R/agentcall/issues/192)

## Decision

Named tasks cease to be AgentCall's authorization noun. They remain optional
workflow and instruction packages. A workflow may request authority, but only a
compiled policy decision can grant it.

Authorization is split into two deep modules:

1. A **sharing compiler** turns owner-friendly presets and exceptions into a
   versioned, explicit policy. Presets exist only at this authoring seam; changing
   a preset later never changes an already compiled share.
2. An **authorization kernel** evaluates one canonical request against one
   immutable policy snapshot. Relay admission, context loading, tool execution,
   approval/resume, and runtime limits are adapters at this seam. They do not
   implement their own precedence rules.

The kernel interface has three operations:

```ts
evaluate(request: AuthorizationRequest, policy: PolicySnapshot): Decision
explain(request: AuthorizationRequest, policy: PolicySnapshot): Explanation
assert(policy: PolicySnapshot, cases: readonly PolicyAssertion[]): AssertionReport
```

`evaluate` and `explain` use the same decision trace. `assert` calls the same
evaluator used in production. The implementation is pure, deterministic,
synchronous, and performs no I/O.

The sharing compiler has one operation:

```ts
compile(intent: ShareIntent, ceiling: AdminCeiling): CompileResult
```

Both interfaces consume closed canonical types. Their minimum shape is:

```ts
type Effect = "deny" | "approval" | "allow";
type Phase = "admission" | "context" | "action" | "resume" | "runtime";
type Subject = { organizationId: string; kind: "person" | "agent" | "group" | "role"; id: string };
type Resource = { organizationId: string; kind: ResourceKind; id: string; selector?: NormalizedSelector };
type CanonicalAction = {
  name: ActionName;
  normalizerName: string;
  schemaVersion: number;
  normalizedArguments: CanonicalJson;
  argumentsDigest: string;
};
type AuthorizationRequest = {
  organizationId: string;
  accountableOwner: Subject;
  agentEndpoint: Resource;
  currentAdminCeilingRevision: string;
  phase: Phase;
  caller: Subject;
  agent: Subject;
  attestedSubjects: readonly Subject[];
  resources: readonly Resource[];
  action: CanonicalAction;
  workflow?: Resource;
  approval?: ApprovalProof;
  reservation?: LimitReservationProof;
};
type PolicySnapshot = {
  organizationId: string;
  accountableOwner: Subject;
  agentEndpoint: Resource;
  revision: string;
  adminCeilingRevision: string;
  actionSchemas: readonly { action: ActionName; normalizerName: string; schemaVersion: number }[];
  grants: readonly ExplicitGrant[];
  assertions: readonly PolicyAssertion[];
};
type Decision =
  | { effect: "allow"; execution: { ready: true; obligations: Obligations } |
      { ready: false; reservation: LimitReservationChallenge }; trace: DecisionTrace }
  | { effect: "approval"; challenge: ApprovalChallenge; trace: DecisionTrace }
  | { effect: "deny"; code: DenialCode; trace: DecisionTrace };
```

`CompileResult` is either one validated immutable snapshot plus its source
intent, or a stable compile error; there is no partial output. `ShareIntent`
contains a resolved subject, preset, named resources, exclusions, action
overrides, and limits. A new resource or action shape requires a versioned
schema change and assertion fixtures; adapters cannot invent extra fields.
Evaluation requires exact request/snapshot endpoint equality and also denies
when the trusted current administrator-ceiling revision
differs from the snapshot. Request, snapshot, approval, and budget evidence all
bind the same accountable owner and agent endpoint.

## Canonical nouns

### Subject

A subject is a relay-verified in-organization identity. `organizationId` is
mandatory on the snapshot, every subject and resource, every approval
fingerprint, and every budget key:

- `person` or `agent`, identified by a stable identity rather than a handle;
- an attested `group` or organization `role` supplied by the relay; or
- the answering agent and accountable owner, carried separately from the caller.

Caller text, a requested workflow name, a handle supplied in tool arguments, and
model output are never identity evidence. Cross-organization subjects do not
exist; federation remains a standing non-goal. Evaluation denies unless every
organization id matches exactly. Group and role grants are additive only after
same-organization attestation.

### Resource

A resource is a typed, owner-named target with a stable id and normalized
selector. Initial kinds are `agent_endpoint`, `public_context`, `filesystem`, `repository`,
`github`, `saas_account`, `environment`, `dataset`, and `workflow`. A task is a
`workflow` resource evaluated with the separate `workflow.invoke` action.
Filesystem selectors carry a canonical root plus includes and excludes. Excludes and explicit denies
always win. Unknown kinds and ambiguous or failed normalization deny.

An `agent_endpoint` is one callable line, identified by its stable line/agent id
inside its organization. It is the resource targeted by `call.submit` at relay
admission and appears explicitly in grants, assertions, and explain output.

Private bytes are a resource too. They must be authorized before entering model
context. `context.load` or `data.read` means that exact resource is approved for
disclosure to that caller; otherwise it cannot enter the prompt. A direct reply
may contain only data from disclosure-approved resources, and every
tool-mediated outbound emission is evaluated separately.

Filesystem normalization resolves existing targets through symlinks. For a
create, it resolves the nearest existing ancestor and appends the unresolved
tail, applies platform case semantics conservatively, and rejects ambiguity.
Mutation uses the same resolved target handle where possible, otherwise it
re-resolves and re-evaluates immediately before execution to close rename and
symlink races.

### Action

Actions use a namespaced noun/verb rather than four coarse capabilities. The
initial vocabulary is:

- `call.submit`, `workflow.invoke`, `context.load`, `data.read`;
- `draft.create`, `file.write`, `process.execute`;
- `external.read`, `external.comment`, `external.publish`;
- `resource.delete`, `deploy.run`, and `agent.delegate`.

Every action has a versioned closed normalizer schema listing every
authorization-relevant native field: repository, branch, PR, ref, environment,
destination, destructive flags, delegated scope, and equivalents. It rejects
unknown or unrepresented native fields and serializes normalized arguments as
RFC 8785 canonical JSON before hashing. The normalizer name and version are in
policy, approvals, assertions, and audit evidence. `write` does not imply publish, merge, deploy, delete, or SaaS
administration. `process.execute` does not imply any of those actions either.
An action adapter that cannot normalize a tool call denies it.

### Autonomy

Autonomy is exactly `deny`, `approval`, or `allow`. It is evaluated per
subject/resource/action tuple; there is no global autonomy toggle. An explicit
deny outranks every grant. Approval is not a weak allow: it produces a challenge
for one exact normalized action.

### Limits

Limits are independently intersected ceilings: calls per window, rate, runtime,
cost, tool/action counts, and delegation depth. The most restrictive value wins.
Budget enforcement is two-pass so adapters never reproduce policy precedence.
After authority and approval checks, evaluation returns `effect: allow` with
`execution.ready: false` and a canonical reservation challenge containing every
applicable ceiling, organization, accountable owner, endpoint, subject,
resource, action, policy/admin revisions, and pessimistic estimates. An
organization-scoped budget port atomically reserves exactly that challenge and
returns an immutable reservation id and attested proof. Re-evaluation validates
the proof and only then returns `execution.ready: true`; adapters must never
execute a non-ready allow. Call/rate/action counts
are never refunded; cost/runtime may reconcile downward, while overruns trip the
hard ceiling. Leased reservations use bounded expiry and heartbeats. Port
failure, lost lease, or reconciliation failure denies further work. The kernel
evaluates the proof, never mutable “remaining” counters. A runtime hard
ceiling remains independent and may be narrower than application policy.

### Approval

An approval binds organization, accountable owner, agent endpoint, caller,
answering agent, resource ids, action,
normalizer name/version, canonical argument digest, policy revision, expiry, and
remaining use count. Resume reloads current policy, atomically consumes the approval, and
evaluates again. A stale policy, changed argument, exhausted use count, changed
resource, or storage failure denies. Broad approvals such as “allow GitHub” are
not representable.

## Composition and decision order

The effective authority is the intersection of:

```text
platform/admin ceiling
∩ owner grant
∩ authenticated caller and attested groups/roles
∩ answering-agent/runtime capability
∩ resource constraints
∩ remaining limits
− explicit denies
```

The fixed evaluation order is:

1. validate the policy snapshot and canonical request;
2. require relay-verified identity and a known resource;
3. apply platform/admin ceilings and explicit denies;
4. resolve exact subject, attested group/role, and owner grants;
5. intersect runtime capability, resource selectors, and limits;
6. validate exact approval when the result requires it; and
7. return `allow`, `approval`, or `deny` with a redacted ordered trace.

Malformed or unreadable policy, unavailable evaluator state, unverified
identity, unknown action/resource, normalization ambiguity, stale approval,
unavailable approval/budget storage, and unmatched rules all fail closed.
Stable denial codes name the class of failure without exposing unrelated policy
or private arguments.

## Enforcement adapters

| Phase | Adapter obligation |
|---|---|
| Relay admission | Authenticate caller and organization; attest groups/roles; reserve call/rate limits; evaluate `call.submit` against the answering line resource, managed ceiling, owner grants, and caller blocks before dispatch. |
| Pre-prompt context | Enumerate each private source and authorize it before loading any bytes. Denied sources never reach the model. |
| Pre-tool execution | Normalize the proposed tool, target resources, and important arguments; evaluate immediately before execution. |
| Approval/resume | Reload policy, atomically consume an exact approval, and re-evaluate. |
| Runtime ceiling | Enforce filesystem, process, network, duration, cost, and delegation ceilings independently of application allow. |

Relay identity/group derivation and Claude/Codex tool normalization are adapters
because their representations vary. Durable policy, approval, and budget stores
are ports with production adapters and in-memory test adapters. The kernel never
receives a socket, filesystem path parser, SDK tool call, or mutable store.

## Owner-facing presets

`agentcall share <caller>` first resolves a handle or group through the relay to
one same-organization stable subject id. Absence or ambiguity aborts before
preview. Omitted actions always compile to `deny`; the complete defaults are:

| Action | Ask | Collaborate | Act with approval | Trusted |
|---|---:|---:|---:|---:|
| `call.submit` | allow on the selected agent endpoint | allow on the selected agent endpoint | allow on the selected agent endpoint | allow on the selected agent endpoint |
| `workflow.invoke` | allow on selected workflows | allow on selected workflows | allow on selected workflows | allow on selected workflows |
| `context.load`, `data.read` | allow on shareable context | allow on named resources | allow on named resources | allow on named resources |
| `draft.create` | deny | allow | allow | allow |
| `file.write`, `process.execute` | deny | deny | approval when selected | allow when selected |
| `external.read` | deny | allow when selected | allow when selected | allow when selected |
| `external.comment`, `external.publish` | deny | deny | approval when selected | deny unless explicitly overridden |
| `resource.delete`, `deploy.run`, `agent.delegate` | deny | deny | deny unless selected, then approval | deny unless selected, then the owner's explicit approval/allow choice |

Every non-deny tuple is bounded to selected resources and limits. Trusted is not
a wildcard. Presets are compiled to explicit grants, so later preset edits never
alter an existing share.

The default flow is testable as this sequence:

```text
$ agentcall share ken
Resolved: ken@acme -> person per_01 (Acme)
Preset [Ask]: Act with approval
Resources: repository agentcall
Exclusions [.env,secrets/**]: <enter>
Risky overrides [none]: file.write=approval, process.execute=approval
Limits [20 calls/day, 15m/call, $2/day, delegation depth 0]: <enter>
Preview: 4 allow, 2 approval, 7 deny; 12 assertions pass
Save this share? [y/N]: y
Share saved atomically at policy revision 7.
```

The CLI also offers `agentcall share edit|revoke` and two explain forms:

- `agentcall policy explain <caller>` renders the complete effective envelope;
- `agentcall policy explain <caller> --action <name> --resource <selector>
  --arguments <canonical-json>` runs a what-if with the same normalizer and may
  take explicit attested group/role fixtures for administrator diagnosis.

Explain reports source-layer intersections, matched grants, the winning
deny/exclusion, limit obligations, exact approval scope, and remediation from
the evaluator trace. Secret arguments and unrelated rules remain redacted.

## Migration without widening

Migration is a zero-user cutover, not a permanent dual schema.

1. Convert each caller block into an absolute subject deny.
2. Convert `ask` into Ask over only today's public working context.
3. Convert every task offer into `{ resource: workflow:<id>, action:
   workflow.invoke }` plus no more authority than the task envelope and workdir
   currently enforce.
4. Preserve task selection as a condition for compatibility grants. An
   open-ended request receives no new authority merely because it is now valid.
5. Map `read`, `write`, `fetch`, and `exec` conservatively. In particular,
   `write` excludes external mutation and destructive actions; `exec` adds no
   deploy, publish, delete, SaaS-admin, or delegation authority.
6. Preserve managed `allowed_tasks` as a compatibility ceiling and managed/user
   caller blocks as denies.
7. Generate parity assertions and run old/new evaluation in shadow mode over
   the complete finite legacy domain: every explicit caller; an unknown-caller
   sentinel for defaults; every group combination that can change a grant;
   every installed, offered, stale, and unknown-task sentinel; and every mapped
   action/resource tuple. Compare the full authority lattice `deny < approval <
   allow`, requiring `newEffect <= oldEffect` in every case; an old deny must
   remain deny, not become an approval challenge. Runtime-dependent or
   unenumerable authority becomes `deny`, never a guessed resource scope.
8. Require owner confirmation for any intentional expansion, including
   deny-to-approval, then delete the
   legacy schema and evaluator rather than maintaining two authorities.

Incomplete or unnormalizable legacy envelopes deny state-changing actions. The
migration may under-grant and ask the owner to choose a preset; it must never
guess broader intent.

## Executable policy assertions

Assertions contain the same canonical request used at runtime plus an expected
`allow`, `approval`, or `deny`, optional stable denial code, and expected limit
obligations. Required fixtures cover:

- all four preset compilations;
- representative context, filesystem, external, destructive, and delegation
  actions;
- explicit-deny precedence and managed-ceiling intersection;
- resource include/exclude and normalization ambiguity;
- exact-argument approval, expiry, use exhaustion, and policy revision changes;
- call/runtime/cost/delegation limit exhaustion;
- task migration subset parity; and
- malformed policy and unavailable policy/approval/budget state.

Policy edits and compiled shares are rejected atomically when assertions fail.
Explain output is derived from the same trace, so it cannot disagree with
enforcement.

## Non-goals and consequences

- This does not choose Cedar, Oso, Cerbos, OpenFGA, or another vendor. The nouns,
  precedence, and enforcement seams come first.
- This does not make prompt instructions an enforcement mechanism.
- This does not replace kernel/runtime sandboxing; application allow cannot
  grant authority the runtime ceiling withholds.
- This does not enumerate natural-language intents. Open-ended requests are
  valid; proposed actions remain unauthorized until the kernel decides.
- This does not preserve task grants as a second authority. Tasks become
  workflows only, and all authority flows through the compiled policy.

This decision supersedes task-name grants as the target model. Until its
implementation lands, README's current task-based behavior remains authoritative.
