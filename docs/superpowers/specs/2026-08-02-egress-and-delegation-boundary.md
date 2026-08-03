# Egress and delegated-call boundary

Date: 2026-08-02  
Decision: accepted; accidental-loop interlock implemented, structural controls not implemented  
Issue: #112; constrains #1, #8, #10, #17, #99, #104, #111, #114, and #154

## Current facts

AgentCall does not own an OS-level network boundary. Task capabilities select
agent-runtime tools; they are not a domain firewall.

- A Claude task without `fetch` does not receive `WebFetch` or `WebSearch`, and
  one without `exec` does not receive `Bash`. A `fetch` grant enables the web
  tools without a domain allowlist. An `exec` grant gives Bash the user's
  practical filesystem and network reach.
- A Codex answer runs with `--ignore-user-config` and a native read-only or
  workspace-write sandbox, but AgentCall cannot map `fetch` and `exec` into
  separate Codex controls and does not impose or audit a domain allowlist. The
  exact network behavior belongs to the installed Codex/runtime/platform and
  is not an AgentCall policy guarantee.
- The model API and the reply to the caller are allowed data-exit paths. Even a
  future domain proxy cannot prevent a model from encoding permitted input into
  traffic sent to a permitted model endpoint.

The relay authenticates only the immediate line credential. `CallRequest` and
`IncomingCall` carry no origin, run, sponsor, or parent. Local `calls.log`
therefore records only the immediate `from` handle. A spawned answering process
also runs as the machine owner and can read or reuse the line credential when
its granted/runtime capabilities allow it. The relay cannot distinguish that
reuse from a fresh call the owner initiated.

`context_id` is not a delegation carrier. It is a callee-minted opaque binding
for conversation continuity, scoped to one caller, task, workdir, runtime, TTL,
and turn budget. A2A likewise defines `contextId` as conversation grouping, not
an authorization or accountability chain.

## Egress decision

Do not add `egress` domains to `policy.json` and do not inject
`HTTP_PROXY`/`HTTPS_PROXY` as a purported security control. A process can ignore
or remove those variables. Shipping that shape under the same policy vocabulary
as enforced task admission would be security theatre.

Keep the current runtime capability labels and disclose their exact limits.
They reduce accidental reach, especially for Claude first-class tools, but they
do not establish a cross-runtime destination boundary.

A future higher-assurance egress profile must enforce outside the answering
process. Its minimum contract is:

1. the run has no direct default route; its only network path is a controlled
   gateway/proxy or an administrator-owned equivalent;
2. default deny, named destination groups, and policy failure that denies;
3. IP-literal refusal and address-range validation after DNS resolution on each
   connection, including metadata/private/link-local ranges;
4. end-to-end TLS tunnelling by default, with interception only as a separate,
   disclosed operator policy;
5. bounded audit events and durable degradation health, correlated to the run;
6. explicit model/API lanes and an honest statement that an allowed model
   channel remains an exfiltration path; and
7. conformance tests that try direct sockets, ignored proxy variables, DNS
   rebinding, IPv4/IPv6 literals, redirects, and policy-engine failure.

If this substrate also enforces delegation, its AgentCall relay lane must force
answering-run traffic through the run broker. Allowing a direct relay connection
with the owner's root line token would bypass the entire chain even if every
other destination were perfectly filtered.

This likely belongs to managed deployment or a self-hosted runner substrate,
not an unprivileged npm process on an employee Mac. MDM firewall/network
extension policy can be another conforming enforcement adapter if it can bind a
decision to the answering run rather than to every process owned by the user.

## Delegation decision

Nested AgentCall delegation is unsupported now. The CLI refuses `agentcall
call` when `AGENTCALL_CALL_ID` says it is running inside an inbound answer. This
prevents the normal accidental A → B → A loop before it opens a socket. It is an
interlock, not a security boundary: a shell-capable process can remove the
environment variable or use the line credential directly.

Do not add a caller-supplied hop counter or origin array to the current wire
protocol. Either can be omitted or reset. Governed delegation becomes supported
only when all of the following land together:

- **Stable principals.** Chain entries use stable `agent_id` values, not
  reclaimable handles. The root principal comes from native AgentCall identity
  or the authenticated A2A-principal mapping in #10.
- **Secret isolation and forced mediation.** The answering run cannot read the
  owner's line credential. Direct relay traffic from that run is blocked or
  mediated so it cannot present a copied root token. A trusted broker holds the
  root authority and exposes only the specific delegated-call operation.
- **Per-run authority.** The relay or broker mints a short-lived,
  audience-bound run credential for the accepted call. The forced downstream
  path accepts that credential and rejects an absent/reset parent chain.
- **Relay-attested chain.** The parent chain, origin, acting run, sponsor, task,
  and inherited authority are integrity-protected claims. The relay appends the
  authenticated hop; the model never authors the chain.
- **Hard depth and cycle rules.** Initial policy is at most two delegated hops
  (A → B → C). Depth is derived from the attested chain, and a target whose
  stable `agent_id` is already present is rejected before delivery/spawn.
- **Authority intersection.** A child receives the intersection of inherited
  delegation authority and the callee's local/managed policy. Current task
  capability labels are callee-owned and are not yet a sufficient shared scope
  vocabulary, so “child scopes are a subset” cannot honestly be implemented by
  comparing task names.
- **Accountability without invented humans.** Audit records carry origin agent,
  acting agent/run, sponsor principal, chain/parent run, depth, and decision.
  Until AgentCall has organization/human ownership, `sponsor` is unavailable;
  a handle must not be mislabeled as a human sponsor.
- **Cascade.** Cancellation, expiry, or revocation of a parent run rejects new
  children, revokes descendant credentials, and attempts bounded cancellation
  of active descendants. Every partial failure remains visible.

Conformance must run from inside the real answering substrate and attempt the
known bypass: read the normal line config, send the owner root token directly to
the relay call endpoint, remove the interlock environment variable, and use a
raw socket instead of the CLI. Governed delegation cannot ship unless all paths
fail while the brokered run credential succeeds.

The private listener/relay frame may eventually transport a compact delegation
envelope, but A2A should carry it through an explicitly negotiated extension or
authenticated token claims—not `Task.contextId`. A2A authorization remains
implementation-defined and requires servers to authorize the authenticated
principal; it does not supply AgentCall's sponsor or chain semantics.

## Reference patterns

- [Wardyn](https://github.com/cjohnstoniv/wardyn) separates human `sub`, acting
  run `act`, and accountable `sponsor`, and treats a gatewayless run plus an
  external proxy as the structural egress boundary.
- [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
  defines `contextId` as conversational grouping and leaves authorization to
  the implementation.
- Paddock's CONNECT proxy and kitelogik's depth/scope rules remain useful
  reference patterns, but their controls only transfer when AgentCall has an
  equally structural enforcement point and a comparable authority vocabulary.
