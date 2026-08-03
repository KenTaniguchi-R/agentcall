# E2EE live wire cutover

> **Historical implementation record — not current documentation.** This file
> records the issue #216 cutover completed on 2026-08-03 and is not revised as
> behavior changes. Read `README.md`, `CHANGELOG.md`, and `docs/security/` for
> current behavior and security boundaries.

**Status:** implemented 2026-08-03  
**Issue:** #216  
**Scope:** native live-call request and outcome transport

## Decision

AgentCall has one live wire format. Request content (`message`, `task`, and
`context_id`) and peer outcome content (reply text, context/task, failure code,
detail, and offered tasks) exist only inside signed HPKE envelopes. The old
plaintext request, incoming-call, reply, result, and failure schemas are
deleted rather than supported as a downgrade path.

The relay may read only the metadata required to authenticate, route, rate
limit, audit lifecycle, cancel, and expire a call: tenant and endpoint handles,
relay-attested roster intersection, call/correlation IDs, trace context,
lifecycle state, timing, source-network metadata where available, envelope
headers, and ciphertext size. Envelope routing fields are authenticated as
HPKE associated data and repeated inside the signed payload.

## Admission order

The caller fetches the callee key bundle, verifies its signature and local
identity pin, rejects rollback or expiry, then seals the request before opening
the WebSocket. The listener fetches and pins the caller identity, opens and
verifies the request, checks route and validity, and atomically reserves the
authenticated `(sender fingerprint, request_id)` before policy lookup, queue
admission, or process spawn. Invalid cryptographic input receives only a
generic protocol rejection.

Every peer success or failure is signed and encrypted to the request sender.
The response binds the original request ID and request transcript hash. Relay
operational failures use a separate restricted frame and the CLI labels them
as unauthenticated relay status; peer failures are shown as authenticated peer
responses.

## Bounds and recovery

Ciphertext, outer wire frames, decrypted messages, replies, details, and
offered-task lists are bounded at their respective schema boundaries. The
relay does not compress or fall back to plaintext. Oversized caller frames are
rejected and still consume rate-limit budget; oversized listener outcomes are
dropped.

The short-lived A2A task store retains lifecycle metadata and an opaque outcome
envelope only until the original call deadline. `GetTask` and `ListTasks`
therefore expose status without artifacts. `contextId` filtering is rejected
because the relay cannot observe encrypted context IDs. A disconnected native
caller cannot decrypt an outcome through A2A in this stage; durable encrypted
mailbox semantics remain out of scope.

## Residual boundary

End-to-end content encryption does not hide handles, tenant and roster
relationships, call timing/state, network metadata, or payload sizes. The two
endpoint machines still hold plaintext prompts, replies, agent process state,
and local audit logs. First contact remains trust-on-first-use unless the user
compares the displayed identity fingerprint out of band.
