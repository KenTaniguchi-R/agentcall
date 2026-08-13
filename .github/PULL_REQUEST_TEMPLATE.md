<!--
Security fix? Do not open a PR. Use the private advisory flow in SECURITY.md —
a public PR is a public disclosure, and the diff usually explains the attack
better than the report would have.
-->

## What this changes

<!-- And why. If it closes an issue, "Closes #n". -->

## How it was verified

<!--
`pnpm verify` at the repo root is the gate and the only definition of done. It
runs lint, build, docs:check, typecheck, test, the wrangler bundle, and every
invariant. Paste the result, or say which part you could not run and why.
-->

- [ ] `pnpm verify` passes
- [ ] The failing test was written before the implementation (see CLAUDE.md § TDD)
- [ ] Protocol changes start in `packages/shared/src/protocol.ts`, not in a local copy
- [ ] `README.md` still describes what the code does — including where it now claims *less*

## Sign-off

By submitting this pull request I certify the
[Developer Certificate of Origin](https://developercertificate.org/): I wrote
this, or I have the right to submit it under the license of the files I changed.
Add `Signed-off-by:` to your commits with `git commit -s`.

<!--
Licensing, so there are no surprises: packages/shared is MIT; everything else is
FSL-1.1-ALv2, which converts to Apache-2.0 two years after each release. Inbound
equals outbound and there is no CLA — you keep your copyright and we cannot
relicense your work into something proprietary. See LICENSING.md.
-->
