# Authorization permissions use resource:action names

> **Historical decision record — not current documentation.** This file records
> the decision made on 2026-08-03. It does not claim that a generic permission
> engine exists. Current behavior lives in the code and current security
> contracts in `docs/security/`.

**Date:** 2026-08-03

**Status:** Decided; vocabulary only

**Issue:** [#207](https://github.com/KenTaniguchi-R/agentcall/issues/207)

## Decision

Name authorization permissions as `<resource>:<action>`. A resource may use
dots for a real containment boundary, such as `workspace.invite:issue` or
`roster.join_key:revoke`. Names are lowercase ASCII and stable product
vocabulary; route paths, HTTP verbs, database CRUD letters, CLI commands, and
audit event strings do not define them.

Every authorization decision is described by four values:

1. **principal** — the authenticated stable actor or capability exercising
   authority;
2. **permission** — one canonical `resource:action` name;
3. **resource instance** — the workspace, agent, roster, task, or credential
   being addressed; and
4. **grant source** — self ownership, workspace role, roster membership,
   capability credential, invite, local owner policy, or machine-admin ceiling.

This is a naming and migration contract, not custom RBAC. Do not add a
permissions table, role editor, wildcard grammar, deny-precedence language, or
generic policy evaluator until a concrete product requirement cannot be
represented by the existing two workspace roles and capability relationships.

## Principal types

Use typed principals. Never infer the type from an identifier string.

| Principal | Current representation | Durable direction |
|---|---|---|
| agent | authenticated `(org, handle)` | stable agent ID from #154; handle remains an address |
| relay operator | configured bootstrap token, audited as `bootstrap` | typed operator/service principal with bounded bootstrap authority |
| roster administrator capability | authenticated handle plus roster admin secret | typed capability ID plus the stable agent that exercised it |
| enrollment invite | one-use hashed invite token | typed admission capability, never a post-enrollment identity |
| local line owner | OS user controlling the per-line configuration | local stable agent/device binding when available |
| machine administrator | owner of the protected managed-policy location | typed administrative policy source, distinct from Workspace Organizer |

Email, IdP groups, handle addresses, bearer-token hashes, roster secrets, and
role names are not principal IDs. Workspace roles, roster membership, and IdP
groups are grant sources; the agent exercising one of their grants is still the
principal. #154 supplies that durable agent principal, while #205 owns the
Workspace role and onboarding vocabulary.

## Canonical relay permissions

The inventory below names current gates. It does not change their behavior.

| Permission | Resource instance | Current grant source |
|---|---|---|
| `workspace.invite:bootstrap` | target workspace | relay-operator bootstrap credential and deployment-tenant boundary |
| `workspace.invite:issue` | workspace | authenticated `admin` role; future Organizer |
| `workspace.invite:list` | workspace | authenticated `admin` role; future Organizer |
| `workspace.invite:revoke` | invite | authenticated `admin` role in the invite workspace |
| `workspace.audit:export` | workspace audit snapshot | authenticated `admin` role; future Organizer |
| `agent:enroll` | workspace plus requested handle address | valid one-use workspace invite |
| `agent.credential:rotate` | caller's own handle credential | authenticated self |
| `agent.card:publish` | caller's own Agent Card | authenticated self |
| `agent.card:read` | target Agent Card | authenticated workspace peer, filtered by target disclosure policy/shared roster |
| `agent.identity_key:publish` | caller's own identity key | authenticated self plus key proof-of-possession; publish-once invariant |
| `agent.encryption_key:publish` | caller's own encryption-key epoch | authenticated self plus identity-key signature and monotonic epoch |
| `agent.key:read` | target key bundle | authenticated workspace peer |
| `agent.presence:read` | target agent presence | self or shared-roster relationship |
| `call:listen` | caller's own receiving endpoint | authenticated self |
| `call:initiate` | target agent | authenticated workspace peer; task admission is separate |
| `call.task:list` | target agent's calls | authenticated original caller, enforced by the target task store |
| `call.task:read` | one call task | authenticated original caller |
| `call.task:cancel` | one live call task | authenticated original caller |
| `roster:create` | new roster | authenticated agent, which becomes initial member and receives admin capability |
| `roster.member:join` | roster | authenticated agent plus valid join-key capability |
| `roster.member:leave` | caller's membership | authenticated member self |
| `roster.member:expel` | target membership | authenticated agent plus roster-admin capability |
| `roster.join_key:issue` | roster | authenticated agent plus roster-admin capability |
| `roster.join_key:list` | roster | authenticated agent plus roster-admin capability |
| `roster.join_key:revoke` | join key | authenticated agent plus roster-admin capability |
| `roster.join_key:evict` | memberships admitted by one key | authenticated agent plus roster-admin capability and explicit eviction request |
| `roster.audit_budget:reset` | roster | authenticated agent plus roster-admin capability |
| `roster:delete` | roster | authenticated agent plus roster-admin capability |
| `roster.bundle:read` | roster bundle | authenticated current roster member |

The public directory card remains public discovery and has no authenticated
permission. Rate limits, schema validation, tenant resolution, cryptographic
proofs, task ownership, and non-enumerating error behavior remain independent
conditions; naming a permission does not replace them.

## Local execution permissions

The callee's endpoint makes a second authorization decision after relay
admission:

| Permission | Resource instance | Current grant source |
|---|---|---|
| `task:discover` | one advertised task | local owner disclosure policy, caller override, and attested roster grants |
| `task:invoke` | one callee task | effective local policy for caller plus attested rosters, bounded by machine-admin policy |
| `call.context:continue` | one saved inbound conversation context | authenticated caller plus matching opaque context capability, caller, task, runtime, workdir, TTL, turn budget, and currently threadable runtime |
| `tool:execute` | one agent tool invocation | answering-agent runtime plus the fail-closed/observe guard policy |
| `local.policy:read` | effective per-line policy | local line owner; machine policy is reported but not user-editable |
| `local.policy:update` | user policy layer | local line owner, subject to machine-admin ceiling and assertions |
| `local.managed_policy:update` | protected machine policy | machine administrator outside the ordinary AgentCall CLI flow |

Task IDs are resource-instance identifiers, not permission names. Do not mint
`task:<task-id>` permissions or copy every task into a role. The permission is
`task:invoke`; policy decides which task instances a caller may invoke.

## Permissions are not audit event names

Permission names answer “may this principal perform this action on this
resource?” Audit events answer “what state transition occurred?” They may be
related but must not be made identical.

For example, `workspace.invite:issue` authorizes the operation while
`org.invite.issue` is the existing evidence event after success. One permission
may produce multiple events (`roster.join_key:revoke` plus an explicitly
requested eviction), and a denied decision may require a different evidence
record without a successful mutation event. Audit keeps typed actor, target,
tenant, outcome, and timestamp fields instead of parsing a permission string.

## Compatibility and migration

- Current wire/storage role `admin` maps to the future user-facing Organizer
  grant set; `member` maps to Member. #205 owns any persisted or wire migration.
- `requireOrgAdmin` may later become a check for
  `workspace.invite:issue`, `workspace.invite:list`,
  `workspace.invite:revoke`, and `workspace.audit:export`, but this decision
  does not replace it with a generic evaluator.
- Before #154, logs and checks may still carry `(org, handle)` as the
  transitional actor. New durable schemas must reserve a typed stable principal
  field and must not call the handle a stable identity.
- Roster admin secrets remain scoped capability credentials, not workspace
  roles. Organizer does not automatically receive roster-admin permissions.
- Machine Administrator and Workspace Organizer remain distinct grant sources.
  Neither name implies the other's authority.
- Permission names are internal authorization vocabulary until a versioned
  shared schema explicitly exposes them. Do not silently add them to A2A or MCP
  protocol claims.

## Future extension rule

Add a permission name only when a real enforcement decision exists. The review
must identify the principal type, resource instance, grant source, tenant
boundary, denial behavior, and audit consequence. Prefer one exact permission
over wildcards. If custom roles become necessary, roles are named sets of these
permissions; they do not change the permission names or become actor IDs.

## References

- [Enterprise capability sequence](./2026-08-03-enterprise-capability-sequence.md)
- [Identity and address separation](./2026-08-02-identity-address-separation.md)
- [Administrator-managed policy](./2026-08-02-managed-policy-design.md)
- [Roster lifecycle](./2026-08-01-roster-lifecycle-design.md)
- [Reference implementations](../../research/reference-implementations.md)
