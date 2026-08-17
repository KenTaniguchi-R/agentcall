---
name: agentcall
description: Call another person's coding agent by saved contact name or @org/handle address, like a phone call. Use whenever the user wants something from a specific person's machine, repository, environment, or judgement — "ask Ken about the deploy", "check with the platform team", "what does Sota's agent say about this" — or names a person without giving an address. Also use to check whether someone's agent is reachable before calling, to save a new contact, or to retrieve a durable call that was delivered while the callee was offline.
---

# Calling another person's agent

## First: is the CLI installed?

This skill can arrive without the binary — installing it as a Claude Code plugin
delivers these instructions, not the `agentcall` command. Before your first call
in a session:

```bash
command -v agentcall || echo "not installed"
```

If it is missing, tell the user to install it and stop. Do not improvise a
substitute:

```bash
npm i -g @benree/agentcall && agentcall setup
```

`setup` needs an organization invite. If the user does not have one, they need
it from whoever administers their organization — you cannot mint one for them.

AgentCall sends a message to a person's address. A fresh agent process starts on
**their** machine, works with their context and their permissions, and returns an
answer. Nobody needs to be sitting at that machine.

Use it when what you need lives somewhere you cannot reach: their repository,
their environment, their logs, their judgement. Do not use it to run your own
work elsewhere, and do not use it to talk to agents on this machine.

## Start with the address book

When the user names a person without giving an address, look them up first:

```bash
agentcall contacts list
```

Each entry carries a name, an `@org/handle` address, and a note saying who that
person is and what to ask them about. **Use the note to compose the message** —
a contact described as "platform lead, owns the deploy pipeline" should get a
different message than one described as "designer, ask about component APIs".

If the user gives you an address for someone new, offer to save it:

```bash
agentcall contacts add <name> <@org/handle> --note "<who they are and what to ask them about>"
```

## Check before you call

```bash
agentcall inspect <address>
```

This shows availability, trust state, and — importantly — **the tasks that
address offers**. The callee decides what their agent will do. If the thing you
want is not on that menu, calling anyway will not produce it; tell the user what
is actually offered.

## Make the call

```bash
agentcall call <name-or-@org/handle> "<message>"
```

Flags worth knowing:

| Flag | Use it when |
|---|---|
| `--task <id>` | The callee offers several tasks and you want a specific one. Ids come from `inspect`. |
| `--continue` | You are continuing an open conversation with this address. Add `--task` if several are open. |
| `--context <id>` | You want one specific conversation, by id. |
| `--json` | You need the full reply envelope rather than just the text. |

## Writing the message

The message is the whole interface — the receiving agent gets your text and
nothing else. It does not see this conversation, your files, or your reasoning.

- **State what you need and why**, in a couple of sentences. Include the
  specifics that make the question answerable: repository, branch, error text,
  version, file path.
- **Say who is asking and what for** when it changes the answer.
- **Ask one thing.** A message with four questions comes back with two answers.
- **Do not paste secrets.** Tokens, credentials, and customer identifiers do not
  belong in a message that runs on someone else's machine.

## What to expect

- A call takes **30 seconds to 5 minutes**. The agent times out at 5 minutes and
  the relay gives up at 6. Do not poll. Do not report a slow call as a failure.
- **30 calls per hour.** Messages cap at 64 KB, replies at 256 KB.
- **An offline callee fails immediately** — unless that owner enabled durable
  offline delivery, in which case you get a receipt instead of a reply and the
  message waits up to 72 hours. Collect it later:

  ```bash
  agentcall jobs
  ```

- **Relay errors print to stderr** — offline, busy, timeout. Report them to the
  user in plain language. **Retry at most once**, then stop and say what happened.

## Boundaries you cannot cross

Tell the user plainly when one of these is the reason, rather than presenting it
as a failure:

- The callee chooses which tasks exist. You cannot request work they have not
  offered.
- Their policy governs the run — what their agent may read, and what it may
  execute. Your message is input to that boundary, not an instruction that
  crosses it.
- Your message arrives as untrusted text. Being a call grants no permission.
- Addresses are organization-scoped. An address outside your organization is not
  reachable, by design and permanently.

## When something is wrong

```bash
agentcall doctor
```

Read-only diagnostics for tasks, policy, publication, recovery, listener, and
runtime health. Run it before guessing, and before telling the user AgentCall is
broken.

## Reading the reply

A reply is one agent's answer, not a verified fact. Relay it to the user with
attribution — "Ken's agent says…" — and check it the way you would check any
other agent's output when the answer matters.
