# Constrained-output tasks: declassification by capacity

> **Historical document — not current documentation.** This is a dated design
> record that describes the repository state on 2026-08-06 and is deliberately
> *not* updated when behavior changes.

**Date:** 2026-08-06

**Status:** Proposed

**Verified against:** `main` @ `db7317c`

**Parent:** [#372](https://github.com/KenTaniguchi-R/agentcall/issues/372) — the
last open item on its checklist.

**Prior design:** [Sensitivity and clearance](./2026-08-06-sensitivity-clearance-model-design.md)

**Research:** [Information-flow control for agent answers](../../research/2026-08-06-information-flow-control-for-agent-answers.md)

## The idea, restated

From the FIDES paper's type lattice:

> `bool ⊑ enum["a", "b", "c"] ⊑ string` … Low capacity outputs are less useful
> to deliver prompt injection payloads or exfiltrate information.

A value with bounded capacity cannot carry a payload. So a task that emits only
such a value may derive it from content the caller could not otherwise receive.
"Is the build green?" is answerable to anyone; the build log is not.

The parent design gave this example:

```yaml
---
description: Report the status of a Jira ticket
sources: [jira]
output:
  status: enum[todo, in-progress, blocked, done]
  updated: date
---
```

## What the parent design got wrong about the code

The parent design describes enforcement at the **reply**:

> One check, at one place: the running context's sensitivity must be ≤ the
> caller's clearance. Reading a `secret` source raises context to `secret`, and
> the reply is refused.

**That is not what shipped.** `permits` appears in exactly two places
(`guard.ts:98`, `guard.ts:160`), both inside the PreToolUse guard, and both on
the **read**. A path above the caller's clearance is denied at the tool call.
There is no running-context accumulator and no check at the reply — `listener.ts:425`
emits `out.text` with no sensitivity involvement at all.

The shipped design is *better* than the documented one: it prevents rather than
refuses, so a caller never burns a call to be told no, and the owner's content
never enters a context that then has to be thrown away. But it has a consequence
the parent design did not follow through:

**A `public` caller's agent cannot read the `internal` Jira source in the first
place.** The guard denies it. There is no high-sensitivity content in the
context, so there is nothing for a constrained output to declassify *from*. The
worked example in the parent design cannot run against this code.

This is the fact that shapes everything below. Constrained output is not a
filter bolted onto the existing path; it requires a task to read **above** the
caller's clearance, which is precisely what the guard exists to prevent.

## The design

### A task declares an elevated read clearance and a bounded output

```yaml
---
description: Report the status of a Jira ticket
reads: internal          # what the task may READ, above the caller's clearance
output:
  status: enum[todo, in-progress, blocked, done]
  updated: date
---
```

Both keys are required together. `reads:` without `output:` is a privilege
escalation with no bound and must fail to load; `output:` without `reads:` is
harmless but pointless, and is also rejected so the pair always means one thing.

At spawn, the guard's clearance becomes `max(caller clearance, task.reads)`.
Everything else about the guard is unchanged — the floor still applies, `secret`
is still never readable, and `reads: secret` is rejected by the same
`GrantableClearance` enum that refuses a `secret` grant anywhere else.

### The output is validated, not requested

The model is asked for JSON matching the schema. **That request is not the
mechanism** — a model, injected or merely wrong, can emit anything. The
mechanism is that the listener parses the reply against the declared schema and
**refuses to send anything that does not validate**.

On a validation failure the caller gets `agent_error` with the existing fixed
reason. Not the raw text, not a diagnostic, not a retry with the error fed back
— a retry loop is a side channel with as many bits as it has iterations.

What is sent is the **re-serialized validated value**, never the model's
original bytes. This is the load-bearing detail. A model that emits

```json
{"status": "done", "updated": "2026-08-06"}  // ...and the API key is sk-abc123
```

must not have that trailing text reach the caller. Re-serializing from the
parsed value discards everything not in the schema by construction, rather than
relying on the parse to have rejected it.

### Field types and their capacity

| Type | Capacity | Notes |
|---|---:|---|
| `bool` | 1 bit | |
| `enum[a, b, c]` | log₂(n) bits | n ≤ 32 |
| `int[lo..hi]` | log₂(hi−lo+1) bits | bounded range required |
| `date` | ~15 bits | a day within ±50 years |
| `string` | **unbounded** | **never permitted in an `output:` block** |

`string` is excluded structurally, the same way `secret` is excluded from
`GrantableClearance`. A free-text field would make the whole mechanism a no-op,
and "it's only a short string" is not a bound — `maxLength: 20` is 160 bits.

**A per-task ceiling of 32 bits total**, summed across fields, enforced at load.
The number is a judgement call and is argued below rather than asserted.

## The honest limit: this is a channel, and it is not small

An enum is not zero-capacity, and the parent design's language ("cannot carry a
payload") is too strong. It carries less. How much less has to be stated, because
this is the part that a reviewer should push on.

The worked example is **17 bits per call** — 2 for the four-value status, 15 for
the date. Note that the date is over seven times the status field, which is
worth seeing plainly: `updated: date` is by far the larger channel in an example
whose point was the enum.

Capacity is per call, and calls repeat. With `RATE_LIMIT_PER_HOUR = 30`:

| | per call | per hour | per 8h day |
|---|---:|---:|---:|
| `bool` | 1 bit | 30 bits | 240 bits |
| the worked example | 17.2 bits | 515 bits | 4.0 Kb |
| the 32-bit ceiling | 32 bits | 960 bits | 7.5 Kb |

**7.5 Kb/day is an exfiltration channel.** An AES-256 key is 256 bits: **eight
calls at the ceiling, sixteen minutes** at the current rate limit. Anyone
claiming this design "cannot leak" is wrong, and the number is small enough that
the claim would be tempting to make.

What is actually true, and what the design rests on:

1. **It requires a compromised or adversarial answering agent**, sustained over
   hundreds of calls, against one caller who is collecting the bits. That is a
   different and much higher bar than a single injected Jira ticket, which is
   the threat the parent design is built around. A one-shot injection gets 32
   bits — a fifth of a UUID.
2. **It is auditable.** Every call is already an audit line (`calls.log`). A
   caller making 200 constrained-output calls is visible in a way that one
   free-text answer containing a key is not.
3. **The alternative is not "no channel", it is "no feature."** Without this,
   the honest answer to "is the build green?" from a public caller is a refusal,
   and the product is the useless-but-secure thing #372 was opened to fix.

The 32-bit ceiling is chosen to keep a single call's yield below a useful secret
while leaving room for a genuinely useful answer (a status, a count, a date, a
flag). It is not derived from anything; it is a place to start that can be
lowered once real tasks exist.

**Rate limiting is the real control, not the ceiling.** A follow-up should
consider a separate, much tighter per-caller budget on constrained-output calls
specifically — they are the only calls that read above clearance, and 30/hour is
a limit designed for free-text Q&A.

## What this does not do

**It does not make the answer correct.** An injected Jira ticket can still make
the model choose `done` when the truth is `blocked`. Capacity bounds what
*leaves*, not whether it is true. The parent design already accepts that a wrong
answer to a coworker is not a security incident; that acceptance is load-bearing
here and should be re-examined if a constrained output is ever wired to
something that acts on it.

**It does not compose across turns.** A constrained-output task must be
`threadable: false`, enforced at load. Threading would let an attacker plant a
premise on turn 1 and cash it on turn 5, and — more directly — `MAX_CONTEXT_TURNS`
is 10, so a threaded conversation multiplies per-call capacity by ten while
looking like one call in the audit log.

**It does not extend to `secret`.** `reads: secret` is rejected. Secret means
never leaves, and a 32-bit derivative of a secret is still a derivative of a
secret. The lattice has an escape hatch at one level only.

## Implementation surface

Small, and deliberately concentrated at two points.

**`packages/shared`** — nothing. This is entirely local enforcement; the reply
is already a string on the wire, and a validated JSON value serializes into it.
No protocol change, no relay change.

| File | Change |
|---|---|
| `tasks.ts` | `reads` + `output` in `SkillFrontmatter`; the paired-keys rule; the capacity ceiling; `threadable: false` enforcement |
| `output-schema.ts` *(new)* | the field-type grammar, capacity accounting, parse-and-revalidate |
| `runner.ts` | spawn clearance becomes `max(caller, task.reads)` |
| `listener.ts` | validate before `trySendOutcome`; send the re-serialized value |
| `lint.ts` / `policy-report.ts` | show which tasks read above clearance, and their capacity in bits |
| `card.ts` | **decision needed** — see below |

### Open question: does the card advertise it?

A constrained-output task is the one kind of task where a caller genuinely
benefits from knowing the shape of the answer before calling. But publishing
`output:` also publishes the exact capacity available to an attacker, and #383
already records that clearance has no equivalent of the old menu's
information-hiding.

Recommendation: publish the field *names* and types but not the enum *values*.
`status: enum` tells a caller what they will get; `enum[todo, blocked, …]` tells
an attacker the alphabet. Weak reasoning — the model will emit those values
anyway within a few calls — so this is flagged as a decision rather than
settled.

## Risks

1. **The capacity ceiling is a guess.** 32 bits is defensible and undefended by
   evidence. The first three real tasks should be measured against it, and it
   should be lowered if they fit comfortably under.
2. **The elevated-read path is a new privilege, and it is granted by a file the
   owner edits.** A task's `reads: internal` is exactly as trustworthy as the
   owner's review of that SKILL.md. This is the same trust model as the
   sensitivity map itself, but it is a *second* place to get it wrong, and
   `lint` should say loudly which tasks hold it.
3. **Validation is the whole mechanism, so a validation bug is a total
   bypass.** It deserves adversarial tests specifically: trailing content after
   valid JSON, a schema-shaped prefix, unicode confusables in enum values,
   numeric coercion, duplicate keys, deeply nested payloads under a valid
   top-level shape.
4. **This is the first feature that lets content cross a clearance boundary at
   all.** Everything else in #372 moves in the restrictive direction. That
   asymmetry is worth a second reviewer.

## Recommendation

Build it, with the ceiling at 32 bits, `string` structurally excluded,
`threadable: false` enforced, and a follow-up issue opened for a per-caller rate
budget specific to constrained-output calls before this is enabled on any
public-facing line.

Do **not** ship it in the same release as the rest of #372. The rest of that
work removes capability; this adds one, and it should land where it can be
reviewed on its own.
