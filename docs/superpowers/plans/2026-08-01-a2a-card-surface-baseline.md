# A2A Card Surface — TCK Baseline

Recorded baseline for the four card requirements this plan owns
(`CARD-DISC-001`, `CARD-STRUCT-001`, `CARD-PROTO-001`, `CARD-PROTO-002`),
run against the real A2A Technology Compatibility Kit rather than only our
own tests. This is the artifact the CI gate compares against in Plan 3.

## Command

```bash
./scripts/tck.sh http://localhost:8787
```

Which resolves to:

```bash
git clone https://github.com/a2aproject/a2a-tck.git "$TMPDIR/a2a-tck"
git -C "$TMPDIR/a2a-tck" checkout --quiet 5996b79f9cefa6fc390980e383e358a66fb9e49e
cd "$TMPDIR/a2a-tck" && uv venv --quiet && source .venv/bin/activate && uv pip install --quiet -e .
./run_tck.py --sut-host http://localhost:8787 --transport http_json --level must -- \
  tests/compatibility/agent_card
```

`run_tck.py` hardcodes `tests/compatibility/` as its base pytest path and
appends any trailing args rather than replacing the base, so the actual run
collects the full `tests/compatibility/` tree (core_operations, transports,
etc.), not only `agent_card`. That's expected per the task brief: operations
(`message:send`, `GetTask`, ...) are Plan 2 and not implemented yet, so their
absence is not a failure to fix here. Only the `agent_card` transport results
below are in scope for this task.

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
    -d '{"handle":"tcktest","agent_kind":"claude"}'
  # -> {"token":"...","address":"tcktest@agentcall.benree.tech"}
  curl -s -X PUT http://localhost:8787/v1/card \
    -H 'content-type: application/json' \
    -H 'X-AgentCall-Handle: tcktest' \
    -H "Authorization: Bearer <TOKEN>" \
    -d '{"description":"TCK test agent","agent_kind":"claude","tasks":[{"id":"ask","name":"Ask","description":"Answer a question.","examples":[]}],"default_offer":["ask"],"grants":{}}'
  ```
- The TCK discovers the card via `GET /.well-known/agent-card.json` — the
  RELAY DIRECTORY card (`toDirectoryCard`), which advertises the origin, not
  the per-handle `tcktest` card. All four requirements below are evaluated
  against that directory card.

## Overall run summary

```
OVERALL COMPATIBILITY: 43.5%

Level       Passed  Failed  Skipped  Total
MUST            10      46       58    114
SHOULD           0      11        0     11
MAY              0       4        0      4

BY TRANSPORT:
  agent_card:    6/6 ✓
  grpc:          0/65 (65 skipped) ✓
  jsonrpc:       1/81 (80 skipped) ✓
  http_json:     4/40 (23 skipped) ⚠
```

The `grpc`/`jsonrpc`/most of `http_json` failures and skips are all
operations/task-store requirements (Plan 2 scope) or unrelated MUST
requirements (e.g. `CORE-ERR-002`, `VER-SERVER-002` failing because a
non-card path 301-redirects instead of erroring — not part of this task's
surface). Not investigated further here; owned by Plan 2/3.

## Per-requirement table — `agent_card` transport (from `reports/compatibility.json`)

| Requirement       | Level | Status | Test(s) |
|--------------------|-------|--------|---------|
| `CARD-DISC-001`    | MUST  | PASS   | `test_agent_card.py::TestAgentCardDiscovery::test_agent_card_retrievable` |
| `CARD-STRUCT-001`  | MUST  | PASS   | `test_agent_card.py::TestAgentCardStructure::test_agent_card_validates_against_schema`, `::test_required_fields_present` |
| `CARD-PROTO-001`   | MUST  | PASS   | `test_agent_card.py::TestAgentCardProtocol::test_supported_interfaces_non_empty` |
| `CARD-PROTO-002`   | MUST  | PASS   | `test_agent_card.py::TestAgentCardProtocol::test_each_interface_validates_against_schema` |
| `BIND-FIELD-001`   | MUST  | PASS   | `test_agent_card.py::TestBindingFieldDeclaration::test_all_protocols_declared` (incidental pass, not one of this plan's four, noted for completeness) |

All four requirements this plan is responsible for — `CARD-DISC-001`,
`CARD-STRUCT-001`, `CARD-PROTO-001`, `CARD-PROTO-002` — are **PASS**, first
run, no code changes required. `agent_card` transport: 6/6 tests passed.

## Notes / non-blocking observations

- `supportedInterfaces[].url` in both the directory card and per-handle cards
  resolves to `http://agentcall.benree.tech` instead of `http://localhost:8787`
  when running under `wrangler dev` locally — an artifact of the `routes`
  entry in `apps/relay/wrangler.jsonc` rewriting `c.req.url`'s origin to the
  configured custom domain. Harmless for the card suite (still a valid
  absolute URI, which is all `CARD-PROTO-002`'s schema check requires), but
  worth knowing if a future operations suite (Plan 2) tries to actually call
  through that URL against a local `wrangler dev` instance.
- No changes were needed to `packages/shared/src/a2a/card.ts` or
  `apps/relay/src/a2a.ts` to satisfy this baseline.
