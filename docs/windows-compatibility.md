# Native Windows compatibility harness

Windows is not a supported AgentCall callee platform yet. GitHub Actions runs
the `windows-compat` job on a native `windows-2025` VM to keep that boundary
observable while [#251](https://github.com/KenTaniguchi-R/agentcall/issues/251)
implements it. A passing harness means the platform-neutral code and packed
CLI startup surface work; it does not mean setup, listening, or secret storage
are safe on Windows.

## Automated coverage

The job can be started with GitHub's **Run workflow** button and also runs for
pull requests and pushes to `main`.

- Node 20, 22, and 24 each install the Linux-built shared and CLI tarballs into
  a clean Windows prefix whose path contains spaces, then run the npm-generated
  `agentcall.cmd` shim with `--version` and `--help`.
- The normal npm install is expected to fail with `EBADPLATFORM`. The job uses
  `--force` only after proving that public-install boundary remains intact.
- Node 24 additionally runs the monorepo build and typecheck, every shared test,
  and the CLI `test:windows` allowlist. That allowlist contains only
  suites that do not construct unsupported machine paths, rely on POSIX mode
  bits, launch Unix processes, or test Unix supervisors.
- `setup`, `doctor`, and `listen` are executed from the packed CLI and must all
  stop at the same documented `Managed policy is not supported on win32`
  boundary. A different error is an undocumented red test.

## Blocker inventory

All functional work below belongs to #251. The harness must keep a stable,
explicit expectation until that issue replaces it with positive coverage.

| Area | Current evidence and required #251 replacement |
| --- | --- |
| npm `os` metadata | `packages/cli/package.json` permits `darwin` and `linux`; native installation must fail with `EBADPLATFORM`. Remove the restriction only when the functional gate is green. |
| Absolute managed-policy paths | `managedPolicyPath("win32")` rejects the platform. #251 must use a machine-owned absolute `%ProgramData%` location that `AGENTCALL_HOME` cannot relocate. |
| Unix-only fixture shebangs and executable bits | The full CLI suite creates executable shell fixtures and assumes shebang launch. `test:windows` names the portable allowlist; #251 must add `.cmd`/native fixtures and then retire the allowlist. |
| POSIX modes versus Windows ACLs | Stores use `chmod(0600/0700)`, which is not a Windows secrecy boundary. #251 must apply and diagnose owner-only Windows ACLs for credentials and local state. |
| launchd/systemd listener supervision | The service adapter has only launchd and systemd. #251 must add an idempotent per-user Windows supervisor, including install, status, restart, and uninstall. |
| Detached process groups and process-tree teardown | `runAgent` uses negative PIDs plus `SIGTERM`/`SIGKILL`. #251 must prove Windows cancellation, timeout, overflow, and shutdown terminate the entire child tree. |
| `.cmd` / `.exe` discovery | The packed smoke test proves npm's `agentcall.cmd` shim. #251 must cover agent discovery through `PATH`/`PATHEXT`, executable suffixes, and paths with spaces. |
| Shell and PowerShell quoting | The harness uses clean prefix and home paths containing spaces. #251 must cover user-controlled Windows paths, PowerShell argument boundaries, drive letters, UNC paths, case folding, and reparse points. |

## Daytona/manual Windows VM probe

Run this checklist on a fresh Windows VM from the #251 implementation branch;
record the Windows edition/architecture, Node and AgentCall versions, agent
binary/version, and the command transcript. Do not mark #251 supported from a
Docker-on-macOS run.

1. Install the packed CLI into a non-admin prefix containing a space. Run
   `agentcall.cmd --version` and `agentcall.cmd --help`.
2. Run `agentcall.cmd setup ...` with a disposable organization invite. Close
   the setup shell and verify the per-user listener remains supervised.
3. Stop that supervisor and run `agentcall.cmd listen` for the foreground listen
   probe. From a second enrolled handle, place one inbound call and
   verify its reply.
4. Place a call whose fake/test agent exceeds its deadline; verify timeout
   kills the full process tree and leaves no child behind.
5. Place another call and cancel it while running; verify cancellation reaches
   the caller and leaves no child process behind.
6. Run `agentcall.cmd status <peer>` and `agentcall.cmd doctor`; verify service,
   PATH, auth, managed-policy, and ACL rows match the VM state.
7. Run `agentcall.cmd uninstall`, confirm the per-user supervisor is removed,
   and record whether local identity/state was retained or explicitly purged.

Today steps 2–7 are expected to stop at the #251 boundary. This checklist is
the positive acceptance probe once that implementation lands, not evidence
that the current release supports Windows.
