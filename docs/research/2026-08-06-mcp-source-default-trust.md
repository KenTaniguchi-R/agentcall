# What a fresh install should trust: the MCP default

**Date:** 2026-08-06
**Issues:** [#392](https://github.com/KenTaniguchi-R/agentcall/issues/392) (the wiring),
[#394](https://github.com/KenTaniguchi-R/agentcall/issues/394) (the labelling-model amendment)
**Verified against:** `main` @ `6dbf1c6`; MCP spec revision `2026-07-28`; sources dated inline.

`defaultSensitivityMap` seeds `mcp: {}` (`sensitivity.ts:40`), unlabelled means
`secret` (`:24`), and `permits` refuses `secret` unconditionally (`:75-78`). So
on a fresh install every MCP server is denied. The question is whether any
shipping system has a better answer.

## Findings first

1. **No surveyed system fails closed on confidentiality for an unlabelled
   source. Every one of them fails open.** FIDES defaults an unlabelled tool to
   `PUBLIC` confidentiality. Azure AI Search returns unlabelled documents to
   everyone. Microsoft Purview's default label policy assigns unlabelled content
   `General \ All Employees (unrestricted)`. Cloudflare MCP Portals expose every
   tool of a newly added server. The MCP trust-annotations extension says
   absence is "no claim made".

2. **That evidence does not transfer, and the reason is structural.** In every
   one of those systems the party who receives the data is the party whose
   credentials fetched it. AgentCall is the only case where the credential
   holder (the owner) and the reader (the caller) are different people. A
   fail-open default is cheap when the reader already had the access; it is a
   disclosure when they did not.

3. **The one shipping system whose shape does match AgentCall — Azure's
   "elevated read" — neither denies nor trusts. It allows, and emits one audit
   record per document returned.** That is a third posture, and it is the one
   the evidence actually supports.

4. **Per-tool-within-a-server labelling does not buy confidentiality
   granularity.** `microsoft/agent-framework` is the only system found that can
   partition a tool result, and it partitions for *integrity only* — the
   confidentiality label is joined across every item including the ones it hid.
   `github/github-mcp-server` refuses per-item labels outright for the same
   reason.

5. **`readOnlyHint` is not a confidentiality signal.** FIDES uses it, correctly,
   to decide whether a tool is a *sink*. It says nothing about how sensitive
   what you read is. For a confidentiality-only model it is worth zero.

6. **MCP does have a URI hierarchy — on the Resources surface, which is not the
   surface AgentCall enforces on.** Tool results are not URI-addressed, and
   Claude Code exposes Resources only through user `@`-mentions, not as
   agent-callable tools. The prefix logic has nothing to bind to.

**Recommendation: keep `secret`, and stop treating the label as a setup-time
problem.** See [What this means for AgentCall](#what-this-means-for-agentcall).

---

## 1. What each system does with an unlabelled opaque source

| System | Default for unlabelled | Direction |
|---|---|---|
| `microsoft/agent-framework` (FIDES) | `UNTRUSTED` + `PUBLIC` | closed on integrity, **open on confidentiality** |
| `github/github-mcp-server` | emits no label at all (opt-in flag) | punts to the consumer |
| MCP `trust-annotations` extension | "no claim made" | punts to the client, explicitly |
| `ifc.fides.v1` scheme | host's default policy; "labels are an *additive* signal" | **open** |
| Azure AI Search + Purview | unlabelled documents are returned | **open** |
| Purview default label policy | `General \ All Employees (unrestricted)` | **open** (second-lowest tier) |
| Cloudflare MCP Portals | all tools exposed | **open** |
| Claude Code, `.mcp.json` from a clone | `⏸ Pending approval` | **closed**, on provenance |
| AgentCall today | `secret` | closed |

### FIDES / Microsoft Agent Framework

The shipping implementation is `python/packages/core/agent_framework/security.py`
(`@experimental(feature_id=ExperimentalFeature.FIDES)`, read at `5f9ac6b394`,
2026-07-09). Its constructor:

```python
default_integrity: IntegrityLabel = IntegrityLabel.UNTRUSTED,
default_confidentiality: ConfidentialityLabel = ConfidentialityLabel.PUBLIC,
```

> `default_integrity`: Default integrity label for tools without source_integrity.
> **Defaults to UNTRUSTED for safety** (tools must opt-in to TRUSTED).
> `default_confidentiality`: Default confidentiality label. **Defaults to PUBLIC.**
> — `security.py:758-760`

The asymmetry is deliberate and stated at the MCP auto-labelling seam, where an
MCP tool with no annotations at all is handled:

> No annotations at all - treat as both UNTRUSTED-by-default and a potential
> sink (max_conf=PUBLIC). **We have no signal that the tool is safe to receive
> PRIVATE data, so we err on the side of blocking exfiltration.**
> — `security.py:3057-3062`

Read that carefully: the "err on the side of caution" move is entirely about
*what the tool may be given*. What the tool *returns* is labelled `PUBLIC`,
which in FIDES's lattice is the least restrictive value. FIDES fails closed
against exfiltration and fails open against disclosure, because in its threat
model the reader is the user who owns the agent.

### `github/github-mcp-server`

`pkg/ifc/ifc.go` (read at `667bd3e803`, 2026-06-17) defines a two-axis label and
one `Label*` function per tool family. There is no default: labels are attached
only behind an opt-in feature flag.

```go
const FeatureFlagIFCLabels = "ifc_labels"   // pkg/github/feature_flags.go:16
```

`ifc_labels` is in `AllowedFeatureFlags` but **not** in `InsidersFeatureFlags`
(`feature_flags.go:34-54`), so even insiders do not get it without asking. And
when the server cannot determine the answer it emits nothing rather than
guessing:

> Consistent with the other IFC-labeled tools, **if the visibility lookup fails
> the label is omitted rather than risking a misclassification.**
> — `pkg/github/ifc_labels.go:44-47` (read at `778f5bb6a3`, 2026-07-08)

So the emitter's posture is: label when certain, stay silent otherwise, and let
the consumer decide what silence means. That is a coherent position for a
server and it hands the entire question back to us.

The per-item reasoning quoted in #394 is verbatim in the source
(`ifc.go:128-134`):

> Why a single joined label rather than one label per item: a tool result is
> delivered as one opaque payload (a single content block) and the IFC engine
> makes one allow/deny decision per flow at egress. Once the items share a
> buffer in the agent's context they can be copied anywhere together, so the
> only sound bound for the whole result is the meet of every item's label.
> Per-item labels would only become load-bearing if the enforcement engine could
> partition a result and route individual items to different sinks; until then
> they would invite unsafe declassification of a "public" item that actually
> arrived alongside private data.

### The MCP spec and its Extensions Track

Confirmed against the schema, not a write-up. `schema/2026-07-28/schema.ts`
defines `ToolAnnotations` with exactly five fields — `title`, `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint` (`:1912-1954`) — and
`Annotations` with `audience`, `priority`, `lastModified` (`:2270-2300`).
`schema/draft/schema.ts` differs from it elsewhere but is byte-identical over
that region. Grepping both for `sensitiv|confidential|classif|ifc` returns hits
only in `ElicitRequest` prose. **There is no data-classification field in the
current spec or the draft.**

SEP-1913 "Trust and Sensitivity Annotations" is open, `draft`, sponsored by
`@localden`, last touched 2026-08-03 — by the activity bot, for the fifth time
since 2026-05-11. On 2026-06-10 the author announced the split to the Extensions
Track and incubation moved to
[`modelcontextprotocol/experimental-ext-tool-annotations`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations).

That repo's `specification/draft/trust-annotations.mdx` (read at `d0733ef8e6`,
2026-06-16) narrows the taxonomy to two booleans and states the default rule
plainly:

> Both booleans are optional and default to `false`/absent. **Absence MUST be
> treated as "no claim made," never as "asserted false."**

and, on backward compatibility, SEP-1913 itself:

> Missing annotations treated as unknown (not as "safe"). **Clients should apply
> appropriate defaults for unlabeled data.**

The spec track has looked directly at this question and deliberately declined to
answer it. There is no standard default to adopt.

Two secondary confirmations of #394's claims, since it flagged its own batch as
needing re-checking:

- The set-theoretic critique is real and is [@JustinCappos's
  comment](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/711#issuecomment-2967516811):
  *"I want an email with medical test results to be able to be read by my mail
  MCP and my credit card number to be sent to a payment MCP, but I may not want
  either bit of detail shared with the other."* It is recorded in
  `docs/open-questions.md` as "sensitivity is set-theoretic not linear".
  #394's paraphrase is accurate; the wording it quotes is a paraphrase, not a
  quotation from the SEP.
- `sensitiveHint: low|medium|high` no longer appears anywhere in the SEP or the
  extension. What was actually demoted was a four-level
  `public/personal/confidential/highly_confidential` class plus regulatory
  scope, moved behind an `evidenceRef` profile (`docs/decisions.md`,
  2026-06-10). Same conclusion, different artefact.

### Azure AI Search + Microsoft Purview

The one system in this survey with a shipping, documented, end-to-end
sensitivity-label enforcement path — and the closest analogue to what AgentCall
is trying to build.

Unlabelled documents are not filtered. The enforcement rule is stated as an
exclusion of *labelled* documents the user lacks rights for:

> If the user isn't authorized for a document's sensitivity label with `EXTRACT`
> permissions, that document is excluded from the query results.
> — [Query-time sensitivity label enforcement](https://learn.microsoft.com/en-us/azure/search/search-query-sensitivity-labels), `ms.date` 2026-07-07

The degraded path makes it explicit that unlabelled means unrestricted:

> **Calls without `x-ms-query-source-authorization`** issued by an application
> with at least the **Search Index Data Reader** role: The request succeeds and
> **returns only documents that don't have a sensitivity label.** Labeled
> documents are omitted from the response.

And Purview, upstream, does not leave content unlabelled at all. Its default
label policy:

> **Default label of General \ All Employees (unrestricted) for unlabeled
> documents, email, and meetings**
> — [Default sensitivity labels and policies](https://learn.microsoft.com/en-us/purview/default-sensitivity-labels-policies), `ms.date` 2026-05-01

In AgentCall's lattice that is `internal`, not `secret`. The vendor that owns
this vocabulary defaults unlabelled content to *org-internal-unrestricted*.

The response-level aggregation #394 cites is also real, and it applies to an MCP
endpoint:

> `metadata.responseSensitivityLabelInfo` — An aggregate label that represents
> the highest-priority sensitivity label across all referenced documents in the
> response. … **Typically, the most restrictive label wins.**
> — [Query a knowledge base via API or MCP](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-retrieve), `ms.date` 2026-07-21

So Azure ships per-reference labels *and* a response-level join, over MCP. It is
the counter-example to "nobody labels sub-parts". Section 3 covers why it does
not generalise.

### Cloudflare MCP Portals

> When you add an MCP server to a portal, **all of its tools and prompts are
> available to portal users by default.**

The inversion exists but is opt-in — the API field is `default_disabled`, and
setting it to `true` exposes only tools explicitly enabled
([MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)).
Note the framing: the *fail-open* is the default and the *fail-closed* is the
flag, in a Zero Trust product.

Cloudflare's WriteGuard ([blog post, 2026-08-05](https://blog.cloudflare.com/mcp-portal-writeguard-private-beta/),
private beta) is the closest thing to per-tool labelling in a gateway: "Every
tool gets a risk tier, an enabled or disabled state, and a labeling
configuration", across four tiers (Read Only, Minimal Impact, Contained Write,
Critical). It is entirely **manual** — configuration is written in TypeScript in
Cloudflare's internal monorepo — and the post does not state a default for an
unclassified tool. It is also an *action*-risk taxonomy, not a data-sensitivity
one.

### Claude Code — the one fail-closed default, and it is provenance-based

Claude Code connects servers from the user's own configuration without asking.
Servers arriving from a repository do not connect:

> Project-scoped servers from `.mcp.json` that are awaiting your approval appear
> in `claude mcp list` … as `⏸ Pending approval`.

> A cloned repository can't approve its own servers: `enableAllProjectMcpServers`
> or `enabledMcpjsonServers` committed to the project's `.claude/settings.json`
> is ignored in an untrusted folder, and the server stays at `⏸ Pending
> approval`.
> — [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)

This is a genuine capability-scoped-by-provenance default, and it is the answer
to "does anyone fail closed": yes, on the axis of *who wrote the config*, not
*what the server holds*. It gives AgentCall nothing, because every MCP server an
answering agent could reach is in the owner's own configuration by construction.

---

## 2. Is there a middle posture?

Four candidates were tested against the sources. Three fail for this model.

**Capability-scoped / read-only defaults — fails, and the reason is clean.**
FIDES's rule is the best-argued version of this:

> Conservative rule: only tools that *explicitly* declare `readOnlyHint=True`
> are treated as pure data sources. Everything else — including tools whose
> server omits the hint entirely — is treated as a potential write / sink and
> capped at PUBLIC confidentiality. This matters because many real servers
> (notably GitHub's MCP) declare `readOnlyHint=True` on read tools but leave
> *all* hints as `None` on their write tools …
> — `security.py:3078-3086`

and

> Read-only tools are pure data sources; **they cannot exfiltrate data**, so
> they are safe to call even when the agent context is tainted.
> — `security.py:3091-3094`

Both statements are about *sinks*. `readOnlyHint` bounds what a tool can do with
data it is given; it says nothing about the sensitivity of data it returns. In a
model whose only sink is the reply, every MCP tool is a source and none of them
is a sink, so this axis is degenerate. The MCP spec independently caps what the
hint could ever be worth: *"clients **MUST** consider tool annotations to be
untrusted unless they come from trusted servers"*
([Tools, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

**Per-tool-within-a-server labelling — fails, on the confidentiality axis
specifically.** `agent-framework` implements it: per-item embedded labels are
tier 1, above the tool's declaration and above the input join
(`security.py:1180-1192`), and it *does* partition — untrusted items are hidden
behind variable references while trusted items pass through unchanged
(`security.py:1426-1441`). This is exactly the enforcement-engine partitioning
`ifc.go` said would be required to make per-item labels load-bearing.

And it still refuses to partition confidentiality:

> **Only visible content can taint integrity; hidden content still contributes
> confidentiality to later policy decisions.**
> — `security.py:1350-1357`

The context label's confidentiality is updated from `result_label` — the join
over *all* items — while integrity is updated from `visible_result_label`. Even
when a system can route items to different sinks, confidentiality is joined over
everything that entered the buffer. AgentCall's model is confidentiality-only.
Per-tool labels therefore give it nothing but more knobs.

**Provenance-based defaults — real, shipping, and inapplicable.** Covered above:
Claude Code's `.mcp.json` trust gate keys on config provenance, which does not
discriminate among an owner's own servers. Nothing in an MCP server declaration
distinguishes "work tool" from "personal data store": not transport (local
`stdio` covers both `openmemory` and a repo indexer), not name, not annotations.
Inferring it is auto-classification, which #394 already ruled out on the
structural argument — a classifier under a fail-closed default can only ever
*downgrade*, and every downgrade is an unproven declassification.

**Allow-with-mandatory-audit — the one that survives.** Azure's elevated read is
the only shipping mechanism found where the reader is not the credential holder:

> Azure AI Search **skips the per-document label-based access check** and returns
> matching documents, regardless of the requesting user's `EXTRACT` permissions
> on each label. For each document in the response, Azure AI Search **emits one
> entry to the Microsoft Purview audit log**. A single search request that
> returns *N* documents produces *N* audit entries.

It costs a higher role (`Search Index Data Contributor`, not Reader), it is
per-document rather than per-request, and when the audit path is unavailable the
whole request fails `5xx` — *"Azure AI Search doesn't return labeled documents
without first being able to emit audit logs."* Audit is a precondition of
access, not a consolation for it.

That is the same shape as #394's first build-instead item (push denials
out-of-band as information, no approve button), pointed at accesses rather than
denials.

---

## 3. Is "opaque container" the right framing for MCP?

Partly wrong about the protocol, right about our enforcement point.

**The protocol does carry hierarchy.** Every Resource is identified by a URI
(`resources/list`), and `resources/templates/list` returns RFC 6570 URI
templates — `file:///{path}` is the spec's own example. The spec defines
`https://`, `file://`, `git://` and permits custom schemes. Longest-prefix-wins
over `file://`, `git://`, or a custom `jira://PROJ/` would be a sound
transplant of `classifyPath`.

**But tool results are not URI-addressed.** A `CallToolResult` carries
`content` blocks (`text`, `image`, `audio`, `resource_link`, `resource`) plus
optional `structuredContent`. Only `resource_link` and embedded `resource`
blocks carry a `uri`; a plain `TextContent` — what almost every server returns —
carries none. There is nothing to prefix-match on.

**And AgentCall's enforcement point never sees the Resources surface.** The
guard is a `PreToolUse` hook keyed on tool name and arguments (`guard.ts:8-12`,
`EXACT_TARGET`/`SCANNING_ROOT` at `:69-79`). An answering agent reaches an MCP
server through `mcp__<server>__<tool>`. Claude Code surfaces Resources to the
*user* via `@server:protocol://resource/path` mentions, not as agent-callable
tools. So the one place URIs exist is a surface the answering agent does not
drive and the guard would never intercept.

Azure is the demonstration that per-sub-part labelling *can* work over MCP — but
look at what it costs: the labels are minted by Purview, carried through
indexing, projected onto every chunk, and enforced against the end user's own
Entra token before the result is built. The label is produced by the system that
owns the data. AgentCall would be inferring labels about someone else's server
from outside it. Those are not the same problem.

Two smaller notes, both from the `ifc.fides.v1` scheme
(`schemes/ifc-fides.md`, 2026-06-16), which is the closest thing to a
peer-reviewed statement of our exact difficulty:

> Repository visibility is only a *default* hint, not the whole story: a public
> repository can serve sub-resources that are **not** world-readable (draft
> security advisories, draft releases, the collaborator roster itself,
> authenticated-user fields), so a correct emitter MUST classify **per resource
> returned**, not per repository.

and, on why a single opaque marker cannot compose:

> Two distinct `"private"` markers … are **not equal**, and their
> confidentiality join is **not** the same `"private"` token: data derived from
> both may flow only to principals who can read *both* sources — the
> intersection of their reader sets.

The second is the sharpest available statement of #394's point 2. AgentCall's
`internal` is exactly such an opaque marker, and `combine()`
(`sensitivity.ts:65-70`) takes the max of a total order rather than an
intersection. That is not wrong today — one `internal` level means one audience
by definition — but it is the assumption that breaks first if compartments are
ever added.

---

## 4. What the ecosystem assumes

**Registry size — counted, not estimated.** `GET
https://registry.modelcontextprotocol.io/v0/servers?limit=100&version=latest`,
paginated to exhaustion on 2026-08-06, returns **20,373 entries** (204 pages).
Without `version=latest` the same walk passes 40,000 entries at a 400-page cap.
This counts published registry entries, including inactive ones; it is not a
count of servers anyone runs.

**How many a developer configures — no primary source found.** The number in
circulation is "70% of MCP consumers have between 2 and 7 servers configured",
attributed to Zuplo's *State of MCP* survey (fielded mid-November to
mid-December 2025). Zuplo's [blog post](https://zuplo.com/blog/mcp-survey)
describes the population only as *"technical professionals from our network and
the broader MCP community"*; the report itself is gated and I could not read the
figure, the sample size, or the recruitment method at the primary source. It is
a self-selected vendor survey with no published `n`. **Do not cite the number as
fact.**

**No first-party telemetry writeup found** from Anthropic, Cursor, or any other
host on MCP server counts per user.

So the honest position on the "one-time or recurring cost" question is: I could
not establish the size of N. What can be said without data is that the cost is
recurring in kind — servers are added over time, `notifications/tools/list_changed`
exists precisely because a server's tool set changes at runtime, and a label
attached to a server does not track what the owner later puts inside it.

---

## What I could not verify

- **The size of N** — how many MCP servers a typical developer configures. The
  only figure available is behind a vendor gate with no published sample size.
- **What share of MCP servers implement Resources** (as opposed to Tools only).
  The registry does not record declared capabilities, and probing 20k servers
  was out of scope.
- **WriteGuard's default for an unclassified tool.** The blog post defines four
  risk tiers but does not say what happens to a tool with no configuration, and
  the product is in private beta with no public docs.
- **Whether any host consumes `_meta.ifc` other than `agent-framework`.** I found
  one consumer (`security.py:3224 _label_from_mcp_meta`) and one emitter
  (`github-mcp-server`, flag-gated). The scheme doc's "a host-side IFC engine …
  already exists in practice. (Linked once a public reference is available.)"
  suggests a second one exists and is not public. Could not verify.
- **Docker MCP Gateway has no data-classification or labelling layer** that I
  could find — its security story is container isolation, a curated catalog, and
  Docker Desktop secrets management. I did not find a policy engine, so it is
  absent from the table rather than scored. Absence of evidence here; the repo
  is large and I read the README, catalog docs, and SECURITY.md only.
- The `2026-05-28` Tool Annotations IG meeting is cited by several primary
  documents as the decision point for the extension-first strategy. I did not
  read [discussion 2820](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2820)
  itself; the decisions attributed to it are quoted from the repo's own decision
  log, which is a first-party record of that meeting but not the minutes.

---

## What this means for AgentCall

### The default should stay `secret`, and the reason should be written down

Not because fail-closed is a virtue, and not because nobody else fails open.
Because **AgentCall is the only system in this survey where the reader is not
the credential holder**, and every fail-open default found is safe precisely
because that identity holds:

| System | Who receives the data | Whose credentials fetched it |
|---|---|---|
| FIDES / agent-framework | the agent's own user | the same user |
| Azure AI Search (standard) | the `x-ms-query-source-authorization` user | that user's Entra token |
| Cloudflare MCP Portals | the Access-authenticated portal user | that user's OAuth grant |
| Purview default label | an employee of the tenant | tenant membership |
| github-mcp-server | the PAT holder | the same PAT |
| **AgentCall** | **the caller** | **the owner** |

Copying FIDES's `PUBLIC` default into a confidentiality-only model whose sink is
a reply to a third party would mean: every MCP server the owner has configured
is readable by every `public`-cleared caller, by default, on a fresh install.
That is not "the emerging convention" — it is a category error about what the
convention is for. The design spec already lists "the emerging MCP `_meta.ifc`
convention" as a mitigation for labelling burden (Risks §2); this note is the
evidence that it is not one, and that
[`trust-annotations`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations)
explicitly hands the default back to us.

The one genuinely uncomfortable finding is the inconsistency with our own path
default: `defaultSensitivityMap` labels the git repository `internal` without
asking (`sensitivity.ts:256-267`), while `mcp: {}` asks for everything. Purview
does the former for all unlabelled content. The difference that justifies it is
that `setup` runs *inside* the repository it labels — the owner's cwd is
evidence of intent — whereas an MCP config entry is evidence of nothing but
installation. That distinction is worth writing into the spec, because without
it the two defaults look arbitrary next to each other.

### The convergent move is not a default; it is when the label is asked for

#394 correctly killed "enumerate the servers at setup and ask once" — that is
per-tool allowlisting with a wizard, and it does not converge because the list
is bounded by the config file's length rather than by anything the owner cares
about.

But "ask at setup" and "never ask" are not the only options, and the evidence
points at the third. Two things from this survey:

1. **Azure's elevated read**: when the reader is not the credential holder, the
   shipping answer is neither deny nor trust — it is *allow with a mandatory,
   per-item, out-of-band record*, with the record as a precondition of access.
2. **`github-mcp-server`'s posture**: label when you have evidence, stay silent
   otherwise. Silence is not a failure state; it is the normal state.

Applied here, that says the labelling worklist should be **demand-driven**:
today a denial is logged locally and never surfaces, so an owner has no signal
that a real question hit `mcp__openmemory__search` and was refused. Surface it
out of band — #394's build-instead item 1 — and the set of servers the owner
ever labels is bounded by the questions people actually ask, not by
`~/.claude.json`. Each label is then prompted by evidence rather than by a
wizard, which is the difference between a security review and a bug report.

This converges where the setup wizard does not, and its failure mode is a
refused answer rather than a leak. It is also the cheapest thing on #394's list
and needs no protocol dependency.

### What I would not do

- **Do not build on `_meta.ifc`.** One flag-gated emitter, one experimental
  consumer, three incompatible wire keys, a sponsor unresponsive since May, and
  a spec that says absence means "no claim made". Parse it opportunistically if
  it is free; do not let the guarantee depend on it.
- **Do not label per tool within a server.** The one system that can partition
  a result declines to partition confidentiality, in a comment
  (`security.py:1350-1357`) that reads like it was written after finding out why.
- **Do not use `readOnlyHint` as a confidentiality signal.** It is a sink
  annotation, the spec says clients must treat it as untrusted, and this model
  has one sink that is not a tool.
- **Do not extend capacity-based declassification to `secret` to route around
  this.** It is tempting — a constrained-output task could reach an unlabelled
  server because an `enum` cannot carry a payload — but `permits`'s own comment
  is right that making `secret` grantable "would turn the top of the lattice
  into a bypass that any policy edit could hand out" (`sensitivity.ts:72-74`).
  If that is ever wanted it is a deliberate change to what `secret` means, not
  a workaround for a default.

## Sources

Primary, in the order they carry weight:

- `microsoft/agent-framework` — `python/packages/core/agent_framework/security.py`
  @ `5f9ac6b394` (2026-07-09); `python/samples/02-agents/security/github_mcp_example.py`,
  `FIDES_DEVELOPER_GUIDE.md`
- `github/github-mcp-server` — `pkg/ifc/ifc.go` @ `667bd3e803` (2026-06-17),
  `pkg/github/ifc_labels.go` @ `778f5bb6a3` (2026-07-08),
  `pkg/github/feature_flags.go`
- `modelcontextprotocol/modelcontextprotocol` — `schema/2026-07-28/schema.ts`,
  `schema/draft/schema.ts`; [spec 2026-07-28 server/tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [server/resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources);
  [SEP-1913 (PR #1913)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1913)
  and its comment thread
- `modelcontextprotocol/experimental-ext-tool-annotations` —
  `specification/draft/trust-annotations.mdx` @ `d0733ef8e6` (2026-06-16),
  `schemes/ifc-fides.md`, `docs/decisions.md`, `docs/open-questions.md`
- Microsoft Learn — [query-time sensitivity label enforcement](https://learn.microsoft.com/en-us/azure/search/search-query-sensitivity-labels)
  (2026-07-07), [indexer label ingestion](https://learn.microsoft.com/en-us/azure/search/search-indexer-sensitivity-labels)
  (2026-07-07), [agentic retrieval / MCP endpoint](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-retrieve)
  (2026-07-21), [Purview default labels and policies](https://learn.microsoft.com/en-us/purview/default-sensitivity-labels-policies)
  (2026-05-01)
- Cloudflare — [MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/),
  [WriteGuard](https://blog.cloudflare.com/mcp-portal-writeguard-private-beta/) (2026-08-05)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- MCP official registry API, `registry.modelcontextprotocol.io/v0/servers`,
  walked 2026-08-06

Secondary, flagged as such:

- [Zuplo, *The State of MCP*](https://zuplo.com/blog/mcp-survey) — the "2–7
  servers" figure could not be verified at the primary source. See
  [What I could not verify](#what-i-could-not-verify).
</content>
