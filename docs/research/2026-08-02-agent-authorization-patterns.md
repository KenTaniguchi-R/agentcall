# Authorization patterns for person-owned AI agents

**Date:** 2026-08-02  
**Status:** Research, not a product decision  
**Question:** How can the owner of an AgentCall agent limit what each person can
ask it to do, and which existing products provide useful precedents?  
**Method:** Product behavior was checked against first-party documentation and
product pages on 2026-08-02. Marketing claims are treated as product claims, not
independent security verification.

---

## Short answer

There is no single mature "permissions for LLMs" product that covers the whole
problem. The useful systems split it into deterministic layers:

1. **Human to agent:** may this authenticated person or agent invoke this agent,
   and at what role?
2. **Agent to action:** may this agent, acting for this caller, invoke this exact
   tool with these arguments?
3. **Agent to data:** may the caller and agent read this specific resource before
   it enters the model context?
4. **Delegation and approval:** is the agent acting as itself or on behalf of a
   user, and does this particular high-risk operation need approval?
5. **Runtime containment:** even if application policy is wrong, what files,
   credentials, processes, and network destinations can the process physically
   reach?

The closest broad references are **Microsoft Entra Agent ID** for giving every
agent a governed identity and controlling who may call it, **Amazon Bedrock
AgentCore Identity + Policy** for carrying caller and agent identity through a
tool gateway and checking every tool call, **Auth0 for AI Agents** for user login,
delegated credentials, approval, and RAG filtering, and **Permit MCP Gateway**
for the especially useful "administrator ceiling, human-selected trust,
agent-specific grant" model. Cerbos and OpenFGA are useful lower-level engines;
Composio and Arcade solve credential delegation but are not, by themselves, the
complete policy layer.

The key design rule for AgentCall is:

> The LLM may propose an action, but only deterministic code outside the LLM may
> authorize and execute it.

## Reference matrix

| Reference | Strongest relevant control | Boundary / caveat | Best idea for AgentCall |
|---|---|---|---|
| [Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/) | A distinct identity for every agent; app roles and `assignmentRequired` can restrict who can call it | Deepest fit for Microsoft/Azure estates | Model a person's agent as both a protected resource and an independently revocable principal |
| [AWS Bedrock AgentCore Policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html) | An external Cedar policy engine intercepts every Gateway tool call; policy can use user identity and tool arguments | AWS AgentCore Gateway is the enforcement point | Put policy enforcement outside the prompt/runtime and authorize exact tool + arguments |
| [Auth0 for AI Agents](https://auth0.com/docs/get-started/auth0-for-ai-agents) | User authentication, on-behalf-of API access, Token Vault, async approval, document-level RAG authorization | A suite of several Auth0 products, not one universal policy primitive | Preserve both caller and agent identity; filter data before the model sees it; approve sensitive operations out-of-band |
| [Permit MCP Gateway](https://docs.permit.io/permit-mcp-gateway/managing-humans-and-agents/) | Separates human and MCP-client identities; admin sets a ceiling, human chooses trust inside it, each agent gets its own grant | Some broader MCPermit architecture documentation is explicitly marked upcoming | Use a three-party grant: organization ceiling, owner consent, caller-agent-specific effective permission |
| [Cerbos](https://www.cerbos.dev/ecosystem/claude-agent-sdk) | PDP check before every tool call using user, role, attributes, target resource, and context | The application must provide trustworthy context and enforce the answer | Add a policy-decision call at the local tool boundary, with deny-by-default behavior |
| [OpenFGA](https://openfga.dev/docs/fga) | Open-source ReBAC graph with conditions and contextual tuples | It answers authorization questions; it does not authenticate callers, broker OAuth, or sandbox processes | Represent owners, callers, agents, tasks, tools, and datasets as a relationship graph if the model outgrows local maps |
| [WorkOS FGA](https://workos.com/docs/fga/resource-types) | Resource hierarchy explicitly describes agents as resources and subjects, with tools/datasets below a workspace | Current FGA docs elsewhere still say supported subjects are users/groups, so agent-subject support should be verified before purchase | Carry the conceptual duality: users launch an agent; the agent itself has narrower grants to tools/data |
| [Composio](https://docs.composio.dev/docs/tools-direct/authenticating-tools) | Per-user connected accounts, OAuth scopes, separate auth configs for read-only versus full access; the LLM need not own credentials | Credential and tool plumbing is not the same as caller-to-agent authorization | Never put durable provider credentials in the model context; bind connections to a verified local user identity |
| [Arcade](https://docs.arcade.dev/en/guides/create-tools/tool-basics/create-tool-auth) | Tool-declared OAuth scopes, explicit user consent, secure token injection into tool context | OAuth consent authorizes a scope until expiry/revocation; it is not per-operation approval | Declare minimum scopes on each task/tool and inject tokens only at execution time |
| [Modal Sandboxes](https://modal.com/docs/guide/sandbox-networking) | Default-denied inbound access plus outbound block/CIDR/domain allowlists; policies can be narrowed during a run | Remote sandbox shape conflicts with AgentCall's current local, owner-context agent | Copy the capability shape, not necessarily the hosted product: explicit mounts and network allowlists at the runtime boundary |
| [Pangea AI Guard](https://pangea.cloud/docs/ai-guard/overview) / [Google Model Armor](https://cloud.google.com/security/products/model-armor) | Detect prompt injection, sensitive data, unsafe content, and risky tool inputs/outputs | These are probabilistic content guardrails, **not authorization** | Use only as defense in depth; an authorization allow/deny must not depend on an LLM or classifier |

## 1. Human to agent: who may call whose agent?

Microsoft has the clearest direct precedent. Entra Agent ID treats agent
identities as a first-class identity type with owners, sponsors, permissions,
sign-in logs, lifecycle governance, Conditional Access, and the ability to disable
one agent, a blueprint, or all agents tenant-wide
([overview](https://learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities),
[administration](https://learn.microsoft.com/en-us/entra/agent-id/manage-agent-identities-admin)).
For inbound access, an agent blueprint can define app roles assignable to users,
groups, service principals, or other agents. With `assignmentRequired = true`,
only an explicitly assigned principal can sign in or call the agent
([control user access](https://learn.microsoft.com/en-us/entra/agent-id/control-user-access-agents)).

AWS supplies a lower-level equivalent at its resource boundary. AgentCore
resource policies can name which AWS principals may invoke or manage Runtime,
Gateway, and Memory resources, and are evaluated alongside the caller's
identity-based IAM policy
([resource-based policies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/resource-based-policies.html)).

Permit's MCP model adds an important owner-consent pattern. It distinguishes the
human from each MCP client/agent. An administrator determines the maximum access,
the human chooses a trust level inside that ceiling, and separate clients owned by
the same person can receive and lose different permissions. Revoking one client
does not revoke the others
([managing humans and agents](https://docs.permit.io/permit-mcp-gateway/managing-humans-and-agents/)).

**AgentCall lesson:** keep the current task menu, but add a separate inbound role.
"May contact this agent" and "which task may run" are different decisions. A
useful owner-facing vocabulary would be:

- `private`: only the owner;
- `named`: explicitly listed people/agents;
- `roster`: members of selected, relay-attested rosters;
- `organization`: authenticated organization members;
- optionally `public`: only for tasks with a separately safe hosted boundary.

Each grant should be to a verified principal, not an email string supplied by the
prompt. An agent/device identity should remain independently revocable even when it
belongs to the same human.

## 2. Agent to tool/action: what may execute?

AWS AgentCore Policy is the strongest enforcement precedent. The policy engine is
attached to an AgentCore Gateway, intercepts every tool request outside the agent's
code, and evaluates deterministic Cedar policy before allowing access. Rules can
select a user identity, exact tool, Gateway, and tool input parameters. Decisions
are logged; a `LOG_ONLY` mode supports testing before `ENFORCE`
([Policy overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html),
[policy scope](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-scope.html)).
The Gateway can also ask which tools are authorized, allowing an agent to receive a
filtered tool list rather than learning about tools it cannot call
([IAM permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-permissions.html)).

Cerbos documents the same architecture independent of AWS: before a Claude agent
invokes a tool, the application sends the verified user context, tool name, target
resource, and request context to a local Policy Decision Point; the tool runs only
after `allow`. The authorization decision and enforcement remain outside the
model
([Cerbos + Claude Agent SDK](https://www.cerbos.dev/ecosystem/claude-agent-sdk)).

Permit's Access Request MCP adds a durable interrupt/resume approval flow for
operations such as deleting a resource. The agent proposes a request, a human
reviewer approves or denies via UI/API, and execution continues only after the
decision
([Access Request MCP](https://docs.permit.io/ai-security/access-request-mcp/overview/)).

**AgentCall lesson:** task-level `ask`, `read`, `write`, and `exec` capabilities are
a good coarse first boundary, but high-risk tasks need a second check over the
concrete operation. The enforcement input should include at least:

```text
verified caller + answering agent + task + tool + normalized arguments
+ target resource + current organization/roster context + approval state
```

The local guard/tool proxy should return allow/deny before execution. A task
manifest controls which tools are visible; a policy controls whether this caller
may use them; a runtime boundary controls what the process can physically touch.
None substitutes for the others.

## 3. Agent to data: what may enter model context?

Auth0's RAG guidance applies document-level Auth0 FGA checks during retrieval so
only documents the current user may access are returned to the model. This is the
important placement: filtering happens before sensitive content enters the prompt,
not after the model drafts an answer
([Auth0 for AI Agents](https://auth0.com/ai/docs/intro/overview)).

OpenFGA provides the generic relationship model behind this style of check. An
authorization model plus tuples such as `user:alice viewer document:roadmap`
answers a deterministic `Check`; conditions can add time windows, IP ranges,
resource attributes, and entitlements
([concepts](https://openfga.dev/docs/concepts),
[conditions](https://openfga.dev/docs/modeling/conditions)). Contextual tuples can
carry request-only facts such as an IdP group claim without permanently writing
them, but their documentation notes that token-derived access can remain valid
until token expiry after the underlying group changes
([contextual tuples](https://openfga.dev/docs/interacting/contextual-tuples)).

WorkOS publishes a particularly useful model for an agent platform: an organization
contains workspaces; a workspace contains agents, tools, and datasets; agents are
protected resources when users configure or launch them and subjects when they are
granted `invoker` or `reader` on tools and datasets. The agent's effective access
should be a subset of the user's
([resource types](https://workos.com/docs/fga/resource-types)). This is a design
precedent; verify current agent-subject API availability because the same page set
also describes additional subject types as forthcoming.

**AgentCall lesson:** filesystem roots, repositories, connector accounts, and future
knowledge sources should be named policy resources. Check read authorization before
loading content into the agent. Output redaction is only a fallback after a more
important boundary has already failed.

## 4. Delegated identity, credentials, and approval

An agent acting for Alice is not simply Alice and is not simply a service account.
AWS's on-behalf-of exchange preserves both identities: an inbound user token is
exchanged for a downstream, audience-scoped token containing the agent identity and
original caller identity, leaving the authorization server to decide scopes and
delegation
([AgentCore OBO token exchange](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html)).
Microsoft similarly supports delegated permissions for user-centric agents and
application permissions for autonomous agents, while explicitly blocking several
high-risk directory roles and Graph permissions from agent identities
([Entra authorization](https://learn.microsoft.com/en-us/entra/agent-id/authorization-agent-id)).

Auth0 combines OAuth/OIDC login, Token Vault for external provider tokens, CIBA for
asynchronous user authorization, and Rich Authorization Requests for describing
fine-grained approval. Its documentation positions these as separate layers rather
than giving the LLM a root token
([Auth0 for AI Agents](https://auth0.com/docs/get-started/auth0-for-ai-agents),
[RAR flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow/authorization-code-flow-with-rar)).

Arcade and Composio are narrower but practical references for connector credentials.
Arcade binds a tool to minimum OAuth scopes, prompts the user when those scopes are
missing, and injects the resulting token into tool context so the LLM and MCP client
do not see it
([Arcade tool authorization](https://docs.arcade.dev/en/guides/create-tools/tool-basics/create-tool-auth)).
Composio binds connected accounts to an application `userID`, supports separate auth
configs for read-only and full-access scopes, and now supports project API keys whose
permissions separately control tool discovery, execution, proxy execution, account
management, and logs
([authenticating tools](https://docs.composio.dev/docs/tools-direct/authenticating-tools),
[scoped project keys](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions)).

**AgentCall lesson:** carry these as separate audit fields throughout a call:

- authenticated caller identity;
- caller's human owner/organization, when verified;
- answering agent identity and owner;
- task/tool identity;
- delegated downstream credential ID and scopes;
- approver, exact action digest, expiry, and one-time/reusable status.

An approval should bind the normalized action and important arguments. "Allow GitHub"
is not equivalent to "approve merging PR 42 into `main` once."

## 5. Sandbox/runtime controls are a separate layer

Authorization decides what should happen. A sandbox limits what can happen after a
bug, prompt injection, policy mistake, or compromised tool.

Modal's Sandbox is a useful capabilities reference: no incoming access or Modal
resource access by default, total network blocking or outbound CIDR/domain allowlists,
inbound CIDR allowlists, authenticated connection tokens, and mounting only a user's
subdirectory of a volume
([networking](https://modal.com/docs/guide/sandbox-networking),
[filesystem](https://modal.com/docs/guide/sandbox-files)). E2B likewise requires an
access token for its sandbox controller and presigned upload/download URLs when secure
access is enabled
([secured access](https://e2b.dev/docs/sandbox/secured-access)).

These hosted runtimes are not a direct fit for AgentCall's current promise that the
person's real local agent answers from their own machine and context. The reusable
ideas are explicit mounts, short-lived process identity, network egress allowlists,
credential injection at execution time, and hard process lifetime/resource limits.

Pangea AI Guard and Google Model Armor belong beside, not inside, authorization. They
screen prompts, responses, tool inputs/outputs, and sensitive data using rules and
classifiers
([Pangea overview](https://pangea.cloud/docs/ai-guard/overview),
[Model Armor](https://cloud.google.com/security/products/model-armor)). They may catch
attacks, but they cannot prove that Alice is allowed to run a tool. AgentCall should
never turn a probabilistic "looks safe" result into authority.

## Recommended AgentCall model to prototype

Do not begin by adopting a vendor. Prototype the authorization nouns and enforcement
points first, then decide whether the graph/policy volume justifies buying an engine.

### Effective permission

For every operation, calculate:

```text
organization administrator ceiling
  INTERSECT agent owner's grant
  INTERSECT caller/user delegated scope
  INTERSECT answering agent/task capability
  INTERSECT runtime hard ceiling
  MINUS explicit denies
```

An unavailable/invalid layer fails closed. The caller cannot widen the owner's grant,
the owner cannot widen an administrator ceiling, and an agent never receives more
access than both its caller and its own workload identity possess.

### Enforcement points

| Decision | Enforcement point | Example |
|---|---|---|
| May caller reach agent? | Relay before delivery | `alice can_call ken` |
| May caller invoke task? | Listener before caller text enters a prompt | `alice can_invoke review-pr` |
| May task call tool? | Local pre-tool proxy/guard | `review-pr can_call github.get_pr` |
| May this exact action run? | Tool proxy with normalized arguments | `alice may comment on repo X, but not merge` |
| May data enter context? | Retriever/filesystem/connector boundary | `agent may read repo X/docs, not payroll` |
| Must a person approve? | Durable approval service, then resume | `merge PR 42 once before 14:00` |
| What if policy is bypassed? | OS/container/sandbox boundary | no credentials mount; egress only to GitHub |

### Product-facing simplification

The internal model can be detailed while the owner's UI stays simple. Start with
presets that compile to explicit grants:

- **Ask only:** answer from explicitly allowed read sources; no writes or external
  actions.
- **Read project:** read one named repository/workspace and approved read-only
  connectors.
- **Draft changes:** create a patch/draft but do not publish or execute it.
- **Act with approval:** propose writes; each high-risk operation pauses for owner
  approval.
- **Trusted automation:** bounded actions without per-operation approval, only for
  named principals and narrow resources.

Always provide an "explain this decision" view showing which grant allowed or denied
the request, and retain policy tests. AWS's `LOG_ONLY` rollout and AgentCall's existing
executable policy assertions point in the same direction: simulate changes, prove
important allows and denies, then enforce.

## Buy/build conclusion

- **Study first:** Microsoft Entra Agent ID, AWS AgentCore Policy/Identity, Permit MCP
  Gateway, and Auth0 for AI Agents. Together they cover the complete conceptual model.
- **Potential policy engine later:** Cerbos for attribute/context-heavy local policy;
  OpenFGA/Auth0 FGA for a growing relationship graph. AgentCall's current caller/task
  map does not yet require a separate FGA datastore.
- **Potential connector layer:** Composio or Arcade if AgentCall tasks need many SaaS
  connections. Treat them as token brokers/tool runtimes beneath AgentCall policy.
- **Do not misclassify:** Pangea AI Guard, Google Model Armor, E2B, and Modal are
  complementary guardrail/runtime products, not answers to "who may do what."

The most differentiated piece for AgentCall is not inventing another general-purpose
authorization engine. It is making a person-owned agent's policy understandable:
**who may reach me, which named tasks they may request, which exact resources/actions
those tasks may use, and when I must approve**—then enforcing each answer outside the
LLM.
