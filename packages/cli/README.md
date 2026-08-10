# @benree/agentcall

Call another person's coding agent — Claude Code or Codex — on their machine,
across the public internet.

Claim an address such as `@acme/ken` and share it with your team. When someone
calls, AgentCall starts a fresh agent process on your machine, runs it in a
task-specific working directory, and returns its answer to the caller. Requests
and replies are signed and HPKE-encrypted between endpoints.

> **Pre-production software for trusted teams.** Claude is the live-tested
> answering path; Codex support is experimental and has a weaker read boundary.
> Read the [security model](https://agentcall.mintlify.app/security/overview)
> before making an agent callable.

## Before you install

You need three things:

- **Node.js 20 or newer**, on macOS or Linux (there is no native Windows listener yet).
- **An authenticated Claude Code or Codex CLI**, if this machine will answer calls.
- **A one-time invite from an AgentCall organization**. There is no self-serve
  signup: registration requires an invite, and the first invite in an
  organization is issued by the relay operator. Ask an organization
  administrator, or see
  [invite members](https://agentcall.mintlify.app/administration/invites).

## Install

```bash
npm install -g @benree/agentcall
agentcall setup
```

Setup asks for the invite and you paste it in. It registers your identity,
creates a line configuration, prepares a working directory, installs a
background listener, and makes a test call to confirm your agent can answer.

> Do not run bare `npx agentcall` — that unscoped npm name belongs to a
> different project. Use the globally installed `agentcall`, or
> `npx @benree/agentcall`.

## Call someone

```bash
agentcall inspect @acme/ken                     # identity, card, and disclosed availability
agentcall call @acme/ken "Why did CI fail?"     # ask their agent
agentcall call @acme/ken "Which commit?" --continue
```

Lifecycle updates go to stderr and the authenticated reply to stdout, so replies
stay pipeable. `--json` gives machine-readable output.

## Receive calls safely

Plain calls use the built-in, read-only `ask` task. Publish a named task only
when a caller needs more specific instructions:

```bash
agentcall task new architecture-history
agentcall doctor
agentcall block spammer            # or nothing at all
```

Any caller you have not blocked can request any task. On a Claude line, its
first-class file tools may read only under the configured scope roots, except
for paths on the built-in and owner denylist. Paths outside the roots or on the
denylist are refused before the agent sees them. The answer itself is not
inspected.

This is not a complete machine boundary: Bash bypasses the read guard, so a
caller can ask it to read any file the account can reach. Treat scope as a
default-shaping control, not confidentiality protection.

**On a Codex line this is not enforced** — there is no AgentCall read guard.
**Any authenticated handle in your organization may call you** — an address is a
routing identifier, not a secret.

## Troubleshooting

```bash
agentcall doctor
```

`doctor` is read-only and reports task validity, effective policy, card drift,
key publication, recovery, listener state, and runtime health. Use `--json` for
machine-readable output. Publish explicitly with `agentcall admin card publish`
or `agentcall admin keys publish`.

## Documentation

- [Get started](https://agentcall.mintlify.app/get-started/install)
- [Security model](https://agentcall.mintlify.app/security/overview)
- [CLI reference](https://agentcall.mintlify.app/reference/cli)
- [Current limitations](https://agentcall.mintlify.app/overview/limitations)
- [Source and issues](https://github.com/KenTaniguchi-R/agentcall)

MIT licensed.
