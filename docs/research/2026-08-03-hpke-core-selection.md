# HPKE library selection for Stage 2

**Date:** 2026-08-03  
**Issue:** #211  
**Decision:** Pin `@hpke/core` `1.9.0` in the CLI package.

## Why this package

The accepted E2EE design requires RFC 9180 base mode with
`DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM`. The upstream package
implements that exact suite using only WebCrypto, declares Node 16+ support,
and documents npm runtimes including Cloudflare Workers. AgentCall's supported
Node floor is newer (20), and the relay does not need the dependency: Stage 2
routes opaque envelope fields while endpoint CLIs seal and open content.

The dependency is exact-pinned rather than ranged because ciphertext
interoperability and key parsing are protocol behavior. Its transitive
`@hpke/common` version and integrity hashes remain locked by `pnpm-lock.yaml`.

Primary sources:

- [`@hpke/core` npm package](https://www.npmjs.com/package/@hpke/core)
- [Upstream hpke-js repository](https://github.com/dajiaji/hpke-js)
- [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html)
- [Official CFRG test vectors](https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/master/test-vectors.json)

## API and key-format findings

- `CipherSuite` composes `DhkemP256HkdfSha256`, `HkdfSha256`, and
  `Aes128Gcm`.
- Single-shot `seal` returns the 65-byte P-256 encapsulated key and AEAD
  ciphertext; `open` accepts that key plus the same `info` and AAD.
- The existing public encryption key is already the raw uncompressed SEC1
  point accepted by `kem.deserializePublicKey`.
- AgentCall stores the private encryption key as PKCS#8. It imports directly as
  a WebCrypto ECDH private key. The import must be extractable because
  `@hpke/core` derives its matching public point during base-mode decapsulation;
  this does not make the on-disk key less protected, and the `CryptoKey` never
  leaves the endpoint operation.
- The library's deterministic `ekm` hook is used only in the RFC known-answer
  test. Production sealing always lets the library generate fresh ephemeral
  key material.

Context7 was queried under `@hpke/core`, `hpke-js`, and `dajiaji hpke-js`, but
did not index the package and returned unrelated libraries. The investigation
therefore used only the upstream repository, installed type declarations/source,
npm metadata, and the CFRG/RFC sources above.

## Boundary

This issue adds primitives and tests only. It does not alter the live
`call_request`, relay forwarding, or listener response path. The #210 cutover
must replace plaintext atomically and fail closed; it must not negotiate or
fall back to the legacy payload.
