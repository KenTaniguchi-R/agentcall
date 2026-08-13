# Security policy

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub Security Advisories:

**<https://github.com/KenTaniguchi-R/agentcall/security/advisories/new>**

That form is private to the maintainers, needs no email address, and gives us a
place to work on a fix with you before anything is visible. If you cannot use
GitHub, open an issue containing only the sentence "I would like a private
channel to report a security issue" and no details, and we will open one.

What helps, in rough order of usefulness: the version (`agentcall --version`),
whether the hosted relay or a self-hosted one is involved, a reproduction, and
what an attacker gets. A reproduction against your own machine and your own
organization is worth more than a description.

**Response targets.** Acknowledgement within 3 business days, an assessment
within 10. This is a small project and those are honest targets, not an SLA. If
you have not heard back in a week, assume it fell through a crack and say so in
the advisory thread.

**Disclosure.** We will credit you by name or handle unless you prefer
otherwise, and we would like to publish the advisory once a fix is released. If
we go quiet or disagree with your severity, publish anyway — 90 days from your
report is a reasonable deadline and we will not ask you to wait longer.

**Safe harbour.** Testing in good faith against your own installation, your own
organization, and your own handles is authorised, and we will not pursue or
support any action against you for it. Do not test against other people's
organizations, do not access data that is not yours, and do not run availability
or load testing against `agent-call.app`.

## Supported versions

The latest released version only. There is no long-term support branch and
fixes are not backported.

## What is in scope

- Cross-organization reachability of any kind. The organization is the outermost
  boundary AgentCall routes within, and a path across it is the most serious
  class of bug in this system.
- Handle or address takeover, invite forgery, roster join-key misuse.
- Flaws in the end-to-end encryption: key confusion, downgrade, replay,
  ciphertext or plaintext reaching the relay.
- Credential material reaching a place it should not — relay logs, audit
  records, the local call log, a reply that the outbound redaction pass claims
  to cover.
- Guard bypass **for Claude file tools within the stated boundary**: reads of
  credential paths or of paths outside the task working directory.
- Anything in the published npm packages: install-time execution, tampered
  tarballs, provenance failures.

## What is not a vulnerability

These are documented properties of the design, written down in
[README.md](./README.md#security-model-v1-explicit) and in the
[security overview](https://agentcall.mintlify.app/security/overview). Reports
about them are welcome as discussion, but they will be closed as known rather
than treated as findings:

- **Shell access is not confined by the file guard.** A task that grants shell
  execution grants broad local and network authority. The guard is recorded, not
  enforced, on that path. If a task grants a shell, the shell is the boundary.
- **Files a coding agent loads into its own system prompt are outside the
  guard.** The guard evaluates tool calls. Files an agent reads while starting
  up — `CLAUDE.md` and its imports, for example — are loaded before any tool
  call happens, so no tool-call-level control can see them. Keep secrets out of
  the files your agent loads at startup.
- **Prompt injection written as ordinary prose.** The caller's message is
  defanged against AgentCall's own instruction fence and model control tokens.
  That is a syntax boundary, not a classifier. A harmful instruction phrased as
  plain English still reaches the agent; the task and its capabilities are what
  bound it.
- **Codex answering does not enforce a read boundary.** Codex support is
  experimental and its read-only mode prevents writes, not reads.
- **Any organization member can call any handle in that organization.** An
  address is a routing identifier, not a secret capability.
- **A labelled source grants the files git was told to ignore.** Sensitivity
  labels resolve by longest-prefix over the configured sources, and the only
  subtractions are eight credential basename patterns (`.env`, `id_rsa`,
  `*.pem`, and similar). `.gitignore` is not consulted, and `setup` labels the
  enclosing git repository `internal` by default — so a build artefact, a
  `*.local` override, a `.terraform/` state directory, or a scratch dump inside
  that repository is readable by a cleared caller. Cursor and Copilot both
  auto-grant the workspace *and* ship a default exclusion list; we ship the
  first half only. This is [#397](https://github.com/KenTaniguchi-R/agentcall/issues/397),
  it is open, and the honest reason it is not fixed yet is that consulting
  `.gitignore` correctly means nested files, negation patterns and
  `core.excludesFile` on every single tool call, against a guard entry point
  with a pinned import budget. Until it lands: do not keep secrets in ignored
  files inside a labelled repository, and remember the residual is large either
  way — basename patterns catch roughly 5–13% of real secrets.
- **The relay sees traffic metadata** even though call content is end-to-end
  encrypted.

The line between this list and the previous one is whether the property is
written down. If you find something that contradicts what the documentation
claims, that is in scope even if it resembles an item above — a documentation
claim that overstates the boundary is itself the bug, and has been before.

## Operating your own relay

If you self-host, you own the deployment. Scope the Cloudflare API token to the
Worker and its bindings, keep `workers_dev` disabled so the bypass URL cannot
reach your relay directly, and apply D1 migrations before deploying code that
depends on them.
