# Is auto-labelling the enclosing git repo `internal` defensible?

**Date:** 2026-08-06
**Status:** Research note, not a decision. Opened against
[#393](https://github.com/KenTaniguchi-R/agentcall/issues/393), which states the
problem and lists the five options this note grades.

Every figure below was pulled from the primary source and is cited with a URL and
a date. Where a number in #393 traces only to a secondary summary, this note says
so. See [what I could not verify](#what-i-could-not-verify) — it is not short, and
it is the part that constrains the recommendation.

## What ships, verified against `main` @ `6dbf1c6`

`packages/cli/src/commands/line.ts:157` writes the seed on every new line, from
`defaultSensitivityMap` (`packages/cli/src/sensitivity.ts:256-267`): walk up from
`cwd`, and the first directory that is not `$HOME` and contains a `.git` is
labelled `internal`. No repository means an empty map, and an empty map means
every source classifies `secret`.

Three properties of the shipped code matter to the options below and are easy to
misread:

1. **`internal` is the *restrictive* label of the two grantable ones.**
   `permits(clearance, content)` is `RANK[content] <= RANK[clearance]` with
   `public: 0, internal: 1` (`sensitivity.ts:20, 75-78`), and
   `DEFAULT_POLICY.default_clearance` is `"public"` (`policy.ts:58`). A `public`
   caller therefore **cannot** read an `internal` source.
2. **Basename denial is the only content-shaped defence.** `guard.ts:58-63`
   denies `.env`, `.env.*` (except `example`/`sample`/`template`), `id_rsa`,
   `id_ed25519`, `id_ecdsa`, `.pem`, `.p12`, `.pfx` — anywhere on disk,
   including inside a labelled repo.
3. **Nothing reads `.gitignore`.** `grep -rn gitignore packages/cli/src apps/relay/src`
   returns nothing. A build artefact, a local override, or a scratch dump that
   git is told to ignore is fully readable inside a labelled repo. Every
   comparable product in [§3](#3-what-comparable-products-auto-grant-on-install)
   honours `.gitignore` by default; we are the exception.

---

## 1. Where secrets actually live inside a repository

### 1a. The 6× figure in #393 checks out. The percentages behind it do not appear in the source #393 cites.

The [GitGuardian blog post](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/)
(2026-03-17), under *"Public leaks are only half the story"*, says exactly:

> Internal repos are roughly 6× more likely than public ones to contain hardcoded secrets.

The [press release](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026-pr/)
repeats it as *"Internal repositories remain the biggest exposure reservoir. They
are ~6× more likely than public ones to contain hardcoded secrets."*

**Neither page states the underlying percentages.** #393's "roughly a third hold
at least one" is correct, but it comes from a *different* document —
[The Hacker News' 9-takeaways piece](https://thehackernews.com/2026/03/the-state-of-secrets-sprawl-2026-9.html)
(2026-03), which quotes:

> 32.2% of internal repos contain at least one hardcoded secret, compared to just 5.6% of public repos.

32.2 / 5.6 = 5.75, which rounds to the ~6× GitGuardian states, so the two are
consistent. But the gated full report is the only place the split would be
primary, and I could not read it. **Cite the 6× to the blog; cite 32.2%/5.6% to
THN, not to GitGuardian.** #393 currently attributes both to the blog.

Two further figures from the same report bear on the boundary:

- *"About 28% of incidents originate entirely outside repositories, in places like
  Slack, Jira, and Confluence."* — read the other way, **~72% of incidents are in
  repositories**, which is the surface the seed grants.
- 24,008 unique secrets in MCP-related config files on public GitHub, 2,117 valid
  (8.8% of MCP-related findings). Relevant to [#392](https://github.com/KenTaniguchi-R/agentcall/issues/392),
  not to this one.

**Verdict on the premise: the measurement in #393 stands.** An internal repo is
the highest-density secret container a developer routinely has on disk, and the
seed grants exactly one of those, whole.

### 1b. File-type distribution: basename denial covers roughly an eighth of the risk, not most of it.

Two measured distributions exist. Both are older than I would like, and I found
no newer one (see [what I could not verify](#what-i-could-not-verify)).

**GitGuardian, [*Secret Sprawl: Most common files to leak secrets*](https://blog.gitguardian.com/top-10-file-extensions/)
(published 2021-03-12, data = all public GitHub commits scanned in 2020):**

| Rank | Extension | Share of findings | Covered by `DENIED_BASENAMES`? |
|---|---|---|---|
| 1 | `.py` | 27.9% | no |
| 2 | `.js` | 18.8% | no |
| 3 | `.env` | 9.7% | **yes** |
| 4 | `.json` | 7.5% | no |
| 5 | `.properties` | 4.0% | no |
| 6 | `.pem` | 3.6% | **yes** |
| 7 | `.php` | 2.2% | no |
| 8 | `.xml` | 2.0% | no |
| 9 | `.yml`/`.yaml` | 2.0% | no |
| 10 | `.ts` | 2.0% | no |

The post states *"top 10 file extensions account for 81% of all the results"*.
Our basename list intersects that top 10 at `.env` + `.pem` = **13.3%**. Markdown,
Terraform, and notebooks do not appear in the top 10 at all.

**Basak, Neil, Reaves, Williams, [*SecretBench: A Dataset of Software Secrets*](https://arxiv.org/abs/2303.06729),
MSR 2023 (arXiv 2303.06729, 2023-03-12).** 97,479 candidate secrets from 818
public GitHub repositories, **manually labelled**, 15,084 confirmed true (Cohen's
κ = 0.86 between raters). The paper's §III-B:

> the top 5 file types based on the number of true secrets are txt (2,935), toml (1,985), js (1,583), html (1,337), and pem (813).

Against 15,084 true secrets that is txt 19.5%, toml 13.2%, js 10.5%, html 8.9%,
**pem 5.4%**. `.env` does not make the top five by true secrets at all. The
candidate-secret ranking is different again — *"js (10,412), nix (8,623), json
(8,132), txt (7,737), and xml (6,429)"* — which is a reminder that raw scanner
hits and confirmed secrets have different shapes.

One cross-table inference, flagged as inference: Table II gives *Private Key* as
the largest category with **5,789 true secrets (38.4% of all true secrets)**,
while only 813 true secrets sit in `.pem` files. Even if every `.pem` secret were
a private key, **most private keys in this dataset live in files whose basename
our rule does not recognise** — embedded in source, config, or fixture files.

**What this settles.** #393 asks whether basename denial "covers most of the risk
or a tenth of it." Two independent datasets, five years apart, both land near the
low end: **13.3% by the 2020 GitGuardian scan, ~5.4% by SecretBench's manually
confirmed labels.** The honest description of option 1 in #393 —
*"we auto-grant your repo and hope the secret is in a file we recognise"* — is
not rhetoric. It is roughly a one-in-eight hope.

**Caveats that keep this directional rather than exact.** GitGuardian's
distribution is public-repo data from 2020 and predates the AI-assisted commit
era its own 2026 report is about. SecretBench selected its 818 repos by a
multiset-multicover algorithm designed to maximise coverage of 761 distinct regex
*patterns*, explicitly not to be representative of a typical repository — its own
Threats to Validity section flags manual-labelling bias. Neither is a random
sample of the repositories AgentCall owners will actually label.

---

## 2. Option 5 — seed `docs/`, `README*`, `*.md`

#393 calls this "the most interesting and the least evidenced". It has two
independent halves. **The first is unverified. The second is contradicted, and by
more than one line of evidence.**

### 2a. Do secrets leak into Markdown at a materially lower rate? — Unverified, but the sign is probably right.

Markdown appears in **neither** measured distribution above: not in GitGuardian's
top 10 (which covers 81% of findings), and not in SecretBench's top 5 by true
secrets. That is weak, indirect support for the low-rate claim — absence from two
top-N lists is not a measured rate, and I found no study that reports a per-file-type
*rate* (secrets per file) rather than a *share* of total findings.

Documented counter-examples exist and are not rare. GitGuardian's PyPI research
records *"the chatllm project leaked 209 OpenAI keys in an internal markdown
file"*. And in the dotfiles corpus below, `README.md` is the single most common
filename — 333,164 files across 69,845 of 124,230 repositories.

**So: could not verify. The claim is plausible and unmeasured.**

### 2b. Is prose what people ask about? — No. The measured taxonomy says the opposite.

The canonical measurement is Sillito, Murphy, and De Volder,
[*Questions Programmers Ask During Software Evolution Tasks*](https://www.cs.ubc.ca/~murphy/papers/other/asking-answering-fse06.pdf),
FSE 2006 — two observational studies (9 graduate-student newcomers in 12 paired
lab sessions; 16 industrial programmers on their own code in 15 sessions),
yielding a catalog of 44 question types. The organising principle, quoted from §4:

> Considering a code base as a graph of entities (methods and fields, for example) and relationships between those (references and calls, for example), to answer any given question requires understanding some subgraph of the system.

The four categories and their sizes: *Finding initial focus points* (5),
*Building on those points* (15), *Understanding a subgraph* (13), *Questions over
groups of subgraphs* (11). Representative questions, verbatim:

> 12. Where is this method called or type referenced?
> 17. What does the declaration or definition of this look like?
> 23. How is this feature or concern (object ownership, UI control, etc) implemented?
> 30. Why isn't control reaching this point in the code?

**None of the 44 is answerable from `docs/`.** Every one requires reading source.
A line seeded with only `*.md` would answer "I can't share that" to the entire
catalog.

The limitation is real and I will not oversell this: Sillito measures a
*programmer performing a change task on code they will edit*, not a colleague
asking a question over a call. Those are different populations, and 2006 predates
every tool in this space. But it is the only rigorously coded taxonomy of "what
does someone need to know about a codebase," and it points hard away from prose.
I could not find a measured Copilot Chat / Cursor query-topic distribution from a
primary source (see [what I could not verify](#what-i-could-not-verify)); the
closest, Zhong, Zou & Adams,
[*Developer-LLM Conversations*](https://arxiv.org/abs/2509.10402) (arXiv
2509.10402, 2025-09), reports a 7-category / 20-subcategory intent taxonomy with
Bug Fixing and Code Generation dominant — but I could not extract the per-category
percentages from the PDF and will not quote a number I did not read.

### 2c. The half nobody costed: `docs/` is the *worst* thing to auto-grant, not the safest.

This is the finding that changes the shape of option 5.

Kao, Li, Dai, Qiu, Zhou, Jiang & Sperl,
[*You Told Me to Do It: Measuring Instructional Text-induced Private Data Leakage in LLM Agents*](https://arxiv.org/abs/2603.11862)
(arXiv 2603.11862v1, 2026-03-12) — the ReadSecBench paper. 500 real-world README
files from distinct repositories, 100 each across Java, Python, C, C++, and
JavaScript, with adversarial payloads, evaluated against Claude, GPT, and Gemini
model families and end-to-end against a commercially deployed computer-use agent.

Measured:

- **End-to-end exfiltration success rates up to 85%**, consistent across five
  languages and three injection positions.
- Attack success **rises** when the payload is moved *two document links away*
  from the main README — i.e. into a linked `CONTRIBUTING.md` or `SECURITY.md`.
- **15-participant user study: 0% detection rate**, across all participants.
- 12 rule-based and 6 LLM-based defenses evaluated: *"None of the scanners can
  simultaneously achieve both a low false positive rate and a high detection
  rate."*

The [CSA research note](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/03/CSA_research_note_readme_instruction_injection_ai_coding_agents_20260317-csa-styled.pdf)
(2026-03-17) that summarises this alongside the IDEsaster disclosures is **marked
"Unofficial AI-assisted Research"** on its own cover page — *"This document was
generated with AI assistance and has not undergone official CSA review and
approval processes."* I verified its ReadSecBench citation against the arXiv
paper directly; treat the rest of that note as unconfirmed. Its one useful framing
is that project documentation — `README.md`, `CONTRIBUTING.md` — is a *"lower-trust
but still effective injection surface because agents process them as informational
context that nonetheless shapes their responses and actions."*

**The consequence for AgentCall specifically.** `readableSources` feeds the
labelled directories into the answering agent's prompt, and `workdirFor` spawns
the agent inside the first of them (`sensitivity.ts:198-240`). Option 5 would make
the default spawn directory a tree of Markdown, and a repo's docs are typically
the most externally-contributed, least-reviewed files in it. This is the exact
architecture ReadSecBench measures at up to 85%. It is not a narrow-and-generous
compromise; it is a targeted grant of the injection surface with the code the
agent would need to be useful removed.

**Verdict on option 5: both halves fail.** Half one is unverified. Half two is
contradicted by the only measured taxonomy. And the option carries an unpriced
third cost that is larger than the risk it was meant to reduce.

---

## 3. What comparable products auto-grant on install

This is the strongest available precedent, and it splits cleanly. **Every
developer-workstation tool auto-grants the working directory or the whole repo.
Every one of them also ships a default exclusion list.** The enterprise-search
tools do the opposite and inherit source-system ACLs.

| Product | Documented default scope at first run | Opt-in per directory? | Default exclusions |
|---|---|---|---|
| **Claude Code** | *"By default, Claude has access to files in the directory where you launched it."* Read-only tools: approval required **"No, within the working directory and additional directories"** ([permissions docs](https://code.claude.com/docs/en/permissions)) | No — cwd is automatic; `--add-dir` / `/add-dir` / `additionalDirectories` **widen** it | **None documented.** `.env` appears only as an example of a rule *you* write (`Read(./.env)`) |
| **Cursor** | Indexes the workspace on open | No | `.gitignore` **plus** a built-in list — *"Cursor automatically ignores files in `.gitignore`"* — including `.env*`, lockfiles, `node_modules/`, `__pycache__/`, binaries. **Indexing only.** ([ignore-file docs](https://cursor.com/docs/reference/ignore-file)) |
| **GitHub Copilot (`@workspace`)** | *"VS Code indexes relevant text files that are part of your current project. This is not limited to specific file types or programming languages."* ([workspace context docs](https://code.visualstudio.com/docs/agents/reference/workspace-context)) | No | `.gitignore`, `files.exclude`, *"some common file types that are typically not relevant, such as `.tmp` or `.out`"*, binaries. Content exclusion is a **separate, admin-configured, opt-in** feature ([docs](https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/exclude-content-from-copilot)) |
| **Sourcegraph Cody** | *"By default, Cody can access all repositories for context when making requests to third-party LLMs, with no restrictions on inclusion or exclusion."* ([ignore-context docs](https://sourcegraph.com/docs/cody/capabilities/ignore-context)) | No — **all repos**, and narrowing requires an Enterprise license and a site admin | None by default; `cody.contextFilters` is opt-in and Enterprise-only |
| **Devin** | Setup offers *all repositories in the organization* or a named subset; "included" repos are cloned so Devin can access the code ([repo setup docs](https://docs.devin.ai/onboard-devin/repo-setup)) | **Yes** — an explicit choice at connect time | n/a; secrets are a separate scoped store |
| **Glean** | Inherits per-document ACLs from each connected source; enforced per-query at retrieval ([how Glean accesses information](https://docs.glean.com/user-guide/assistant/how-glean-accesses-info)) | n/a — grants come from the source system | n/a |

Three things fall out of that table.

**The default AgentCall ships is the industry-standard default.** Claude Code —
which is the answering agent — already grants read of the launch directory with no
prompt. Cody grants *every repository on the instance*. Nobody in the
workstation-tool column makes you name a directory first. On precedent alone,
option 3 (seed nothing) is the outlier, and options 1 and 5 are inside the norm.

**But the precedent does not transfer cleanly, and the reason is the whole
product.** In every row of that table the reader is the owner or someone already
inside the owner's trust boundary. Cursor's index goes to Cursor. Copilot's
`@workspace` answers the person at the keyboard. Claude Code's cwd grant is the
owner reading their own files through a tool. AgentCall's grant is **read by a
remote caller on someone else's machine**, mediated only by a clearance level.
That is Glean's problem, not Cursor's — and Glean solves it by never inventing a
grant, only mirroring one that already exists in a source system. AgentCall has no
such source system to mirror, which is why the seed exists at all.

**The one thing every workstation tool does that we don't: a default exclusion
list.** Cursor and Copilot both auto-grant broadly *and* subtract `.gitignore` plus
a built-in list before anything is read. We auto-grant broadly and subtract eight
basename regexes. Cursor's list explicitly includes `.env*`; ours does too. Neither
Cursor nor Copilot stops there. Note also Cursor's own honest caveat, which is the
right calibration for how much any of this buys: *"While Cursor blocks ignored
files, complete protection isn't guaranteed due to LLM unpredictability."*

---

## 4. Is "the enclosing git repo" the right unit?

### The `$HOME` carve-out is well-founded, and #393's characterisation of the evidence needs one correction.

Jungwirth, Saha, Schröder, Fiebig, Lindorfer & Cito,
[*Connecting the .dotfiles: Checked-In Secret Exposure with Extra (Lateral Movement) Steps*](https://martina.lindorfer.in/files/papers/dotfiles_msr23.pdf),
MSR 2023 (TU Wien / MPI-INF). Verified from the paper:

> We mined 124,230 public dotfiles repositories and inductively searched them for security and privacy issues. […] We found that 73.6% of repositories leak potentially sensitive information, most commonly email addresses (of which we found 1.2 million), but also RSA private keys, API keys, installed software versions, browsing history, and even mail client inboxes.

**#393 quotes the 73.6% accurately but the reading is generous.** Table III shows
that figure is dominated by PII: email addresses appear in **70.7%** of
repositories. Actual credential rates are an order of magnitude lower — GitHub API
keys in **5.51%**, Twitter client IDs in 3.14%, RSA private keys in **1.19%**. The
carve-out is still right (5.51% of home directories holding a live GitHub token is
plenty), but "73.6% leaked sensitive info" should not be cited as a credential rate.

The paper also documents the second-order risk that makes `$HOME` categorically
worse than a project directory, which is the part worth carrying into any future
design: `.dotfiles` leak *context* — a `.bashrc` alias naming a server, an
`.ssh/config` naming jump-hosts, a `known_hosts` file — that turns a leaked
credential from a fact into a usable path. Our `FLOOR_DIRS`/`FLOOR_FILES`
(`sensitivity.ts:135-149`) already cover `.ssh`, `.zshrc`, `.bashrc`, `.profile`
and friends, and are non-overridable. They do **not** cover `.vimrc`, `.gitconfig`,
`.tmux.conf`, or `config` — which are, per the paper's Table IIb, the 3rd, 5th, 6th
and 4th most common filenames in that corpus. That is not exploitable today
because `$HOME` is never labelled; it becomes exploitable the moment anyone labels
a parent of one.

### Other traps: mostly unquantified.

- **Monorepo.** Walking up to the enclosing repo means running `setup` in
  `services/billing` grants the entire monorepo, including every other team's
  service. The code comments frame walk-up as a feature ("running it deep in a
  monorepo still names the root") — which is correct for finding *a* root and
  exactly wrong for scoping a grant to a stranger. **I could not find a primary
  survey measuring monorepo prevalence.** The widely-repeated "63% of companies
  with 50+ developers use monorepos" figure appears across 2025–2026 vendor blogs
  with no identifiable originating survey; I am not citing it.
- **Dotfiles repo.** Carved out only when it is exactly `$HOME`. A dotfiles repo
  checked out at `~/dotfiles` and `setup` run inside it **is** labelled `internal`,
  and the floor rules protect `~/.ssh` but not `~/dotfiles/ssh/config`. This is a
  real gap in the shipped code, not a hypothetical: the MSR'23 corpus is 124,230
  repositories of exactly this shape, and Table IIb shows `config` and `.ssh`
  contents are routine in them.
- **A repo at an unusually broad root** (`~/`, `~/code`, `/`). No data found on
  frequency. `$HOME` is handled; `~/code` containing a stray `.git` is not.

---

## Verdicts on the five options

**Option 1 — keep it, lean on basename denial + [#173](https://github.com/KenTaniguchi-R/agentcall/issues/173).**
*Defensible on precedent, weak on measurement.* For: it matches what every
workstation coding tool defaults to, including the answering agent itself; it is
what ships; a fresh line is useful. Against: the two independent file-type
distributions put basename coverage at **5–13%**, so the residual is not a corner
case; and the reader is remote, which is the one property no product in the
precedent table shares. #393's self-description is accurate and should be written
into the docs verbatim rather than softened.

**Option 2 — seed `public` instead of `internal`. Reject: it is a widening, not a
mitigation.** #393 calls this "close to a no-op". It is worse than that. Content
labelled `public` is readable by any caller at clearance `public` — which is
`DEFAULT_POLICY.default_clearance` — while content labelled `internal` is readable
by *nobody* at the default clearance. Seeding `public` would make the repo
readable by **every** caller instead of only explicitly-cleared ones. The current
`internal` seed is the more restrictive of the two available choices.

**Option 3 — seed nothing.** *Correct on security, and the only option that is
correct on security.* Fail-closed matches the module's own stated design
(`sensitivity.ts:6-8`: "the failure mode of an unconfigured or half-configured
line is a refusal to answer rather than a leak"). Against: it is the outlier
versus every product in §3, and it re-opens
[#372](https://github.com/KenTaniguchi-R/agentcall/issues/372)'s useless-on-day-1
state. The cost is real but it is a *product* cost, and it is the only option
whose failure mode is a bad first impression rather than a leak.

**Option 4 — seed the repo, exclude by content.** *Reject, unchanged.* I verified
the REDACT figure #393 relies on: Presidio scores **0.07 recall on
HIGH-sensitivity categories** ([arXiv 2606.19881v1](https://arxiv.org/abs/2606.19881v1)),
evaluated over a locked 1,000-record stratified sample against five detectors. 7%
recall is not a boundary. This is the same bar that
[2026-08-06-information-flow-control-for-agent-answers.md](./2026-08-06-information-flow-control-for-agent-answers.md)
already applied to prompt-injection classifiers, and it fails identically.

**Option 5 — seed `docs/`, `README*`, `*.md`.** *Reject, and it is the worst of
the five.* Half one (secrets are rarer in Markdown) is **unverified** — plausible,
absent from both distributions, but never measured as a rate. Half two (prose is
what people ask about) is **contradicted**: all 44 questions in the Sillito
taxonomy require reading source. And the unpriced third cost is decisive —
ReadSecBench measures **up to 85% end-to-end exfiltration** through exactly this
file class, with **0% human detection** and no scanner achieving usable
precision/recall. Option 5 removes the files that make the agent useful and keeps
the files that make it exploitable.

---

## What I could not verify

Listed because #393's brief asks for it explicitly, and because a recent batch in
this directory contained one fabricated claim.

1. **The GitGuardian full report.** Gated behind a download form. Everything cited
   here comes from the public blog post, the press release, and THN's summary. The
   **32.2% / 5.6%** split is *not* in either GitGuardian page — only "~6×" is.
2. **Any file-type distribution of leaked secrets newer than 2023.** GitGuardian's
   extension breakdown is 2020 data published 2021; SecretBench is MSR 2023. I
   searched the 2024, 2025, and 2026 reports and found no successor table. **The
   central number in §1b is five years old.** If the decision hinges on it, buying
   or requesting the current report is worth doing before deciding.
3. **A measured per-file-type *rate* of secret leakage** (secrets per Markdown file
   vs per Python file). Both sources report *share of total findings*, which
   confounds rate with file population. Option 5's first half cannot be settled
   without this.
4. **A primary Copilot Chat / Cursor query-topic distribution.** No vendor
   publishes one. The nearest academic work
   ([arXiv 2509.10402](https://arxiv.org/abs/2509.10402), 2025-09) has the right
   taxonomy but I could not extract its per-category percentages from the PDF, so
   I quote none.
5. **Monorepo prevalence.** No primary survey found. The 63% figure circulating in
   2025–2026 vendor blogs has no identifiable source and is not used here.
6. **What fraction of developers have a repo at an unusually broad root.** No data
   found in any form.
7. **GitHub secret-scanning transparency data broken down by file type.** GitHub
   publishes partner-program and volume data; I found no file-type breakdown.
8. **The CSA README-injection note's non-ReadSecBench claims** (IDEsaster CVE
   counts, AIShellJack success rates). The note is self-labelled *"Unofficial
   AI-assisted Research"* that "has not undergone official CSA review". I verified
   only its ReadSecBench citation, against the arXiv paper.

---

## Recommendation

**The evidence supports a recommendation, and it is not one of the five options as
written.** It is option 1 with the exclusion layer that every comparable product
ships and we don't, plus option 3's fail-closed behaviour applied to the two cases
where the walk-up heuristic is guessing.

The reasoning: §3 shows auto-granting the working directory is not a deviant
default — it is what Claude Code, Cursor, Copilot, and Cody all do. §1b shows our
subtraction from that grant is far thinner than theirs. The gap between us and the
precedent is **not the grant, it is the exclusion list.** That is also the cheapest
gap to close.

Concretely, in the order I would do them:

1. **Honour `.gitignore` inside a labelled source.** Cursor and Copilot both do
   this by default; we do it nowhere. It costs one dependency and it removes
   build artefacts, local overrides, and `*.local` config from the grant — the
   files most likely to hold a working credential and least likely to be asked
   about. Highest value per unit of work of anything in this note.
2. **Do not seed when the walk-up is guessing.** Two cases where the heuristic is
   not measuring what it thinks: the repo root is more than N levels above `cwd`
   (a monorepo grant the owner did not ask for), or the repo looks like dotfiles
   (contains `.bashrc`/`.zshrc`/`.vimrc`/`.gitconfig` at its root — Table IIb of
   MSR'23 is a usable signature). In those cases seed nothing and let `doctor`
   ask. This is option 3 applied narrowly, where its day-1 cost is lowest and its
   value highest.
3. **Say the true thing in the docs.** Not "we label your repo `internal`" but
   "this grants a cleared caller read of everything in this repository, now and in
   future, minus a short denylist that catches roughly one in eight leaked
   secrets by published measurement." #393 already quotes Anthropic's
   [*How we contain Claude*](https://www.anthropic.com/engineering/how-we-contain-claude)
   framing — *"it may be better conceptualized as a capability grant"* — and that
   is the correct frame. An owner who reads that sentence and proceeds has made a
   decision; one who reads "labelled `internal`" has not.
4. **Leave #173 as the acknowledged residual, and stop treating it as the plan.**
   Content scanning of the reply is the only thing that catches an in-source
   secret, and §1b says that is 87–95% of them. But option 4's evidence (0.07
   recall) says content classification cannot be a boundary — so #173 is a
   detector, not a fix, and the seed decision must stand on its own without it.

**Two things I am explicitly not recommending.** Option 5 in any form — the
ReadSecBench numbers make `docs/`-only strictly worse than what ships. And a
straight adoption of option 3 — the security case is clean, but nothing in the
evidence says the day-1 cost is worth paying *globally* when the two failure modes
that motivate it (monorepo, dotfiles) can be detected directly.

---

## Sources

Primary, each verified by reading the cited page or paper:

- <https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/> — GitGuardian, 2026-03-17. "~6×"; "About 28% of incidents originate entirely outside repositories"
- <https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026-pr/> — press release, same figure
- <https://thehackernews.com/2026/03/the-state-of-secrets-sprawl-2026-9.html> — 2026-03. Sole source for "32.2% of internal repos … 5.6% of public repos"
- <https://blog.gitguardian.com/top-10-file-extensions/> — GitGuardian, 2021-03-12, 2020 data. Extension distribution
- <https://arxiv.org/abs/2303.06729> — SecretBench, MSR 2023. 15,084 manually-labelled true secrets, 818 repos, 311 file types
- <https://arxiv.org/abs/2603.11862> — ReadSecBench / *You Told Me to Do It*, 2026-03-12. Up to 85% exfiltration via README; 0% human detection
- <https://www.cs.ubc.ca/~murphy/papers/other/asking-answering-fse06.pdf> — Sillito et al., FSE 2006. 44 questions, four code-graph categories
- <https://martina.lindorfer.in/files/papers/dotfiles_msr23.pdf> — Jungwirth et al., MSR 2023. 124,230 dotfiles repos; 73.6% (70.7% email, 5.51% GitHub API keys, 1.19% RSA private keys)
- <https://arxiv.org/abs/2606.19881v1> — REDACT. Presidio 0.07 recall on HIGH-sensitivity categories
- <https://code.claude.com/docs/en/permissions> — Claude Code working-directory default and read-only tool table
- <https://cursor.com/docs/reference/ignore-file> — Cursor default ignore list, `.gitignore` handling, best-effort caveat
- <https://code.visualstudio.com/docs/agents/reference/workspace-context> — Copilot `@workspace` index scope and default exclusions
- <https://docs.github.com/en/copilot/how-tos/configure-content-exclusion/exclude-content-from-copilot> — Copilot content exclusion is opt-in and admin-configured
- <https://sourcegraph.com/docs/cody/capabilities/ignore-context> — "By default, Cody can access all repositories for context"
- <https://docs.devin.ai/onboard-devin/repo-setup> — Devin repository inclusion is an explicit choice
- <https://docs.glean.com/user-guide/assistant/how-glean-accesses-info> — Glean inherits source ACLs per query

Secondary, cited only where labelled as such:

- <https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/03/CSA_research_note_readme_instruction_injection_ai_coding_agents_20260317-csa-styled.pdf> — CSA, 2026-03-17. **Self-labelled "Unofficial AI-assisted Research"**; only its ReadSecBench citation was verified
- <https://arxiv.org/abs/2509.10402> — Developer-LLM Conversations, 2025-09. Taxonomy referenced; no figures quoted
