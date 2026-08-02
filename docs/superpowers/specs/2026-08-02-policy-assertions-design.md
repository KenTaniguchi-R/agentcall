# Executable policy assertions

Status: implemented by issue #107.

## Decision

Both `~/.agentcall/policy.json` and the administrator-managed policy may carry
an optional `tests` array. Each assertion names a bare relay-verified caller,
optional local group names, tasks that must be accepted, and tasks that must be
denied:

```json
{
  "caller": "ken",
  "groups": ["eng"],
  "accept": ["review-pr"],
  "deny": ["exec"]
}
```

This adapts Tailscale's current policy tests: accepted destinations must remain
reachable, denied destinations must remain unreachable, and a failing test
rejects a policy update. Tailscale's GitHub integration runs the same tests on
pull requests and again before apply. AgentCall keeps the file format ready for
that GitOps loop without building fleet sync in this issue.

References:

- <https://tailscale.com/docs/reference/syntax/policy-file>
- <https://tailscale.com/docs/integrations/github/gitops>

## Semantics

Assertions run against the effective policy after the managed task ceiling and
mandatory caller blocks are composed with user intent. User tests can therefore
detect that an administrator ceiling removed a required grant. Managed tests
can prove that an administrator block or ceiling survived the user's file.

`groups` contains local group names, not caller-provided roster ids. Evaluation
maps each name to its configured roster id and passes those ids through the
same `offeredFor` function used by call enforcement. Unknown group names fail.
An individual caller block still outranks defaults and group grants.

Every `accept` task must appear in the computed offer. Every `deny` task must be
absent. `deny: ["*"]` requires an empty offer and cannot be combined with
`accept`. Empty or internally contradictory assertions are invalid. Files are
bounded to 100 assertions, 100 accepted tasks, 100 denied tasks, and 20 groups
per assertion so listener startup and hot reload remain predictable.

Assertions describe policy authority. Existing lint checks still separately
reject grants to task ids with no manifest on disk; task resolution remains the
final runtime filter.

## Enforcement points

- `agentcall lint` uses the normal effective-policy load path and exits nonzero
  with the assertion number, caller, and mismatched tasks.
- CLI policy verbs validate their proposed user policy against the installed
  managed layer before saving. A failure preserves the last known-good file and
  does not publish a card.
- Listener startup validates before opening its relay socket. The listener also
  reloads and validates before every call, so a broken hand edit fails closed
  without spawning an agent or exposing the local diagnostic to a caller.
- Card review and publication already load the effective policy, so they inherit
  the same checks.

Raw `loadUserPolicy` parsing does not execute assertions. Editing commands need
to read a currently failing file in order to repair it; enforcement and
publication always use the validating effective loader.

No policy sync service or GUI is introduced. A future admin console must keep
the managed file and CI path as a co-equal interface rather than creating a
GUI-only capability.
