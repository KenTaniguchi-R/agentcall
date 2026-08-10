# Employee transparency statement

Last reviewed: 2026-08-03 against the E2EE cutover, local abuse-signal
filtering, and opt-in local telemetry implemented in issues #216, #47, and
#187. Release verification remains pending.

AgentCall lets another person ask a coding agent to run on your machine. This
page is for the person whose machine and agent account do that work. It states
what each party can see, which actions are automatic, and where the current
controls stop.

## The short version

- Making your agent callable is optional. If you opt in, an offered task runs
  automatically when an authenticated member of your organization calls it.
  There is no per-call approval prompt or ringing UI.
- The default offered task is `ask`, a read-only task intended to answer from
  `~/AgentCall/public`. A task's declared capabilities and caller policy are
  resolved before the caller's message enters the prompt.
- Capability labels are not an OS sandbox. In particular, a task with `exec`
  can use your user account's filesystem and network access, and a Codex-backed
  answering agent has no enforced read boundary. The full residual-risk detail
  remains in the README security model.
- AgentCall has no domain allowlist. A Claude `fetch` grant enables web tools
  without constraining destinations, and AgentCall does not impose a domain
  policy on Codex network access.
- Nested calls are unsupported. The normal CLI refuses them inside an inbound
  answer to stop accidental loops, but that environment check cannot constrain
  a hostile shell-capable process sharing your account and line credential.
- Your local logs belong to this installation. They are not automatically an
  employer-visible call-history service. The hosted relay separately keeps
  identity, invite, card, and security-audit data described in the cloud data
  map, plus retained legacy roster rows that current routes no longer use.
- AgentCall exports no local telemetry by default. An operator can opt the
  listener into OTLP export; when enabled, bounded call metadata, timing, and
  paired tool lifecycle identity/outcome may leave the endpoint for the
  operator-selected collector. Tool arguments, results, paths, prompts,
  replies, and error text are excluded from tool lifecycle spans.

## What the caller can see

Before a call, an authorized caller can fetch the tasks your effective policy
publishes to them. During a call they receive status changes, the final reply,
or a bounded failure reason. They do not receive your local `calls.log`,
`tools.log`, agent session identifier, policy file, or tool-denial details.

The caller can nevertheless influence what your agent reads and says through
their message. If the selected task permits access to a file or network
resource, the agent can use that information in its reply, which makes the
reply visible to the caller. The relay forwards only signed HPKE ciphertext. A policy controls which
task is selected; it cannot make an unsafe instruction harmless inside a broad
task.

## What you can see on your machine

`agentcall history` reads two newline-delimited JSON files under
`~/.agentcall/`:

- `calls.log` records caller, task, outcome, duration, and the first 500
  characters of the incoming message. Successful calls now also record the
  first 500 characters of the reply. Failures may contain a bounded local error
  detail, and noteworthy guard decisions may contain local path details.
- `tools.log` records tool attempts that reach the installed guard, including
  the tool name and—when the guard is enforcing—its allow/deny result.
  `agentcall history` reports counts, not tool arguments or guard details.

The command shows the newest 20 calls by default; `--limit` accepts 1–100,
`--flagged` filters objective local policy-refusal and tool-denial signals,
and `--json` emits the same local entries for scripts. These flags do not
classify message intent and are detection, not prevention. It warns when malformed JSON
records were skipped. To keep the command bounded, each log scan reads at most
the newest 4 MiB and warns when older bytes were not inspected; tool counts may
then be partial. It does not prove that every action was observed: shell command
text receives weak denied-path substring inspection, which can flag but does
not enforce a boundary; Codex guard mode observes rather than blocks; and Codex
routes such as `view_image` and `apply_patch` do not currently reach this hook.

These files have no automatic rotation or retention window. `agentcall
uninstall` stops the listener but keeps them; `agentcall uninstall --purge`
deletes the local AgentCall directory. Device backup, endpoint management, and
any copies made outside that directory remain separate responsibilities. On
write, AgentCall enforces mode 0700 on `~/.agentcall` and 0600 on both audit
files, including repairing older files created under weaker umask permissions.

## What your organization can see

AgentCall ships an administrator-only organization audit export. Current
organization and call-lifecycle mutations create D1 audit events containing
actor/target identifiers, timestamp, source IP/country, and descriptions.
Historical roster events remain exportable, but no current route creates new
ones. These ledgers do not contain call prompts or replies. Their retention and
export-before-expiry requirements are documented in the
[audit retention policy](./audit-retention.md).

An administrator-managed policy can place a ceiling on offered tasks and block
callers. The machine owner's user policy cannot widen that ceiling. Managed
policy is not a remote screen-sharing or local-log collection mechanism.

Separately, an operator who sets `AGENTCALL_OTEL=1` on the listener can export
local OpenTelemetry spans and metrics to an OTLP destination they configure.
Those records contain bounded call/correlation/context identifiers, runtime,
task, lifecycle timing/outcome, and—for exactly paired hook observations—a
bounded tool name and stable tool-call ID. They exclude caller messages,
replies, handles, tool arguments/results, paths, policy details, error text,
and agent session IDs. Codex failures without a post hook are omitted rather
than inferred. Raw tool-call IDs are exported only as per-invocation keyed
digests and tool names come from a fixed allowlist. The transient mode-0600 hook
spool stays in AgentCall's private state outside the configured worktree and
Codex writable sandbox, is capped at 256 KiB/512 events, and is
consumed and deleted at invocation end. Destination access, retention,
residency, and employee notice are the operator's responsibility. Claude
`exec` has no OS filesystem boundary, so these hook observations are not an
audit-grade source even with the channel's validation and export constraints.

## What the relay operator can see

Call messages, task and context identifiers, replies, and peer-authored failure
details traverse the hosted Cloudflare Worker, Durable Object, and WebSockets
only inside signed HPKE envelopes. The relay operator can inspect ciphertext
and still sees organization, caller/callee handles, call
IDs, lifecycle/timing metadata, source-network metadata where available, and
payload sizes. Endpoint-local prompts, agent output, and local audit files are
plaintext on their owning machines. Provider processing and account-level
metadata logging settings remain separate from application behavior.

The relay persistently stores identity, credential verifiers, cards, invites,
security-audit evidence, and legacy roster rows retained by append-only
migrations. Current call routing and policy do not read those roster rows. The
exact fields, logical retention, Cloudflare surfaces, and residency limitations
are listed in the [cloud data map](./data-residency.md).

Status-read analytics contains only identity-unlinked allowed/denied points and
timestamps. It does not contain the organization, viewer, target, source IP,
country, or online/offline result. Exact timestamps can still be correlated with
information held elsewhere, while sampling prevents this dataset from reliably
or completely reconstructing a person's presence access history. A non-personal
D1 health row counts only binding-call failures the Worker observed locally.

## What AgentCall does not automatically collect

AgentCall does not implement keystroke capture, screenshots, webcam/microphone
capture, email collection, browser-history collection, or an inventory of your
unrelated agent sessions. It does not upload your local call/tool logs to the
hosted relay. Opt-in OTLP exports are separate metadata records, not uploads of
those log files.

This is not a claim that the answering agent cannot reach those data. It runs
as your user, and a sufficiently broad task may read local files, call network
services, or include discovered content in its reply. Those actions are subject
to the capability and guard limitations above.

## Your controls

- Decline callable setup, or run `agentcall uninstall` to stop the background
  listener while keeping your local configuration.
- Run `agentcall policy` to review the effective per-caller/per-task envelope.
- Use `agentcall block <handle>` or remove task offers before future calls.
- Use `agentcall history` to review local activity after calls.
- Use `agentcall uninstall --purge` to remove AgentCall's local configuration
  and logs. This does not delete hosted relay identity/audit data; the hosted
  service has no supported subject-erasure workflow today.

There is no current control to approve or reject one individual incoming call
after it arrives. Stopping the listener or changing policy affects subsequent
delivery; it does not retract data a caller or relay operator already received.
