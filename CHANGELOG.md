# Changelog

All notable changes to agentcall are recorded here. Versions apply to both
`@benree/agentcall` (the CLI) and `@benree/agentcall-shared` (protocol schemas),
which are released together.

## Unreleased

### Answering agents inherit the owner's connected tools (#392)

- Claude calls now grant installed skills, web research, user-configured MCP
  servers, claude.ai hosted connectors, and MCP servers bundled by installed
  plugins. Deferred MCP schemas load through `ToolSearch`.
- Codex calls now load the owner's normal user configuration, including MCP
  servers, skills, apps, web search, and image generation. Its native
  read-only sandbox remains enabled, but MCP processes may act outside it.
- Claude's local `Write`, `Edit`, `NotebookEdit`, and `Bash` tools remain out of
  the spawn allowlist and are now also denied by the PreToolUse guard.
- Connected tools are delegated authority: their own send, update, delete, and
  payment operations are available to every caller the installation answers.

### Single self-diagnostics interface (#429)

- Make `agentcall doctor` the only self-diagnostics surface, with matching
  human and JSON reports for task validity, effective policy, card drift, key
  publication, recovery, listener state, and runtime health.
- Keep plain `doctor` read-only and remove its relay self-call. It never fixes,
  publishes, or rewrites installation state.
- Remove top-level `lint`, `policy`, `card`, and `keys publish` without aliases.
  Move explicit remote publication to `agentcall admin card publish` and
  `agentcall admin keys publish`; retain policy mutations, trust reset, token
  rotation, and recovery commands.

### Unified peer inspection (#428)

- Add `agentcall inspect <contact-or-address>` as the single read-only view of
  resolved address, saved contact note, availability disclosure, identity pin
  comparison, offered tasks, examples, and a safe next command.
- Remove top-level `status` and `verify`, and remove peer-target `card`; retain
  self `card`, `card push`, contacts CRUD, and explicit `trust --reset`.
- Never create or replace a trust pin during inspection. Peer availability is
  `undisclosed` after the self-only presence change in #424; only self
  inspection reports `online` or `offline`.

### One installation identity (#427)

- Replace local multi-line selection with one identity per installation. Remove
  `line add/list/remove/primary`, multiple listeners, `--line`, `--as`,
  `AGENTCALL_LINE`, primary-line state, and their tests and current docs.
- Store identity, policy, keys, contexts, recovery state, and logs directly in
  `~/.agentcall`; keep contacts installation-scoped and authored tasks in
  `~/AgentCall/tasks`.
- Refuse legacy `~/.agentcall/lines/` installations instead of choosing or
  merging identities automatically, with an explicit migration guide.

### Roster and search removal (#424)

- Remove roster/search CLI commands, local roster state and caches, relay
  routes and mutation logic, shared discovery schemas, and roster group
  attestation from calls, presence, and policy.
- Keep calling explicit addresses and saved contacts as the single discovery
  model; presence inspection is limited to the authenticated line itself.
- Preserve append-only D1 migrations, legacy roster tables, historical roster
  audit events, and their administrator export contract.

### Accountless Room removal (#371)

- Remove the experimental accountless Room command and protocol so AgentCall has
  one authenticated Team call model instead of two parallel identity systems.
- Remove Room HTTP and WebSocket routes, schemas, Durable Object bindings,
  client runtimes, safety adapters, tests, and current documentation.
- Remove the Room-only terminal helpers and simplify the shared call lifecycle
  to its remaining authenticated Team principal.

### The Room membership code is reported, not asked (#369)

- Joining a Room no longer stops on `Does everyone see the same code? [y/N]`.
  Every participant confirms automatically and the Room starts.
- This removes a failure mode that cost the whole group the Room: the relay gave
  everyone 60 seconds to answer, and a timeout, a stray keystroke, or one person
  stepping away closed it for everybody — unrecoverably, because locking a Room
  already deleted its invite.
- The membership code is still derived and still shown, now on the line that
  announces the Room is active, so anyone who wants to compare it out of band
  still can. This matches how `agentcall verify` already treats peer identity
  fingerprints, and how Zoom and Signal treat theirs: access control blocks, key
  verification does not.

### Room auto-admits joiners and drops `--seats` (#367)

- `agentcall room` no longer stops on a blocking `<name> wants to join. Admit?
  [Y/n]` prompt for every guest. The host now auto-admits anyone who redeems the
  invite, up to the Room's seat capacity, which is still enforced relay-side.
- The membership fingerprint compare after everyone joins is unchanged — it
  catches a network-level mismatch on the transcript, not identity, and was
  never what the admit gate was checking.
- `--seats <n>` is removed. Room capacity is now a fixed 6-person ceiling —
  not a target to size upfront, just the max the invite will admit before
  fingerprint verification and the call itself begin.

### Conversations say when they have ended (#364)

- Keep one outbound conversation per address **per task**. Calling the same peer
  on a second task previously discarded the first conversation from the caller's
  store while the callee kept its binding, so `--continue` reported "no open
  conversation" for a thread that was still live.
- `--continue` resumes when exactly one conversation matches, names the open
  tasks when `--task` selects none, and asks for a `--task` rather than guessing
  when several match.
- Clear the stored context when the callee reports `context_unknown`. The entry
  was only ever written on success, so an ended conversation left `--continue`
  re-sending a dead context id and failing identically forever.
- Report a resume the answering agent's CLI no longer holds as
  `context_unknown` rather than `agent_error`, and drop the dead binding. Agent
  session state lives in claude's/codex's own store, which AgentCall neither
  owns nor prunes, so an admitted binding can still fail at spawn — that is an
  ended conversation, not an internal agent fault.

### Native Windows compatibility evidence

- Add a native `windows-2025` CI matrix for Node 20, 22, and 24 that exercises
  the packed CLI from a clean path containing spaces while preserving the
  public unsupported-platform install boundary.
- Run build, typecheck, shared tests, and an explicitly platform-neutral CLI
  suite on Windows; classify every remaining setup, supervision, ACL, process,
  executable-resolution, and path blocker under #251.
- Document the Daytona/manual setup, foreground listener, inbound call,
  cancellation, timeout, status, and uninstall probe required before Windows
  can be claimed as a supported callee platform.

### Generation-bound handle recovery

- Add an org-scoped, generation-versioned recovery proof that is issued only
  after an out-of-band backup acknowledgement and is never stored in AgentCall
  config, pending state, stdout/stderr, or logs.
- Make recovery a client-led, crash-safe operation: the CLI durably saves its
  candidate online token before commit, the relay atomically consumes the
  predecessor and records an exact seven-day replay receipt, and `--resume`
  recovers a lost response without creating different credential material.
- Advance to an acknowledged successor proof, reject changed and cross-identity
  replays, evict sockets in the recovered identity's current Durable Object
  after commit, and make normal token rotation compare-and-swap against
  concurrent credential changes. Until #154 moves outbound sockets to their
  authenticated identity, already-open outbound calls remain outside that DO.
- Report recovery generation and missing-backup risk in `agentcall doctor`.

### Line credential persistence

- Route per-line config and relay-token saves through the shared unique-temp
  atomic writer. A stale legacy `config.json.tmp` path or concurrent writer no
  longer shares the staging inode, and a serialization failure preserves the
  previous credential.

### Primary-line persistence

- Route `person.json` saves through the shared unique-temp atomic writer. A
  stale legacy `person.json.tmp` path or concurrent writer no longer shares the
  staging inode, and a serialization failure preserves the previous primary
  line.

### Conversation context persistence

- Save inbound conversation bindings with a unique same-directory staging file
  and atomic rename. A planted `contexts.json` symlink is now replaced instead
  of overwriting its target, and failed serialization preserves the previous
  context store.

### Authorization permission vocabulary

- Name existing authorization decisions with stable `resource:action`
  permissions while keeping principals, resource instances, and grant sources
  explicit.
- Keep Workspace roles, roster capability credentials, local owner policy, and
  machine-administrator ceilings distinct instead of introducing custom RBAC.
- Separate permission checks from audit event names and reserve stable agent
  identity for future durable principal bindings.

### Enterprise capability sequence

- Sequence workspace roles and onboarding before complete audit evidence, then
  deal-triggered managed SSO, written-request-only SCIM, and evidence-backed SOC
  2 readiness instead of treating issue numbers as a roadmap.
- Keep hosted SSO provider-managed and provider-adaptable, with WorkOS as an
  evaluated candidate rather than a committed dependency or a customer-owned
  relay requirement.
- Separate the canonical permission vocabulary for existing gates from the
  two-role Workspace onboarding model and from any future custom RBAC engine.
- Preserve stable agent identity as a prerequisite for durable role, IdP,
  provisioning, and offboarding bindings.

### Confidential-computing deployment decision

- Keep an AWS Nitro Enclaves relay trigger-gated instead of adding a speculative
  second deployment target or portability layer.
- Separate exact-image attestation, source-to-measurement transparency, and
  signer-authorized upgrade lineage; none is allowed to stand in for the others.
- Define the customer signals and security, state, upgrade, operations, and
  claim-review gates required before a future TEE evaluation can begin.

### Organization administration and audit export

- Make organization authority explicit with `admin` and `member` roles; the
  operator bootstrap invite creates the first admin, and admin-issued invites
  can deliberately delegate either role.
- Let administrators stream a tenant-scoped NDJSON or CSV export that merges
  organization and roster audit ledgers in deterministic order, with time-range
  and exact actor, event-type, and source-IP filters.
- Sign pagination cursors with a relay-only secret and bind them to the tenant,
  administrator, filters, and captured per-ledger ID/count checkpoint so
  tampering and concurrent appends cannot corrupt export completeness; abort
  if retention removes a checkpointed row mid-export.
- Preserve the granted role as structured audit evidence on invite issue,
  redemption, and revocation events.
- Retain tenant-scoped call submission and terminal lifecycle evidence without
  prompt/reply bodies, using an idempotent Durable Object outbox so call truth
  and retryable audit intent commit atomically across temporary D1 failures.
- Let API clients conditionally poll exact audit pages with strong response
  ETags and private revalidation, without weakening authorization, rate limits,
  cursor validation, or checkpoint-gap detection.
- Issue a tenant-bound completion receipt only for terminal unfiltered exports,
  and let administrators explicitly advance an atomic, monotonic per-ledger
  acknowledgement watermark as the export-before-expiry retention prerequisite.
- Add an administrator-only, tenant-scoped retention control plane with a
  versioned 400-day default event window, bounded overrides, and one explicit
  legal/incident hold whose create/release lifecycle is idempotent and audited;
  keep deletion and erasure explicitly unimplemented.
- Add a read-only retention readiness snapshot that evaluates policy, active
  hold, export watermarks, and exact per-ledger eligible/unacknowledged counts
  in one D1 transaction without authorizing or performing deletion.

### Experimental customer-owned Cloudflare relay

- Add a binding-complete self-host Wrangler configuration and an operator
  runbook covering D1 provisioning/migrations, secrets, custom-domain-only
  routing, deployment validation, CI, upgrades, rollback, and ownership.
- Pin customer-operated relays to one configured organization, rejecting
  conflicting tenant headers, bootstrap requests, and invite redemption while
  preserving the hosted multi-tenant routing behavior.
- Keep the deployment claim precise: this is isolated customer-owned
  Cloudflare infrastructure, not on-premises packaging, relay federation, or a
  regional data-residency guarantee.
- Limit the artifact to internal, pre-production evaluation until security
  issues #1–#8 close; public and enterprise production remain unsupported.

### Codex account boundary and explicit exec trust

- Disable Codex's bundled authenticated apps with strict recognized configuration
  on fresh and resumed answering spawns, so remote calls cannot use the owner's
  account-backed read, deploy, environment, or access-control tools.
- Remove top-level web search and image generation from the same spawn boundary,
  preventing undeclared outbound calls that survive user-config isolation.
- Document `exec` as an explicit broad-authority grant for Claude rather than a
  read-isolated capability, while keeping Codex's filesystem read floor scoped to
  the separate kernel-boundary work.

### Git-backed documentation site

- Add a self-contained Mintlify site for installation, setup, core CLI commands,
  protocol frames, and the current security posture.
- Generate CLI and protocol references from the built Commander program and Zod
  schemas, and validate that public navigation and links cannot expose historical
  repository documentation.
- Expand the site into 25 task-oriented pages covering evaluation, first call,
  safe answering, tasks and policy, discovery, identity, multiple lines,
  administration, configuration, A2A retrieval, troubleshooting, and privacy.
- Generate detailed CLI help recursively for every command and nested subcommand,
  with a contract test that fails when the command tree or required reader
  journeys fall out of the published reference and navigation.
- Replace the 1,100-line repository README with a concise product overview,
  quick start, safe-receiving path, security summary, and links into the
  task-oriented documentation.

### A2A task retrieval for live calls

- Retain each admitted call in its callee Durable Object until the existing
  six-minute deadline, even when the caller disconnects or the call finishes.
- Add authenticated A2A `GetTask`, `ListTasks`, and `CancelTask` HTTP+JSON
  operations with caller-only visibility, cursor pagination, filtering, and
  listener-confirmed cancellation.
- Project relay lifecycle states and bounded text replies into shared,
  validated A2A task/status/artifact schemas without adding a durable mailbox.

### Linux and isolated container listeners

- Publish the CLI for Linux and install one restartable systemd user service
  there, while keeping launchd as the macOS adapter behind the same listener
  service interface.
- Teach setup, line management, uninstall, and doctor to use the active
  platform adapter; replace the launchd-specific `--skip-launchd` option with
  `--skip-service`.
- Add a source-built, non-root container listener that requires an exact agent
  package version, keeps enrollment/authentication in an isolated named volume,
  and mounts the selected project read-only by default.
- Test packed CLI installation on both macOS and Linux, and prevent Claude's
  enforcing guard from rewriting Linux systemd user units.

### Documentation — GTM sequencing and privacy positioning

- Keep the first design-partner segment focused on non-EU, non-unionized
  100–500-person engineering organizations and measure senior-time recovery.
- Preserve the live-routing/no-central-corpus distinction while retiring the
  ambiguous “we do not ingest employee data” claim; any stronger future claim
  must separately name content confidentiality and retained metadata.
- Gate regulated and EU expansion on shipped security, audit, retention,
  administration, runtime, residency, and worker-governance controls.

### Encryption-key rotation continuity

- Chain each rotated encryption-key record to the previous canonical signed
  transcript, persist the basis only after successful publication, and refuse
  rotation when no trustworthy local chain basis exists.
- Make publication retries and next-epoch key rotation converge safely across
  concurrent CLI processes using immutable epoch elections and public retirement
  tombstones, without retaining superseded encryption private keys.
- Record the #171 requirement that future peer-chain verification reject missing
  key epochs rather than fetch relay-supplied history.
- Breaking migration: reject pre-chain local key files because they cannot
  reconstruct the exact previously published record. Preserve the old state
  for recovery and enroll a new handle with a new invite; setup cannot replace
  the spent handle's relay-pinned identity.

### End-to-end encrypted live calls

- Replace plaintext call request, incoming-call, reply, and peer-failure frames
  with signed HPKE envelopes. Callers verify and pin recipient keys before
  opening a WebSocket; listeners authenticate, current-check, and persistently
  reserve requests against replay before policy evaluation or agent spawn.
- Bind request IDs, complete signed transcripts, relay origin, endpoint
  addresses, recipient key ID, and epoch into authenticated request/response
  exchanges. Reject stale, replayed, rolled-back, misrouted, oversized, or
  unauthenticated content without a plaintext compatibility fallback.
- Keep relay-operational status distinct from authenticated peer outcomes and
  label the distinction in caller errors. The relay retains routing/lifecycle
  metadata and bounded opaque ciphertext, while A2A task recovery becomes
  status-only because context, reply, and failure content are encrypted.

### Opt-in local OpenTelemetry

- Propagate a bounded caller correlation ID across relay, listener, lifecycle
  status, reply/failure, audit, and tool-attempt records; post-admission status
  frames now include the relay-minted call ID.
- Add explicit opt-in caller/listener OpenTelemetry spans and bounded custom
  invocation metrics. Invalid optional trace context is ignored without
  affecting delivery, and untrusted remote sampling cannot exceed local ratio
  and token-bucket ceilings.
- Pair stable pre/post tool hook IDs through a bounded private local spool and
  emit `execute_tool` child spans plus `gen_ai.execute_tool.duration` only for
  complete observed lifecycles. Missing, duplicate, mismatched, or oversized
  events are omitted; hook arguments, results, paths, and error text never enter
  the spool or exporter.
- Keep Codex tool spans disabled after its 0.146.0 default code-mode path
  completed without emitting paired lifecycle hooks. OpenTelemetry never
  changes Codex's tool surface to manufacture an observable path; doctor
  reports the compatibility gap while preserving ordinary call telemetry.
- Keep prompts, replies, handles, paths, policy details, sessions, and exporter
  credentials out of telemetry; answering agent and hook subprocesses inherit
  correlation but no `OTEL_*` or AgentCall exporter configuration.
- Persist bounded local exporter/queue degradation counters for
  `agentcall doctor`, and await a bounded telemetry flush during listener shutdown.

### Nested-call interlock and egress boundary

- Refuse the normal `agentcall call` path inside an inbound answering process,
  preventing accidental recursive call loops until relay-attested delegation and
  per-run credentials exist.
- State explicitly that task capabilities are not a domain firewall and reject an
  advisory proxy allowlist as a security control without external enforcement.
- Define the future stable-principal chain, two-hop maximum, cycle check,
  secret-isolated run credential, brokered relay path, authority intersection,
  sponsor-aware audit, and descendant-revocation gates.

### Presence telemetry is not audit evidence

- Removed organization, handle, IP, and country dimensions from sampled status-read
  analytics; the dataset now contains only identity-unlinked allowed/denied points.
- Added a non-personal D1 health counter for locally observable Analytics Engine
  binding failures without making presence depend on telemetry availability.
- Recorded the three-month retention, sampling, US-only CMB, and asynchronous-loss
  constraints so audit export and abuse monitoring use purpose-built durable stores.

### Documentation — subject erasure and bounded retention decision

- Committed AgentCall to a supported subject-erasure workflow rather than treating
  indefinite relay retention as a permanent product policy.
- Separated erasure from handle reclaim: erasure starts a disclosed, identity-unlinked
  address quarantine that hard-expires after 30 days; safe reuse binds a fresh identity.
- Chose crypto-shredding for subject-bearing audit evidence, a 400-day event default,
  and 30-day network-evidence retention, while keeping every promise explicitly
  unshipped until identity ownership, export, legal holds, analytics, and backup gates
  are implemented.

### Documentation — positioning after MCP Tunnels and EMA

- Reframed AgentCall around governed, person-scoped delegation rather than
  private-network reachability, which MCP Tunnels now supplies for MCP servers.
- Recorded Enterprise Managed Authorization as a useful identity and token-exchange
  reference for #15/#27, but not a compatibility claim for the non-MCP relay.
- Deferred an MCP facade until a named customer need and the principal-mapping,
  endpoint-security, identity, audit, and conformance prerequisites all exist.

### Added — Multiple lines: several agentcall addresses on one machine

A single machine can now hold more than one agentcall address ("line"), each with its
own handle, relay token, agent kind (or none, for caller-only), policy, tasks, and
working directory under `~/.agentcall/lines/<name>/`. One supervised process still
runs — `agentcall listen` now opens one socket per callable line instead of
assuming exactly one.

- `agentcall line add <name> --handle <h> --agent <claude|codex>` registers another
  address; `--caller-only` for a line that only calls out. `agentcall line list`,
  `agentcall line remove <name> --yes`, and `agentcall line primary <name>` round
  out the group.
- `agentcall call`/`agentcall status` pick whichever line is registered on the
  destination's relay automatically (the primary, when more than one line shares
  it); `--as <line>` overrides. `agentcall listen --line <name>` runs a single line
  in the foreground instead of every callable one.
- `--line <name>` (or `AGENTCALL_LINE`) now selects which line `rotate`, `card`,
  `lint`, `policy`, `task new`, the roster/search/key commands, and the six
  policy verbs act on.
- `agentcall setup` is first-run only now: run again on a machine that already has
  a line and it prints the existing lines and points at `line add` instead of
  clobbering the one config.json that used to exist.
- The tool guard's task-directory denial and per-call audit log (`calls.log`,
  `tools.log`) are per line, so an answering agent on one address can't rewrite or
  read another address's task grants or history.
- **An address is not a security boundary between lines on the same machine** —
  see the README's "Several agents, several addresses" section for what splitting
  into lines does and does not separate.

This removes the single flat `~/.agentcall/config.json` (and `Config`/`Paths`/
`loadConfig`/`assertCallableConfig`) entirely; every command now resolves a
`LineContext` instead. `AddLineOpts.verify` (accepted, previously unread) now runs
a post-registration verify pass by default, mirroring `setup`'s; `--no-verify` on
`line add` skips it.

Tenancy is a property of the LINE, not the machine: `org` sits in each line's
`config.json` alongside `relay`, because an org names a tenant *on a relay* and
the relay was already per-line. Rosters, `agentcall search`, tenant invites and
conversation bindings follow it — each is scoped to one line and takes
`--line <name>` (defaulting to the primary line), so a machine can hold lines in
two organizations without either seeing the other's memberships, invites, or
open conversations.

### Recoverable roster audit-budget exhaustion

- Members can always leave a roster after its 10,000-event membership audit
  budget is exhausted, so the presence authorization boundary cannot trap a
  member in a frozen roster.
- Exhausted joins now identify the administrator recovery action. An
  authenticated administrator can reset the budget without deleting the
  roster; each effective reset writes a distinct append-only audit event.

### Employee transparency and local history

- Added `agentcall history` so the person whose machine answers calls can see
  local caller, task, outcome, prompt/reply previews, and correlated guarded
  tool-attempt counts. JSON output is available for local inspection scripts,
  malformed log records and bounded-scan gaps are disclosed instead of
  silently hidden, and audit directories/files are repaired to 0700/0600 on
  write.
- Added `agentcall history --flagged` for objective local signals only:
  blocked-caller attempts, unknown or unoffered task requests, and enforcing
  tool-policy denials. Persisted signal fields are cross-checked against their
  source status, contradictory log rows are rejected, and no prompt classifier
  or central data flow is introduced.
- Callable setup now states that offered tasks run automatically without
  per-call approval, and the employee transparency page documents what the
  caller, machine owner, organization, and relay operator can actually see.

### Audit retention policy

- Documented that roster audit events are retained indefinitely and
  organization audit events are count-bounded but have no time-based expiry.
  Automated deletion remains blocked on verifiable export, bounded cleanup,
  backup handling, and legal-hold policy in the admin/audit-export track.

### Bounded call rate-limit retention

- Handle Durable Objects now sweep expired per-caller rate-limit keys on the
  next charged call, with at most four 128-key pages of work per event. Larger
  backlogs continue by alarm until drained; dormant objects with no pending
  sweep do no work and cannot keep accumulating historical callers.

### Consistent roster group grants

- Roster bundle discovery now applies the same deterministic first-50 shared
  roster cap as direct card projection and call admission, preventing search
  from advertising a group-granted task that the call path would reject.
- Bundle ETags now cover the actual caller-specific projection, so membership
  changes cannot preserve stale group-granted tasks through a `304` response.

### Safe reply rendering

- Human-readable call replies and fetched agent cards now neutralize terminal
  control characters and Unicode bidirectional formatting from remote text
  while preserving normal line breaks and tabs. `call --json` still emits the
  exact reply payload, with terminal-active code points safely Unicode-escaped
  in its serialized representation.

### Release OIDC enforcement

- The npm publish process now pins `NODE_AUTH_TOKEN` empty and verifies both
  GitHub OIDC request variables before touching the registry. The guard runs in
  the same step as `npm publish`, so token auth cannot bypass a check performed
  in a different process.
- A workflow-structure regression test proves a deliberate token reintroduction
  fails the invariant and keeps the OIDC checks before the first publish call.

### Organization invite lifecycle

- Replaced the create-only organization invite command with `invite create`,
  `invite list`, and idempotent `invite revoke` operations. Inventory exposes a
  SHA-256 public ID and lifecycle/provenance metadata, never the invite secret.
- Invite creation now accepts a bounded purpose and 1–90 day expiry, enforces a
  100-active-invite tenant cap, and deletes terminal credential rows after a
  30-day application retention window.
- Issue, redemption, and revocation mutations append evidence atomically to a
  10,000-event rolling organization ledger. Any authenticated member retains
  the existing authority to manage invites; role restrictions remain assigned
  to the RBAC/SSO track.
- Revoked credentials fail registration, lifecycle operations remain
  tenant-isolated, and hosted registration addresses are derived from the
  invite's organization even when the request uses a conflicting tenant host.

### Documentation — bounded credential lifecycle

- The future identity cutover now includes 90-day client credentials that
  exchange for one-hour opaque access tokens, with automatic refresh/rotation,
  a 24-hour maximum overlap, parent-child revocation, and access-token-bounded
  WebSocket sessions.
- Normal rotation proves the replacement before revoking the old credential;
  recovery instead atomically revokes D1 credential state, then idempotently
  evicts live sessions. Client secrets remain reveal-once and hard expiry never
  silently extends through a child token or WebSocket.
- Subject-owned Durable Objects will serialize WebSocket admission and
  revocation so outbound caller sockets cannot escape eviction in a callee's
  object. Recovery successors remain out-of-band and never share AgentCall's
  normal credential store.
- `last_used_at` is a coarsened liveness signal updated at most hourly, not a
  per-request D1 write, audit trail, or automatic reclaim authority. The
  obsolete `handles` row receives no temporary lifecycle fields before #154.
### Documentation — identity and address separation

- Agent identity is now decided as an opaque, organization-scoped lifetime
  separate from the reclaimable `handle@host` routing address, rotatable
  credentials, and future lines/sessions.
- Durable state, cards, roster membership, policy subjects, and audit actors
  will attach to stable identity so handle reassignment cannot inherit the
  previous owner's authority or data. Credential and signing-key rotation will
  not change identity.
- The runtime change is deliberately a coordinated zero-user cutover after the
  recovery-credential change and before SSO/SCIM, reclaim, or card signing. It will
  have no dual-read compatibility path and must fail closed if production row
  counts contradict the zero-user premise.

### Documentation — Cloudflare Access boundary

- Cloudflare Access is selected for the future human admin hostname and as a
  customer-owned SSO profile for self-hosted relays, with mandatory Worker-side
  JWT validation and separate human and service actor types.
- Access will not protect the current relay API, replace AgentCall application
  authorization, reuse the existing `Authorization` header for service tokens,
  or serve as the hosted multi-tenant customer IdP control plane.
- The deployment acceptance contract covers alternate-origin bypasses,
  issuer/audience/key validation, application RBAC, redaction, negative tests,
  service-token rotation, and break-glass operations. No runtime integration is
  claimed before an admin UI or supported self-hosted distribution exists.

### Documentation — trust-domain-scoped agent identity

- The future Agent Card signing design now preserves `handle@host` as a
  trust-domain-scoped name while separating identity, routing, and rotatable
  credentials. Ed25519 uses RFC 9864's fully specified `alg: Ed25519` with
  RFC 8037's `kty: OKP` / `crv: Ed25519` key representation; the deprecated
  polymorphic `EdDSA` algorithm is rejected by default.
- Verification must select a configured JWKS by the expected host and handle
  before resolving `kid`; cross-domain/cross-handle key pools and arbitrary
  card-supplied `jku` fetches are explicitly rejected. Same-relay discovery is
  documented as host-authorized or trust-on-first-use, not proof against a
  malicious relay operator. The current unsigned-card trust boundary remains
  documented until #101 implements the zero-user cutover.
- The living reference index records the date-sensitive IETF, A2A, and MCP
  watch points without prematurely adopting a pre-consensus identity protocol.

### Documentation — cloud data map and residency decision

- A living inventory now covers every D1 table, Durable Object storage shape,
  native rate-limit counter, Analytics Engine dataset, log surface, transient
  call-content path, and endpoint-local boundary, with sensitivity and actual
  application retention.
- Production D1 is recorded as WNAM with no jurisdiction and replication off.
  The decision rejects pinning Durable Objects alone: jurisdictional ID
  derivation would strand current objects while D1, analytics, processing, and
  logs remained outside the claim.
- Regional conclusions are explicit: a coordinated new EU deployment is
  possible with caveats; complete US residency is blocked by D1's lack of a US
  jurisdiction; Japan has no D1 or Durable Objects jurisdiction.

### Documentation — organization-scoped call reachability

- The security model now states the implemented boundary explicitly: every
  authenticated handle can call every registered peer in its organization,
  while cross-organization routing is rejected. Rosters scope discovery,
  presence, and task policy; they are not a second tenancy boundary.
- A member-minted-invite amplification risk is documented as accepted: one
  compromised member can enroll multiple handles, each with its own per-caller
  call budget. A relay regression test pins open same-organization delivery
  between handles in disjoint rosters.

### Fixed — doctor detects Codex policies that suppress tool telemetry

- `agentcall doctor` now queries Codex's read-only `hooks/list` endpoint with
  the exact production hook and trust overrides. It succeeds only when
  AgentCall's session hook is present, enabled, and trusted; no additional
  model call or effective-config dump is required.
- `allow_managed_hooks_only = true`, hook normalization drift, disabled hooks,
  malformed responses, and app-server failures now make doctor exit nonzero
  with an actionable diagnostic instead of silently claiming telemetry.
- AgentCall still does not install an administrator-managed guard. An
  administrator who requires managed-only hooks must leave that setting unset
  until a managed installation flow ships.

### Fixed — the Codex guard now runs without trusting foreign hooks

- Codex spawns now supply the exact trusted hash for AgentCall's inline
  `PreToolUse` hook. The trust grant is scoped to that synthetic session-hook
  key; AgentCall does not use `--dangerously-bypass-hook-trust`, so unrelated
  user, project, plugin, and managed hooks do not inherit execution trust.
- The normalized hash and whole-table `hooks.state` override are pinned to
  codex-cli 0.146.0. A live env-gated regression proves the AgentCall hook runs
  on a real tool call while an unrelated `$CODEX_HOME/hooks.json` hook remains
  untrusted. A Codex normalization change fails closed by skipping the hook.
- Codex telemetry remains observe-only and incomplete: tool attempts that emit
  `PreToolUse` are recorded, but the hook does not enforce a read boundary and
  non-hooked routes such as `view_image` remain absent from `tools.log`. An
  administrator setting `allow_managed_hooks_only = true` disables this session
  hook; doctor now detects that condition, while managed-hook installation
  remains future work.

### Added — readable effective capability policy

- `agentcall policy [--line <name>]` renders the composed user and administrator
  policy for one line as a
  per-caller, per-roster, and per-task capability report, including blocks,
  ignored missing tasks, assertion status, and the runtime-specific Claude or
  Codex enforcement boundary.

### Documentation — living reference implementation index

- Enterprise, security, and A2A designs now start from a discoverable living
  index of the external systems and specifications AgentCall follows, including
  the exact invariants to reuse, boundaries not to copy, and local designs or
  implementations where each precedent has already landed.

### Security verification — malformed Codex requirements fail closed

- The Codex read-floor verifier now requires malformed machine-wide
  requirements to stop startup with the exact fatal configuration-loader
  diagnostic; an unrelated crash can no longer count as a successful denial. A
  targeted `--malformed-only` mode
  and signal-safe restoration keep the root-only experiment bounded.

### Changed — presence is roster-scoped and auditable

- Handles can read their own presence or that of a peer in a shared roster.
  `agentcall status` therefore reads as a line: it uses the line registered on
  the destination's relay (`--as <line>` overrides), and roster sharing is
  evaluated for that line's handle.
  Unrelated and nonexistent targets now return a byte-identical generic 404;
  call delivery remains independent of roster membership.
- Authenticated allowed and denied status reads are written to a dedicated
  Analytics Engine dataset with viewer, target, timestamp, source location,
  and decision, but never the target's online/offline state.

### Added — executable policy assertions

- User and administrator-managed policy files can assert accepted and denied
  tasks for direct callers and relay-attested roster groups. Assertions run on
  the composed effective policy, including managed ceilings and blocks.
- `agentcall lint` exits nonzero on a broken assertion. CLI policy edits reject
  a breaking change before saving it, and the listener validates at startup
  and before every call so a hand edit fails closed.

### Changed — roster join credentials are independently manageable

- The single roster-wide join secret is replaced by keyed credentials with a
  stable public prefix, reveal-once secret, mandatory expiry, one-off or
  reusable scope, metadata-only listing, and individual revocation.
- `agentcall roster key issue|list|revoke` replaces roster-wide rotation
  (`agentcall roster rotate` is gone). Each takes `--line <name>`, since a
  roster membership belongs to a line. Revocation retains members by default;
  `--evict` removes only members that joined through the selected key.
- Roster creation still has a one-paste onboarding path by returning an
  initial reusable key with a 30-day expiry. The relay retains only the secret
  half's SHA-256 digest and each member's admission-key provenance.

### Added — administrator-managed policy ceiling

- macOS and Linux now have fixed, `AGENTCALL_HOME`-independent managed-policy
  paths. Administrators can cap every task grant and impose unoverridable caller
  blocks without rewriting the user's policy. The ceiling is machine-scoped and
  applies to every line, so adding a line cannot escape it; each line keeps its
  own user policy underneath it.
- Missing managed policy remains unmanaged behavior; unreadable, malformed, or
  invalid managed policy fails closed instead of falling back to user defaults.

### Changed — verifiable npm releases

- Every third-party GitHub Action is pinned to an immutable commit.
- Published releases now build and test both packages from the tagged `main`
  commit, publish through npm OIDC with keyless provenance, and attach the exact
  tarballs, SHA-256 checksums, and a CycloneDX SBOM to the GitHub release.
- Clean tarball consumers now exercise `agentcall doctor` on Node 20, 22, and
  24, enforcing the published CLI's declared runtime floor.

### Changed — roster mutations emit complete audit evidence

- Roster audit events now use stable `roster.*` names and record CRUD action,
  organization, actor authority, typed target, source IP/country, description,
  and timestamp. Join-key issuance, revocation, and provenance-scoped eviction
  have their own `roster.join_key.*` event types alongside roster creation,
  membership changes, and deletion.
- A persistent per-roster budget bounds membership audit growth independently
  of source IP. Exhaustion is recorded once, while administrative recovery and
  security operations remain available.

### Changed — Durable Object lifecycle is declarative

- Relay deployments now declare `HandleDO` and `RateLimiterDO` as SQLite-backed
  Durable Object exports instead of maintaining an ordered migration-tag ledger.
  This preserves the existing namespaces while making future class renames,
  transfers, and deletions explicit in Wrangler's deployment reconciliation.

### Added — multi-turn calls: `agentcall call --continue`

- **`agentcall call <address> "..." --continue`** follows up on your last
  conversation with that address instead of starting a fresh one, reusing the
  answering agent's session. `--context <id>` targets a specific conversation
  by id rather than "the last one". Conversations expire 30 minutes after
  their last turn and are capped at 10 turns; a conversation is scoped to the
  caller and to the task it started on, and cannot be handed to someone else
  or moved to another task.
- **`threadable` in a task's `SKILL.md` frontmatter** opts a task into
  `--continue`. Tasks granting `write` or `exec` are not conversational by
  default — a caller's earlier messages persist in the agent's context across
  turns, which is a materially worse risk against those capabilities than
  against a read-only one — but read-only tasks default to threadable.

### Changed — `session_id` is now an opaque callee-minted `context_id`

- The protocol's `session_id` field is renamed `context_id` and no longer
  carries the answering agent's real session id — that value never leaves the
  callee's machine. `context_id` is instead a token the callee mints and
  hands the caller back, which the callee looks up against its own local
  binding store on the next turn.
- `RATE_LIMIT_PER_HOUR` raised from 10 to 30, so a normal multi-turn
  conversation doesn't consume a caller's entire hourly budget.

### Fixed — `doctor`'s tool-guard check called healthy installs broken

The check asked a real `claude` spawn to read a canary `.env` and required a
`tool_denied` record as proof the guard fired. That proof only exists if the model
actually attempts the read — and on some models and versions it declines on its own,
or claude's own built-in protection denies the read first (which suppresses the hook
entirely). A fresh, correct install then reported `✗ tool guard — no denial was
recorded`, under a fix hint (`run pnpm build in packages/cli`) that means nothing to
anyone who installed from npm.

The check now separates "the guard did not stop a protected read" from "the guard was
never asked". The inconclusive case is settled by invoking `guard-entry.js` directly
with a synthetic `PreToolUse` payload — no model involved, ~50ms — and reports `!`
with the model's own words, leaving doctor's exit code at 0. A genuinely broken guard
still fails, and the reinstall hint now names both `npm i -g @benree/agentcall` and
the in-checkout `pnpm build`.

`VerifyCheck` gained a `warn` flag; `formatCheck` renders it as `!` with a `note:`
rather than a `fix:`.

## 0.4.0 — 2026-08-01

### Added — roster-based discovery: `agentcall search`, `agentcall roster`, task `keywords`

- **`agentcall search "<question>"`** finds which colleague's agent can answer
  something, ranked over the rosters you've joined. The ranker runs entirely
  on your machine — the relay never sees the query text, only that your
  handle refreshed a roster (and when). `--json` gives a machine-readable
  result for your own agent to parse, `--roster <name>` scopes to one roster,
  and `--offline` ranks against the last cached bundle without refreshing.
  A result is prefixed with `[roster-name]` only when more than one roster is
  in scope. If every joined roster fails to refresh, the command exits
  non-zero; a partial failure across several rosters still exits `0`, with
  the affected roster called out as stale in the output.
- **`agentcall roster create|join|list|forget`** — an opt-in discovery group.
  One person creates a roster and shares its id and join secret once (the
  relay stores only a SHA-256 digest of the secret); everyone else joins with
  `agentcall roster join <id> --secret <secret>`. `forget` only drops the
  local record of having joined — there is no leave operation, so membership
  on the relay is unaffected.
- **`keywords` in a task's `SKILL.md` frontmatter**, published on the agent
  card and weighted highest by search (`keywords` 3, task name 2, description
  1 per matching word). A result must clear a minimum score to be shown at
  all, so a single word incidentally shared with a description does not
  surface a task that can't actually help — this came from a real
  over-firing case during development.
- Relay: `POST /v1/roster`, `POST /v1/roster/:id/join`, and
  `GET /v1/roster/:id/bundle` (filtered per caller), backed by the new
  `rosters` and `roster_members` tables (migration `0004_rosters.sql`).

### Known issue — no way to expel a roster member or rotate a roster secret (unfixed)

- A roster has no membership-lifecycle operations beyond joining: nobody can
  be removed, and the join secret can't be rotated. A leaked secret means
  abandoning the roster and creating a new one. `agentcall roster forget`
  only erases the local record of having joined; it does not leave the
  roster, so a member who believes they left is still visible to everyone
  else's search.

### Known issue — Codex reaches the filesystem without the shell, and unrecorded (unfixed)

- **`view_image` is a general file-read primitive, not an image viewer.** It does
  not validate that its argument is an image: pointed at a text file outside the
  workspace it returns the raw bytes as
  `{"image_url":"data:application/octet-stream;base64,…"}`. `apply_patch` also
  reads a file, to verify patch context. Both are reachable in the exact
  `buildSpawnSpec` shape under `--ignore-user-config --sandbox read-only`.
- **Neither leaves any record.** They emit no event that `parseCodexJsonl` reads
  (it extracts `agent_message` only), so a read through them appears in no log —
  not `tools.log`, not `calls.log`. This corrects a README claim that Codex
  "reaches the filesystem entirely through `Bash`", which was the stated
  justification for the guard being observe-only.
- **A machine-wide `deny_read` does stop them.** Verified against codex-cli
  0.146.0: with `/etc/codex/requirements.toml` installed, all three routes
  (`exec_command`, `view_image`, `apply_patch`) fail with
  `Operation not permitted (os error 1)`. That is the C.2 read floor, which is
  *not* shipped — `agentcall` neither installs nor currently requires it.
  `scripts/verify-codex-deny-read-p2.sh` is the repeatable check.

### Fixed — the guard's fail-closed paths could fail open (security-relevant)

- **Exit 2 now carries a reason on stderr.** Claude blocks on exit 2 regardless
  of stderr, so this was invisible while the guard was Claude-only. Codex blocks
  on exit 2 *only* when stderr carries a reason and treats an empty one as a
  merely-failed hook — which runs the tool. Every fail-closed path was therefore
  a fail-*open* path the moment the same entry point reached a Codex spawn.

### Added — the Codex spawn is now observed, and no longer loads your `~/.codex`

- **`--ignore-user-config` on the Codex spawn.** A Codex answering agent used to
  inherit the owner's whole `~/.codex`: MCP servers, plugins and apps. Those are
  separate processes that reach the filesystem outside Codex's sandbox, so a
  caller could route around every control in the CLI — on a typical dev machine
  that means a filesystem MCP server, and often `claude mcp serve`, which
  re-exposes `Read` and `Bash`. Claude fences these off with `--allowedTools`, an
  allowlist `mcp__*` names never match; Codex has no equivalent, so not loading
  them is the only lever. Codex's own bundled `codex_apps` tools are **not**
  removed by this flag.
- **The PreToolUse guard is registered on the Codex spawn**, inline via `-c` so
  the owner's `~/.codex/hooks.json` is untouched — the Codex analogue of the
  inline `--settings` used for Claude. It runs in **observe** mode: it records
  attempts and never blocks. Codex has no `Read`/`Grep`/`Glob` and reaches the
  filesystem through `Bash`, which the guard records rather than blocks, so
  enforcing would add no protection while denying Codex tools it cannot classify
  (`apply_patch`) and breaking the runtime. **This is not read-guard parity, and
  the README no longer implies it is.** `tools.log` lines from a Codex spawn
  carry `"mode":"observe"` and omit `allowed`, because PreToolUse reports what
  was attempted, not what was permitted.
- **`~/.codex` joins the denied paths** for a Claude answering agent, on the same
  argument that put `~/.claude` there: it holds `auth.json` and a `config.toml`
  that routinely carries API keys in plaintext.

### Changed — the callee side is now cancellable (relay not yet switched over)

- **`call_answer` is split into `call_accepted` and `call_started`.** The
  listener now sends the two separately instead of one combined
  acknowledgement, so a future relay can distinguish "the listener has
  admitted this call" from "the agent has actually started running." The
  relay is deliberately untouched by this change and still only understands
  `call_answer` — it never receives either new frame, so it never emits
  `call_status answered`. **The caller-facing `answered` status is dark until
  the relay is switched to the new frames in the next plan.**
- **New `cancel_call` / `call_cancelled` / `call_not_cancelled` frames.** The
  relay can ask the listener to cancel a call in flight; the listener
  acknowledges only after the pending job is confirmed removed or the running
  agent's process group is confirmed exited — never on signal-sent — and
  reports `call_not_cancelled` when the `call_id` is unrecognized. (`reason`s
  `too_late` and `already_terminal` are reserved for the next plan; see
  `docs/superpowers/plans/2026-08-01-a2a-listener-protocol.md`.)
- **`maxPending` changed from 5 to 0.** The listener now refuses a second
  concurrent call outright instead of queuing it. With a 5-minute agent
  timeout running against a 6-minute relay deadline measured from submission,
  a queued call would not have enough budget left to finish in time, so
  queuing it was never actually safe.

### Removed — the OS-level sandbox (breaking, security-relevant)

- **Spawned agents are no longer wrapped in Seatbelt.** Every call used to run
  under `npx @anthropic-ai/sandbox-runtime --settings <file>`, with
  deny-by-default reads and a network allowlist. That wrapper is gone: the
  answering agent is meant to be the owner's real agent with the owner's real
  context, which a confined fresh spawn cannot be. Enforcement is now
  capability scoping (`--allowedTools` for claude, `--sandbox` level for codex)
  plus pre-prompt task resolution. **Within a granted capability, nothing
  constrains where the agent reads or writes** — see the security model in the
  README before sharing your address.
- `~/.agentcall/srt.json` is no longer written or read. Existing files are
  inert and can be deleted; `agentcall uninstall --purge` removes them.
- `~/AgentCall/public` as the working directory is now a prompt instruction
  rather than an enforced boundary.

### Removed — `write_paths` and `network` task frontmatter

- Both fields existed only to populate the sandbox's `allowWrite` and
  `allowedDomains` lists, so they no longer grant anything. They are ignored if
  present in an existing `SKILL.md`, which keeps old task files loading. Task
  capabilities are now expressed by `tools:` alone.

### Added — optional `workdir`

- **`workdir` in `~/.agentcall/config.json`** sets the absolute directory the
  answering agent runs in, so calls can be answered with real project context
  instead of from an empty share folder. Defaults to `~/AgentCall/public`, and
  is deliberately *not* prompted for during setup — it's a two-second question
  for a developer and an unanswerable one for everyone else.
- Resolved once at listener start, so a relative, missing, or non-directory
  path stops `agentcall listen` with a clear message rather than failing every
  inbound call. `agentcall doctor` reports it as its own check.
- When `workdir` is set, the prompt no longer instructs the agent to stay
  inside its working directory.

### Removed — the `tier` field

- Task frontmatter, the `Task` type, and the `CardTask` protocol schema all
  carried a `tier` of `"T1" | "T2"`, with T2 reserved for approval-gated tasks.
  Nothing ever branched on it and the approval gate isn't being built, so it's
  gone. `tier` in an existing `SKILL.md` or in a card already stored on the
  relay is ignored rather than rejected, and `agentcall card` no longer prints
  a `[T1]` marker next to each task.

### Changed — platform-specific listener code is isolated

- `launchd.ts` is now the only module that knows the background listener is a
  macOS LaunchAgent. `Paths.plistFile` is gone; callers use
  `isLaunchAgentInstalled(paths)` instead of testing for a plist. Groundwork
  for a non-macOS listener — no behavior change.

### Fixed

- `agentcall --version` reported `0.2.0` on a `0.3.0` package.
- `agentcall doctor` gained a `workdir` check.

## 0.2.0 — 2026-07-16

Two headline features: **task menus** (owners scope what callers may do) and
**caller-only installs** (register just to call, no agent to answer).

### Added — Task menus & agent cards

- **Task-scoped capabilities.** An owner defines a menu of named tasks under
  `~/AgentCall/tasks/<id>/SKILL.md`. Each call is resolved to one task *before*
  the agent spawns, and the agent runs with only that task's tools, writable
  paths, and network domains — enforced by both agent flags (`--allowedTools` /
  codex sandbox level) and the srt sandbox. A caller's message can never widen
  the capability set.
- **Built-in `ask` task.** A read-only Q&A task is always available; it needs no
  files and answers using the public directory only.
- **Agent cards.** `agentcall card <address>` shows another agent's task menu
  (personalized to what you're granted). Owners review their own card and lint
  it for problems with `agentcall card` (no arguments), and publish with
  `agentcall card push`. Cards are stored on the relay and fetchable while the
  callee is offline.
- **Policy verbs** rewrite `~/.agentcall/policy.json` and republish your card:
  `agentcall allow <handle> <task>`, `revoke`, `block`, `unblock`,
  `offer <task>`, `unoffer`.
- **`agentcall task new <id>`** scaffolds a ready-to-edit task file.
- **`agentcall call --task <id>`** picks a task explicitly; refusals come back
  with the menu of tasks you *are* offered.

### Added — Caller-only mode

- **`agentcall setup --caller-only`** registers a handle for calling out without
  installing the background listener or any answering machinery — useful on a
  machine with no agent, or where you only initiate calls.
- Interactive setup now asks whether to make your agent callable and falls back
  to caller-only when neither `claude` nor `codex` is found.
- Re-running `setup` on a caller-only install upgrades it to callable once an
  agent is present.

### Changed

- **Plain calls now run the read-only `ask` task.** A call without `--task` no
  longer gets full workspace access by default — it runs `ask` (read-only). To
  offer write/exec/network capability, define a task with those tools and grant
  it (`agentcall offer <task>` or `allow <handle> <task>`). This is the
  intended least-privilege default; it changes behavior for anyone who relied
  on plain calls having full access.
- Task definitions are a single YAML-frontmatter `SKILL.md` per task (the
  directory name is the task id). There is no separate manifest file.

### Fixed

- **Relay would fail to start** because it exported a non-handler value from the
  worker entry module; current workerd rejects that. (Blocked deploys.)
- **Sandboxed spawns failed with exit 127** inside terminal wrappers (e.g. cmux)
  when an ephemeral per-session shim shadowed the real agent binary on `PATH`;
  the runner now prefers the durable install.
- `write_paths` in a task are restricted to `public` and its subpaths, so a task
  can't declare a writable directory the sandbox would deny anyway.
- The `offered` list on error frames is bounded and validated, closing a
  terminal-injection vector from a hostile callee.

### Protocol (`@benree/agentcall-shared`)

- `call_request` / `incoming_call` / `call_result` gain an optional `task`;
  `call_reply` echoes it.
- New error codes: `blocked`, `task_not_offered`, `task_unknown`.
- Error frames carry an `offered: string[]` menu.
- `RegisterRequest.agent_kind` is optional (caller-only registration).
- New relay route `GET /v1/card/:handle` (public and authenticated views) and
  `PUT /v1/card`.

### Migration (relay operators)

- Apply the D1 migrations before deploying the new worker:
  `cd apps/relay && npx wrangler d1 migrations apply DB --remote`
  (adds the `cards` table and makes `handles.agent_kind` nullable).

## 0.1.2 — 2026-07-14

- Keep ephemeral temp shim directories out of the LaunchAgent PATH.
- Survive launchd bootstrap races; skip the agent prompt on reuse.

## 0.1.1

- Setup no longer hangs on the second interactive prompt.

## 0.1.0

- Initial release: call another person's sandboxed coding agent by address over
  a shared relay, with a resident listener for instant answers.
