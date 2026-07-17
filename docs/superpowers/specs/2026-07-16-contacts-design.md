# agentcall contacts — local address book design

Date: 2026-07-16
Status: approved

## Problem

Calling another agent requires a full `handle@host` address, retyped from memory on
every call. There is nowhere to store addresses, and — since calls are mostly placed
by agents on the user's behalf — nowhere to record *who* a contact is. The agent
doesn't know the relationship between the user and `ktnk-dev2@agentcall.benree.tech`,
so it can't compose an appropriate message without the user spelling it out each time.
Handles are not always human-readable, which gets worse as the user count grows.

## Solution overview

A local address book, `~/.agentcall/contacts.json`, managed by an `agentcall contacts`
command group. Each entry maps a human-friendly name to an address plus a free-text
note capturing the relationship and what the contact is good for. `call`, `status`,
and `card` resolve names to addresses, so the raw handle is typed exactly once — at
`contacts add` time. The CLAUDE.md/AGENTS.md snippet is updated so agents know to
consult the address book.

No relay changes. No protocol changes. Local-only by design: relationship notes are
personal data and never leave the machine. The schema leaves room for relay sync
later if ever wanted.

## Storage

New `contactsFile` entry in `Paths` (`packages/cli/src/paths.ts`), pointing at
`~/.agentcall/contacts.json`. Written with mode 0600, directory 0700, matching
`saveConfig`. A missing file means an empty address book (not an error). A corrupt
file is a hard error naming the path.

```json
{
  "contacts": [
    {
      "name": "ken",
      "address": "ken@agentcall.benree.tech",
      "note": "coworker, owns the relay infra — ask about DO/D1 issues"
    }
  ]
}
```

Field rules:

- `name` — unique key, matched case-insensitively, stored as given. Must match
  `/^[a-z0-9][a-z0-9._-]*$/i` and therefore can never contain `@`, so a name is
  never parseable as an address and resolution is unambiguous.
- `address` — must pass the existing `parseAddress` from `@benree/agentcall-shared`.
- `note` — optional free text. Carries both relationship ("coworker") and purpose
  ("ask about relay/DO issues"). One field, not structured: it's filled by a human
  and read by an agent as prose.

The top level is an object with a `contacts` array (not a bare array) so future
fields (e.g. a sync cursor) can be added without a format break.

## CLI surface

New module `packages/cli/src/contacts.ts` (load/save/validate/resolve), wired into
`index.ts` as a `contacts` command group:

- `agentcall contacts add <name> <address> [--note "..."]` — upsert. Adding an
  existing name (case-insensitive) updates it and prints "Updated ken." instead of
  "Added ken."; there is no separate edit command. Invalid name or address is a
  clear error before anything is written.
- `agentcall contacts list [--json]` — human-readable table of name, address, note,
  sorted by name. `--json` prints the raw contacts array for agent consumption.
  An empty book prints a hint: how to add, and that `call` accepts names.
- `agentcall contacts remove <name>` — deletes; unknown name is an error naming
  `agentcall contacts list`.

## Name resolution in call / status / card

The `<address>` argument of `call`, `status`, and `card` accepts either form:

1. Contains `@` → parsed with `parseAddress` exactly as today. Unchanged behavior.
2. No `@` → looked up in contacts by case-insensitive name. Found → resolved to the
   stored address. Not found → error: `No contact named "ken" — run \`agentcall
   contacts list\`, or use a full handle@host address.` and exit 1.

Resolution lives in one shared helper in `contacts.ts` (e.g.
`resolveAddress(paths, arg)`) so the three commands can't drift. `card push` and the
policy verbs (`allow`, `block`, …) take bare handles, not addresses, and are
untouched. In `card`, the literal targets (`push`, and the omitted-target
self-review form) are checked before contact resolution, so a contact named
"push" can never shadow `agentcall card push`.

## Agent integration (snippet update)

`SNIPPET` in `packages/cli/src/snippet.ts` gains the contacts workflow:

- `agentcall contacts list` shows saved contacts — who they are and what they're
  good for. Consult it when the user names a person without an address.
- Calls accept a contact name: `agentcall call ken "<message>"`.
- Use the contact's note to compose an appropriate message (the note says who the
  person is to the user and what to ask them about).
- After the user gives an address for someone new, offer to save it:
  `agentcall contacts add <name> <address> --note "<who they are>"`.

**Targeted fix while there:** `appendSnippet` currently skips whenever the
`<!-- agentcall -->` marker exists, so existing installs would never receive an
updated snippet. Change it to replace the marker block when its content differs from
the current `SNIPPET` (returning a third result, `"updated"`). Both markers
(`<!-- agentcall -->` … `<!-- /agentcall -->`) already delimit the block, so
replacement is a bounded splice, not a heuristic.

## Error handling

- Invalid name at `add`: rejected with the allowed pattern shown.
- Invalid address at `add`: rejected via `parseAddress` with the expected
  `handle@host` shape shown.
- Unknown name at `remove` / resolution: error suggesting `contacts list`; exit 1.
- Corrupt `contacts.json`: hard error naming the file path (no silent reset —
  the file is user data).
- Missing `contacts.json`: treated as empty everywhere, including `list`.

## Testing (TDD)

Vitest in `packages/cli/test/contacts.test.ts`, written before implementation,
using a temp `AGENTCALL_HOME` per the existing config/policy test pattern:

- Store: round-trip add/list/remove; upsert on same name and case-variant name;
  missing file → empty; corrupt file → throws with path; file mode 0600.
- Validation: name regex accepts/rejects table; address must pass `parseAddress`.
- Resolution: `@`-containing arg bypasses the book; name hit resolves
  case-insensitively; name miss returns the not-found error; empty book miss
  still errors cleanly.
- Snippet: existing tests extended for the replace-on-outdated behavior —
  absent file → appended; current block → `already_present`; stale block →
  replaced in place, surrounding file content untouched.

`pnpm -r test && pnpm -r typecheck && pnpm -r build` green before done.

## Out of scope

Relay sync, tags/groups, structured relationship fields, auto-saving contacts
after successful calls, importing from a relay directory, per-contact call
history. All deliberately deferred; the object-wrapper schema and the single
`contacts.ts` module keep them addable without migration.
