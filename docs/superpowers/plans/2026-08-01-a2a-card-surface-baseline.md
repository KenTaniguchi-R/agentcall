# A2A Card Surface — TCK Baseline

> **Amended 2026-08-01 (fix wave on `feat/a2a-card-surface`).** The original
> version of this doc recorded MUST-level results without stating which of
> the two cards this relay serves (`toDirectoryCard` vs `toAgentCard`) was
> actually evaluated, and claimed all 11 SHOULD failures were out of scope
> when two of them (`CARD-CACHE-001`, `CARD-CACHE-002`) are this plan's own
> card surface. Both are corrected below with a fresh, post-fix run. This
> amendment also reflects the FIX 1/2/4/5 changes to `card.ts` (extensions
> moved under `capabilities.extensions`, top-level `protocolVersion` removed,
> `extendedAgentCard: false`, no `tenant` on the per-handle interface) — the
> numbers below are from re-running the TCK against the corrected card, not
> the pre-fix one.

Recorded baseline for the four card requirements this plan owns
(`CARD-DISC-001`, `CARD-STRUCT-001`, `CARD-PROTO-001`, `CARD-PROTO-002`),
run against the real A2A Technology Compatibility Kit rather than only our
own tests. This is the artifact the CI gate compares against in Plan 3.

## Command

```bash
./scripts/tck.sh http://localhost:8787
```

Which resolves to (post-FIX-6; see below for why this changed from the
original `run_tck.py`-wrapping form):

```bash
git clone https://github.com/a2aproject/a2a-tck.git "$TMPDIR/a2a-tck"
git -C "$TMPDIR/a2a-tck" checkout --quiet 5996b79f9cefa6fc390980e383e358a66fb9e49e
cd "$TMPDIR/a2a-tck" && uv venv --quiet && source .venv/bin/activate && uv pip install --quiet -e .
python3 -m pytest tests/compatibility/agent_card \
  --sut-host=http://localhost:8787 --transport=http_json -m must --tb=short -q \
  --compatibility-report=reports/compatibility \
  --html=reports/tck_report.html --self-contained-html \
  --junitxml=reports/junitreport.xml
```

`run_tck.py` hardcodes `tests/compatibility/` as its base pytest path and
**appends** any trailing args rather than replacing the base, so passing
`-- tests/compatibility/agent_card` did not narrow the run — the full tree
(core_operations, transports, etc., which are Plan 2 and unimplemented) was
still collected and failed, and `set -euo pipefail` made every invocation of
the wrapper script exit 1 regardless of the card suite's actual health. The
script now invokes `pytest` directly on `tests/compatibility/agent_card`,
mirroring the flags `run_tck.py` would otherwise have built, so the gate
depends only on the card suite. Verified live: the script exits `0` when the
card suite is green (see "Overall run summary" below) even though the rest
of the TCK tree still fails wholesale for unimplemented operations.

## TCK ref

`5996b79f9cefa6fc390980e383e358a66fb9e49e` (verified via `git -C $TMPDIR/a2a-tck rev-parse HEAD`
after checkout — matches the pin).

## SUT setup

- `cd apps/relay && pnpm dev` (wrangler dev, `http://localhost:8787`)
- Local D1 migrations applied: `npx wrangler d1 migrations apply agentcall --local`
  (needed once; the fresh local D1 file has no `cards` table until migrations
  run, which surfaced as a 500 on `GET /v1/a2a/:handle/agent-card.json` before
  they were applied)
- Handle registered and card published:
  ```bash
  curl -s -X POST http://localhost:8787/v1/register \
    -H 'content-type: application/json' \
    -d '{"handle":"tcktest2","agent_kind":"claude"}'
  # -> {"token":"...","address":"tcktest2@agentcall.benree.tech"}
  curl -s -X PUT http://localhost:8787/v1/card \
    -H 'content-type: application/json' \
    -H 'X-AgentCall-Handle: tcktest2' \
    -H "Authorization: Bearer <TOKEN>" \
    -d '{"description":"TCK test agent","agent_kind":"claude","tasks":[{"id":"ask","name":"Ask","description":"Answer a question.","examples":[]}],"default_offer":["ask"],"grants":{}}'
  ```

## Which card, which URL — per requirement

The TCK's `agent_card` fixture (`tests/compatibility/conftest.py::agent_card`)
is hardcoded to fetch `{sut_host.rstrip("/")}/.well-known/agent-card.json` —
it does not accept an arbitrary card path. On this relay, that well-known
path is wired to `toDirectoryCard` (`apps/relay/src/a2a.ts`), i.e. **the
relay directory card**, not any per-handle `toAgentCard` card. So:

| Requirement       | Level  | Card evaluated                | URL requested                                    |
|--------------------|--------|--------------------------------|---------------------------------------------------|
| `CARD-DISC-001`    | MUST   | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `CARD-STRUCT-001`  | MUST   | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `CARD-PROTO-001`   | MUST   | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `CARD-PROTO-002`   | MUST   | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `BIND-FIELD-001`   | MUST   | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `CARD-CACHE-001`   | SHOULD | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `CARD-CACHE-002`   | SHOULD | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |
| `CARD-CACHE-003`   | MAY    | Directory (`toDirectoryCard`)  | `GET http://localhost:8787/.well-known/agent-card.json` |

**The per-handle card (`toAgentCard`, served at
`GET /v1/a2a/:handle/agent-card.json`) was never exercised by the live TCK,
and cannot be with this TCK build**, because the `agent_card` fixture always
appends the fixed suffix `/.well-known/agent-card.json` to `--sut-host` with
no override — there is no flag to point it at a different path. Making the
per-handle card reachable there would require adding a route alias
(`/.well-known/agent-card.json` → the per-handle card, keyed some other way,
e.g. by header or subdomain) purely to satisfy this test tool; that's a
product/routing decision out of scope for this fix wave (not one of FIX 1–7)
and is not done here.

In place of a live TCK run, the per-handle card's structural conformance is
covered by **FIX 3**'s schema test:
`packages/shared/test/a2a-card.test.ts` → `describe("schema conformance …")`.
That test calls `toAgentCard(...)` directly (no network, no relay) and
asserts its top level, `capabilities`, `capabilities.extensions[]`, and
`supportedInterfaces[]` entries contain no keys outside the vendored
`"Agent Card"` / `"Agent Capabilities"` / `"Agent Extension"` /
`"Agent Interface"` definitions from `specification/a2a.json` at the pinned
TCK ref, with `additionalProperties` enforced. It is the permanent regression
guard for exactly the class of bug FIX 1/2 fixed (a field the real schema
rejects going undetected because the only live-fire test hit the directory
card, not the per-handle one). This is the intended, durable substitute for
a per-handle TCK run — not a temporary workaround.

## Overall run summary (post-fix, `--level must`, directory card)

```
OVERALL COMPATIBILITY: 100.0%

Level       Passed  Failed  Skipped  Total
MUST             5     109        0    114
SHOULD           0      11        0     11
MAY              0       4        0      4

BY TRANSPORT:
  agent_card:    6/6 ✓
```

(`scripts/tck.sh http://localhost:8787` exit code: `0`.)

The MUST "109 failed" / SHOULD "11 failed" / MAY "4 failed" figures come from
the compatibility reporter scoring the FULL requirement catalog — including
every operations/task-store requirement this run never collected, because
`-m must` and the `tests/compatibility/agent_card` path restrict what pytest
*runs*, not what the reporter *scores against*. Only the `agent_card`
transport row (6/6) reflects what was actually exercised; those failures are
all Plan 2 scope (core_operations, transports for `message:send`, `GetTask`,
etc., not implemented on this branch) or unrelated non-card MUST requirements
or previously noted (e.g. a non-card path 301-redirecting instead of
erroring). Not investigated further here; owned by Plan 2/3.

## Overall run summary (post-fix, no `--level` filter, directory card)

Re-run without `-m must` to get the real SHOULD/MAY result for this plan's
own card surface (FIX 7):

```
OVERALL COMPATIBILITY: 100.0%

Level       Passed  Failed  Skipped  Total
MUST             5     109        0    114
SHOULD           2       9        0    11
MAY              1       3        0    4

BY TRANSPORT:
  agent_card:    10/10 ✓
```

`CARD-CACHE-001` (Cache-Control present, with `max-age`) and `CARD-CACHE-002`
(ETag present) — both SHOULD-level and both this plan's own card surface, not
Plan 2 — **PASS**. `CARD-CACHE-003` (Last-Modified, MAY-level) also **PASS**.
The prior version of this doc claimed "all 11 SHOULD failures are Plan 2
scope" without having actually run the suite at that level; that claim was
wrong for these three and is corrected here. The remaining SHOULD/MAY
failures in the master count are, as with the MUST count above, unexercised
operations requirements outside `agent_card` — not evaluated by this run.

## Per-requirement table — `agent_card` transport (from `reports/compatibility.json`)

| Requirement       | Level  | Status | Test(s) |
|--------------------|--------|--------|---------|
| `CARD-DISC-001`    | MUST   | PASS   | `test_agent_card.py::TestAgentCardDiscovery::test_agent_card_retrievable` |
| `CARD-STRUCT-001`  | MUST   | PASS   | `test_agent_card.py::TestAgentCardStructure::test_agent_card_validates_against_schema`, `::test_required_fields_present` |
| `CARD-PROTO-001`   | MUST   | PASS   | `test_agent_card.py::TestAgentCardProtocol::test_supported_interfaces_non_empty` |
| `CARD-PROTO-002`   | MUST   | PASS   | `test_agent_card.py::TestAgentCardProtocol::test_each_interface_validates_against_schema` |
| `BIND-FIELD-001`   | MUST   | PASS   | `test_agent_card.py::TestBindingFieldDeclaration::test_all_protocols_declared` (incidental pass, not one of this plan's four, noted for completeness) |
| `CARD-CACHE-001`   | SHOULD | PASS   | `test_agent_card_caching.py::TestAgentCardCacheControl::test_cache_control_present`, `::test_cache_control_has_max_age` |
| `CARD-CACHE-002`   | SHOULD | PASS   | `test_agent_card_caching.py::TestAgentCardETag::test_etag_present` |
| `CARD-CACHE-003`   | MAY    | PASS   | `test_agent_card_caching.py::TestAgentCardLastModified::test_last_modified_present` |

All four requirements this plan is responsible for — `CARD-DISC-001`,
`CARD-STRUCT-001`, `CARD-PROTO-001`, `CARD-PROTO-002` — are **PASS**, against
the **directory card** at `GET http://localhost:8787/.well-known/agent-card.json`,
post-fix. `agent_card` transport: 6/6 tests passed at `--level must`, 10/10
with no level filter.

## Notes / non-blocking observations

- `supportedInterfaces[].url` in both the directory card and per-handle cards
  resolves to `http://agentcall.benree.tech` instead of `http://localhost:8787`
  when running under `wrangler dev` locally — an artifact of the `routes`
  entry in `apps/relay/wrangler.jsonc` rewriting `c.req.url`'s origin to the
  configured custom domain. Harmless for the card suite (still a valid
  absolute URI, which is all `CARD-PROTO-002`'s schema check requires), but
  worth knowing if a future operations suite (Plan 2) tries to actually call
  through that URL against a local `wrangler dev` instance.
- The per-handle card was manually inspected (not TCK-driven) against the
  same running relay: `GET /v1/a2a/tcktest2/agent-card.json` returns
  `capabilities.extensions[0].uri` set to the policy extension, no top-level
  `protocolVersion`, no `tenant` on its `supportedInterfaces[0]`, and
  `capabilities.extendedAgentCard: false` — matching FIX 1/2/4/5 and the
  schema-conformance test in `packages/shared/test/a2a-card.test.ts`.
