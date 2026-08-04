# Accountless group Rooms

> **Historical document — not current documentation.** This is a dated decision
> record that describes the repository state on 2026-08-03 and is deliberately
> *not* updated when behavior changes.
>
> **Approved product decision and validation contract.** This issue does not
> implement production Room behavior; implementation is split into follow-up issues
> only after the decision and validation sequence below is accepted.

**Date:** 2026-08-03  
**Issue:** [#259](https://github.com/KenTaniguchi-R/agentcall/issues/259)  
**Status:** Approved; file-only decision spec  

## Decision summary

AgentCall will validate one sharply bounded product first:

```text
Room     temporary, accountless, group agent collaboration
Team     separate durable administration path; not required for a Room
```

- A **Room** lets 2–6 people who already have Claude Code or Codex try targeted
  agent-to-agent calls without an AgentCall account, Team, global handle, address,
  card, roster, background listener, or durable history.
- A Room is a complete temporary session, not a preview of a defined Channel model.
- **Channel is deferred.** This decision does not define Channel semantics, replace
  roster, change durable reachability, or design a Room-to-Channel conversion.
- After a successful Room, AgentCall may ask whether people want persistence. That
  response is research evidence only; it creates nothing and promises no data model.
- **Workspace** is not a Team synonym. It may describe only a local coding workspace,
  project, worktree, or agent working directory.

AgentCall has zero users. This is a clean product cutover. The next implementation
must not preserve public `organization`, `admin`, `roster`, or legacy setup vocabulary
for compatibility, and it must not pretend the published `0.4.0` flow is the new
onboarding design.

## Why now

An attempted setup with Sota exposed friction at nearly every transition before
value: acquiring an invitation, understanding who the organization administrator is,
choosing an organization and handle, starting a listener, understanding an address,
and constructing the first call. One attempt does not estimate prevalence, but the
failures share a structural cause: permanent governance and routing concepts appear
before the evaluator sees an agent reply.

The intended trial setting is already social. A hackathon or team normally has 2–6
people who know one another and already have authenticated coding agents. AgentCall
should use that existing relationship instead of requiring an established AgentCall
administrator to create it.

```text
Current:  administrator → invite → organization → handle → listener → address → call
Room:     host → individual invites → verified group → targeted call
Later:    use Room evidence to decide whether any durable group product is needed
```

Adjacent developer tools commonly separate constrained evaluation from durable
administration. TryCloudflare offers an accountless temporary tunnel and reserves
named tunnels and Access policy for production. Live Share and OpenCode create a
capability link from the context where collaboration starts. Tailscale creates the
first personal network before asking the user to administer collaborators. AgentCall
should borrow the separation, not their exact security models.

## Product contract

| Term | Lifetime | Membership/identity | Owns | Does not mean |
|---|---|---|---|---|
| Room | Maximum 30 minutes | Session-local capability participants | Foreground membership, verification, targeted calls | Temporary Team or durable identity |
| Team | Durable | Stable principals; Organizer and Member roles | Governance, identity, invitations, billing, audit | A prerequisite for trying a Room |
| Project/workdir | Local, owner-controlled | One local agent/task | Files and process working directory | Team or Room |
| Conversation/context | Bounded pairwise call continuation | Caller and callee for a call context | Follow-up agent session binding | Room history or group persistence |

Public Room docs and CLI must not introduce Team, Organizer, Channel, roster,
organization, tenant, or Workspace during the trial flow. Existing durable product
work may continue to use **Team / Organizer / Member**. Machine-managed policy may
continue to say administrator or IT. `Workspace` remains available only for local
coding context.

## Verified current state

Verified against `origin/main` at `b2ef8cf` on 2026-08-03.

| Current surface | Evidence | Consequence for this decision |
|---|---|---|
| Installation requires an organization-admin invite before setup | `README.md:35-53`; `packages/cli/src/index.ts:78-110` | The only path to value assumes durable administration already exists. |
| Setup requires a handle and registers a durable line | `packages/cli/src/setup.ts:179-214` | A global routing identity is being asked for before a trial call. |
| Setup may install a background listener and prints an organization-scoped address | `packages/cli/src/setup.ts:216-276`; `packages/cli/src/config.ts:10-20` | Evaluators must understand service lifecycle and addressing before activation. |
| Calls use an organization-scoped handle address with saved organization credentials | `packages/cli/src/callClient.ts:93-178`; `packages/shared/src/protocol.ts:133-139,201-209` | The normal call protocol cannot be reused as an anonymous Room by inventing fake handles. |
| Existing roster and Team reachability are durable, authenticated paths | `apps/relay/src/groups.ts:3-18`; `docs/superpowers/specs/2026-08-02-organization-scoped-call-reachability.md:13-35` | Room must be a separate capability path and must not modify these models in this experiment. |
| Agent execution is bounded by runtime/output and native agent permissions, but it is not an OS read sandbox | `packages/cli/src/runner.ts:213-260,364-485`; `README.md:118-121` | Room “safe mode” must be proven per client and cannot be a prompt-only promise. |
| Codex read-only mode still permits reads outside the workdir | `packages/cli/src/runner.ts:250-259` | Codex is excluded from the Room MVP until an executable adapter proves the promised boundary. |

### What must remain true

- Caller text is not consulted when choosing authorization or task capability.
- The relay derives Room membership from session credentials; a caller cannot choose
  the Room or participant identity that authorizes its request.
- The local agent owner controls the files, task, permissions, and model spend used to
  answer a call.
- E2EE call payloads remain authenticated end to end; the Room must not regress to a
  plaintext relay merely because participants are temporary.
- Calls and child process groups remain bounded and cancellable.

## Architecture restructuring policy

Refactoring and restructuring are recommended when they produce a smaller, clearer,
or more enforceable Room design. AgentCall has zero users, so implementation should
prefer one clean cutover over compatibility aliases, parallel legacy paths, fake
Team records, or duplicated call machinery.

The recommended boundary is:

```text
shared, identity-neutral primitives
  ├── call lifecycle, cancellation, byte/runtime bounds, E2EE framing
  └── allowlisted local agent execution adapters

durable path                         accountless path
  ├── Team credential principal       ├── Room capability participant
  ├── address / HandleDO routing       ├── RoomDO routing
  └── durable policy and audit         └── ephemeral limits and retention
```

Specifically:

- Extract identity-neutral call lifecycle and process-control logic where reuse is
  safer than copying `HandleDO`, `listener.ts`, `callClient.ts`, or `runner.ts`.
- Give authorization a discriminated principal context so durable Team credentials
  and Room participant capabilities cannot be accidentally accepted by each other's
  routes. Shared lifecycle code must receive an already-authorized principal; it must
  not decide authentication.
- Reuse audited E2EE, terminal-sanitization, timeout, cancellation, and bounded-output
  building blocks, but keep Room keys, credentials, state, and retention in dedicated
  Room modules and `RoomDO` storage.
- Split oversized modules when the Room path would otherwise add another mode branch
  to the existing durable call flow. Prefer explicit `room/` and identity-neutral
  lifecycle modules over `if (room)` conditionals spread across current files.
- Delete superseded internal paths in the coordinated Room cutover when no durable
  behavior depends on them. Do not preserve a worse abstraction solely because it is
  current code.

This is not permission for an unrelated repository-wide rewrite. A refactor belongs
in R1 or R2 only when it removes duplication, makes an authorization boundary
structural, enables deterministic tests, or is required for the safety adapter. Every
such change must preserve the existing authenticated Team call behavior with
regression tests.

## Accountless Room

### Target situation

- 2–6 people are already together in person or in an existing trusted chat/call.
- Every participant has at least one locally authenticated supported coding agent.
- They want a live demonstration or short collaboration session, not unattended
  availability.
- No participant needs a pre-existing AgentCall account.
- Each participant pays for calls answered by their own local agent.

### Exact first-run experience

The study and release notes pin an exact new package version. They must never instruct
participants to install or use `0.4.0` for this flow.

Host:

```text
$ npx @benree/agentcall@<exact-new-version> room --seats 4

AgentCall found Claude Code and verified the Room safety adapter.

This creates a private 4-person Room for up to 30 minutes.
No account, Team, address, saved identity, or background listener will be created.

Ask each person to run:
  npx @benree/agentcall@<exact-new-version> room join

Send one invitation privately to each person:
  Guest 2: acri_<secret-1>
  Guest 3: acri_<secret-2>
  Guest 4: acri_<secret-3>

Each invitation expires in 5 minutes and works once.
Waiting for 3 people…  Ctrl-C closes the Room.
```

Guest:

```text
$ npx @benree/agentcall@<exact-new-version> room join

Invitation (hidden input):
Name in this Room [Guest 2]: sota

sota is asking to join. Waiting for the host to admit you…
```

The display name is optional, session-local, non-unique outside the Room, and never
persisted. Pressing Enter accepts the generated seat name, so choosing a handle is not
a prerequisite. Duplicate names in one Room are rejected with a local suggestion.

When a guest submits an unused invite, the host sees one inline decision:

```text
sota requested Guest 2. Admit? [Y/n]
```

The host's `--seats` value includes the host and defaults to 2. When all expected
seats are admitted, membership locks automatically. The host may type `/start` early
after at least one guest joins; this revokes unused invitations and locks membership.
No participant can join after locking.

All terminals then show the same transcript-derived fingerprint:

```text
Room members: ken, sota, maya, dev
Compare this code with everyone: 7K2-MQ9-PDX-4HF
Does everyone see the same code? [y/N]
```

Calls remain disabled until every admitted participant confirms the same membership
epoch. Any rejection or 60-second confirmation timeout closes the Room as a security
failure; it does not silently remove a participant and continue under a different
membership view.

After verification, each terminal becomes one foreground REPL:

```text
Room active · 27m remaining · safe mode · 4 people
  ken   local    ready
  sota           ready
  maya           ready
  dev            ready

> @sota We have two hours left and the demo only works locally. What should we cut?

sota accepted · agent working…
sota's agent:
Cut remote deployment and show the local workflow end to end…
```

Targets are one participant at a time, selected by `@name` with tab completion. There
is no `@all`, wildcard, broadcast, or implicit fan-out. `/members`, `/pause`, `/resume`,
`/help`, and `/leave` are the only Room management commands in the MVP.

The first inbound call on each participant requires a local confirmation:

```text
ken wants to run your local agent (up to 90s). Allow? [once/session/deny]
```

`session` means only the remaining bounded calls in this verified Room. It does not
persist. `/pause` immediately denies new inbound calls without leaving.

### Room limits

| Limit | MVP value | Enforcement point |
|---|---:|---|
| Participants | 2–6 admitted | Relay Room object |
| Invite entropy | 256 random bits | CLI generation / relay hash verification |
| Invite lifetime | 5 minutes, single use | Relay Room object |
| Verification deadline | 60 seconds after membership lock | Relay Room object |
| Absolute Room TTL | 30 minutes from creation | Relay alarm plus every client transition |
| Idle TTL | 10 minutes without participant or call activity | Relay alarm |
| Prompt | 4 KiB UTF-8 | Sender, receiver, and relay envelope validation |
| Reply | 16 KiB UTF-8 | Receiver and sender validation |
| Agent runtime | 90 seconds | Receiving client process-group timer |
| Active inbound calls | 1 per participant | Relay and receiving client |
| Queue | 0; additional call returns `busy` | Relay |
| Calls | 5 attempts per participant per Room | Relay, charged at accepted submission |
| Submission cooldown | 3 seconds per participant | Relay |
| Rejected/timed-out joins | 3 per Room, then close | Relay |

The five-call limit replaces the earlier pair-only “three per direction” proposal: in
a six-person Room, a per-pair allowance would create 150 possible directed attempts.
Five per participant caps a full Room at 30 attempts while allowing everyone one
useful call. No model-token ceiling is claimed unless the selected agent exposes one
that the adapter can prove.

### Room state machine

```text
                 create
                   │
                   v
                WAITING ── host locks / seats fill ──> VERIFYING
                  │  │                                  │   │
     host leaves ─┘  └─ invite/join abuse               │   └─ reject/timeout
                                                       │
                              all confirm ──────────────┘
                                                       v
                                                     ACTIVE
                                                       │
                 host leaves / TTL / <2 active / fatal │
                                                       v
                                                     CLOSED
```

`CLOSED` carries a non-sensitive reason: `host_left`, `expired`, `idle`,
`verification_failed`, `insufficient_participants`, `abuse_limit`, or `relay_error`.
It is terminal. There is no Room reopen.

Participant state is:

```text
PENDING → ADMITTED → VERIFIED → READY ↔ PAUSED → DEPARTED
    └────────────── denied/timeout ────────────────┘
```

- The host is the only temporary moderator and may admit or deny pending guests.
- The host cannot read another participant's prompt/reply plaintext or approve calls
  on their behalf.
- A non-host departure marks that participant unavailable. The Room continues only
  while the host and at least one other verified participant remain.
- A host disconnect, clean exit, process crash, or laptop sleep beyond a 15-second
  heartbeat grace closes the Room. There is no moderator transfer or reconnect.
- A departed participant credential can never reattach. Starting again creates a new
  Room and new invitations.

### Cryptographic and authorization model

Room authorization is a separate capability-scoped protocol, not a special Team:

1. The host creates a random `room_id`, 256-bit host credential, ephemeral signing
   and encryption keys, and one independent 256-bit invitation per remaining seat.
2. The relay stores only credential/invitation hashes and public keys. A redeemed
   invitation is atomically consumed before a participant credential is issued.
3. Each guest creates ephemeral signing/encryption keys locally and proves possession
   while joining. The host admits the relay-bound pending participant.
4. Membership locking increments `membership_epoch` and canonicalizes the ordered
   transcript `(room_id, epoch, participant_id, display_name, signing_key,
   encryption_key)` by opaque participant ID.
5. Every client derives a 60-bit, domain-separated display fingerprint from that
   canonical transcript. Human confirmation binds all admitted public keys to the
   membership view.
6. Each call is signed and end-to-end encrypted to exactly one verified recipient.
   Its authenticated associated data includes `room_id`, `membership_epoch`, sender,
   recipient, call ID, issued time, and expiry.
7. The relay derives sender and Room from the participant credential, verifies both
   participants are verified in the active epoch, and injects the attested membership
   identifiers. A request body cannot select its own sender, Room, or authorization.

The fingerprint is not an access secret. It detects substitution only when people
compare it over their existing trusted channel or in person. The high-entropy invite
and participant credentials remain the access capabilities.

### Relay data model

These are concrete protocol shapes; names may change only through another reviewed
decision.

```ts
type RoomState = "waiting" | "verifying" | "active" | "closed";
type RoomParticipantState =
  | "pending" | "admitted" | "verified" | "ready" | "paused" | "departed";

interface RoomRecord {
  room_id: string;                    // random 128-bit opaque ID
  state: RoomState;
  moderator_participant_id: string;
  expected_participants: 2 | 3 | 4 | 5 | 6;
  membership_epoch: number;
  created_at: number;
  invite_deadline: number;
  verification_deadline?: number;
  idle_deadline: number;
  expires_at: number;
  close_reason?: string;
}

interface RoomInviteRecord {
  invite_id: string;
  room_id: string;
  seat: 2 | 3 | 4 | 5 | 6;
  secret_hash: string;
  expires_at: number;
  consumed_at?: number;
  participant_id?: string;
}

interface RoomParticipantRecord {
  participant_id: string;             // random 128-bit opaque ID
  room_id: string;
  seat: 1 | 2 | 3 | 4 | 5 | 6;
  state: RoomParticipantState;
  display_name: string;               // 1–24 safe display characters
  credential_hash: string;
  signing_public_key: string;
  encryption_public_key: string;
  agent_adapter: string;               // adapter + verified version
  joined_at: number;
  admitted_at?: number;
  verified_epoch?: number;
  last_seen_at: number;
  calls_charged: number;
}

type RoomCallState =
  | "submitted" | "accepted" | "working" | "completed"
  | "failed" | "canceled" | "expired";

interface RoomCallRecord {
  call_id: string;
  idempotency_key: string;
  room_id: string;
  membership_epoch: number;
  from_participant_id: string;
  to_participant_id: string;
  state: RoomCallState;
  request_digest: string;
  encrypted_request: string;          // live delivery only
  encrypted_outcome?: string;         // live delivery only
  created_at: number;
  expires_at: number;
}
```

Room records belong in a dedicated `RoomDO`, not the Team D1 schema and not a
`HandleDO`. Encrypted call frames may live only until delivery or Room closure. No
Room row is projected into handles, stable identities, address bindings, cards,
contacts, rosters, Team audit, or A2A task history.

### Failure semantics

| Failure | Required behavior |
|---|---|
| Duplicate join submission | Atomic invite consumption returns the same pending participant only to the same proof; otherwise generic unavailable. It never allocates two seats. |
| Duplicate call submission | Same sender/idempotency key returns current terminal outcome or `in_progress`; a changed digest is `protocol_error`; never starts a second process. |
| Recipient busy/paused/offline | Fail before spawning with `busy`, `paused`, or `offline`; charge the attempt only after relay admission. |
| Participant leaves during call | Receiving process group is canceled; late output is discarded; caller receives `peer_left`. |
| Room TTL during call | All active process groups are canceled; late frames are rejected; reachable clients receive `room_expired`. |
| Non-host network loss/sleep | After 15 seconds, mark departed and cancel their calls. Continue only with host plus one peer. |
| Host network loss/sleep | After 15 seconds, close the Room and cancel every call. |
| Relay partition | Clients show `connection_lost`, cancel local inbound work after grace, and do not reconnect into the Room. |
| Client crash | Heartbeat path applies. Participant credentials expire with the Room and cannot resume. |
| Malformed or oversized frame | Reject before parsing into prompts, count toward bounded abuse limits, and never echo peer-controlled detail unsanitized. |

### Safe execution gate

“Safe mode: no project files” is an enforceable adapter property, not copy. Every
supported `(agent, exact version, OS)` tuple must pass an executable probe showing
that a fresh inbound prompt:

- starts in a new empty temporary directory outside the invoking repository;
- does not load repository instructions, previous sessions, memory, plugins, hooks,
  MCP servers, bundled apps, browser/search, or image tools;
- receives only the environment necessary for agent authentication and AgentCall
  correlation, with unrelated secrets removed;
- has no file, write, shell, process, arbitrary network, or credential-reading path;
- terminates its whole process tree on timeout, cancellation, participant departure,
  or Room expiry; and
- cannot bypass those controls by resuming a session or using user configuration.

The adapter matrix is allowlisted and fails closed. A newer unprobed agent version is
unsupported rather than silently downgraded to prompt-only safety.

Current code is not proof of this Room boundary. Claude currently receives selected
tools plus a local guard, and Codex `read-only` still reads outside its workdir. The
first executable spike may ship Claude-only if and only if its exact adapter passes.
Codex is excluded until it independently passes. If no adapter passes, the Room
experiment stops; the product must not ask people to expose their normal agent.

Project context, custom tasks, write, shell, MCP, browser, network, prior session
continuation, or a participant's normal workdir are not Room MVP features. A later
read-context upgrade needs its own enforcement and consent design.

### Threat model

| Threat | Control | Residual risk |
|---|---|---|
| Invitation copied or intercepted | Per-seat 256-bit secret, hidden guest input, 5-minute expiry, atomic single use, host admission | The interceptor may race the intended guest and cause denial of service. |
| Wrong person admitted | Host sees session name; all participants compare a transcript-derived fingerprint before calls | Humans may skip or falsely confirm comparison. |
| Relay substitutes keys or membership | All clients derive the same fingerprint and E2EE-sign every call against the locked epoch | A compromised relay can deny service and observe timing/IP metadata. |
| Participant impersonation | Session credential plus ephemeral signature; relay derives participant ID | A compromised participant machine can act as that participant until Room expiry. |
| Prompt injection | Tool-free, isolated fresh process; authorization chosen before prompt text enters the model | The model can still produce misleading text; users must treat replies as untrusted advice. |
| Model-spend abuse | Local first-call/session approval, pause/leave, 5 attempts per participant, 90-second runtime, no fan-out, one active inbound call | A trusted participant can intentionally consume the bounded allowance. |
| Malicious participant content | Byte caps, terminal sanitization, E2EE authentication, explicit sender display | Content can still be offensive or socially manipulative. |
| Room enumeration | Opaque IDs, capability auth, generic unavailable errors, bounded join attempts | Network-level traffic remains visible to the relay/operator. |
| Secret leakage to logs/history | Invitation entered through hidden input; secrets redacted and never emitted to telemetry | The host must still send each invitation through some external channel. |
| Process escape/local data access | Per-version executable adapter probe and allowlist | Unsupported agent/OS tuples cannot join as callable participants. |

### Room instrumentation and retention

The activation funnel is:

```text
local_room_invoked (consent-based client event)
  → local_adapter_verified (consent-based client event)
  → relay_room_created
  → relay_participant_joined
  → relay_membership_locked
  → relay_fingerprint_confirmed_all
  → relay_first_call_accepted
  → relay_first_reply_completed
  → relay_second_distinct_target_completed
  → persistence_interest_recorded (consent-based client event)
```

- Never collect invitation values, participant credentials, prompts, replies, local
  paths, repository names, agent session IDs, environment variables, or filenames.
- Relay Room records and encrypted live frames are deleted on close and no later than
  one hour after absolute expiry.
- Per-Room security counters and coarse close reasons may remain for 24 hours, keyed
  by a random Room ID that has no durable identity mapping.
- Rate-limit evidence may retain a daily rotating HMAC of a coarse network signal for
  seven days. Raw IPs are not put in product analytics.
- Aggregate funnel events and coarse durations may be retained for 30 days. Counts
  less than five are suppressed in product reports.
- Client events are opt-in. Relay-created events are the authoritative denominator
  only from `relay_room_created`; install-to-reply and relay-session conversion must
  be reported separately.

Initial hypotheses, not launch guarantees:

1. At least 70% of Rooms with two or more admitted participants reach full
   fingerprint confirmation.
2. At least 60% of verified Rooms complete one reply.
3. At least 40% of successful Rooms complete calls to two distinct target agents.
4. Median Room creation to first completed reply is under two minutes for the cohort
   with client telemetry.
5. At least 20% of successful Rooms explicitly ask to keep the collaboration.

## Validation before implementation

### Stage 1: paper comprehension test

Observe at least five independent groups of 3–6 people. Do not explain the product
model. Give them only:

```text
Person A: run the host command for your group size
Everyone else: run the pinned join command and paste your private invitation
Goal: complete useful calls to two different teammates' agents
```

Record where people hesitate, how invitations are shared, whether the difference
between a Room name and a durable handle is understood, whether everyone compares the
fingerprint, how targets are chosen, what first prompts contain, and what they believe
their agent can access. Do not record prompt/reply content.

### Stage 2: executable safety and flow spike

Build a disposable spike using the real pinned package, dedicated Room relay object,
foreground REPL, individual invites, membership lock/fingerprint, targeted E2EE call,
and one allowlisted safe-mode adapter. Run the same five groups without coaching.

The spike is not promoted until it proves:

- at least one exact agent/OS adapter passes the isolation probes;
- 2, 3, and 6 participant Rooms enforce membership and call caps;
- stolen/replayed/expired invitations and forged membership assertions fail closed;
- timeout, host loss, peer loss, TTL-during-call, duplicate submission, and relay
  partition follow the specified state machine; and
- no prompt, reply, invitation, credential, path, or durable identity enters
  analytics or logs.

### Measurement

Measure separately:

1. host command to invitations shown (consented client cohort only);
2. Room creation to first admitted peer;
3. first admitted peer to locked and fully verified membership;
4. verification to first completed reply;
5. percentage completing calls to at least two distinct agents;
6. time to first reply and categorized failures; and
7. explicit interest in persistence and the reason given.

Five groups are discovery evidence, not statistical proof. The output is a funnel,
qualitative findings, revised limits/copy, and a go/change/stop decision.

## Implementation sequence after approval

Do not implement the whole decision as one issue. After this decision is approved,
create these independently claimable issues:

```text
R0 safe-mode adapter spike ───────────────┐
                                          v
R1 Room protocol/schema + RoomDO ──> R2 foreground CLI + E2EE ──> R3 group study
                                                                   │
                                                                   v
                                                      decide durable follow-up
```

| Work item | Deliverable | Estimated effort |
|---|---|---:|
| R0 | Per-version Claude/Codex safety probes and allowlist decision | 3–5 days |
| R1 | Identity-neutral lifecycle seam, Room schemas, capability auth, RoomDO, limits, relay tests | 6–10 days |
| R2 | Agent adapter seam, host/join REPL, hidden invite input, fingerprint UX, E2EE targeted calls | 6–10 days |
| R3 | Study harness, privacy-safe funnel, five-group report | 3–5 days plus recruiting |

R0 precedes executable Room work because a false safety promise invalidates the
experiment. R1 establishes the fail-closed capability and lifecycle boundary before
R2 exposes it as onboarding. R3 measures the real group flow before AgentCall chooses
any durable group abstraction. Team, roster, Channel, and persistence work do not
block this sequence and are not changed by it.

## Acceptance criteria

1. Public Room terminology distinguishes Room, Team, project/workdir, and
   conversation/context exactly as the product contract table states, without
   introducing Channel or roster into trial onboarding.
2. A 2-, 3-, and 6-person Room can be created and verified without allocating a Team,
   stable principal, global handle, address, card, roster, or background listener.
3. Each non-host seat uses a distinct 256-bit, five-minute, single-use invitation;
   replay, theft races, admission denial, and expiry fail closed.
4. Calls remain disabled until all locked members confirm one transcript-derived
   membership fingerprint, and forged caller/Room/membership values are rejected.
5. Room limits enforce at most five accepted attempts per participant, one active
   inbound call, 4 KiB prompts, 16 KiB replies, 90-second runs, and a 30-minute TTL.
6. No Room operation supports wildcard or `@all` fan-out.
7. Host loss, participant loss, network grace expiry, Room TTL during a call,
   duplicate calls, duplicate joins, pause, and busy state match the documented
   transitions and leave no agent process running.
8. At least one exact `(agent, version, OS)` adapter passes the executable safe-mode
   probes. An unprobed tuple cannot enter callable Room state. Codex remains excluded
   while its read boundary is unproven.
9. Room analytics and logs contain no prompt, reply, invitation, credential, local
   path, repository, session ID, or durable identity, and records expire on the stated
   1-hour/24-hour/7-day/30-day schedule.
10. Room creation, membership, calls, and teardown neither allocate nor mutate Team,
    roster, Channel, handle, address, card, or durable audit records.
11. The post-success persistence question records research interest only and does not
    create an account, Team, identity, membership, browser flow, or placeholder
    conversion command.
12. Five uncoached 3–6-person observations produce the defined funnel, failure
    taxonomy, qualitative findings, and go/change/stop decision before production
    implementation issues advance.
13. Shared lifecycle/runner refactors keep authentication outside the shared layer,
    give Room and durable principals disjoint route types, remove rather than duplicate
    superseded machinery, and preserve existing Team-call regression tests.

## Testing plan

| Layer | Required coverage | Minimum |
|---|---|---:|
| Unit | Room schema bounds, fingerprint canonicalization, invite hashing/expiry, state transitions, idempotency, counters, retention classification | 30 cases |
| Architecture | Durable credentials rejected by Room routes, Room capabilities rejected by durable routes, shared lifecycle accepts only authorized contexts | 12 negative cases |
| Relay integration | 2/3/6 members, admit/deny, lock/verify, forged identity, replay, busy, pause, TTL, disconnect, duplicate calls, E2EE routing | 24 cases |
| Agent adapter probes | Exact supported agent/OS matrix, config/plugin/session bypass attempts, environment minimization, process-tree kill | 1 passing suite per allowlisted tuple |
| CLI integration | Host output, hidden input, pinned version, name collision, fingerprint confirmation, REPL targeting, actionable failures | 18 cases |
| Durable-boundary integration | Room operations cannot reach or mutate Team, roster, handle, card, address, or Team-audit routes | 10 negative cases |
| E2E | Uncoached host + 1/2/5 guests through first reply, reverse/distinct-target call, host loss, persistence-interest question | 8 journeys |
| Privacy | Log/telemetry sink inspection with canary secrets/content/paths | 10 negative cases |

## Rollout and rollback

Room rollout is allowlisted and kill-switchable by exact package version, relay
deployment, agent adapter, and operating system. Start with the internal executable
study, then a named invitation-only cohort, then a bounded public experiment only if
the funnel and abuse evidence support it. Disabling Room creation must not affect Team
calls. Existing Rooms expire within 30 minutes without migration.

Rollback is disabling new Room creation and reverting the Room-specific CLI/relay
deployment. Room state needs no migration or backfill: every live Room expires within
30 minutes, and its remaining relay data is deleted within one hour. Rollback must not
rewrite Team, roster, identity, address, card, policy, or Team-audit storage because
the Room path never writes those stores.

## Out of scope

- Implementing Room in this decision issue.
- Supporting the old `0.4.0` onboarding path as a compatibility requirement.
- A solo demo agent supplied by AgentCall.
- A Room with more than six participants, reconnect, moderator transfer, offline
  delivery, background listener, custom tasks, project context, write/shell/browser/
  network/MCP access, continuation, or durable history.
- Defining or implementing Channel, replacing roster, or choosing a durable group
  collaboration model.
- Cross-Team federation.
- Any Room persistence or conversion flow, implicit Team creation, or Room history
  import. The post-success question measures interest only.
- Full arbitrary RBAC. Team Organizer and Member remain the durable roles owned by
  #205.

## Relationships

- #205 — separate Team / Organizer / Member durable onboarding; not a Room prerequisite
- #154 — future durable identity work; intentionally not used by Room participants
- #17 — Team audit; Room evidence has its own bounded retention and is not Team audit
- #26 — existing roster/group behavior remains unchanged by the Room experiment
- #59 / current reachability decision — authenticated Team calls remain unchanged
- #243 — future documentation must lead trial users to Room before durable setup
