# Claude Code cross-session messaging — implications for AgentCall

**Date:** 2026-08-09  
**Type:** Competitive / platform research (not a product decision)  
**Question:** What did the Claude Code feature highlighted in the referenced X
post ship, and what—if anything—should AgentCall learn from it and agmsg?

## Executive read

Claude Code now has a first-party **cross-session messaging** feature. A Claude
session can discover other reachable sessions and send them a *text-only*
summary, finding, status update, or request. It does **not** transfer files or
conversation history. This is a useful developer-workflow primitive, but it is
not an AgentCall substitute: it is confined to one user's Claude Code sessions,
is same-machine-first, has no durable remote address or organization routing,
and cannot initiate a cross-machine exchange.

The nearby open-source project [agmsg](https://github.com/fujibee/agmsg) makes
the complementary trade-off: shared local SQLite gives cross-vendor agents
durable local history with almost no infrastructure. Its portability and
delivery-mode abstraction are useful lessons; its shared-file trust and
delivery model are not a model for AgentCall's authenticated, policy-governed,
cross-person boundary.

## What Claude Code shipped

The official [cross-session messaging documentation](https://code.claude.com/docs/en/cross-session-messaging)
describes it as messaging **your other Claude Code sessions**. It requires
Claude Code **v2.1.224+**, runs on macOS and Linux (including WSL), and is not
available on native Windows or several managed-cloud providers.

| Aspect | Current behavior |
|---|---|
| Discovery and send | Claude uses `ListAgents` and `SendMessage`; `/list-agents` lets the user inspect reachable sessions. |
| Payload | A message is text Claude writes for another Claude. The receiver gets neither the sender's files nor its conversation history. Full-context continuation uses session resume instead. |
| Local transport | Same-machine sessions register on local disk and communicate through a per-session Unix-domain inbox socket, never through Anthropic servers. Containers are isolated unless both sessions share the container filesystem. |
| Cross-machine / web | Transport goes through Anthropic Remote Control, but a session can only **reply** to a message that originated remotely; it cannot start that exchange. |
| Delivery | A running recipient reads between tool calls; an idle interactive recipient starts a turn. The receiving session can deliver, hold, or refuse an inbound message. |
| Safety | Messages are marked as agent-originated, are never user consent, cannot execute slash commands, and remain subject to the receiver's own permissions. `isolatePeerMachines` requires approval for remote sends. |
| Durability / flow control | The channel is plaintext-only, throttles loops, deduplicates rapid identical messages, and caps pending messages. This is an active-session coordination channel, not a durable mailbox. |

Claude Code's experimental [agent teams](https://code.claude.com/docs/en/agent-teams)
are a related but distinct feature: a lead creates independent Claude sessions
with a local shared task list and mailbox. They are experimental, disabled by
default, local to a session-derived team, and use significantly more tokens
than a single session. That documentation makes the central design point
explicit: teammates receive project context and their spawn prompt, **not the
lead's conversation history**.

## agmsg comparison

agmsg connects Claude Code, Codex, Gemini, Copilot, and other CLI agents on a
shared machine. Its [README](https://github.com/fujibee/agmsg#readme) states
that a `send.sh` call appends to a WAL-mode SQLite database; hooks or a monitor
stream surface new rows. History persists and can be replayed into a fresh
agent. Delivery is selectable: real-time monitor, between-turn polling,
both, or manual. This solves the vendor-compatibility and local durability
gaps that Claude's feature intentionally leaves open.

| Dimension | Claude cross-session messaging | agmsg | AgentCall today |
|---|---|---|---|
| Scope | One person's Claude sessions | Local agents, including different vendors | A named caller to another person's live agent within one organization |
| Transport | Local Unix socket; remote replies via Remote Control | Shared local SQLite | Authenticated relay + live listener |
| Persistence | Active-session messaging; bounded queues | Durable SQLite history and replay | Live by default; an owner may opt into a bounded ciphertext mailbox |
| Context transfer | Explicit text only | Explicit message / optional history replay | Explicit request and reply; task policy resolves before inbound text reaches the prompt |
| Safety boundary | Recipient treats peer text as untrusted and preserves its permissions | Shared local database and hooks; no equivalent trust boundary claimed | Authenticated identity, callee-selected task, prompt defanging, audit and policy |
| Compatibility | Claude Code only | Cross-vendor CLI | Multi-agent CLI invocation at a person-scoped address |

AgentCall's [overview](../site/overview/how-it-works.mdx) defines a call as live,
with offline delivery as an owner-enabled exception: a target that has not
enabled it still fails immediately, and an enabled mailbox holds ciphertext for a
bounded window rather than acting as a general store-and-forward queue. That
distinction should remain visible: a local developer coordination channel is not
durable person-scoped delegation.

> **Correction (2026-08-17).** As written on 2026-08-09 this note said AgentCall
> had "deliberately no store-and-forward mailbox." The opt-in ciphertext mailbox
> (`call_queued`, `MAILBOX_TTL_MS`) has since landed, so the two statements above
> were corrected to describe it. The comparison's point is unchanged — the
> mailbox is bounded, owner-enabled, and opaque to the relay.

## Practical lessons

1. **Keep cross-session payloads deliberately narrow.** Claude's “text, never
   transcript or files” rule is a strong UX and security boundary. AgentCall
   should keep any future coordination notification separate from conversation
   continuation and file transfer.
2. **Make provenance visible at the receiver.** Claude distinguishes peer
   messages from user input and does not treat them as permission. This
   reinforces AgentCall's existing trust-boundary direction: provenance must
   survive delivery, not merely authenticate the transport.
3. **Separate local coordination from durable delivery.** agmsg demonstrates
   that a shared SQLite floor is a compelling zero-setup solution for one
   machine. It is an optional local workflow / adapter opportunity, not a
   reason to blur AgentCall's online routing, retention, and authorization
   guarantees.
4. **Support capability-dependent delivery explicitly.** agmsg's
   monitor/turn/off modes handle the fact that agent runtimes cannot all accept
   asynchronous input. Any AgentCall adapter should declare its delivery
   guarantees and failure behavior rather than promising uniform real-time
   arrival.
5. **Treat inbound coordination text as a new source class.** Claude's hold /
   refuse controls, remote-send approval, queue caps, and loop throttling are
   concrete safeguards worth retaining as requirements if AgentCall ever adds
   a notification or mailbox surface.

## What not to infer

- The X post's “summary” language does not mean Claude Code moves or shares a
  session summary automatically: the documented protocol sends a plain-text
  message Claude composes. Full conversation continuity remains resume/fork.
- Claude's remote capability is not general inter-machine messaging; it is
  reply-only through the same account's Remote Control connection.
- agmsg's local shared database is not evidence that an organization-scale,
  security-sensitive durable mailbox can safely use the same trust model.

## Primary sources

- Anthropic, [Message your other Claude Code sessions](https://code.claude.com/docs/en/cross-session-messaging) (current documentation, consulted 2026-08-09).
- Anthropic, [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) (current documentation, consulted 2026-08-09).
- fujibee, [agmsg README](https://github.com/fujibee/agmsg#readme) (source repository, consulted 2026-08-09).
- AgentCall, [How it works](../site/overview/how-it-works.mdx) and [limitations](../site/overview/limitations.mdx) (current repository behavior).
