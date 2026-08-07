# Two provenance signals: git remotes and MCP transport

**Date:** 2026-08-06
**Verified against:** `main` @ `6dbf1c6`; git 2.55.0; MCP spec revision `2026-07-28`.
**Companion notes:** [repo-seed default evidence](./2026-08-06-repo-seed-default-evidence.md),
[MCP source default trust](./2026-08-06-mcp-source-default-trust.md).

AgentCall may not ask the owner or an IT admin to configure anything, so any
split between "safe to answer from" and "personal, do not touch" has to be
derived from what is already on disk. Two candidate signals were put on the
table. This note grades both.

Two conventions used throughout, because a recent batch in this directory
contained a fabricated claim and a fabricated quotation:

- **VERIFIED** marks something I established by running it on this machine.
  Commands and outputs are reproducible; the throwaway repos live in the
  session scratchpad and nothing outside them was modified.
- **DOCUMENTED** marks something I read at a primary source. Everything inside
  quote marks is text I actually read at the cited URL or file.

Everything else is inference and is labelled as such.

---

## Verdicts

**Signal 1 — git remote as an organization-ownership signal.**
**Unsound in the granting direction. Default-grade in the withholding
direction.** A remote that resolves to the organization's own forge does *not*
imply the caller can read the repository — GitHub's private-repository access
model is per-team and per-user, the organization-wide base permission can be
`None`, and outside collaborators are members of no team at all. That is not a
corner case; it is how private repositories are normally administered. The
contrapositive, however, is sound and cheap: **no remote, or a remote that does
not resolve to organization infrastructure, is good evidence that the content
was never shared with anyone**, and withholding on it fails closed.

**Signal 2 — MCP transport as a work/personal signal.** **Unsound.** The
stdio/HTTP split does not separate the population — the two most widely
installed corporate MCP servers (GitHub, Slack) are normally installed as
*stdio* processes holding a long-lived token, and `mcp-remote` exists
specifically to make any remote server look like a stdio one. Worse, the
refinement that survives the transport critique — "does the server perform OAuth
against a remote authorization server" — fails on a different axis: a Gmail MCP
server does exactly that, against a system with a rigorously enforced ACL whose
membership is one person. And underneath both, the delegation problem is fatal
on its own: an MCP server on the owner's machine answers with the *owner's*
permissions, so "the backing system enforces an ACL" tells you nothing about
whether the *caller* was inside it.

---

# Signal 1 — the git remote

## 1.1 How `origin` actually resolves, and where a naive parse breaks

The naive implementation is `git config --get remote.origin.url`, parse a host
out of the string, compare it to something. Each step below is wrong in at least
one common configuration.

### The wrong command

**DOCUMENTED.** `git remote get-url` and `git config --get remote.origin.url`
are not the same query. git-remote(1) says of `get-url`:

> Retrieves the URLs for a remote. Configurations for `insteadOf` and
> `pushInsteadOf` are expanded here. By default, only the first URL is listed.

**VERIFIED**, git 2.55.0, throwaway repo. With
`remote.origin.url = git@work:acme/repo.git` and
`url."https://github.com/acme/".insteadOf = "git@work:acme/"`:

```
git config --get remote.origin.url   ->  git@work:acme/repo.git
git remote get-url origin            ->  https://github.com/acme/repo.git
git ls-remote --get-url origin       ->  https://github.com/acme/repo.git
```

Adding `url."ssh://git@internal.example/".pushInsteadOf` made
`git remote get-url --push origin` return `ssh://git@internal.example/repo.git`
— a *third* answer, and the one git will actually push to.

`url.<base>.insteadOf` is documented in git's own config reference
(`Documentation/config/url.adoc`, v2.55.0):

> Any URL that starts with this value will be rewritten to start, instead, with
> `<base>`. […] When more than one insteadOf strings match a given URL, the
> longest match is used.

So a rule that reads `remote.origin.url` sees a URL git itself never contacts.
Direction of error: **either**, depending on which side of the rewrite the
organization sits on. In the shape above — a personal-looking SSH alias
rewritten to a corporate HTTPS host — reading the raw config **fails closed**.
In the reverse shape (corporate-looking URL rewritten to a personal mirror) it
**fails open**.

### The host is frequently not in the URL

**VERIFIED.** A remote of `git@work:acme/repo.git` names an SSH `Host` alias,
not a hostname. Resolving it requires reading `~/.ssh/config`. With

```
Host work
  HostName github.example-corp.com
  User git
  Port 2222
```

`ssh -G work` returns `hostname github.example-corp.com`, `port 2222`. Git never
does this resolution itself — it hands the alias string to `ssh`. **VERIFIED**
that `git remote get-url origin` still returns `git@work:...` with the alias
unexpanded.

The same mechanism runs the other way. A second alias in the same file,

```
Host gh-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_personal
```

**VERIFIED** to resolve to `hostname github.com`. This is the standard recipe
for separating a work identity from a personal one on the same machine, and it
means the *personal* remote is the one wearing a corporate-looking hostname in
the URL string. Direction of error: **fails open** — a remote reading
`git@gh-personal:alice/notes.git` is a personal account, and any rule matching
on the literal host string sees an unfamiliar host, while a rule that resolves
it sees `github.com`, which is also where the employer's org lives.

`ssh -G <host>` is the correct resolution and it is cheap (a fork, no network).
It also reads `/etc/ssh/ssh_config` and any `Include`d files, so it is the only
answer that accounts for a machine-level config the owner did not write.

### Conditional includes hide the config that decides identity

**DOCUMENTED.** git-config(1):

> You can conditionally include a config file from another by setting an
> `includeIf.<condition>.path` variable to the name of the file to be included.
> […] **`gitdir`** - The data that follows the keyword `gitdir` and a colon is
> used as a glob pattern. If the location of the .git directory matches the
> pattern, the include condition is met.

`includeIf "gitdir:~/work/"` is the canonical work/personal split, and it is
*also* where an `insteadOf` rewrite typically lives. **VERIFIED** that
`git config --show-origin --get remote.origin.url` reports which file a value
came from (`file:.git/config` in the test repo), so the provenance of the value
is inspectable — but only if you ask git rather than parsing files yourself.

### The enumerated failure table

Everything below was **VERIFIED** on git 2.55.0 unless marked otherwise.

| Shape | What a naive parse of `remote.origin.url` concludes | Truth | Direction |
|---|---|---|---|
| HTTPS `https://github.com/acme/repo.git` | org `acme` on github.com | correct | — |
| SSH scp-like `git@github.com:acme/repo.git` | needs a second parser (no scheme, `:` is not a port) | correct if parsed right | — |
| SSH URL `ssh://git@github.com:2222/acme/repo.git` | third syntax again | correct if parsed right | — |
| **SSH `Host` alias** `git@work:acme/repo.git` | host is literally `work` | `github.example-corp.com` | **open or closed** — unknowable without `ssh -G` |
| **Personal alias** `git@gh-personal:alice/x.git` | host is `gh-personal` | `github.com`, personal account | **fails open** if the rule allowlists by org path only |
| **`insteadOf` rewrite** | pre-rewrite URL | post-rewrite URL is what git uses | **either** |
| **`pushInsteadOf`** | fetch URL | push URL differs | **either** |
| **Multiple URLs on one remote** (`git remote set-url --add`) | first URL only ("By default, only the first URL is listed") | repo is pushed to both; second was `gitlab.example.com` in the test | **fails open** — a second, unexamined destination |
| **Fork: `origin` = personal, `upstream` = org** | `origin` = `github.com/alice/repo` | the code is the org's | **fails closed** if you only read `origin` |
| **Reverse fork: `origin` = org, `upstream` = public** | org-owned | correct for the branch, but merged upstream content is public | benign |
| **Submodule** | superproject's remote — *if you look at the superproject* | the submodule root has its own `.git` **file** and its own `origin`, often a third-party upstream | see below |
| **Relative submodule URL** (`../inner.git` in `.gitmodules`) | a filesystem path | **VERIFIED**: git resolved it against the superproject's origin and tried `https://github.com/acme/inner.git` | **fails closed** on a naive parse (looks like a local path) |
| **Linked worktree** | — | **VERIFIED**: `.git` is a *file* (`gitdir: …`); `git remote get-url origin` works and returns the main repo's remote | correct |
| **Remote configured, never pushed** | org-owned | nothing was ever shared | **fails open** |
| **No remote at all** | **VERIFIED**: `git remote get-url origin` exits 2, `error: No such remote 'origin'` | nothing was ever shared | correct, and loudly |
| **GHES / self-hosted GitLab on a custom domain** | unknown host | is the organization's own forge | **fails closed** under a host allowlist; **fails open** under an org-name match, since org names are not unique across forges |
| **Stray `.git` file that is not a gitfile** | — | **VERIFIED**: `git rev-parse` fails `fatal: invalid gitfile format` | fails closed |

The submodule row deserves its own sentence, because it interacts with what
ships. `defaultSensitivityMap` (`packages/cli/src/sensitivity.ts:256-267`) walks
up from `cwd` and stops at the first directory containing `.git`. **VERIFIED**
that a submodule's `.git` is a regular file, and `existsSync` returns true for a
file — so the walk-up stops at the *submodule*, not the superproject. That is
narrower than the monorepo grant the note on repo seeding worried about, which
is good; but the submodule's `origin` is typically a vendored third-party
upstream, so a remote-based rule evaluated at that root classifies the
employer's checkout by a dependency's provenance.

**Summary of 1.1.** A correct resolution is possible — `git remote get-url
origin` for the rewrite, `ssh -G` for the alias, `--all` for the extra URLs,
`--show-superproject-working-tree` for the submodule — but it is four to six
subprocess calls per repository, each of which is a place to be wrong, and two
of the shapes (self-hosted forge, never-pushed) cannot be resolved correctly at
all without knowing something the machine does not contain.

---

## 1.2 Does "same-org remote" imply "this colleague can read it"? No.

This is the load-bearing weakness, and it does not depend on any of the parsing
above being wrong. Suppose the remote is resolved perfectly and points at
`github.com/acme/billing-service`, and the caller is a member of `acme`. That
still does not establish read access.

### The visibility model

**DOCUMENTED**, from `github/docs` source
(`content/repositories/creating-and-managing-repositories/about-repositories.md`,
read 2026-08-06):

> * Public repositories are accessible to everyone on the internet.
> * Private repositories are only accessible to you, people you explicitly
>   share access with, and, for organization repositories, certain organization
>   members.
> * Internal repositories are accessible to all enterprise members.

Note the hedge in the private line: *certain* organization members. And on
internal:

> Organization members have read permissions to all internal repositories in an
> enterprise, including those in organizations they are not a member of.
> Internal repositories are not visible to people outside of the enterprise,
> including outside collaborators on organization repositories.

So the three visibilities map onto three different reader sets, only one of
which ("internal") is approximately "everyone a colleague could be" — and
`internal` requires GitHub Enterprise Cloud with an enterprise account.

### Why the private case breaks the inference

**DOCUMENTED**, `setting-base-permissions-for-an-organization.md`:

> You can set base permissions that apply to all members of an organization when
> accessing any of the organization's repositories. **Base permissions do not
> apply to outside collaborators.**

> By default, members of an organization will have **Read** permissions to the
> organization's public repositories.

> Internal repositories have a minimum visibility level of read, even if the
> base permission has been set to none.

Three things follow, and the third is the one that matters:

1. Base permission is a settable organization-wide dial whose options run down
   to `None`. Any organization that administers access per team — which is the
   entire point of teams — sets it low.
2. Outside collaborators are explicitly outside the dial.
   `adding-outside-collaborators-…` defines one as *"a person who is not a
   member of your organization, but has access to one or more of your
   organization's repositories"*, and notes they cannot be added to teams
   because *"team membership is restricted to members of the organization"*.
3. The read floor GitHub guarantees to org members is stated for **internal**
   repositories only. There is no analogous guarantee for private ones. A
   private repository in an organization is readable by exactly the union of its
   team grants, individual grants, outside-collaborator grants, and whatever the
   base permission happens to be — a set the local machine has no view of.

The default base-permission sentence is worth reading twice. It says members get
Read to the organization's **public** repositories by default. I could not find
a primary statement that the default extends read to private repositories, and
I am not going to assert one. Either way the conclusion is the same: whether a
given colleague can read a given private org repo is a per-repository
administrative fact, not a property of the remote URL.

### Quantifying the over-approximation — could not

I looked for any published measurement of how far "member of the org"
over-approximates "can read this repo": a study of team-grant density, of base
permission settings in the wild, of outside-collaborator prevalence. I found
none — see [What I could not verify](#what-i-could-not-verify). The GitHub
Octoverse figures that surfaced in search are about public/private repository
counts globally, not about intra-organization readability, and I did not verify
them at the primary source, so they are not cited here.

**What can be said without a number.** The over-approximation is not bounded by
anything. There is no floor: an organization can hold ten thousand private
repositories and grant a given member read on one of them. A signal whose error
rate has no upper bound derivable from the signal itself is not a boundary. The
absence of a measurement is not a gap in the argument — the argument is
structural.

---

## 1.3 Verifying instead of inferring: possible for a minority of repos, and it is the wrong minority

The real check is "does caller X have read access to repo Y". GitHub exposes it.

**DOCUMENTED**, from the GitHub OpenAPI description
(`github/rest-api-description`, `api.github.com.deref.json`, fetched 2026-08-06),
`GET /repos/{owner}/{repo}/collaborators/{username}/permission`:

> Checks the repository permission and role of a collaborator.
> […] The calculated permissions are the highest role assigned to the
> collaborator after considering all sources of grants, including: repo, teams,
> organization, and enterprise.

That is exactly the right question — it joins every grant source, which is
precisely what the local machine cannot do. **VERIFIED** against the live API on
2026-08-06:

| Call | Result |
|---|---|
| Unauthenticated, public repo | `401` `"Requires authentication"` |
| Authenticated (`repo`, `read:org` scopes), a public repo the token holder does not own | `403` `{"message":"Must have push access to view collaborator permission."}` |
| Authenticated, a repo the token holder owns | `200` `{"permission":"admin", …}` |

**The owner's token can only answer the question for repositories where the
owner already has push access.** For every repository where the owner is a
reader — which is most of an organization's repositories, for most people —
verification returns 403 and the answer is unavailable.

The sibling endpoint is worse, not better. **DOCUMENTED**, same source, `GET
/repos/{owner}/{repo}/collaborators/{username}`:

> The authenticated user must have push access to the repository to use this
> endpoint.
> OAuth app tokens and personal access tokens (classic) need the `read:org` and
> `repo` scopes to use this endpoint.

The GraphQL alternative does not route around it. **VERIFIED**:
`repository(owner:…, name:…) { viewerPermission }` returned `"ADMIN"` — but
`viewerPermission` is the *token holder's* permission by definition. There is no
`permissionFor(user:)`. The API surface simply does not offer "what can this
other person see" to a non-privileged token, which is a defensible design and a
fatal one for this use.

Even org membership is not freely checkable. **VERIFIED**:
`GET /orgs/github/members/octocat` from a token whose holder is not a member of
that org returned `404 "User does not exist or is not a public member of the
organization"` — the API silently degraded to the *public* membership check, so
a private member of an organization the owner is not in is indistinguishable
from a non-member.

**Cost, where verification is possible.** **VERIFIED** on 2026-08-06:
`GET /rate_limit` reported `core` limit **5000** requests/hour. Five sequential
calls to the permission endpoint took **0.308, 0.424, 0.437, 0.419, 0.313 s**
(`curl -w %{time_total}`, warm, residential connection). **DOCUMENTED**, GitHub's
rate-limit page: 5,000/hour for a personal access token, 5,000/hour for a GitHub
App installation, *"If the installation is on a GitHub Enterprise Cloud
organization, the installation has a rate limit of 15,000 requests per hour."*

So: ~350 ms of latency added to a call, well within a 5,000/hour budget for any
plausible call volume, and cached-able. **Cost is not the obstacle. Authority
is.** Answering the question requires a credential that can see the target
repository's collaborator list, which the owner's token has only where the owner
has push access. Getting one would mean AgentCall asking for a GitHub App
installation on the organization — which is exactly the "IT admin configures
something" that the premise forbids.

**Stated plainly: verification is not possible without new credentials, and the
credential it needs is an organization-level one the owner cannot grant alone.**

---

## 1.4 Per-file provenance: cheap, precise, and answering a slightly different question

All five states are distinguishable, per file, from two local commands and no
network. **VERIFIED** in a throwaway repo with a local bare remote:

```
git status --porcelain=v2 --branch --untracked-files=all --ignored=matching
git diff  --name-only @{u} HEAD
```

Output on a repo with one pushed file (locally modified), one committed-unpushed
file, one untracked file and one ignored file:

```
# branch.oid a3875378e1984985f9c8dd32515421232d90c035
# branch.head master
# branch.upstream origin/main
# branch.ab +1 -0
1 .M N... 100644 100644 100644 89e64b8… 89e64b8… pushed.txt
? untracked.txt
! ignored-thing.txt
```

and `git diff --name-only @{u} HEAD` → `unpushed.txt`.

| State | Where it shows |
|---|---|
| tracked, pushed, clean | absent from `status`, absent from the `@{u}..HEAD` diff |
| tracked, pushed, locally modified | `1 .M …` (or `1 M. …` if staged) |
| tracked, committed, **not** pushed | named by `git diff --name-only @{u} HEAD`; `# branch.ab +N` counts the commits |
| untracked | `? path` (requires `-uall`; the default `-unormal` collapses whole directories) |
| ignored | `! path` (requires `--ignored=matching`; `--ignored=traditional` collapses directories) |

**Cost. VERIFIED** on a synthetic repo built in the scratchpad: 50,000 tracked
files, 60,001 working-tree files (10,000 of them ignored `node_modules` noise),
no `core.untrackedCache`, no fsmonitor, macOS/APFS, warm cache, 5 runs each,
median:

| Command | Median |
|---|---|
| `git status --porcelain=v2 --branch -uno` | 56 ms |
| `git status --porcelain=v2 --branch -uall --ignored=matching` | **78 ms** |
| `git ls-files` | 10 ms |
| `git diff --name-only HEAD` | 57 ms |
| `git check-ignore -v <one path>` | 6 ms |

**So this is a per-call cost, not a per-file cost, and it is small.** One
`status` invocation yields the classification for every file in the tree. Doing
it per file via `check-ignore` would be 6 ms × N and is unnecessary.

### Three caveats that decide how much the per-file answer is worth

1. **`@{u}` is a local cache, not the remote.** Remote-tracking refs advance
   only on fetch and push. If someone else pushed and this machine has not
   fetched, files already on the remote are reported as unpushed — **fails
   closed**, which is the direction you want. The fail-open direction exists
   (a force-push that removes commits leaves `origin/*` claiming content the
   remote no longer has) but it means "was shared once and later withdrawn",
   which is a weaker error.

2. **No upstream, no answer. VERIFIED**: on a branch with no upstream,
   `git diff @{u} HEAD` exits with `fatal: no upstream configured for branch
   'nobranch'`, and `status --branch` simply omits `# branch.upstream` and
   `# branch.ab`. Same for detached HEAD (`# branch.head (detached)`). Both are
   detectable and both should fail closed. This covers the common real case of a
   feature branch that has not been pushed yet — where *every* file in the
   working tree is unshared even though the repository has been pushed for
   years.

3. **"Pushed" means "pushed to `origin`", and `origin`'s identity is Signal 1.**
   In the **VERIFIED** fork configuration (`origin = github.com/alice/repo`,
   `upstream = github.com/acme/repo`), `git diff @{u} HEAD` answers "is this on
   *alice's personal fork*". The per-file mechanism is precise about a
   destination it cannot itself identify. **Per-file provenance does not rescue
   Signal 1 — it inherits Signal 1's central weakness and adds precision on top
   of it.**

**What the per-file layer is genuinely good for.** Not "already shared, so safe
to answer from" — the caveats above kill that. It is good for the *negative*:
untracked and ignored files were provably never sent anywhere, and they are
exactly the population the repo-seed note identified as most likely to hold a
working credential (build artefacts, `*.local` overrides, scratch dumps).
`--ignored=matching` gives that population for 78 ms, once per call, with no
new dependency — which is a cheaper implementation of that note's
highest-priority recommendation than adding a `.gitignore` parser.

---

## 1.5 Signal 1: where it produces the wrong answer

**Fails open (grants content the caller cannot actually read):**

- Private org repo the caller has no team or individual grant on. The base case,
  unbounded, unmeasurable locally.
- Organization with base permission set to `None`.
- Caller is an outside collaborator on *some* org repo — an org-membership
  inference is wrong for them by construction.
- Personal remote wearing an SSH alias that resolves to `github.com`, matched by
  a path-only or alias-string rule.
- `insteadOf` rewriting a corporate-looking URL to a personal mirror.
- Second URL on a multi-URL remote, unexamined ("only the first URL is listed").
- Remote configured but never pushed: the repository is org-named and its
  contents were never shared with anyone.
- GHES/self-hosted forge matched by organization *name*: org names are not
  unique across forges, so `acme` on a stranger's GitLab matches `acme` on the
  employer's.
- A vendored submodule whose `origin` is a third-party upstream, evaluated at
  the submodule root that the shipped walk-up actually stops at.

**Fails closed (withholds content the caller could already read):**

- Fork where `origin` is the developer's personal fork and `upstream` is the
  organization.
- SSH `Host` alias hiding a corporate hostname, under a host allowlist.
- GHES/self-hosted forge under a host allowlist.
- `pushInsteadOf` pointing at internal infrastructure while `origin` reads
  public.
- Relative submodule URL that looks like a filesystem path.
- Stale `origin/*` reporting pushed files as unpushed.
- A branch with no upstream — every file reads as unshared.

**Verdict.** The fail-closed column is a usability cost. The fail-open column is
a disclosure, and its first entry is not an edge case but the ordinary
administration of private repositories. **Do not grant on this signal.** Use its
negation: a repository with no remote, or whose remote does not resolve to
organization infrastructure after `get-url` + `ssh -G`, is evidence of
*not*-shared, and withholding on it is safe by construction. That is a
**default**-grade use of a signal that is **unsound** as a boundary.

---

# Signal 2 — MCP transport

## 2.1 What a client can observe about a configured server without invoking it

**DOCUMENTED**, MCP spec 2026-07-28. The transports page names exactly two
standard bindings:

> 1. stdio: newline-delimited messages over the standard streams of a
>    client-launched subprocess.
> 2. Streamable HTTP: each message is an HTTP POST to a single MCP endpoint;
>    replies arrive as a JSON object or a request-scoped SSE stream.

plus `MAY`-level custom transports, which *"MUST preserve the JSON-RPC message
format, the message patterns, and the per-request metadata model"* and are
otherwise unconstrained.

For a stdio server the spec says only that *"the client launches the MCP server
as a subprocess"*. It says nothing about what the subprocess is or does. The
client's whole view is the config entry.

**DOCUMENTED**, Claude Code's MCP reference (code.claude.com/docs/en/mcp, read
2026-08-06), which is the config surface that actually matters here:

- stdio: `command`, `args`, `env`. Added with
  `claude mcp add --env KEY=value --transport stdio <name> -- <command> <args>`.
- HTTP: `type` (`"http"`, with *"`streamable-http` as an alias for `http`"*),
  `url`, `headers`, `headersHelper`, `timeout`, `alwaysLoad`.
- SSE: same shape, `--transport sse`, and *"The SSE (Server-Sent Events)
  transport is deprecated. Use HTTP servers instead, where available."*
- WebSocket: `type: "ws"`, same fields as `http`; *"Authentication is
  header-only"*.
- Scopes: local, project (`.mcp.json`), user (`~/.claude.json`).
- Disambiguation rule, quoted because it is the only thing tying transport to a
  field: *"A JSON entry that has a `url` but no `type` is a configuration error,
  because Claude Code reads an entry with no `type` as a stdio server."*

**Nothing in the protocol states what backing system a server talks to.** I
confirmed this in the companion note against the schema directly
(`schema/2026-07-28/schema.ts`): `ToolAnnotations` carries `title`,
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and
nothing else; `Annotations` carries `audience`, `priority`, `lastModified`.
There is no classification, no data-source, no tenancy field. The
[trust-annotations extension](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations)
that would have added one is draft, and its own text says *"Absence MUST be
treated as 'no claim made,' never as 'asserted false.'"*

What *is* observable, then: transport type; for stdio, the literal command line
and the names (not values, unless the owner inlined them) of environment
variables; for HTTP, a URL and header names. And, after a connection attempt,
whether the server issued an OAuth challenge — §2.2.

## 2.2 Is stdio/HTTP a sound proxy for local/remote? No, in both directions.

### stdio servers that front a remote SaaS

**`mcp-remote` is the general counter-example.** **DOCUMENTED**
(github.com/geelen/mcp-remote): it *"Connect[s] an MCP Client that only supports
local (stdio) servers to a Remote MCP Server, with auth support"*, configured as

```json
{ "mcpServers": { "remote-example": {
    "command": "npx", "args": ["mcp-remote", "https://remote.mcp.server/sse"] } } }
```

That is a stdio entry whose entire function is to be a remote server. Any rule
keyed on transport misclassifies every server installed this way — and this was
the *only* way to reach a remote MCP server from a stdio-only client for most of
the ecosystem's life.

**The official GitHub server ships both ways.** **DOCUMENTED**
(github.com/github/github-mcp-server): the remote form is
`{"type": "http", "url": "https://api.githubcopilot.com/mcp/"}`; the local form
is `command: "/path/to/github-mcp-server"`, `args: ["stdio"]`, with
`GITHUB_PERSONAL_ACCESS_TOKEN` in `env` — or the Docker variant, `docker run -i
--rm -e GITHUB_PERSONAL_ACCESS_TOKEN`. Same backend, same corporate ACL, two
transports. Transport carries zero information here.

**Slack is stdio-first and the credential is not a person's.** **DOCUMENTED**
(github.com/zencoderai/slack-mcp-server — the maintainer the archived reference
server was handed to): transports are *"Stdio Transport"* (`"Default: Yes"`) and
*"Streamable HTTP Transport"*; the credential is a *"Bot User OAuth Token"* that
*"starts with `xoxb-`"*, via `SLACK_BOT_TOKEN`. A bot token's visibility is the
bot's channel membership — neither the owner's nor the caller's. This one is
worth flagging beyond the transport point: it is a case where the backing system
enforces an ACL and that ACL corresponds to *no human at all*.

**Google Drive was stdio with a local OAuth credential file.** **DOCUMENTED**
(modelcontextprotocol/servers-archived, `src/gdrive`, archived 2025-05-29): the
setup is download `gcp-oauth.keys.json`, run `node ./dist auth`, and the server
reads `.gdrive-server-credentials.json` from `GDRIVE_CREDENTIALS_PATH`. Local
stdio process, remote ACL-bearing backend, credential on disk.

**Sentry ships both.** **DOCUMENTED** (github.com/getsentry/sentry-mcp): hosted
at `https://mcp.sentry.dev` with OAuth, *and* a stdio form,
`npx @sentry/mcp-server@latest --access-token=sentry-user-token`, which is also
how you reach a self-hosted Sentry.

### HTTP servers serving purely local data

The spec anticipates them explicitly. **DOCUMENTED**, Streamable HTTP transport,
Security & Endpoint:

> 2. When running locally, servers **SHOULD** bind only to localhost (127.0.0.1)
>    rather than all network interfaces (0.0.0.0).

> Without these protections, attackers could use DNS rebinding to interact with
> local MCP servers from remote websites.

A normative rule about local HTTP MCP servers is proof the population exists.
And it is populated by tooling: **DOCUMENTED**, `docker mcp gateway run`,
`--transport` is *"stdio, sse or streaming. Uses MCP_GATEWAY_AUTH_TOKEN
environment variable for localhost authentication to prevent dns rebinding
attacks"*, with `--port` *"TCP port to listen on (default is to listen on
stdio)"*. Point the gateway at a set of local containerized servers, run it with
`--transport streaming`, and every one of them appears to the client as a single
HTTP endpoint on localhost.

### The refinement, and why it also fails

The strongest version of the proposal is not transport but **"does the server
perform OAuth against a remote authorization server"**, which would be real
evidence of a remote, ACL-bearing backend. It is observable: **DOCUMENTED**, MCP
authorization requires the challenge-and-discovery dance —
`HTTP 401 / WWW-Authenticate: Bearer resource_metadata="…"`, then
`/.well-known/oauth-protected-resource`, then AS metadata. A client necessarily
sees all of it. And the spec draws the transport line for authorization itself:

> * Implementations using an HTTP-based transport **SHOULD** conform to this
>   specification.
> * Implementations using an STDIO transport **SHOULD NOT** follow this
>   specification, and instead retrieve credentials from the environment.

So OAuth presence *does* separate "reaches a remote system with an
authorization server" from "reads a local file". **It does not separate work
from personal, and the counter-example is decisive.**

**VERIFIED** on the machine this note was written on, via `claude mcp list`
(names and transports only; URLs and tokens redacted before recording): among 20
configured servers, the HTTP/SSE group includes a **Gmail** server, a **Google
Calendar** server, and a personal **Google Drive** server — all remote, all
OAuth, all backed by a system with a rigorously enforced per-user ACL whose
membership for these accounts is one person. Meanwhile `openmemory` — a personal
memory store — is configured over **SSE**, and `personal-info` (a local personal
data server) is stdio.

A signal that classifies the owner's private mailbox as "backed by a system that
already enforces an organization ACL" is not a work/personal signal. It is an
ACL-existence signal, and ACL existence is not the question.

## 2.3 Inventory

Transport is "as normally installed" per each project's own documentation.
Everything in this table is **DOCUMENTED** from the cited source, read
2026-08-06. "Enforces per-user org permissions?" asks about the *backing
service*, not the MCP server.

| Server | Transport as normally installed | Authenticates to a remote service? | Backing service enforces per-user org permissions? | Source |
|---|---|---|---|---|
| **Atlassian (Jira/Confluence/Bitbucket)** | Remote **HTTP**, `https://mcp.atlassian.com/v1/mcp/authv2`; historically reached via `mcp-remote` stdio | Yes, *"secure OAuth 2.1 authorization"* | **Yes** — *"all actions respect users' existing access controls and permissions"* | support.atlassian.com Rovo MCP getting-started |
| **GitHub (remote)** | **HTTP**, `https://api.githubcopilot.com/mcp/` | Yes, OAuth | Yes | github/github-mcp-server README |
| **GitHub (local)** | **stdio** — binary `github-mcp-server stdio`, or `docker run -i --rm` | Yes, via `GITHUB_PERSONAL_ACCESS_TOKEN` | Yes, but as the PAT holder | same |
| **Slack** | **stdio** (documented default), HTTP optional | Yes, `SLACK_BOT_TOKEN` (`xoxb-`) | **No** — a *bot's* channel membership, not any human's | zencoderai/slack-mcp-server |
| **Notion** | **HTTP**, `claude mcp add --transport http notion https://mcp.notion.com/mcp` | Yes, OAuth | Yes — *"the MCP client can use Notion MCP tools to read and update content that you can access"* | developers.notion.com/docs/mcp; Claude Code MCP docs |
| **Google Drive** (reference server, archived 2025-05-29) | **stdio** | Yes, Google OAuth via a local credentials file | Yes, as the authenticated Google account — **which is often a personal one** | modelcontextprotocol/servers-archived `src/gdrive` |
| **Sentry** | **HTTP** `https://mcp.sentry.dev`, *and* **stdio** `npx @sentry/mcp-server --access-token=…` | Yes, OAuth (hosted) or user auth token (stdio) | Yes | github.com/getsentry/sentry-mcp |
| **Linear** | **Streamable HTTP**, *"Read-write access is provided through `https://mcp.linear.app/mcp` by default"* | Yes — *"The interactive setup flow uses OAuth 2.1 with dynamic client registration"*; also bearer/API key | Yes; enterprise-managed auth via Okta available | linear.app/docs/mcp |
| **Gmail / Google Calendar** (Claude connectors) | **HTTP**, OAuth | Yes | **ACL of one person.** The counter-example | VERIFIED locally via `claude mcp list` |
| **Filesystem** (reference) | **stdio** | No | n/a — *"All filesystem operations are restricted to allowed directories"*, from `args` or MCP Roots | modelcontextprotocol/servers `src/filesystem` |
| **Memory / knowledge graph** (reference) | **stdio** | No | n/a — a local JSONL file, `MEMORY_FILE_PATH` | modelcontextprotocol/servers `src/memory` |
| **SQLite / PostgreSQL** (reference, archived) | **stdio** | No (SQLite) / depends (Postgres) | n/a | modelcontextprotocol/servers-archived |
| **openmemory** (personal memory store) | **SSE** — remote transport, personal data | Yes | **No** | VERIFIED locally via `claude mcp list` |
| **Docker MCP Gateway** (aggregating local servers) | **stdio** by default, `--transport sse\|streaming` on a local port | No | n/a | docs.docker.com `docker mcp gateway run` |

Read the transport column against the last column. stdio contains: the official
GitHub server against a corporate ACL, Slack against a bot ACL, Google Drive
against a personal Google account, and the filesystem/memory servers against
nothing. HTTP contains: Atlassian and Linear against corporate ACLs, Gmail
against an ACL of one, openmemory against nothing. **The signal does not
separate the population in either direction.**

## 2.4 The delegation problem, which is fatal independently

Even granting the best case — the owner has the Atlassian server installed, it
is HTTP, it does OAuth, and Jira genuinely enforces an organization ACL — the
inference still does not reach the conclusion AgentCall needs.

Atlassian states the mechanism in its own words. **DOCUMENTED**: *"MCP clients
can perform actions on all connected products (such as Jira, Confluence,
Bitbucket) with **your** existing permissions."* Notion says the same thing
differently: *"the MCP client can use Notion MCP tools to read and update
content that **you can access**."*

"You" is the person who completed the OAuth flow. On AgentCall that is the
owner. The caller is a different person whose Jira permissions are not consulted
at any point in the chain. So "the backing system has an ACL" establishes only
that the *owner's* read was authorised — which was never in doubt — and says
nothing about the caller. This is the same identity gap the MCP default-trust
note identified as the structural reason no other system's fail-open default
transfers here.

### Does anything propagate a caller identity?

**The protocol forbids the naive version. DOCUMENTED**, MCP authorization,
Access Token Usage:

> MCP clients **MUST NOT** send tokens to the MCP server other than ones issued
> by the MCP server's authorization server.
>
> MCP servers **MUST** only accept tokens that are valid for use with their own
> resources.
>
> MCP servers **MUST NOT** accept or transit any other tokens.

combined with the audience-binding requirement that servers *"MUST validate that
access tokens were issued specifically for them as the intended audience"*. So
token passthrough is closed off by design.

**Token exchange exists in MCP — and its subject is the wrong person.** The
`ext-auth` repository (`modelcontextprotocol/ext-auth`, `main` @ `fb374c7db2`,
2026-06-18) contains exactly two extensions: `oauth-client-credentials.mdx`
(draft) and `enterprise-managed-authorization.mdx` (**Stable**). The stable one
*is* RFC 8693 token exchange. **DOCUMENTED**, verbatim:

> This document defines an application of the "Identity Assertion JWT
> Authorization Grant" for use within enterprise deployments of the Model
> Context Protocol (MCP).

> - A user logs in to an MCP Client through their enterprise Identity Provider,
>   resulting in an Identity Assertion (ID Token or SAML assertion) being issued
>   to the MCP Client.
> - The MCP Client sends a Token Exchange [RFC8693] request to the Identity
>   Provider including the ID Token or Refresh Token, and the identifier of the
>   MCP Server it is attempting to access, and obtains a Identity Assertion JWT
>   Authorization Grant (ID-JAG).

> The IdP evaluates administrator-defined policies for the token exchange
> request and determines if the MCP Client should be granted access to act on
> behalf of the user for the target MCP Server and scopes.

The subject token is the ID token of *the user who signed in to the MCP client*.
The extension removes a consent click for that user; it does not let the client
act as somebody else. Applied to AgentCall the subject would be the owner, which
is where we started.

**Gateways do not close it either.** **DOCUMENTED**, Cloudflare MCP Portals: the
default is per-user OAuth — *"User will be prompted to utilize their own login
credentials to establish a connection with the MCP server"* — and the
alternative, with "Require user auth" disabled, is that *"Users who are
connected to the portal will automatically have access to the MCP server via its
admin credential"*. Those are the only two options: each reader authenticates
themselves, or everyone shares one credential. Neither is on-behalf-of. And the
first is structurally unavailable to AgentCall — the caller is not at the
owner's machine and cannot complete a browser OAuth flow into it.

Docker MCP Gateway: **DOCUMENTED**, it *"acts as a centralized proxy between
clients and servers, managing configuration, credentials, and access control"*
and *"injects any required credentials"*. I found no per-user identity,
delegation, or on-behalf-of support in its documentation. Recorded as **not
found**, not as absent — see [What I could not verify](#what-i-could-not-verify).

FIDES (`microsoft/agent-framework`): its labelling model, examined in the
companion note, is a confidentiality lattice over a single user's context. It
has no notion of a second reader.

**Nothing surveyed supports acting on behalf of a different user.** The
consequence is that "the backing system has an ACL" is not merely a weak
argument for safety; it is not an argument for safety at all, because the ACL
that got consulted was the wrong one.

## 2.5 Signal 2: where it produces the wrong answer

**Fails open (treats personal or non-shareable content as work content):**

- Any remote OAuth server backed by a *personal* account — Gmail, personal
  Google Drive, personal Notion, a personal Linear workspace. VERIFIED present
  in a real configuration.
- `openmemory` and similar personal stores exposed over SSE/HTTP.
- A localhost HTTP server, which the spec explicitly contemplates and the Docker
  gateway routinely produces.
- **Every case that passes the transport *and* the OAuth test but fails
  delegation** — a genuine corporate Jira answering with the owner's
  permissions, for a caller who has none. This is the largest fail-open class
  and it is not an edge case; it is the normal operation of the signal.

**Fails closed (refuses work content the caller could read):**

- Official GitHub server installed as a local stdio binary or Docker container.
- Slack via the stdio default.
- Any remote server reached through `mcp-remote`.
- Self-hosted Sentry, Atlassian Data Center, or GitLab via a stdio server with a
  token.
- Corporate Google Workspace Drive via the stdio reference server.

**Verdict: unsound.** Do not use transport, and do not use the OAuth refinement
either. The refinement answers "is there an ACL"; the question is "was the
caller inside it", and no observable property of an MCP configuration
distinguishes the two. This does not change the default the companion note
already recommends — `secret` for unlabelled MCP servers stands, and it stands
for the same reason: AgentCall is the one system where the reader is not the
credential holder.

---

## What I could not verify

1. **Any measurement of how far "member of the org" over-approximates "can read
   this private repo."** No study of team-grant density, base-permission
   settings in the wild, or outside-collaborator prevalence. GitHub does not
   publish it and I found no academic work on it. §1.2's conclusion is
   structural, not statistical, and is stated that way.
2. **Whether GitHub's default base permission extends read to *private*
   organization repositories.** The primary sentence I read covers public
   repositories only: *"By default, members of an organization will have Read
   permissions to the organization's public repositories."* I did not find a
   primary statement either way about private ones and did not assert one.
3. **GitHub Octoverse repository-visibility statistics.** Figures surfaced in
   search (63% of repositories public, 81.5% of contributions in private repos)
   were not verified at github.blog and are not cited. They are about global
   counts, not intra-organization readability, so they would not have been
   load-bearing.
4. **Whether Docker MCP Gateway supports any form of on-behalf-of or per-user
   identity.** I read the gateway overview and the `gateway run` CLI reference
   and found none. This is *not found*, not *absent* — the project is large and
   I did not read its source.
5. **Whether a force-push that removes commits makes `git diff @{u} HEAD`
   over-report pushed state.** The mechanism follows from remote-tracking refs
   advancing only on fetch/push, but my scratchpad reproduction of the
   force-push case did not run cleanly and I did not retry it. The fail-*closed*
   direction (stale `origin/*` under-reporting) **was** verified.
6. **The transport distribution of MCP servers in the wild.** §2.3 is an
   inventory of documented install methods for named servers, not a measurement
   of what people run. The 20-server local configuration in §2.2 is one machine
   and is presented as one machine.
7. **Whether any MCP server or gateway outside the surveyed set implements
   RFC 8693 delegation with a *third-party* subject.** I read the MCP
   authorization spec, both `ext-auth` extensions, Cloudflare MCP Portals'
   documentation, and Docker's gateway documentation. Nothing there does. I did
   not survey the ~20,000-entry registry.
8. **`git status` cost with `core.untrackedCache` or fsmonitor enabled.** The
   78 ms figure is for neither. Both would make it faster, so 78 ms is an upper
   bound for the 50k-file case, not a typical value.

---

## Sources

**Primary — git (all quotations read at source; behaviour VERIFIED on git 2.55.0):**

- `git remote` manual, `get-url` subcommand — <https://git-scm.com/docs/git-remote>
- `git config` manual, conditional includes — <https://git-scm.com/docs/git-config>
- `Documentation/config/url.adoc` @ `v2.55.0` —
  <https://raw.githubusercontent.com/git/git/v2.55.0/Documentation/config/url.adoc>
- `ssh_config(5)` `Host`/`HostName` behaviour, exercised via `ssh -G`

**Primary — GitHub:**

- `github/docs` source, read 2026-08-06:
  `content/repositories/creating-and-managing-repositories/about-repositories.md`;
  `.../managing-repository-roles/setting-base-permissions-for-an-organization.md`;
  `.../managing-repository-roles/repository-roles-for-an-organization.md`;
  `data/reusables/repositories/about-internal-repos.md`
- <https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-outside-collaborators/adding-outside-collaborators-to-repositories-in-your-organization>
- `github/rest-api-description`, `api.github.com.deref.json`, fetched 2026-08-06
  — descriptions for `GET /repos/{owner}/{repo}/collaborators/{username}/permission`
  and `.../collaborators/{username}`
- <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- Live API responses (401 / 403 / 200 / rate_limit / GraphQL `viewerPermission`),
  captured 2026-08-06

**Primary — MCP:**

- Spec 2026-07-28: [transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports),
  [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
  [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
  [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- `modelcontextprotocol/ext-auth` @ `fb374c7db2` (2026-06-18) —
  `specification/stable/enterprise-managed-authorization.mdx`,
  `specification/draft/oauth-client-credentials.mdx`
- `modelcontextprotocol/experimental-ext-tool-annotations` — trust-annotations
  default rule (via the companion note, re-checked)
- [Claude Code MCP reference](https://code.claude.com/docs/en/mcp)

**Primary — MCP servers and gateways:**

- <https://github.com/geelen/mcp-remote>
- <https://github.com/github/github-mcp-server>
- <https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/>
- <https://github.com/zencoderai/slack-mcp-server>
- <https://developers.notion.com/docs/mcp>
- <https://github.com/getsentry/sentry-mcp>
- <https://linear.app/docs/mcp>
- `modelcontextprotocol/servers` — `src/filesystem`, `src/memory`
- `modelcontextprotocol/servers-archived` — `src/gdrive` (archived 2025-05-29)
- <https://docs.docker.com/ai/mcp-gateway/>, <https://docs.docker.com/reference/cli/docker/mcp/gateway/run/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/>

**AgentCall source, read at `main` @ `6dbf1c6`:**

- `packages/cli/src/sensitivity.ts` — `defaultSensitivityMap` (`:256-267`),
  `FLOOR_DIRS`/`FLOOR_FILES` (`:135-149`), `permits` (`:75-78`),
  `readableSources`/`workdirFor` (`:198-240`)
- `packages/cli/src/guard.ts` — `DENIED_BASENAMES` (`:58-63`), `decide`
