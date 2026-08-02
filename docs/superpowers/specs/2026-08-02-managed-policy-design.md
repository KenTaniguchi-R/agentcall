# Administrator-managed policy design

Date: 2026-08-02  
Issue: #104

## Problem

AgentCall's only policy was `~/.agentcall/policy.json`. The same user who ran
the answering agent could widen every default, caller, and roster-group grant,
and `AGENTCALL_HOME` could relocate the complete state tree. There was no place
for a machine administrator to impose a task ceiling or an unoverridable deny.

## Decisions

| Question | Decision |
|---|---|
| Where does managed policy live? | `/Library/Application Support/agentcall/policy.json` on macOS; `/etc/agentcall/policy.json` on Linux |
| Can user-controlled environment variables relocate it? | No |
| What can v1 managed policy express? | An optional global `allowed_tasks` ceiling and exact `blocked_callers` |
| How are user grants handled? | Preserve the editable user policy; filter its default, caller, and group offers only when loading the effective policy |
| Which block wins? | Either layer's block; managed blocks cannot be undone by the user |
| What does a missing managed file mean? | This machine is unmanaged; user behavior is unchanged |
| What does an unreadable or invalid managed file mean? | Fail closed; do not publish or spawn an agent under a fallback policy |
| Do CLI policy verbs edit the effective view? | No; they edit user intent and then publish the separately computed effective view |

The managed schema is deliberately small:

```json
{
  "version": 1,
  "allowed_tasks": ["ask"],
  "blocked_callers": ["contractor-bot"]
}
```

`allowed_tasks` omitted means no task ceiling. An empty array denies every
task. Unknown fields and invalid task/caller identifiers invalidate the file.
The distinct effective union of user and managed blocks must also fit the
relay card's 200-caller bound; otherwise policy loading fails before local
enforcement can diverge from the last successfully published card.

## Why managed policy is not another user-shaped policy

The user policy has additive defaults, per-caller grants, and attested-group
grants. That shape is not closed under intersection.

For example, a user group may grant task `x` while an administrator permits
`x` only for one caller. Their intersection depends on both caller identity and
group membership simultaneously. The existing policy shape can represent a
caller rule or a group rule, but not that conjunction. Converting the result
back into one `Policy` would either over-grant or under-advertise.

A global task ceiling is closed under filtering: the same operation applies
exactly to every offer list, regardless of how the user grant was obtained.
Exact caller blocks are also closed under union. Rich organization
authorization belongs in the relay policy/RBAC design, where verified org and
group identity are available, rather than in a lossy local merge.

## Module interface

The policy module exposes two read paths:

- `loadUserPolicy(paths)` returns editable user intent and is used by mutation
  commands.
- `loadPolicy(paths)` returns the effective administrator-filtered policy and
  is used by listener enforcement, card rendering, and card publication.

Path selection, optional-file reads, schema validation, ceiling filtering, and
deny union stay behind that seam. Callers do not merge policy themselves.

## Failure and deployment semantics

Only `ENOENT` means “no managed policy.” Permission errors, I/O errors, malformed
JSON, schema violations, and unsupported fields are fatal. This distinction is
required to prevent an unreadable administrator policy from silently becoming
the permissive user policy.

MDM or package installers must create the managed directory and file as
root-owned, not writable by ordinary users, and replace updates atomically.
AgentCall does not create this file.

This model does not make a user-owned npm installation tamper-resistant. A
fleet deployment must also install the runtime in an administrator-owned
location and verify a signed release. Managed self-update remains deferred and
must be disabled whenever IT pins the deployed version.

## Future extension rule

Adding fields to managed policy requires proving that the effective policy can
represent their composition exactly. If a rule depends on verified org role,
roster membership, caller identity, and task simultaneously, enforce it at the
relay authorization seam instead of approximating it in this local file.
