# Licensing

This repository is not under a single license. This file is the map.

| Path | License | Why |
| --- | --- | --- |
| `packages/shared/` | MIT | The wire protocol. Anyone must be able to write a client, a relay, or an A2A bridge that speaks it — including a competitor. A protocol nobody may reimplement is not a protocol. |
| `packages/cli/` | [FSL-1.1-ALv2](./LICENSE.md) | The product you install and run. |
| `apps/relay/` | [FSL-1.1-ALv2](./LICENSE.md) | The product we also run as a hosted service. |
| Everything else (docs, scripts, landing) | [FSL-1.1-ALv2](./LICENSE.md) | Default. |

## What the FSL lets you do

The [Functional Source License](https://fsl.software/) grants you every freedom
you would expect from an open source license, minus exactly one. You may:

- run AgentCall inside your company, for any internal purpose, at any scale, forever;
- read, modify, fork, and redistribute it;
- self-host your own relay instead of using `agent-call.app`;
- use it in non-commercial education and research;
- use it while providing professional services to someone else who is also
  complying with these terms.

The one thing you may not do is take this software and sell a hosted service
that substitutes for AgentCall. That is the *Competing Use* clause, and it is
the whole reason this repository can be public at all: the hosted relay is what
funds the work.

**This is not open source by the OSI definition, and we do not claim it is.**
It is [Fair Source](https://fair.io/). We would rather be accurate than
flattering.

## It becomes Apache-2.0 on a timer

Every version converts to Apache License 2.0 on the second anniversary of the
date we made it available. This is irrevocable and applies per version, so the
clock is already running on everything published today. To use the newest
version that has converted:

```bash
git checkout "$(git rev-list -n 1 --before='2 years ago' main)"
```

If `LICENSE.md` at that commit is the FSL, that version is yours under Apache-2.0.

## Versions released before this change

`@benree/agentcall` and `@benree/agentcall-shared` at **v0.4.0 and earlier**
were published to npm under the MIT license. That grant is irrevocable and
still applies to those versions. Relicensing is not retroactive and we are not
pretending otherwise — if MIT terms matter to you, those releases remain
available on npm under MIT.

## Contributions

Inbound equals outbound: your contribution is licensed to us under the same
license as the file you changed. **There is no CLA.** You keep your copyright,
we do not ask you to sign it over, and we therefore cannot relicense your work
into something proprietary later. We ask only for a
[DCO](https://developercertificate.org/) sign-off — see
[CONTRIBUTING.md](./CONTRIBUTING.md#developer-certificate-of-origin).

## Trademarks

The FSL grants no trademark rights. "AgentCall" and the `agent-call.app`
address space identify this project and the service we operate. You may fork
the code; please do not ship the fork under our name, and do not present a
modified relay as if it were the hosted service. Use of the name to refer to
this project — in documentation, comparisons, or compatibility claims — is
fine and needs no permission.

## What is not in this repository

Production deployment configuration, secrets, billing, quota enforcement, and
customer data for the hosted service at `agent-call.app` live in a separate
private repository. It consumes this one; it does not fork it. No product
feature is held back there. See
[docs/site/overview](./docs/site/overview) for the hosted-versus-self-hosted
comparison.
