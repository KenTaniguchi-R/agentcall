# Onboarding comparables for a low-friction AgentCall trial

**Date:** 2026-08-03  
**Question:** How do adjacent developer tools get a brand-new evaluator to first value, and where do they introduce organizations, administrators, invitations, identity, and abuse controls?

## Executive conclusion

AgentCall's current enrollment path is appropriate for a managed deployment, but too heavy as the only way to evaluate the product. Today, even a curious first user needs an existing member's invite; the first member of the first organization needs a relay operator to configure `BOOTSTRAP_TOKEN` and call an admin endpoint. Only then can `agentcall setup --invite ...` register an identity and install the listener ([AgentCall README](../../README.md#install)).

The strongest comparable products separate **evaluation** from **administration**:

- Cloudflare provides an account-less, one-command, deliberately limited temporary tunnel, then sends production users to the authenticated named-tunnel and Access flows.
- ngrok and OpenHands require a normal individual account, not a pre-existing organization administrator.
- Tailscale turns an individual's signup into a personal network automatically; invitations appear when that user wants collaborators.
- Live Share and OpenCode turn sharing into an in-context action that produces a capability link; they do not ask the sharer to model an organization first.
- GitHub's coding agent keeps administration at the policy boundary: individual paid users can start directly, while Business and Enterprise administrators must enable it.

The practical implication is a two-lane AgentCall onboarding: a constrained `agentcall try` path that reaches a real call without an organization administrator, and a separate `agentcall setup` / organization path for persistent addresses, unattended listeners, richer capabilities, policy, and billing.

> **Amendment (2026-08-04) — a decision followed this doc, and it changed one recommendation.**
>
> [#259](https://github.com/KenTaniguchi-R/agentcall/issues/259) (approved, same day)
> adopted the two-lane separation argued here, as **Room** (temporary, accountless)
> versus **Team** (durable administration). It cites the same comparables.
>
> It did **not** adopt this doc's *Recommended experiment*. A vendor-operated demo
> callee is listed in #259's out-of-scope as "a solo demo agent supplied by
> AgentCall". A Room instead requires 2–6 real people who already know each other
> and already have authenticated agents — using the social setting that exists at a
> hackathon or on a team rather than a vendor puppet. #259's motivating evidence is
> an observed failed setup between two real people, not the comparables below.
>
> Room's lifetime was fixed at a 30-minute maximum, inside the 15–60 minute range
> suggested here. Read the Lane A sketch below as the argument that produced the
> decision, not as the decision. #259 is the decision.

## Comparison

| Product | Brand-new path to first value | Organization/admin/invite required? | Identity and abuse controls | Guest, demo, or local path | Pattern worth borrowing |
|---|---|---|---|---|---|
| **Cloudflare Tunnel / TryCloudflare** | Install `cloudflared`; run `cloudflared tunnel --url http://localhost:8080`; copy the random `*.trycloudflare.com` URL. ([TryCloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [GitHub](https://github.com/cloudflare/cloudflared)) | **No** account, domain, DNS zone, organization, or config for TryCloudflare. Production named tunnels use a Cloudflare account and dashboard/CLI setup. ([named-tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)) | The quick path is explicitly testing-only: no SLA, random URL changes on restart, a 200 in-flight request limit, and no SSE. It has no built-in access control; production apps can add deny-by-default Access policies. ([TryCloudflare limits](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)) | Account-less public preview URL. | Make the trial ephemeral and sharply limited instead of forcing production identity setup before the product can be understood. |
| **ngrok** | Create an individual account, install ngrok, add the dashboard authtoken, then run `ngrok http 8080`; an automatically assigned HTTPS dev domain is shown immediately. ([quickstart](https://ngrok.com/docs/guides/share-localhost/quickstart), [docs repo](https://github.com/ngrok/ngrok-docs)) | **No** administrator or invitation for a solo account. Email invitations, JIT, SCIM, and RBAC are team provisioning features introduced later. ([user management](https://ngrok.com/docs/iam/users), [RBAC](https://ngrok.com/docs/iam/rbac)) | The free plan constrains users, assigned dev domains, agents/endpoints, and quotas, and browser traffic may see an anti-phishing interstitial. Agents authenticate with per-agent authtokens; ACLs and separate tokens can reduce compromise scope. ([free limits](https://ngrok.com/docs/pricing-limits/free-plan-limits), [abuse](https://ngrok.com/abuse), [agent credentials](https://ngrok.com/docs/agent)) | Solo-account free tier; no team setup. | An account-bound trial can still be fast if the product creates the minimum personal workspace and uses quotas/interstitials rather than an admin gate. |
| **Tailscale** | Click **Get Started**, authenticate with an identity provider, choose personal/business, install and authenticate the first device; the quickstart uses a second device to demonstrate connectivity. On Linux: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`, which prints an auth URL. ([quickstart](https://tailscale.com/docs/how-to/quickstart), [Linux install](https://tailscale.com/docs/install/linux), [GitHub](https://github.com/tailscale/tailscale)) | **No existing administrator.** Signup creates the evaluator's tailnet. Public-email signup receives a Personal tailnet; custom-domain signup begins an Enterprise trial. Invitations are a later collaboration action; same-domain users can join without an invitation, while external users can receive one-time links. ([quickstart](https://tailscale.com/docs/how-to/quickstart), [invites](https://tailscale.com/docs/features/sharing/how-to/invite-any-user)) | SSO identity anchors membership. Owner/Admin/IT-admin roles govern invites; unused invite links expire after 30 days and can be revoked. ([roles](https://tailscale.com/docs/reference/user-roles), [invites](https://tailscale.com/docs/features/sharing/how-to/invite-any-user)) | After signup/install, `tailscale funnel localhost:3000` can expose one service publicly. ([Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [requirements](https://tailscale.com/docs/features/tailscale-funnel)) | Silently create a personal scope for the evaluator; ask them to create or join an organization only when collaboration requires it. |
| **Visual Studio Live Share** | The host installs the extension, signs in, opens a folder, and clicks **Live Share**; an invitation URL is copied automatically. The guest opens the URL (or uses **Join collaboration session...** and pastes it). ([share quickstart](https://learn.microsoft.com/en-us/visualstudio/liveshare/quickstart/share), [join flow](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-project-join-session-visual-studio-code), [docs repo](https://github.com/MicrosoftDocs/live-share)) | **No** organization setup or administrator for the normal flow. The invitation itself is session-scoped. Some managed Microsoft tenants may require one-time Azure AD admin consent for the app. ([security](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security)) | Each session gets a non-guessable identifier valid only for that session. Signed-in guests use Microsoft or GitHub identity; hosts are notified on join and can remove users or require explicit approval. Anonymous users can join only read-only, with host approval by default. ([security](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security), [manual join](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/manual-join)) | A read-only guest may skip sign-in and provide a display name; the host can also join their own session to test it. ([manual join](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/manual-join), [share quickstart](https://learn.microsoft.com/en-us/visualstudio/liveshare/quickstart/share)) | Use a short-lived capability link plus host visibility/approval, and make the anonymous or untrusted mode read-only. |
| **OpenCode sharing** | In an existing OpenCode conversation, run `/share`; OpenCode creates an `opncd.ai/s/<share-id>` URL and copies it. `/unshare` removes public access and deletes the shared data. ([share docs](https://opencode.ai/docs/share/), [source](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/share.mdx)) | **No** organization or invite for the default manual-sharing flow. Enterprise deployments can disable sharing, restrict it to SSO users, or self-host it. ([share docs](https://opencode.ai/docs/share/)) | Sessions are private by default. A shared URL is public to anyone who has it and persists until `/unshare`; the docs warn users to review content and avoid proprietary or confidential data. ([share docs](https://opencode.ai/docs/share/)) | Public, link-only, read-only conversation view; sharing is optional and happens after the user already received local value. | Put sharing at the moment of intent, default it off, make revocation one command, and be explicit about what data leaves the machine. |
| **OpenHands Cloud** | Visit the hosted app; choose **Log in with GitHub**, **GitLab**, or **Bitbucket**; authorize the app, accept terms, then select an accessible repository or **New Conversation**. ([getting started](https://docs.openhands.dev/openhands/usage/cloud/openhands-cloud), [Cloud UI](https://docs.openhands.dev/openhands/usage/cloud/cloud-ui), [GitHub](https://github.com/OpenHands/OpenHands)) | The consumer quickstart does **not** begin with an organization administrator or invite. Repository access follows the connected source-control identity; organizations and roles are a separate area of the product. ([getting started](https://docs.openhands.dev/openhands/usage/cloud/openhands-cloud), [Cloud UI](https://docs.openhands.dev/openhands/usage/cloud/cloud-ui)) | OAuth authorization makes permissions visible at login, and the app only presents repositories it can access. The self-hosted local GUI is documented as single-user rather than a safe multi-tenant deployment. ([getting started](https://docs.openhands.dev/openhands/usage/cloud/openhands-cloud), [FAQ](https://docs.openhands.dev/overview/faqs)) | Hosted trial is the recommended fastest path with no installation; CLI/local GUI remain separate options. ([quickstart](https://docs.openhands.dev/overview/quickstart), [OpenHands README](https://github.com/OpenHands/OpenHands/blob/main/README.md)) | Put the hosted, lowest-setup experience first; let users choose local/self-hosted control after they understand the product. |
| **GitHub Copilot cloud agent** | In a repository where the agent is enabled, open/create an issue, select **Copilot** under Assignees, optionally add instructions, and click **Assign**; Copilot starts work and opens a pull request. A user can also start a prompt from the repository's **Agents** tab. ([ten-minute quickstart](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview), [docs source](https://github.com/github/docs/tree/main/content/copilot)) | Paid individual subscribers can use enabled agents directly. For Copilot Business and Enterprise, an administrator must enable the cloud agent; third-party agents also depend on account or organization policy. ([quickstart](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview), [third-party agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)) | Existing GitHub repository permissions constrain access. Agent output lands in a pull request for review; third-party agent changes receive CodeQL, secret, dependency-malware, and vulnerability checks, and GitHub App actions are audit logged. ([third-party agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)) | No anonymous/demo mode; the familiar issue/PR workflow is the low-friction surface. | Put admin consent exactly where enterprise policy requires it, while keeping the individual flow native to an existing workflow and review boundary. |

## What the comparisons say

### 1. An organization is usually an upgrade state, not the first object a user must understand

Tailscale is the clearest identity precedent: the user's first login creates a personal tailnet, and collaboration controls appear later. ngrok similarly starts with a personal account. OpenHands starts with a source-control identity. Even GitHub Copilot cloud agent, the most enterprise-shaped product here, only requires an administrator when Business or Enterprise policy is in scope.

This does not mean AgentCall should weaken tenant isolation. It means the hosted service can create an implicit personal tenant (or a deliberately non-persistent trial scope) without exposing “organization administrator” as an onboarding prerequisite.

### 2. The safest no-admin trials constrain power and lifetime

TryCloudflare has no identity gate, but it also makes the URL random and temporary, caps concurrency, excludes production support, and clearly labels the feature as testing-only. Live Share permits an unsigned-in guest only in read-only mode and asks the host to approve them by default. These products trade permanence and capability—not security messaging—for speed.

For AgentCall, a trial should therefore be less capable than the normal product. The current built-in `ask` task is already read-only, while named tasks can grant `write` or `exec` ([AgentCall README](../../README.md#usage)). A trial can expose only a vendor-owned, non-secret demo corpus or a tightly scoped local sample directory; it should not silently turn a user's normal repository into a public agent endpoint.

### 3. Capability links are excellent invitations, but poor identity

Live Share and OpenCode show how one action can create a URL that is easy to send and easy to revoke/end. Both also make the limits visible: Live Share's URL is session-bound and the host sees arrivals; OpenCode's shared transcript is public to anyone with the URL until `/unshare`.

AgentCall can borrow a capability link for a temporary call or enrollment, but should not treat possession of that link as a durable caller identity. Stable addresses, policy grants, audit trails, roster membership, and higher-risk tasks still need authenticated principals.

### 4. First value should prove the core loop, not merely finish installation

TryCloudflare prints a live URL; ngrok prints a live endpoint; Live Share creates a joinable session; OpenHands opens a conversation. Their onboarding ends at an observable result. AgentCall's evaluator flow should end with a successful remote reply, not merely “listener installed” or “address registered.”

## Recommended AgentCall onboarding model

This is a product recommendation inferred from the comparisons, not a description of current behavior.

### Lane A: try AgentCall

Target experience:

```bash
npx @benree/agentcall try
```

The command should:

1. Detect an authenticated local Claude Code or Codex installation.
2. Mint an ephemeral trial principal automatically—no organization name, administrator, invite token, handle selection, LaunchAgent, or permanent config.
3. Call a vendor-operated demo agent with a useful prompt, or guide the evaluator to call a second evaluator through a short-lived link.
4. Print the reply and one clear next action: **Give my agent a persistent address**.

Suggested trial guardrails:

- 15–60 minute TTL and aggressive per-device/IP/account quotas.
- Vendor-owned demo data for the very first call.
- `ask` only; no custom tasks, `write`, `exec`, conversation continuation, public cards, or persistent presence.
- Explicit `trial` / `untrusted` labels in the address, result, and logs.
- No searchable directory and indistinguishable unknown/offline errors, preserving AgentCall's current anti-enumeration posture ([AgentCall README](../../README.md#usage)).
- Immediate server-side revocation and automatic expiry.

If anonymous access is operationally unacceptable, the next-best version is ngrok/OpenHands-style device OAuth with GitHub: one browser approval creates a personal trial scope. That adds identity without adding an organization administrator.

### Lane B: keep AgentCall

After first value:

```bash
agentcall setup
```

The service can offer two choices:

1. **Personal address** — automatically create a personal organization/workspace and choose a handle.
2. **Join a team** — paste an existing one-time invite.

Persistent listener installation, stable address, private workdir choice, cards/tasks, allowlists, rosters, audit, billing, SSO, and administrator policy belong here. A personal workspace can later be converted or attached to a team without forcing a first-time evaluator to understand relay bootstrapping.

### Lane C: self-host or administer an organization

Keep relay bootstrap, DNS, secrets, SSO, policy ceilings, and first-admin creation in a separate **Administrator setup** document. Cloudflare Tunnel, OpenHands, and GitHub all distinguish the fast hosted/personal path from production or enterprise administration; AgentCall should do the same in navigation and CLI help.

## Recommended experiment

Before implementing full personal organizations, test the central assumption with the smallest safe slice:

1. Ship a vendor-operated demo callee with a fixed, non-sensitive knowledge base and `ask` only.
2. Let `agentcall try` create a rate-limited 30-minute caller credential, make one suggested call, and discard local state afterward.
3. Measure install-to-reply completion, median time to first reply, and the fraction choosing **Get a persistent address**.
4. Compare against the existing invite-first flow. Do not measure setup completion as activation; the activation event is a successful call reply.

The threshold question is simple: does removing the administrator/invite prerequisite materially increase successful first calls without producing unacceptable abuse? The comparable products strongly suggest it will, but AgentCall's remote code-agent risk makes the constrained demo corpus and read-only capability essential.

## Scope and source note

Research was limited to official product documentation and first-party GitHub repositories accessed on 2026-08-03. A2A agent-card specifications were not included as a primary comparable because they standardize machine-to-machine discovery and invocation rather than a consumer onboarding journey. Aider and Continue were also omitted because their core first-run experiences do not provide a sharing or remote-agent path as directly comparable as the products above.
