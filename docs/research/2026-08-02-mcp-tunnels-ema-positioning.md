# MCP tunnels, Enterprise-Managed Authorization, and agentcall's boundary

**Date:** 2026-08-02  
**Status:** Research and recommendation, not an implementation decision  
**Source discipline:** Primary sources only: the MCP and A2A specifications,
their official project repositories, and Anthropic's product documentation.

## Executive conclusion

Three things that appeared together in Anthropic's 28 July announcement are
different kinds of artifact:

1. MCP `2026-07-28` is an open protocol release.
2. Enterprise-Managed Authorization (EMA) is a stable, opt-in MCP extension.
3. MCP tunnels are an Anthropic product in research preview, not part of MCP.

MCP tunnels erase private-network reachability as a differentiator. They do not
erase agentcall's defensible product: delegation to a separately owned agent whose
owner controls its context and per-caller policy, with refusal and an agent-to-agent
audit trail. We should stop leading with transport.

AgentCall should not offer an MCP front door now. Reconsider it for a named design
partner only as an optional adapter over the same call service as A2A. A2A remains the
canonical agent-to-agent protocol. Do not build a second execution or authorization
model, and do not block the product on tunnels.

## 1. Correct the release record

[Anthropic's 28 July post](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
announces the fifth MCP specification and then, in a separate "Advancing MCP in
Claude" section, lists Claude product features shipped during the year, including
EMA and MCP tunnels. The official
[MCP `2026-07-28` release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
covers the stateless core, extensions framework, Apps, Tasks, authorization
hardening, deprecations, JSON Schema, and governance. Tunnels are not a protocol
feature.

Anthropic had already announced tunnels on 19 May. Its current
[tunnels documentation](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview)
calls the feature a **research preview**, supplied as-is with no uptime, support,
or continuity commitment and dependent on Cloudflare transport. Anthropic may
change or discontinue it. Therefore the precise description is:

> MCP tunnels are an Anthropic connectivity product for MCP servers, highlighted
> alongside the MCP `2026-07-28` launch; they are not part of the open MCP spec.

### What tunnels actually provide

The customer deploys `cloudflared` and an Anthropic proxy inside its network. The
connector makes an outbound-only connection; the proxy terminates inner TLS,
checks upstream IPs, and routes hostnames to private MCP servers. Tunneled servers
are reachable from Claude Managed Agents and the Messages API. Console-created
tunnels are explicitly not claude.ai connectors
([overview](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview)).

The tunnel is transport, not authorization. Anthropic states that it does not
authenticate to the upstream MCP server; upstream OAuth or bearer authentication
remains independent. Its security model combines outer mTLS/IP validation, inner
TLS, and per-server OAuth. Cloudflare cannot read payloads but can observe connection
metadata. Theft of both the tunnel token and a TLS private key permits proxy
impersonation and payload access
([overview](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview)).

This means "MCP tunnels have no identity or policy" would be an overclaim. The
tunnel itself does not provide them, but the upstream MCP server can enforce OAuth,
user authorization, scopes, and audit. Anthropic's
[hardening guidance](https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/security)
requires OAuth on every server, minimal upstream CIDRs, constrained network reach,
least-privilege tool exposure, monitoring, and credential rotation.

## 2. EMA: adopt the standards, not the label

EMA (`io.modelcontextprotocol/enterprise-managed-authorization`) is an official
**stable** extension. Extensions are opt-in and never active by default
([MCP extension documentation](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)).
It replaces per-server interactive authorization with an IdP-mediated flow: the
enterprise IdP decides whether a user and MCP client may obtain particular scopes
for an MCP server.

The normative
[stable specification](https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx)
is a profile of existing OAuth/OIDC machinery:

- SSO supplies an OIDC ID token or SAML assertion.
- [RFC 8693 token exchange](https://datatracker.ietf.org/doc/html/rfc8693)
  obtains an Identity Assertion JWT Authorization Grant (ID-JAG).
- [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) exchanges that
  signed assertion at the resource authorization server.
- [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) identifies the MCP
  protected resource and its authorization server.
- The resulting access token must be audience-restricted to that MCP server.

The IdP can enforce user, client, server, resource, and scope policy during token
issuance. It does not observe or govern the later MCP traffic; the stable spec says
its visibility ends at access-token issuance.

### Can agentcall implement EMA without MCP?

Not interoperably. The extension normatively assigns MCP roles, uses MCP protected
resource identifiers and authorization metadata, and requires MCP capability
declaration. A non-MCP relay cannot truthfully advertise EMA conformance merely by
using the same JWT flow.

Agentcall can and should reuse the underlying architecture for SSO/SCIM work:
central IdP policy, a stable subject identifier, short-lived signed grants,
audience/resource restriction, scoped tokens, and centralized revocation. Until an
MCP resource server exists, describe this as **EMA-inspired** or an **ID-JAG-based
authorization profile**, not EMA support. If the optional MCP front door is built,
that resource can implement EMA properly while the native relay reuses the same
identity mapping and policy engine.

## 3. Protocol boundary and MCP front-door decision

The official A2A specification defines the boundary cleanly: MCP connects models
and agents to tools, APIs, data, and resources; A2A connects independent agents as
peers for discovery, delegation, task lifecycle, and context exchange. It explicitly
describes an A2A server agent using MCP tools while fulfilling an A2A task
([A2A specification, Appendix B](https://a2a-protocol.org/latest/specification/#appendix-b-relationship-to-mcp-model-context-protocol)).

That makes A2A the canonical AgentCall interface. AgentCall's far side is an opaque,
autonomous agent owned by another person, not merely a tool implementation.

There is a plausible distribution case for MCP: a compatible client could invoke an
AgentCall handle without installing the CLI. The recommendation is **no now; revisit
for a named design partner as a narrow adapter**, subject to these gates:

1. A named design partner requires MCP-native distribution rather than A2A or the CLI.
2. Extract one transport-neutral call service used by the native CLI, A2A, and MCP.
   No adapter may create a separate task lifecycle or policy path.
3. Authenticate every MCP user and map the verified stable subject to an AgentCall
   organization and caller identity. Never collapse callers into one connector or
   service identity.
4. Preserve the callee's pre-prompt policy decision, refusal semantics, limits, and
   audit identity. The MCP adapter grants no authority of its own.
5. Start with a small fixed tool surface such as card lookup and call/delegation.
   Do not publish an enumerable organization-wide handle or task catalog.
6. Keep the adapter remote and server-side; do not install a privileged local MCP
   process on the callee machine and do not give it direct network reach to endpoints.

This is not a cosmetic surface addition. MCP's official
[security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
identifies confused-deputy failures in proxy servers, forbids accepting tokens not
issued for the MCP server, requires audience separation, warns about OAuth-discovery
SSRF, and requires state handles to be bound to the authenticated user. An AgentCall
front door is a proxy by construction, so identity translation, consent, token
audience validation, scope minimization, and non-enumerability are release gates.

A2A adds its own requirements: authenticate requests using schemes declared in the
Agent Card, authorize by authenticated identity, protect sensitive extended cards,
and validate file references and webhook destinations against SSRF
([A2A specification](https://a2a-protocol.org/latest/specification/)). Supporting
both protocols increases parsers, discovery endpoints, auth flows, schemas, and
conformance work. A shared internal service is what keeps that extra surface bounded.

## 4. Defensible positioning

Retire this lead:

> Reach an agent behind a firewall without opening an inbound port.

Use this instead:

> Delegate work to the right colleague's agent, under that colleague's policy,
> with verified caller identity, the ability to refuse, and evidence of who asked
> whom—without centralizing the colleague's private context.

The distinction is not that MCP is insecure or incapable of policy. An MCP server
can implement strong OAuth and fine-grained tools. The distinction is the ownership
and work model:

| MCP tunnel + server | AgentCall |
|---|---|
| Connects Claude to a private tool/resource server | Connects one person's agent to another person's agent |
| Server code performs a declared tool operation | Callee agent reasons with its owner's context and may refuse |
| OAuth governs access to the MCP resource and scopes | Callee policy governs which caller may delegate which task |
| Audit is server-specific | Audit names caller, callee, delegated task, and outcome |
| Private reachability is the product feature | Reachability is replaceable plumbing |

The risk remains real: a tunneled internal MCP server may be good enough for a demo
or a narrow Q&A use case. The response is not a transport race. It is to make the
agent ownership, delegation, caller-specific policy, refusal, and audit differences
observable and enforceable—and to use an optional MCP adapter to remove distribution
friction without surrendering the A2A model.
