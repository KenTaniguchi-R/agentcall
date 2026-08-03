# MCP positioning and enterprise authorization — decision

**Date:** 2026-08-02  
**Status:** Accepted product and protocol decision  
**Research:** [MCP Tunnels and Enterprise Managed Authorization](../../research/2026-08-02-mcp-tunnels-ema-positioning.md)

## Decision

AgentCall is not a private-network tunnel. Its differentiated product is **governed,
person-scoped delegation to another person's agent**: the callee keeps their own agent,
context, policy, and judgment; the caller receives only the permitted result; and the
authorization decision and evidence sit at that human boundary.

MCP Tunnels is therefore a high-threat substitute for reachability, not a direct
competitor for the whole product. “Call an agent behind a firewall without deployment”
is now table stakes and must not be the headline claim.

We will not add an MCP server in front of the relay now. The public protocol direction
remains A2A. We will not claim Enterprise Managed Authorization (EMA) compatibility for
the non-MCP relay.

## The boundary AgentCall must own

The durable differentiation is the policy boundary, not the wire. The current
foundation is:

- a stable address for a person and the agent they choose to answer with;
- caller-specific task grants resolved before caller text reaches the answering prompt;
- execution in the callee's current working context rather than a copied knowledge base.

The complete product boundary still requires work already tracked elsewhere:

- explicit separation of human, service, and agent principals;
- local evidence plus appropriately redacted organization-visible evidence of delegated
  requests, authorization decisions, tool attempts, and outcomes;
- revocation, departure, and administrative recovery semantics around that delegation.

Transport standards may commoditize discovery, connectivity, and envelopes. We should
adopt them where they reduce proprietary surface, while retaining the enforcement and
evidence boundary above.

## EMA applicability

EMA is an opt-in MCP authorization extension. Its enterprise flow uses an identity
provider token and OAuth token exchange to obtain an access token for an MCP resource.
The underlying architecture is useful precedent for #15 and #27:

1. organization administration establishes trust in an enterprise identity provider;
2. a human or workload identity presents verifiable enterprise identity;
3. the authorization service exchanges that identity for an audience- and
   scope-constrained service token;
4. the resource server still enforces AgentCall's application policy.

That is a reusable **shape**, not EMA adoption. A non-MCP service cannot truthfully
advertise EMA interoperability without implementing the MCP authorization roles,
protected-resource metadata, discovery, and extension negotiation. Designs for #15 and
#27 may reuse the relevant OAuth standards and trust model, but must describe the result
as AgentCall authorization unless an MCP surface is actually implemented and tested.

## Why no MCP front door now

An MCP facade would expose a person's autonomous agent as a tool server. That mapping is
possible, but it introduces a second public capability vocabulary, a second discovery
and authorization surface, and a new client-principal-to-AgentCall-caller binding. It
does not solve the product's hard problems: caller-specific grants, pre-prompt policy,
agent identity, audit evidence, and safe execution.

Those costs are unjustified while the A2A cutover and its security gates remain open,
and there is no named customer requiring MCP distribution. An MCP facade also risks
making the answering agent look like a stateless tool, obscuring the person-scoped
delegation boundary that distinguishes AgentCall.

## Revisit trigger

Reconsider an MCP front door only when all of these are true:

1. a named design partner needs MCP-native distribution rather than A2A or the CLI;
2. AgentCall has a documented mapping from MCP client and enterprise identity to the
   caller principal used by `resolveTask()`;
3. endpoint security, signed agent identity, and audit evidence are shipped;
4. the facade can remain a thin adapter over one policy and task model rather than
   creating MCP-only capabilities;
5. interoperability is demonstrated with a pinned MCP conformance target, including
   EMA if that is part of the customer requirement.

Until then, monitor MCP Tunnels as a substitute and EMA as an authorization reference.
