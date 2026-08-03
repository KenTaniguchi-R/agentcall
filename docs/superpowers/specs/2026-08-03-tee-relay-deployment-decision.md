# Confidential-computing relay is trigger-gated, not an active target

> **Historical document — not current documentation.** This is a dated
> decision record that describes the repository state on 2026-08-03 and is
> deliberately *not* updated when behavior changes.

**Date:** 2026-08-03

**Status:** Decided

**Issue:** [#191](https://github.com/KenTaniguchi-R/agentcall/issues/191)

## Decision

Do not build an AWS Nitro Enclaves relay, a generic confidential-computing
abstraction, or a second deployment target now.

Keep the current sequence:

1. the hosted relay stays on Cloudflare Worker, Durable Objects, and D1;
2. the experimental customer-operated profile stays on the same Cloudflare
   primitives in the customer's account; and
3. end-to-end content encryption remains the content-confidentiality path.

A TEE relay remains a legitimate option if a design customer requires hosted
application-metadata confidentiality and accepts AWS processing and traffic-shape
exposure. That trigger starts a new evaluation; it does not reactivate this
record as an implementation plan.

## Why it is technically real

Nitro Enclaves provides a useful boundary, not marketing-only isolation:

- the enclave has no persistent storage, interactive access, or external
  network; vsock to its EC2 parent is its only communication channel;
- the Nitro Hypervisor produces a CBOR, COSE-signed attestation document with
  PCR measurements and optional `nonce`, `public_key`, and `user_data` fields;
- a client can validate the AWS Nitro PKI chain and signature, bind the nonce
  to its challenge, and bind an encrypted session to the attested public key;
- KMS `RecipientAttestation` policies can constrain cryptographic operations by
  `ImageSha384` or PCR values, and KMS returns plaintext re-encrypted to the
  public key in the attestation document; and
- KMS can return decrypted material encrypted to the enclave's attested public
  key, so the parent can proxy that KMS traffic without receiving the material
  in plaintext. Application traffic needs its own end-to-end session bound to
  the attested key to make the same claim.

That is enough to make an enclave-hosted routing table, roster, presence state,
and encrypted audit ledger technically plausible. The EC2 parent would still
observe IP addresses, connections, timing, and ciphertext sizes.

## What attestation does and does not prove

The original issue overstates one point: PCR0 does not “mean nothing” without
reproducible builds. It proves that the running enclave matches one exact enclave
image measurement. What it does **not** prove by itself is that the measurement
corresponds to the published source.

A public source-to-measurement claim needs reproducible builds or an equivalent
transparent build and provenance system. AWS documents unique EIF measurements;
it does not promise that rebuilding an arbitrary Docker input in a different
environment produces the same PCR0.

AWS also supports PCR8, which measures the EIF signing certificate and permits
multiple signed images to share a KMS authorization policy. AWS recommends PCR3
plus PCR8 for flexible KMS policies. That makes upgrades operationally easier,
but changes the trust claim: control of the signing key can authorize a new
image, including a malicious one. Exact-PCR authorization and signer-lineage
authorization are different products and must not be described as equivalent.

## Why it is not the next deployment target

The option is disproportionate to the evidence and the current architecture:

- **The transport decision is settled.** Issue #20 chose Cloudflare DO+D1, and
  #12 shipped the customer-owned Cloudflare artifact. A Nitro target is a relay
  rewrite and an operating-model change, not another Wrangler profile.
- **There is no measured buyer requirement.** No customer has rejected hosted
  operation specifically on application-routing metadata while accepting AWS
  location and network metadata.
- **It creates a second trust distribution system.** Every client needs an AWS
  root, nonce/freshness validation, an accepted measurement or signer feed,
  rollback rules, and a safe update path for that feed.
- **It creates a state and availability system.** The enclave has no disk or
  network. Encrypted state storage, vsock framing, parent failure behavior,
  failover, backup, recovery, and consistency all become AgentCall-owned
  infrastructure.
- **It creates permanent operations.** EC2 parents and enclaves do not inherit
  the current serverless scale-to-zero model. Patching, capacity, regional
  deployment, monitoring, incident response, and on-call ownership remain even
  if the enclave code is small.
- **It is not residency or full metadata privacy.** Data still leaves the
  customer network, AWS remains a processor, and the parent/network can perform
  timing and traffic-shape correlation.

Building a portability seam in anticipation would impose the second target's
constraints on the current relay before its requirements exist. Do not add one.

## Reopen triggers

Open a new decision issue only when at least one of these is evidenced:

- a design customer rejects the hosted relay because the operator can observe
  application-layer routing metadata, but accepts AWS processing and residual
  traffic-shape metadata;
- the customer rejects operating the BYOC Cloudflare profile, making a hosted
  verifiable-confidentiality claim commercially material; or
- a procurement requirement explicitly asks for remotely attested processing
  rather than regional residency or customer-owned infrastructure.

## Required evaluation before implementation

The triggered evaluation must resolve all of these before code is approved:

1. a threat model naming the EC2 parent, AWS control plane, network observers,
   enclave compromise, rollback, side channels, and denial of service;
2. a client verifier for COSE/CBOR, the AWS Nitro certificate chain, certificate
   time validity, nonce/freshness, public-key binding, and accepted policy;
3. a source-to-measurement story: reproducible EIFs or transparent signed build
   provenance, with independently verifiable published measurements;
4. upgrade authorization, signer rotation/revocation, rollback prevention, and
   an emergency measurement-feed recovery path;
5. an explicit KMS choice between exact image/PCR policies and PCR3+PCR8 signer
   lineage, including the authority allowed to change the policy;
6. encrypted-state schema, concurrency, failover, backup, restore, erasure,
   audit completeness, and disaster recovery;
7. multi-region SLOs, capacity, cost, monitoring, incident response, and named
   on-call ownership; and
8. a customer-facing claim that separates application metadata, content,
   traffic-shape metadata, cloud-operator trust, and data residency.

Until that evaluation passes, AgentCall must not advertise “confidential
computing,” “metadata-private hosted relay,” or an enclave deployment roadmap.

## References

- [AWS Nitro Enclaves overview](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html)
- [AWS Nitro attestation root verification](https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html)
- [AWS Nitro cryptographic attestation and PCRs](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html)
- [AWS Nitro Enclaves and KMS](https://docs.aws.amazon.com/enclaves/latest/user/kms.html)
- [AWS Nitro Enclaves concepts](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-concepts.html)
- [Customer-owned relay runbook](../../self-hosting.md)
- [End-to-end encryption design](./2026-08-02-end-to-end-encryption-design.md)
