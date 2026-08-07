# Derived access inheritance: does "could the caller already read it" survive?

**Date:** 2026-08-06
**Issues:** [#393](https://github.com/KenTaniguchi-R/agentcall/issues/393) (the repo seed),
[#394](https://github.com/KenTaniguchi-R/agentcall/issues/394) (the labelling-model amendment)
**Tests:** the proposal that source sensitivity can be *derived* from provenance —
"could the caller already have read it through some other system?" — with zero
typed configuration by owner or admin.

Every quotation below was read at the cited source. Where a claim rests on a
vendor's marketing rather than measurement, it says so in place. See
[What I could not verify](#what-i-could-not-verify).

## Findings first

1. **The proposal's headline signal is factually wrong in the common case, and
   wrong in the dangerous direction.** GitHub's documented default is that org
   members get read on the org's **public** repositories only — a private org
   repo grants a colleague nothing by default. "`origin` points at the org"
   therefore does not imply "a colleague could already read this," and the error
   is a false *positive*: AgentCall would answer from content GitHub's ACL exists
   to withhold. This is not a tuning problem; it is the premise. See §3.

2. **The M365 evidence is worse than "derivation is inaccurate." It shows that a
   *perfectly accurate* latent-access oracle still does not license disclosure.**
   M365 Copilot does not approximate the caller's entitlement — it enforces the
   live ACL, the ground truth. Oversharing happened anyway, and Microsoft's own
   framing is unambiguous: Copilot "does not create new permissions or expose
   data users cannot already access. What it does do is make existing access more
   discoverable." AgentCall would be *estimating* the same oracle, so it inherits
   this failure plus approximation error. See §2.

3. **But every shipped mitigation runs in one direction only, and that is what
   saves the principle.** Restricted Content Discovery, Restricted SharePoint
   Search, and Slack's "Restrict AI access" all reduce *discoverability below*
   existing access; none expands beyond it. Read together with AWS's session-policy
   rule — *"Session policies limit permissions for a created session, but do not
   grant permissions"* — the evidence supports latent access as a **ceiling** and
   rejects it as a **licence**. The proposal as written ("if yes, answering from it
   is a convenience") uses it as a licence. Inverting that one clause is the
   amendment that lets the idea survive. See [Verdict](#verdict).

4. **No shipping product derives *authorization* from provenance.** Two derive
   *discoverability* among content the asker is already authorized on — Atlassian
   Rovo's Smart Links and Glean's Google Drive connector — and both are hedged,
   disableable, and confined to link-shared or domain-shared material. Everything
   else inherits an authenticated per-item ACL or is admin-configured. See §1.

5. **The closest structural analogue to AgentCall ships with exactly this warning
   attached.** Notion Custom Agents answer with the agent's own access rather than
   the caller's, and Notion documents the consequence in one sentence: *"So if the
   agent can see more rows than the end user, the agent may expose information the
   end user can't access directly."* That is AgentCall's architecture and
   AgentCall's risk, stated by a vendor that shipped it. See §1.6.

6. **"Pushed to a shared remote" is used by nobody as an access boundary, and
   `.gitignore` is honoured by everybody for relevance, not access.** The best
   single proof is VS Code's rule that `.gitignore` exclusion is bypassed when you
   have the file open — an exclusion you defeat by opening a file is not an access
   control. See §3.

7. **The prior art is real, is named, and is AWS session policies — not RFC 8693.**
   RFC 8693 supplies delegation *vocabulary* and explicitly defers the authority
   calculus to server policy; it states no intersection rule. Noninterference's
   founding paper puts inference and aggregation **out of scope** in its own words.
   See §4.

---

## 1. Does anyone derive access scope from provenance?

Classification used throughout: **(a) inherited** — handed a per-item ACL by an
authenticated connector, or re-checked against the source with the asker's own
credential; **(b) derived** — inferred from metadata or provenance with no
authenticated per-item check; **(c) admin-configured**.

| Product | Class | Granularity | Tier |
|---|---|---|---|
| Gemini for Google Workspace | (a), strongest form | per-file, live, same-tenant | admin controls edition-scoped |
| Notion AI | (a) | per-page / per-item, ≤1h sync staleness | Business/Enterprise connectors |
| Slack AI | (a) under (c) | per-channel/DM membership, "at the time of request" | native untiered; enterprise search Enterprise+ |
| GitHub Copilot Enterprise | (a) under (c) | per-repository read of the asker | KBs Enterprise; Spaces all tiers incl. Free |
| Dropbox Dash | (a), degrading to team-wide | per-item where the app supports it | Dash for teams |
| Glean | (a) **+ a real (b) carve-out** | per-document ACL; derived for link/domain-shared Drive files | Enterprise only |
| Sourcegraph | (a), **container-level** | per-repository (per-file only for Perforce) | Enterprise + `acls` license |
| Atlassian Rovo | (a) connectors / **(b) Smart Links** | per-item / provenance | Smart Links need no admin setup |

### 1.1 The two genuine derivations

**Atlassian Rovo, Smart Link connectors** is the purest case found. The
item-level surfacing rule is viewing history, not an ACL:

> For a result to show in search, it must be:
> a Smart Link from an app in the table above
> on a page you have viewed within an Atlassian app
> on a site with Rovo

> This means that you may see different results from your teammate, even though
> you may have access to the same Smart Links.
> — [Search with Smart Links](https://support.atlassian.com/rovo/docs/search-with-smart-links/), retrieved 2026-08-06

Atlassian then concedes the per-item check is not live:

> For Smart Link connectors, deleted Smart Links may still show up in Search
> Results. However, if a user clicks on a link to deleted content or clicks on a
> link they no longer have access to, the link will appear broken.
> — [Rovo data privacy and usage guidelines](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), retrieved 2026-08-06

There is an OAuth handshake at the *app* level, so it is not credential-free —
but nothing authenticates *this item* for *this asker* at query time, and results
can outlive the asker's access.

**Glean's Google Drive connector** derives discoverability from cross-system
signals, on by default. For files set to `Anyone with the link` or shared to the
company domain:

> Simply stated: Glean provides the same search permissions enforcement as Google
> Drive with a small, notable exception for documents with public or domain access
> which are shared in a public collaboration channel.

and the enumerated exceptions include:

> The user has already accessed the document

> The user is a member of a Slack channel where a link to the file was shared.
> This is optional and can be disabled.

> A link to the file has been pinned, and the user is part of the pin audience
> — [Google Drive connector permissions](https://docs.glean.com/connectors/native/gdrive/security/permissions), "Last updated on Aug 4, 2026"

Slack channel membership standing in for Drive visibility is real derivation. The
honest qualifier: these files are *already* link- or domain-shared, so the asker
is authorized in Drive. What Glean derives is whether it **surfaces**, not whether
they **may read** it.

**That distinction holds across both cases and is the finding.** Nobody derives
authorization. Two vendors derive discoverability *within* an already-authorized
set, and both hedge it — Glean calls it "a small, notable exception" and makes it
disableable; Atlassian warns your results differ from your teammate's.

### 1.2 The in-between cases worth flagging

- **Sourcegraph is container-level, not per-item.** Every code host except
  Perforce syncs *repository-level* permissions only. And it fails open without a
  license feature: *"If it is not present, Sourcegraph will not enforce repository
  permissions and each repository will be treated as public - any user that has
  access to Sourcegraph will be able to access it."*
  ([Permissions](https://sourcegraph.com/docs/admin/permissions), retrieved 2026-08-06)
- **Dropbox Dash ships an explicit org-wide shortcut**: *"In some cases, apps use
  team-wide rather than content-level permissions, which means all members on the
  Dash team will be able to see connected content. If this is the case, the admin
  will be notified when they connect the app."*
  ([Connect apps to Dash](https://help.dropbox.com/integrations/connect-apps-to-dash), retrieved 2026-08-06)
  Dash indexes anyway and notifies rather than refusing.
- **Notion joins identities by inference**: *"Our connectors automatically link
  users who have the same primary email in Notion and in the connected app."*
  ([Enterprise Search security and privacy practices](https://www.notion.com/help/enterprise-search-security-and-privacy-practices), retrieved 2026-08-06)
- **Glean's indexing API ships an org-wide bypass by design** — setting
  `allowAnonymousAccess` true makes a document searchable by any Glean user
  ([indexing permissions](https://developers.glean.com/api-info/indexing/documents/permissions)).

### 1.3 Nobody derives from a repository remote

Checked directly. Copilot's remote index requires the asker's own GitHub sign-in
(*"GitHub indexes the GitHub repositories in your workspace. Sign in with your
GitHub account to use them."* —
[workspace context](https://code.visualstudio.com/docs/copilot/reference/workspace-context),
page dated 8/5/2026). Amp's Librarian requires *"a GitHub connection in your Amp
settings"* ([Amp news, 2025-10-20](https://ampcode.com/news/librarian)). Neither
treats "your git remote points at org X" as evidence of entitlement to org X's
content.

### 1.4 The cleanest counter-example

Gemini for Workspace holds no ACL copy at all:

> Gemini has the same access to Workspace data as you do. For example, it can only
> access files in Drive that have been shared with you and Calendar events that you
> can view.

and is in one respect *narrower* than the user:

> Delegated Gmail: If someone has given you delegated access to their inbox, Gemini
> doesn't have access to those messages, only the messages in your own inbox.
> — [Google Workspace Learning Center](https://support.google.com/a/users/answer/17010577), retrieved 2026-08-06

### 1.5 GitHub is explicit that org membership is not entitlement

> Viewers can only see sources that they have access to.
> — [Copilot Spaces](https://docs.github.com/en/copilot/concepts/context/spaces), retrieved 2026-08-06

Sharing a Space inside an org does not make its repo sources readable. GitHub
declines to make exactly the inference the proposal makes.

### 1.6 Notion Custom Agents: AgentCall's architecture, with the warning attached

This is the single most relevant paragraph found anywhere in the survey, because
it describes AgentCall's shape rather than an analogue of it:

> There are no inherited permissions from anyone (whether the creator or the user
> of the agent). This also includes database row permissions. A Custom Agent
> responds using *the agent's own access*, not the permissions of the person who
> triggered it. So if the agent can see more rows than the end user, the agent may
> expose information the end user can't access directly.
> — [Custom Agents sharing & permissions](https://www.notion.com/help/custom-agents-sharing-and-permissions), retrieved 2026-08-06

Notion's recommended mitigation is not derivation. It is scope reduction:

> Give agents access to only the specific resources they need for their job. Avoid
> granting workspace-wide access.

That is our `sensitivity.json`, arrived at independently by a vendor with the same
architecture.

---

## 2. The Microsoft 365 Copilot oversharing problem

### 2.1 What the failure mode is, in Microsoft's own words

M365 Copilot enforces the caller's real permissions. Microsoft states this without
hedging, and states the failure in the same breath:

> Copilot follows each user's existing Microsoft Graph permissions and does not
> surface content the user cannot access. However, in many enterprise environments,
> users accumulate access far beyond their current role through leftover project
> permissions, broad temporary group memberships, and inherited rights from outdated
> organizational structures. Copilot does not create this overprovisioning, but it
> makes the full scope of that access immediately visible and usable. What previously
> required sustained effort to locate and correlate can now be surfaced in a single
> prompt.
> — Auzin Ahmadi and Atil Gurcan, [*Limiting Microsoft 365 Copilot data exposure risk with Zero Trust apps and data controls*](https://techcommunity.microsoft.com/blog/fasttrackblog/limiting-microsoft-365-copilot-data-exposure-risk-with-zero-trust-apps-and-data-/4534642), Microsoft FastTrack Blog, 2026-07-08 (Version 3.0), risk item R7/R9

The same post's conclusion is the cleanest one-sentence statement of the problem:

> Microsoft 365 Copilot does not create new permissions or expose data users cannot
> already access. What it does do is make existing access more discoverable, bringing
> years of accumulated oversharing, excessive permissions, unlabeled content,
> unmanaged connectors, and governance gaps into sharper focus.

and, on R7 specifically:

> Content shared with "Everyone," "Everyone except external users," or broad
> security groups becomes part of Copilot's queryable surface for any licensed
> user—even if that user would never have manually located those files. Years of
> SharePoint oversharing, combined with Copilot's ability to traverse and synthesize
> content in a single prompt, can turn long-standing governance debt into immediate
> exposure. Copilot makes data once hidden by volume discoverable by intent.

**"Discoverable by intent" is the whole finding.** The prior boundary was not the
ACL. It was the cost of search. Permissions were the *nominal* boundary and
obscurity was the *operative* one, and only one of those two survives an agent.

Microsoft's own worked example says the quiet part plainly — note that the user
had permission throughout:

> Imagine typing a query about your org structure into Copilot, only to have
> confidential details about an upcoming reorganization surface in the
> response—details you were never meant to see.
> — Alex Pozin, [*From Oversharing to Optimization: Deploying Microsoft 365 Copilot with Confidence*](https://techcommunity.microsoft.com/blog/microsoft365copilotblog/from-oversharing-to-optimization-deploying-microsoft-365-copilot-with-confidence/4357963), Microsoft 365 Copilot Blog, 2024-12-17

"Never meant to see" versus "had permission to see." That gap is the entire
subject of this note.

Microsoft attributes the gap to configuration, not malice:

> Most internal oversharing stems from configuration issues rather than malicious
> user intent.
> — Dave Minasyan, [*Mitigate Oversharing to Govern Microsoft 365 Copilot and Agents*](https://techcommunity.microsoft.com/blog/microsoft365copilotblog/mitigate-oversharing-to-govern-microsoft-365-copilot-and-agents/4448744), Microsoft 365 Copilot Blog, 2025-09-02

And the underlying defaults are permissive by design. From Microsoft's own
readiness guidance: *"By default, SharePoint sets sharing settings to the most
permissive option."*
([Get ready for Microsoft 365 Copilot with SharePoint Advanced Management](https://learn.microsoft.com/en-us/sharepoint/get-ready-copilot-sharepoint-advanced-management), `ms.date` 2026-07-16)

### 2.2 What Microsoft shipped, and what the shape of it implies

| Control | What it does | Direction |
|---|---|---|
| Restricted SharePoint Search (RSS) | admin allow-list of ≤100 sites that Copilot may ground against | **narrows** below existing access |
| Restricted Content Discovery (RCD) | per-site flag removing content from org-wide search and Copilot | **narrows** below existing access |
| Restricted Access Control | hard allow-list group per site, ignoring existing permissions | **narrows** actual permissions |
| Data access governance / EEEU reports | find sites shared org-wide | measurement |
| Site access reviews, Content Management Assessment | delegate remediation to site owners | remediation |
| Purview DSPM for AI, DLP for Copilot | block labelled content from grounding | **narrows** |

**Every control narrows. None widens.** That is the asymmetry that matters more
than any individual product.

The two most informative are RSS and RCD, because Microsoft describes what they
are *not*:

> However, it's important to note that Restricted SharePoint Search isn't a security
> boundary and doesn't change any permissions on SharePoint sites.

> Restricted SharePoint Search is designed for customers of Microsoft 365 Copilot
> chat and agentic experiences. It's a short-term solution that gives your
> organization's administrators time to review and audit site and file permissions.
> It's not intended or scalable for long-term use.
> — [Restricted SharePoint Search](https://learn.microsoft.com/en-us/sharepoint/restricted-sharepoint-search), `ms.date` 2026-07-06

RSS is now retiring — *"Starting July 31, 2026, new enablement is blocked"* — in
favour of RCD, which states the access/discoverability split as its defining
property:

> Restricted Content Discovery doesn't change existing permissions. Users who
> already have access to content can continue to access that content directly.

> **Does Restricted Content Discovery change user permissions?** No. Restricted
> Content Discovery affects discoverability, not access permissions. Users who
> already have access to content can continue to access it.
> — [Restrict discovery of SharePoint sites and content](https://learn.microsoft.com/en-us/sharepoint/restricted-content-discovery), `ms.date` 2026-07-27

**Microsoft shipped a whole product surface whose sole purpose is to make
discoverability narrower than access.** If latent access were a sufficient
disclosure boundary, RCD would have nothing to do.

RSS's worked example is worth reading as a description of the pre-Copilot state:

> For example, Contoso Electronics has a budgeting site with important business
> information. Most people don't know about this site, so the site owner hasn't set
> up proper permissions and hasn't followed correct data governance process. The
> site might be open to some users who aren't allowed to see it, such as Alex.

"Open to some users who aren't allowed to see it" is a contradiction only if you
believe the ACL encodes intent. Microsoft is describing a world in which it
routinely does not.

Slack shipped the same shape. Its AI features are bounded by channel membership —
*"Slack's AI features only use Slack data that members have access to at the time
of request"*
([Security for AI features in Slack](https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack)) —
and Slack *still* added an AI-specific subtraction on top:

> To provide more control over the information that can be used to generate search
> answers, canvas content, and Slackbot responses, you can restrict AI access to
> channels and content in your Enterprise organization.

> Note: This setting only restricts AI read access to channels and content. Members
> can still use Slackbot to send messages to restricted channels or add content to
> canvases and lists.
> — [Restrict AI access to certain channels, canvases, and lists](https://slack.com/help/articles/47421816860947-Restrict-AI-access-to-certain-channels-canvases-and-lists), Enterprise+ plan, retrieved 2026-08-06

An explicit, shipped control saying *AI read access ⊊ member read access* in a
product whose AI is already membership-bounded.

Glean too. Despite inheriting per-document ACLs, it sells a separate governance
layer:

> Detect and remediate overshared or externally exposed sensitive content before it
> becomes a risk in AI-powered search and agents.
> — [About Glean Protect and Protect+](https://docs.glean.com/administration/protect/overview), "Last updated August 3, 2026"; Protect+ is *"a separately licensed add-on to Protect"*

**Three vendors, three different access models — live-ACL (Microsoft), membership
(Slack), synced per-document ACL (Glean) — and all three concluded that enforcing
the asker's real entitlement was not enough.** That convergence is the strongest
signal in this note.

### 2.3 Measured data — vendor, and self-selected

The only quantification found is from Varonis, **a vendor whose product sells
oversharing remediation**. From the primary report PDF, not a summary:

> **90%** of organizations have sensitive files exposed to all employees via M365
> Copilot

> **25,000+** sensitive folders are exposed to all employees on average

> **6%** of organizations have sensitive files open to the internet

> Copilot can surface all accessible data, potentially exposing critical
> information.
> — [*2025 State of Data Security Report: Quantifying AI's Impact on Data Risk*](https://info.varonis.com/hubfs/Files/reports/2025-varonis-state-of-data-security-report.pdf), Varonis, blog page last updated 2025-06-20

Stated methodology, verbatim: *"1,000 organizations"*, *"Nearly 10 billion cloud
resources (objects, files, reports, attachments, etc.)"*, *"More than 20 petabytes
of data — approximately 20 terabytes per organization"*.

**Read it with three caveats.** The population is organizations that ran a Varonis
data risk assessment — self-selected toward suspecting a problem, and not stated
to be a random sample. "Sensitive" is Varonis's own classifier, unpublished. And
the vendor sells the fix. **Directionally credible, not a measurement of the
population AgentCall would deploy into.** The one number Microsoft itself cites
in this area is a Gartner *prediction* about AI value realization, not a
measurement of over-permissioning.

### 2.4 So does this kill the proposal?

**No — but it kills the version in the brief, and for a reason more damaging than
"the derivation is imprecise."**

The tempting reading is: M365 shows latent access is a bad proxy for intended
access, AgentCall would only *approximate* latent access, therefore AgentCall is
strictly worse. That reading is correct and it is not the important one.

The important one is that M365 **has the oracle**. It does not infer the caller's
entitlement; it evaluates the live ACL. The proposal's zero-config derivation is
an attempt to *reconstruct* what M365 already knows exactly — and M365, knowing it
exactly, still produced a named industry problem, a retired stopgap (RSS), a
replacement control (RCD), a licensed governance suite (SAM), a Purview posture
product, and a published deployment blueprint. **Perfect knowledge of latent access
did not yield safe surfacing.** A derived approximation of it cannot do better.

What survives is the *direction* of every fix. Nobody responded to oversharing by
expanding what the agent may answer from on the grounds that the asker was
entitled. Every response narrowed. That is the evidence-supported form of the
principle, and it is the opposite polarity from the proposal's phrasing.

---

## 3. The "already shared" test for source code

### 3.1 The premise fails at GitHub's documented default

> You can set base permissions that apply to all members of an organization when
> accessing any of the organization's repositories. Base permissions do not apply to
> outside collaborators. **By default, members of an organization will have Read
> permissions to the organization's public repositories.** If someone with admin
> access to an organization's repository grants a member a higher level of access
> for the repository, the higher level of access overrides the base permission.

> Internal repositories have a minimum visibility level of read, even if the base
> permission has been set to none.
> — [Setting base permissions for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/setting-base-permissions-for-an-organization), retrieved 2026-08-06 (emphasis added)

So "on the org remote ⇒ a colleague can read it" holds for **public repos** and
**GHEC internal repos**, and fails for **private org repos** — which is the
overwhelmingly common case for the internal codebase AgentCall is meant to answer
about. Corroborated: *"Private repositories are only accessible to you, people you
explicitly share access with, and, for organization repositories, certain
organization members."*
([About repositories](https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories), retrieved 2026-08-06)

The proxy fails in both directions, and the false positive is the dangerous one:

- **False positive.** A private repo under `github.com/acme/` with a three-person
  collaborator list. `origin` matches, so AgentCall answers; the caller has no read
  on GitHub. AgentCall leaks precisely what the ACL exists to prevent.
- **False negative.** A fork whose `origin` is the developer's personal account
  with `upstream` at the org; a worktree; a clone with the remote renamed or
  removed. All readable by the caller, all refused.

**Sourcegraph is the instructive precedent.** It faced this exact question and did
*not* conclude "on the code host ⇒ visible." It built per-user, per-repo permission
syncing — two polling directions, webhooks, an API, a documented lag — whose entire
existence is the argument that org-remote membership is not a usable access signal.
And it required an identity join to work at all: *"For this process to work
correctly, the user needs to have an external account from code host mapped to the
user account on Sourcegraph, otherwise the code host identifier cannot be matched
and repository permissions cannot be enforced."*
([Permission syncing](https://sourcegraph.com/docs/admin/permissions/syncing), retrieved 2026-08-06)

### 3.2 The signal is about the wrong artefact

Even where the remote *does* imply colleague-readability, it describes refs on a
server. AgentCall's answering agent reads the **local working tree**: unpushed
commits, uncommitted changes, stashes, untracked scratch files, `.gitignore`d
build output and local overrides. `readableSources` feeds directories, not refs.
"The remote is org-readable" and "the bytes on this disk are org-readable" are
different propositions, and the proposal's derivation only addresses the first.

### 3.3 Nobody treats pushed-vs-local as an access boundary

No vendor documentation found uses it. Tools index remote-less content routinely:
VS Code — *"Other workspaces: For any other workspace, including local folders not
backed by a GitHub or Azure DevOps repository, Copilot builds the semantic index
for you"*
([workspace context](https://code.visualstudio.com/docs/copilot/reference/workspace-context),
8/5/2026); Zoekt ships `zoekt-index` for *"Indexing a local directory (not
git-specific)"*; Hound supports `"vcs": "local"`.

The nearest thing to a local/hosted switch is an **egress** control, not an access
one: *"Copilot in Visual Studio Code can use semantic indexing for workspace files
from repositories hosted outside GitHub, such as GitLab and local repositories.
This feature uploads your data to GitHub to make it searchable. … This feature is
controlled by policy and is disabled by default."*
([repository indexing](https://docs.github.com/en/copilot/concepts/context/repository-indexing), retrieved 2026-08-06)

The one org-scoped precedent, JetBrains Context, ships the org boundary while
explicitly rejecting the pushed/local half: *"Both Git repositories and non-Git
folders can be indexed."* / *"Organization members. Indexed repository data is
available only within the same organization."*
([Getting started with JetBrains Context](https://www.jetbrains.com/help/jetbrains-console/getting-started-with-jetbrains-context.html), page dated 03 August 2026)

### 3.4 `.gitignore` is honoured for relevance, not access — universally

| Tool | Honours it | Stated reason | Access or relevance |
|---|---|---|---|
| VS Code / Copilot | yes | *"Generated files, build artifacts, logs, and large datasets can produce many irrelevant matches that fill the context window with noise."* / *"Strict exclusions improve search relevance, speed up searches over large workspaces, and reduce the tokens consumed by search results."* | **relevance** |
| Cursor (`.gitignore`) | yes | no reason stated for the inheritance | unstated |
| Cursor (`.cursorignore`, opt-in, separate) | n/a | *"Security: Restrict access to API keys, credentials, and secrets."* — paired with *"While Cursor blocks ignored files, complete protection isn't guaranteed due to LLM unpredictability."* | access, self-disclaimed |
| Amp | yes, with override | `amp.fuzzy.alwaysIncludePaths` — *"Useful for build output directories or generated files you want to reference with @ mentions."* | **relevance** |
| ripgrep | yes, `-u/-uu/-uuu` disables | *"After recursive search, ripgrep's most important feature is what it doesn't search."* | **relevance** |

Sources: [VS Code workspace context](https://code.visualstudio.com/docs/copilot/reference/workspace-context) (8/5/2026),
[Cursor ignore files](https://cursor.com/docs/reference/ignore-file) (retrieved 2026-08-06),
[Amp manual](https://ampcode.com/manual) (retrieved 2026-08-06),
ripgrep `GUIDE.md`/`FAQ.md` @ `master` (retrieved 2026-08-06).

**The decisive detail** is VS Code's own carve-out: *"`.gitignore` is bypassed if
you have a file open or have text selected within an ignored file."* An exclusion
you defeat by opening a file in your editor is a relevance filter, not an access
control.

**No tool found treats untracked-but-not-ignored files differently from tracked
ones.** The one hard committed/uncommitted line is Zoekt's git indexer reading
`refs/heads/*` and never touching the working tree — an artefact of reading git
objects, with no access rationale stated.

**What this means for the proposal's third clause.** "`.gitignore`d files were
never pushed so nobody else has them" is the one half of the derivation that is
directionally sound: it is a *subtraction*, so its errors shrink the answerable
set. It is worth adopting on those grounds — [#393's recommendation](./2026-08-06-repo-seed-default-evidence.md)
already reaches the same place from the secrets-density evidence. But it should be
adopted as a **safety exclusion we are inventing**, not as an industry convention
we are following, because no vendor honours it for that reason.

---

## 4. Prior art: what the principle is actually called

### 4.1 AWS session policies — intersection, stated normatively, three times

This is the strongest precedent and the semantics are exact.

> Session policies are advanced policies that you pass as a parameter when you
> programmatically create a temporary session for a role or an AWS STS federated
> user principal. **The permissions for a session are the intersection of the
> identity-based policies for the IAM entity (user or role) used to create the
> session and the session policies.** Permissions can also come from a
> resource-based policy. An explicit deny in any of these policies overrides the
> allow.

> **Session policies** – Pass advanced session policies when you use the AWS CLI or
> AWS API to assume a role or a federated user. Session policies limit the
> permissions that the role or user's identity-based policies grant to the session.
> **Session policies limit permissions for a created session, but do not grant
> permissions.**
> — [Policies and permissions in AWS IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html#policies_session), retrieved 2026-08-06 (emphasis added)

And normatively in the API reference:

> The resulting session's permissions are the intersection of the role's
> identity-based policy and the session policies. … **You cannot use session
> policies to grant more permissions than those allowed by the identity-based
> policy of the role that is being assumed.**
> — [`AssumeRole`](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html), `Policy` parameter, retrieved 2026-08-06

With a boundary in play, it is a three-way intersection:

> The entity's identity-based policy permissions are limited by the session policy
> and the permissions boundary. The effective permissions for this set of policy
> types are the intersection of all three policy types. An explicit deny in any of
> these policies overrides the allow.
> — [Evaluating effective permissions with boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html), retrieved 2026-08-06

The mapping to AgentCall is exact:

| AWS | AgentCall |
|---|---|
| role's identity-based policy | what the owner's agent can reach on the owner's machine |
| session policy passed at `AssumeRole` | the bound derived from what the caller could already read |
| "the intersection of the role's identity-based policy and the session policies" | answerable set = owner's labelled sources ∩ caller's entitlement |
| "limit permissions … but do not grant permissions" | the caller's entitlement must never *add* a source |
| "an explicit deny … overrides the allow" | `builtinSecretSources` / `withFloor` stay non-overridable |

**The "limit but do not grant" asymmetry is the load-bearing part and AWS states
it three separate ways.** The proposal's phrasing — *"If yes, answering from it is
a convenience"* — reads the intersection as a grant. If the rule ever means "the
caller is entitled, therefore go fetch it," it has stopped being a session policy.

### 4.2 RFC 8693 does **not** specify intersection — a negative finding

RFC 8693 supplies the vocabulary (`subject_token`/`actor_token`, `act`, `may_act`,
delegation vs impersonation) and an audit trail, and defers the authority calculus:

> When and if a composite token is issued is at the discretion of the authorization
> server and applicable policy and configuration.
> — [RFC 8693 §1.1](https://www.rfc-editor.org/rfc/rfc8693.txt), January 2020

`may_act` is an eligibility predicate — *"makes a statement that one party is
authorized to become the actor and act on behalf of another party"* (§4.4) — not a
bound on the resulting authority. The only authority-limiting text is a suggestion
in Security Considerations: *"The use of the "scope" claim (in addition to other
typical constraints such as a limited token lifetime) is suggested to mitigate
potential for such abuse"* (§5). **Cite AWS for intersection, not RFC 8693.**

### 4.3 Google's domain-wide delegation critique — a failure on *who*, not *what*

Google's own IAM guidance:

> Domain-wide delegation doesn't restrict a service account to impersonate a
> particular user, but allows it to impersonate any user in a Cloud Identity or
> Google Workspace account, including super-admins. Allowing a service account to use
> domain-wide delegation can therefore make the service account an attractive target
> for privilege escalation attacks.
> — [Best practices for using service accounts securely](https://cloud.google.com/iam/docs/best-practices-service-accounts), retrieved 2026-08-06

But Google elsewhere narrows its own framing, and the narrowing is the useful part:

> Permissions are Limited: The service account's access is constrained by two
> factors: the permissions of the impersonated user and the OAuth scopes you
> authorize in the Admin console. It cannot access data that the impersonated user
> themselves cannot access.
> — [Using OAuth 2.0 for Server to Server Applications](https://developers.google.com/identity/protocols/oauth2/service-account), retrieved 2026-08-06

DWD's effective authority already *is* an intersection of scopes and the
impersonated user's permissions. What it lacks is a bound on **which principal**
may be impersonated and **whether they consented**. That is the failure AgentCall
must not reproduce: a rule that reads "the caller is entitled somewhere, so fetch
on their behalf" is DWD, not a session policy.

### 4.4 Non-interference explicitly excludes the case

Goguen & Meseguer, *Security Policies and Security Models*, IEEE S&P 1982
([PDF](https://www.cs.purdue.edu/homes/ninghui/readings/AccessControl/goguen_meseguer_82.pdf)):

> one group of users, using a certain set of commands, is noninterfering with
> another group of users if what the first group does with those commands has no
> effect on what the second group of users can see.

And the paper's own scope disclaimer, on p. 11 — the sentence that matters most
here:

> However, our approach does not address the problems of user authentication, of
> security breaches arising through inference, either logical or statistical, of
> unauthorized information from information which is authorized (the so-called
> aggregation problem), or of fault-tolerant secure computing.

*(The 1982 scan's OCR loses word spacing; this sentence was transcribed from the
rendered page image with spacing normalized.)*

**The canonical noninterference paper puts inference and aggregation out of scope,
and that is exactly the gap the proposal sits in.** Ten documents a caller could
each individually read can yield an answer they could not have produced. An
intersection over read-access does not bound what a synthesized answer discloses.

### 4.5 Robust declassification — closest named concept, wrong baseline

Zdancewic & Myers, *Robust Declassification*, CSFW-14 2001
([PDF](https://www.cs.cornell.edu/andru/papers/csfw01.pdf)):

> Robust systems have the property that an attacker is unable to exploit
> declassification channels to obtain more confidential information than was
> intended to be released.

And the fair-environment side-condition, which is the nearest thing in the
literature to the proposal:

> Note that the requirement that A |= SP(≈A) is essentially the fair environment
> assumption: The attacker must not know the secret already (or be able to learn it
> from means other than the system in question).

Its baseline is the attacker's observations of *the same system*. The proposal's
baseline is *any other system in the organization* — strictly wider, weaker, and
harder to verify, and it moves with the org chart. Sabelfeld & Sands's
*conservativity* principle is a false friend: *"Security for programs with no
declassification is equivalent to noninterference"* — "conservative extension" in
the logical sense, saying nothing about what a recipient already knows
([Dimensions and Principles of Declassification](http://www.cse.chalmers.se/~dave/papers/sabelfeld-sands-jcs07.pdf), CSFW'05 / JCS 2009).

**There is no named concept in this literature for "do not disclose what the
recipient could not otherwise obtain."** Framing it as "robust declassification
with the baseline widened from this system to the recipient's total obtainable
knowledge" would be coining, not citing.

### 4.6 Confused deputy — and Hardy's rejection of the checking fix

Norm Hardy, *The Confused Deputy*, ACM SIGOPS OSR 22(4), 1988
([author's copy](http://cap-lore.com/CapTheory/ConfusedDeputy.html)):

> The fundamental problem is that the compiler runs with authority stemming from two
> sources. (That's why the compiler is a confused deputy.) The invoker yields his
> authority to the compiler when he says "RUN (SYSX) FORT". … The other authority of
> the compiler stems from its home files license. The compiler serves two masters and
> carries some authority from each to perform its respective duties. It has no way to
> keep them apart.

That is AgentCall exactly: the answering agent carries the owner's filesystem
authority and the caller's request, with no intrinsic way to keep them apart.

**Hardy then rejects the shape of fix the proposal adopts.** He walks through
check-at-point-of-use and reports where it led:

> Every time we added a clause enabling the opening of a file in a categorical
> situation we would introduce security problems in programs that had been secure.
> Every time we added restrictions to these categories we broke other legitimate
> programs. The last time that I wrote down the requirements for a program to open a
> file, it required fourteen boolean operators ("and"s & "or"s)!

His prescription is that designation carries authority. The nearest modern form is
MCP's normative no-passthrough rule: *"The MCP server **MUST NOT** pass through the
token it received from the MCP client"*
([MCP 2026-07-28 authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).

Worth reading against §1.6: Notion's mitigation for its Custom Agent problem is not
a smarter check, it is *"Give agents access to only the specific resources they need
for their job."* That is designation.

---

## Verdict

**The principle survives. The derivation does not. And the polarity is backwards.**

Three separable claims were tested, and they come apart:

**(A) "Bound the answer by what the caller could already obtain" — SURVIVES,
with excellent prior art.** AWS session policies are the exact semantics, stated
normatively, shipped at scale. Two constraints from the evidence:

1. **It is a ceiling, never a licence.** AWS says it three ways; every M365,
   Slack, and Glean mitigation runs the same direction. The rule must read *"the
   caller could **not** already read it ⇒ refuse."* The converse — *"they could ⇒
   answer"* — is what M365 shipped and what became a named industry problem, and
   in AgentCall it would be the DWD failure Google's own docs warn about.
2. **It bounds the audience, not the inference.** Goguen & Meseguer excluded
   aggregation in 1982 and nobody has closed it since. This is the same residual
   [#173](https://github.com/KenTaniguchi-R/agentcall/issues/173) already tracks;
   the principle does not shrink it.

**(B) "Derive it from provenance with zero configuration" — DOES NOT SURVIVE, on
three independent grounds.**

1. **The signal is wrong.** GitHub's default gives org members read on public
   repos only. The most common case — a private org repo — produces a false
   positive, in the disclosing direction.
2. **The signal is about the wrong artefact.** The remote describes refs on a
   server; the agent reads a working tree containing unpushed, uncommitted,
   untracked and ignored bytes.
3. **Nobody does it.** Two vendors derive *discoverability* within an
   already-authorized set, both hedged and disableable. Zero derive
   *authorization*. Sourcegraph, which had the strongest incentive to, built a
   permission-syncing subsystem instead.

**(C) "Latent access is a good proxy for intended access" — REFUTED, by the
strongest evidence in this note.** M365 Copilot has the oracle — the live ACL, not
an estimate — and oversharing became a named problem anyway, generating RSS, RCD,
SAM, Purview DSPM for AI, and a published blueprint. Microsoft's own explanation is
that the operative pre-agent boundary was the cost of search, not the ACL: *"Copilot
makes data once hidden by volume discoverable by intent."* Slack and Glean reached
the same conclusion from different access models. **Three vendors, three models, one
answer.**

### The concrete amendment

The proposal was offered as a *replacement* for labelling that requires no
configuration. On the evidence it is not that. But it is a good **floor**, and the
floor is free:

1. **Keep `sensitivity.json` as the grant.** Nothing derived should ever widen it.
   This is Notion's own recommendation for the identical architecture, and it is
   already what ships.
2. **Use derivation only to subtract.** Where a provenance signal says the caller
   *could not* have read something, refuse — even if the source is labelled. Errors
   in a subtraction shrink the answerable set, which is the failure mode this repo
   already prefers (`sensitivity.ts:6-8`).
3. **Adopt `.gitignore` exclusion**, on the secrets-density evidence in
   [#393's note](./2026-08-06-repo-seed-default-evidence.md), and record that it is
   our own safety exclusion rather than an inherited convention — every vendor that
   honours `.gitignore` does so for relevance, and VS Code's open-file bypass proves
   it.
4. **Do not seed from `origin`.** The premise is false at GitHub's documented
   default. If a remote signal is ever used, it must be a *narrowing* one: no
   remote, or a remote outside the org, is evidence to **refuse** — never evidence
   to grant.
5. **Write "discoverability ≠ access" into the spec.** It is the one sentence three
   vendors independently converged on, and the design spec's
   ["What this does not solve"](../superpowers/specs/2026-08-06-sensitivity-clearance-model-design.md)
   currently does not say it.

The zero-configuration goal is not met by this proposal. The convergent path
remains the one [the MCP default note](./2026-08-06-mcp-source-default-trust.md)
identified — demand-driven labelling, where the worklist is bounded by the questions
people actually ask rather than by a wizard.

---

## What I could not verify

1. **Any non-vendor measurement of over-permissioning.** The Varonis figures
   (90% / 25,000+ folders) are from a vendor selling the remediation, over a
   self-selected assessment population, using an unpublished "sensitive" classifier.
   No academic, regulator, or neutral-industry equivalent found.
2. **Microsoft's own numbers.** Microsoft describes oversharing qualitatively
   throughout and quantifies it nowhere I could find. The only figure in its
   oversharing blog is a *Gartner prediction* about AI value realization, not a
   measurement.
3. **Whether the Copilot oversharing problem produced measured incidents**, as
   opposed to measured exposure. Microsoft describes risk and remediation; I found
   no first-party incident data.
4. **Notion's and Slack's tiering for the specific controls cited.** Slack's
   Restrict-AI-access page states Enterprise+ and carries no date. Notion's Custom
   Agents page states no tier.
5. **GitHub Copilot Enterprise knowledge bases.** The dedicated docs page 404s —
   knowledge bases were retired in favour of Spaces. The Spaces page was used
   instead. A claim that the cloud coding agent works only with GitHub-hosted
   repositories surfaced in search but could not be found in the raw page text;
   **it is not cited here**.
6. **Cody Context Filters' behaviour for a repo with no remote** (hence no
   `repoNamePattern` to match). The docs never address the no-remote case.
7. **JetBrains `.aiignore` / Junie's stated reason.** The docs page returned an
   effectively empty body.
8. **Google's response to the DeleFriend DWD disclosure.** Widely quoted in trade
   press; not found on any google.com property. Not cited.
9. **The Goguen & Meseguer scope disclaimer's exact spacing.** The 1982 scan's OCR
   layer is damaged; the sentence was transcribed from the rendered page image.
   Wording is verified, whitespace is normalized.

---

## Sources

Primary, in the order they carry weight:

- Microsoft FastTrack Blog — [Limiting Microsoft 365 Copilot data exposure risk with Zero Trust apps and data controls](https://techcommunity.microsoft.com/blog/fasttrackblog/limiting-microsoft-365-copilot-data-exposure-risk-with-zero-trust-apps-and-data-/4534642), 2026-07-08 (v3.0)
- Microsoft 365 Copilot Blog — [Mitigate Oversharing to Govern Microsoft 365 Copilot and Agents](https://techcommunity.microsoft.com/blog/microsoft365copilotblog/mitigate-oversharing-to-govern-microsoft-365-copilot-and-agents/4448744), 2025-09-02; [From Oversharing to Optimization](https://techcommunity.microsoft.com/blog/microsoft365copilotblog/from-oversharing-to-optimization-deploying-microsoft-365-copilot-with-confidence/4357963), 2024-12-17
- Microsoft Learn — [Restricted Content Discovery](https://learn.microsoft.com/en-us/sharepoint/restricted-content-discovery) (`ms.date` 2026-07-27), [Restricted SharePoint Search](https://learn.microsoft.com/en-us/sharepoint/restricted-sharepoint-search) (2026-07-06), [Get ready for Copilot with SAM](https://learn.microsoft.com/en-us/sharepoint/get-ready-copilot-sharepoint-advanced-management) (2026-07-16), [EEEU activity report](https://learn.microsoft.com/en-us/sharepoint/data-access-governance-everyone-except-external-user-report) (2026-05-12), [Secure & governed data foundation blueprint](https://learn.microsoft.com/en-us/microsoft-365/copilot/secure-govern-copilot-foundational-deployment-guidance) (2026-05-06)
- AWS — [IAM policies and permissions §Session policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html#policies_session), [`AssumeRole` API reference](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html), [Evaluating effective permissions with boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html), [Policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
- GitHub Docs — [Setting base permissions for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/setting-base-permissions-for-an-organization), [About repositories](https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories), [Copilot Spaces](https://docs.github.com/en/copilot/concepts/context/spaces), [repository indexing](https://docs.github.com/en/copilot/concepts/context/repository-indexing)
- Notion — [Custom Agents sharing & permissions](https://www.notion.com/help/custom-agents-sharing-and-permissions), [Enterprise Search security and privacy practices](https://www.notion.com/help/enterprise-search-security-and-privacy-practices), [Notion AI security practices](https://www.notion.com/help/notion-ai-security-practices)
- Slack — [Restrict AI access to certain channels, canvases, and lists](https://slack.com/help/articles/47421816860947-Restrict-AI-access-to-certain-channels-canvases-and-lists), [Security for AI features in Slack](https://slack.com/help/articles/28310650165907-Security-for-AI-features-in-Slack), [Set up and manage Slack enterprise search](https://slack.com/help/articles/39044407124755-Set-up-and-manage-Slack-enterprise-search)
- Glean — [Google Drive connector permissions](https://docs.glean.com/connectors/native/gdrive/security/permissions) (2026-08-04), [How code search works](https://docs.glean.com/security/how-code-search-works) (2026-06-17), [About Glean Protect and Protect+](https://docs.glean.com/administration/protect/overview) (2026-08-03), [indexing document permissions](https://developers.glean.com/api-info/indexing/documents/permissions)
- Atlassian — [Search with Smart Links](https://support.atlassian.com/rovo/docs/search-with-smart-links/), [Rovo data privacy and usage guidelines](https://support.atlassian.com/rovo/docs/rovo-data-privacy-and-usage-guidelines/), [Connect to external products](https://support.atlassian.com/rovo/docs/connect-to-external-products/)
- Sourcegraph — [Permissions](https://sourcegraph.com/docs/admin/permissions), [Permission syncing](https://sourcegraph.com/docs/admin/permissions/syncing), [Cody ignore context](https://sourcegraph.com/docs/cody/capabilities/ignore-context)
- Google — [Best practices for using service accounts securely](https://cloud.google.com/iam/docs/best-practices-service-accounts), [OAuth 2.0 for server-to-server](https://developers.google.com/identity/protocols/oauth2/service-account), [Gemini and Workspace data access](https://support.google.com/a/users/answer/17010577)
- VS Code — [Workspace context](https://code.visualstudio.com/docs/copilot/reference/workspace-context) (8/5/2026); Cursor — [ignore files](https://cursor.com/docs/reference/ignore-file); Amp — [manual](https://ampcode.com/manual), [Librarian](https://ampcode.com/news/librarian) (2025-10-20); JetBrains — [Getting started with JetBrains Context](https://www.jetbrains.com/help/jetbrains-console/getting-started-with-jetbrains-context.html) (2026-08-03)
- [RFC 8693, OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.txt), January 2020
- [MCP 2026-07-28 authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Goguen & Meseguer, *Security Policies and Security Models*, IEEE S&P 1982 ([PDF](https://www.cs.purdue.edu/homes/ninghui/readings/AccessControl/goguen_meseguer_82.pdf))
- Zdancewic & Myers, *Robust Declassification*, CSFW-14 2001 ([PDF](https://www.cs.cornell.edu/andru/papers/csfw01.pdf))
- Sabelfeld & Sands, *Declassification: Dimensions and Principles*, CSFW'05 / JCS 17(5) 2009 ([PDF](http://www.cse.chalmers.se/~dave/papers/sabelfeld-sands-jcs07.pdf))
- Hardy, *The Confused Deputy*, ACM SIGOPS OSR 22(4), 1988 ([author's copy](http://cap-lore.com/CapTheory/ConfusedDeputy.html))

Vendor research, labelled as such and not treated as measurement:

- Varonis, [*2025 State of Data Security Report: Quantifying AI's Impact on Data Risk*](https://info.varonis.com/hubfs/Files/reports/2025-varonis-state-of-data-security-report.pdf) — 90% / 25,000+ folders / 6%; methodology "1,000 organizations", "nearly 10 billion cloud resources", "more than 20 petabytes". Self-selected assessment population; vendor sells the remediation.
