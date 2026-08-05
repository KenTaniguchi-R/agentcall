#!/usr/bin/env bash
# Local port of .github/workflows/ci.yml and invariants.yml.
#
# Automatic Actions runs are paused (billing), so this is where the gate lives
# in the meantime. It must stay a faithful mirror: when a workflow step changes,
# change the matching function here. Divergence is worse than no local gate,
# because it reports green for a rule CI would fail.
#
# Two modes, matching the two CI jobs:
#   fast      verify job (build, typecheck, test) + the whole invariants job
#   packaged  packed-cli-consumer job — pack, install globally, exercise on
#             Node 20/22/24. Slow (three npm global installs); run before a
#             release, not on every push.
#   all       both
#
# Plus one narrow mode, `mirror-check`, which runs only the assertion that this
# script still mirrors ci.yml's verify job. invariants.yml calls it so the
# mirror rule is enforced from CI's side too.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""; }

failed=0
warned=0
step()  { printf '\n%s── %s%s\n' "$DIM" "$1" "$OFF"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
fail()  { printf '%s✗%s %s\n' "$RED" "$OFF" "$1"; failed=1; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$1"; warned=1; }

# GitHub renders `::error file=path,line=n::msg` as an annotation. Locally the
# same information has to read as a plain file reference.
annotations() { sed -E 's/^::(error|warning) file=([^,:]*)(,line=([0-9]*))?::/\2:\4: /; s/^([^:]*)::/\1: /'; }

# ---------------------------------------------------------------------------
# Comparison base. CI derives this from the PR base or the push's `before` sha.
# A pre-push hook has the same information (the remote sha) and exports it;
# otherwise fall back to the merge-base with main, then to HEAD^.
# ---------------------------------------------------------------------------
resolve_base() {
  if [ -n "${INVARIANTS_BASE:-}" ] && git rev-parse --verify "${INVARIANTS_BASE}^{commit}" >/dev/null 2>&1; then
    echo "$INVARIANTS_BASE"; return
  fi
  for candidate in origin/main main; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
      git merge-base "$candidate" HEAD 2>/dev/null && return
    fi
  done
  git rev-parse --verify 'HEAD^' 2>/dev/null || git rev-parse HEAD
}

# GNU `date -d` is what the workflow uses; BSD date on macOS needs -j -f.
epoch_of_date() {
  date -u -d "$1" +%s 2>/dev/null \
    || date -u -j -f "%Y-%m-%d" "$1" +%s 2>/dev/null \
    || echo 0
}

# ---------------------------------------------------------------------------
# verify job
# ---------------------------------------------------------------------------
run_verify() {
  step "verify — build, docs, typecheck, test, bundle"
  # Step order mirrors the verify job in ci.yml exactly, and the order is
  # load-bearing twice over. Build first: packages/cli typechecks against
  # packages/shared's built dist, so a build after typecheck would check the
  # previous run's types. docs:check before typecheck: it reads the built CLI,
  # and failing there first keeps a docs drift from being reported as a test
  # failure three minutes later.
  run_step build      "pnpm -r build"      pnpm -r build
  run_step docs       "pnpm docs:check"    pnpm docs:check
  run_step typecheck  "pnpm -r typecheck"  pnpm -r typecheck
  run_step test       "pnpm -r test"       pnpm -r test

  # Both relay configurations must still bundle. A binding renamed in one and
  # not the other typechecks clean and fails at deploy — which is why ci.yml
  # dry-runs them here rather than leaving it to the release.
  run_step bundle "wrangler bundles both relay configurations" \
    bash -c 'cd apps/relay &&
      pnpm exec wrangler deploy --dry-run --config wrangler.jsonc &&
      pnpm exec wrangler deploy --dry-run --config wrangler.self-host.example.jsonc'
}

# run_step <log-name> <label> <command...>
run_step() {
  local log=$1 label=$2; shift 2
  if "$@" >"$TMP/$log.log" 2>&1; then
    ok "$label"
  else
    fail "$label"
    tail -40 "$TMP/$log.log" | sed 's/^/    /'
  fi
}

# ---------------------------------------------------------------------------
# invariants job
# ---------------------------------------------------------------------------
inv_action_pins() {
  if out=$(ruby scripts/verify-action-pins.rb 2>&1); then
    ok "third-party actions are immutable"
  else
    fail "third-party actions are immutable"
    echo "$out" | annotations | sed 's/^/    /'
  fi
}

inv_protocol_frames() {
  # Matches the `type:` KEY, not a bare string literal — see the long comment
  # on the matching step in invariants.yml for the two false-positive rounds
  # that shaped this pattern. Keep the two greps identical.
  local hits
  hits=$(grep -rnE 'type:\s*z\.literal\("' apps/relay/src packages/cli/src 2>/dev/null || true)
  if [ -n "$hits" ]; then
    fail "protocol frames must live in packages/shared"
    echo "$hits" | sed 's/^/    /'
    echo "    Frame shapes are declared once in packages/shared/src/protocol.ts and imported — see CLAUDE.md."
  else
    ok "no frame shapes declared outside packages/shared"
  fi
}

inv_stored_cards() {
  local hits expected
  hits=$(git ls-files -z 'apps/relay/src/**/*.ts' 'apps/relay/src/*.ts' | sort -z | \
    xargs -0 perl -0ne 'while (/CardUpload\.(safeParse|parse)\s*\(/g) { print "$ARGV:$1\n" }')
  expected=$(printf '%s\n' \
    'apps/relay/src/index.ts:safeParse' \
    'apps/relay/src/stored-card.ts:parse')
  if [ "$hits" = "$expected" ]; then
    ok "stored cards parse only through the guarded boundary"
  else
    fail "stored cards parse through the guarded boundary"
    diff -u <(echo "$expected") <(echo "$hits") | sed 's/^/    /' || true
    echo "    Stored reads must use parseStoredCard so legacy rows cannot 500 endpoints."
  fi
}

inv_relay_auth_middleware() {
  local unexpected
  if ! grep -Fq 'app.use("/v1/*", requireIdentity)' apps/relay/src/index.ts ||
     ! grep -Fq 'PUBLIC_V1_PATHS' apps/relay/src/middleware.ts; then
    fail "relay routes must have the shared identity middleware and explicit public allowlist"
    return
  fi
  if grep -Fq 'startsWith("/v1/room/")' apps/relay/src/middleware.ts ||
     grep -Fq 'startsWith("/v1/a2a/")' apps/relay/src/middleware.ts ||
     ! grep -Fq 'requireA2AIdentity' apps/relay/src/a2a.ts; then
    fail "relay identity exceptions must be explicit and A2A must use its route-local seam"
    return
  fi
  unexpected=$(grep -rl 'authenticateRequest' apps/relay/src --include='*.ts' | \
    grep -vE '/(tenant|middleware|a2a)\.ts$' || true)
  if [ -n "$unexpected" ]; then
    fail "inline relay authentication remains outside the approved seams"
    echo "$unexpected" | sed 's/^/    /'
  else
    ok "relay authentication uses the shared middleware seam"
  fi
}

inv_hosted_relay_host() {
  # Keep identical to the matching step in invariants.yml. This host used to be a
  # separate literal in four files, so a rebrand meant finding all four.
  # packages/shared/src/a2a/card.ts is allowlisted deliberately: AGENTCALL_POLICY_EXT
  # is a stable namespace URI that must NOT follow a host change — see its comment.
  local host route strays
  host=$(perl -ne 'print $1 if /^export const HOSTED_RELAY_HOST = "([^"]+)"/' \
    packages/shared/src/protocol.ts)
  if [ -z "$host" ]; then
    fail "HOSTED_RELAY_HOST is declared in packages/shared/src/protocol.ts"
    return
  fi
  route=$(perl -ne 'print $1 if /"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/' \
    apps/relay/wrangler.jsonc)
  if [ "$route" != "$host" ]; then
    fail "the wrangler custom domain matches HOSTED_RELAY_HOST"
    echo "    protocol.ts says \"$host\", wrangler.jsonc route says \"$route\""
    return
  fi
  strays=$(grep -rlF "$host" apps/relay/src packages/cli/src packages/shared/src 2>/dev/null | \
    grep -vE 'packages/shared/src/(protocol\.ts|a2a/card\.ts)$' || true)
  if [ -n "$strays" ]; then
    fail "the hosted relay host is written once"
    echo "$strays" | sed 's/^/    /'
    echo "    Import HOSTED_RELAY_HOST from @benree/agentcall-shared instead of repeating the literal."
  else
    ok "hosted relay host is declared once and matches the wrangler route"
  fi
}

inv_historical_docs() {
  local grace=14 today modified stamp doc_date age
  today=$(date -u +%s)
  modified=$(git diff --name-only --diff-filter=M "${BASE}...HEAD" \
    -- 'docs/superpowers/**' 'docs/security/2026-07-16-security-review.md' 2>/dev/null || true)
  local flagged=0
  for file in $modified; do
    stamp=$(basename "$file" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)
    [ -n "$stamp" ] || continue
    doc_date=$(epoch_of_date "$stamp")
    [ "$doc_date" -ne 0 ] || continue
    age=$(( (today - doc_date) / 86400 ))
    if [ "$age" -gt "$grace" ]; then
      warn "revising a historical document: $file (dated $stamp, ${age}d ago)"
      echo "    These are dated records kept as written. Correct README.md/CHANGELOG.md instead."
      echo "    Ignore this if you are fixing a typo."
      flagged=1
    fi
  done
  [ "$flagged" -eq 1 ] || ok "historical docs not revised"
}

inv_migrations() {
  local manifest=apps/relay/migrations/.immutable
  if [ ! -f "$manifest" ]; then
    fail "missing immutable migration ledger ($manifest)"; return
  fi
  local invalid
  invalid=$(find apps/relay/migrations -maxdepth 1 -name '*.sql' ! -type f -print -quit)
  if [ -n "$invalid" ]; then
    fail "migrations must be regular files, not symlinks: $invalid"; return
  fi
  if [ -n "$(tail -c 1 "$manifest")" ]; then
    fail "the immutable migration ledger must end with a newline"; return
  fi
  local actual recorded
  actual=$(find apps/relay/migrations -maxdepth 1 -name '*.sql' -type f -exec basename {} \; | sort)
  recorded=$(cat "$manifest")
  if [ "$actual" != "$recorded" ]; then
    fail "migration files and the immutable ledger differ"
    diff -u <(echo "$recorded") <(echo "$actual") | sed 's/^/    /' || true
    echo "    Add new migrations to both; never rename old ones."
    return
  fi

  if git cat-file -e "${BASE}:$manifest" 2>/dev/null; then
    git show "${BASE}:$manifest" > "$TMP/base-migrations"
    local base_bytes
    base_bytes=$(wc -c < "$TMP/base-migrations" | tr -d ' ')
    if ! diff -u "$TMP/base-migrations" <(head -c "$base_bytes" "$manifest") >"$TMP/ledger.diff" 2>&1; then
      fail "the applied migration ledger is append-only"
      sed 's/^/    /' "$TMP/ledger.diff"
      return
    fi
    while IFS= read -r file || [ -n "$file" ]; do
      if ! git cat-file -e "HEAD:apps/relay/migrations/$file" 2>/dev/null ||
         ! git diff --quiet "$BASE" HEAD -- "apps/relay/migrations/$file"; then
        fail "applied migrations are immutable: apps/relay/migrations/$file (add a new migration instead)"
        return
      fi
    done < "$TMP/base-migrations"
  fi
  ok "D1 migration history is append-only"
}

# This script claims to be a faithful mirror of ci.yml's verify job. Nothing
# enforced that claim, and it drifted: `pnpm docs:check` and the wrangler
# bundle step ran in CI and not here, so a push could pass this gate on a
# commit CI would fail. With automatic Actions runs paused that difference is
# invisible until a release.
#
# So classify every shell step in the verify job. `mirrored` means the command
# text must appear verbatim inside run_verify; `unmirrored` names a step this
# script deliberately does not run, with the reason. A step added to ci.yml is
# in neither list, and this check fails until someone decides which it is.
inv_gate_mirrors_ci() {
  local actual expected mirrored unmirrored body missing=""

  # Shell steps of the verify job only: `- run: x` plus the lines of a `run: |`
  # block, stopping at the next job.
  actual=$(perl -ne '
    if (/^  (\S+):\s*$/) { $in = ($1 eq "verify") ? 1 : 0; $blk = 0; next }
    next unless $in;
    if (/^\s*-?\s*run:\s*\|\s*$/) { $blk = 1; ($ind) = /^(\s*)/; next }
    if ($blk) {
      next if /^\s*$/;
      my ($i) = /^(\s*)/;
      if (length($i) > length($ind)) { s/^\s+|\s+$//g; print "$_\n"; next }
      $blk = 0;
    }
    if (/^\s*-?\s*run:\s*(\S.*?)\s*$/) { print "$1\n" }
  ' .github/workflows/ci.yml)

  mirrored=$(printf '%s\n' \
    'pnpm -r build' \
    'pnpm docs:check' \
    'pnpm -r typecheck' \
    'pnpm -r test' \
    'pnpm exec wrangler deploy --dry-run --config wrangler.jsonc' \
    'pnpm exec wrangler deploy --dry-run --config wrangler.self-host.example.jsonc')

  # Runner-only setup and the packing that feeds the packed-cli-consumer job.
  # Locally the workspace is already installed, and `ci-local.sh packaged`
  # packs into its own temp dir rather than $RUNNER_TEMP.
  unmirrored=$(printf '%s\n' \
    'pnpm install --frozen-lockfile' \
    'mkdir -p "$RUNNER_TEMP/agentcall-packages"' \
    'pnpm --filter @benree/agentcall-shared pack --pack-destination "$RUNNER_TEMP/agentcall-packages"' \
    'pnpm --filter @benree/agentcall pack --pack-destination "$RUNNER_TEMP/agentcall-packages"')

  expected=$(printf '%s\n%s\n' "$mirrored" "$unmirrored" | sort)
  if [ "$(printf '%s\n' "$actual" | sort)" != "$expected" ]; then
    fail "every verify-job step is classified as mirrored or deliberately not"
    diff -u <(echo "$expected") <(printf '%s\n' "$actual" | sort) | sed 's/^/    /' || true
    echo "    A step changed in ci.yml. Mirror it in run_verify and add it to the"
    echo "    mirrored list, or record here why this script does not run it."
    return
  fi

  # Match against run_verify's body only. Grepping the whole file would match
  # the mirrored list above and pass no matter what run_verify actually does.
  body=$(sed -n '/^run_verify() {/,/^}/p' "$ROOT/scripts/ci-local.sh")
  while IFS= read -r cmd; do
    printf '%s' "$body" | grep -Fq -- "$cmd" || missing+="    $cmd"$'\n'
  done <<< "$mirrored"

  if [ -n "$missing" ]; then
    fail "run_verify runs every mirrored verify-job step"
    printf '%s' "$missing"
    return
  fi
  ok "local gate mirrors the verify job in ci.yml"
}

inv_no_task_board() {
  local added
  added=$(git diff --name-only --diff-filter=A "${BASE}...HEAD" 2>/dev/null || true)
  for file in $added; do
    case "$(basename "$file" | tr '[:upper:]' '[:lower:]')" in
      todo.md|tasks.md|roadmap.md|backlog.md)
        fail "open work is tracked in GitHub Issues, not in a file: $file (see CLAUDE.md)"
        return
        ;;
    esac
  done
  ok "no markdown task board reintroduced"
}

run_invariants() {
  step "invariants — comparing ${BASE}...HEAD"
  inv_action_pins
  inv_protocol_frames
  inv_stored_cards
  inv_relay_auth_middleware
  inv_hosted_relay_host
  inv_historical_docs
  inv_migrations
  inv_no_task_board
  inv_gate_mirrors_ci
}

# ---------------------------------------------------------------------------
# packed-cli-consumer job — exercises only what npm users receive.
# ---------------------------------------------------------------------------
node_bin_for_major() {
  # Highest installed patch for the requested major, e.g. 22 -> v22.23.2.
  local major=$1 dir
  dir=$(ls -d "$HOME"/.nvm/versions/node/v"$major".* 2>/dev/null | sort -V | tail -1)
  [ -n "$dir" ] && [ -x "$dir/bin/node" ] && echo "$dir/bin"
}

run_packaged() {
  step "packed-cli-consumer — pack and exercise the published tarballs"
  local packages="$TMP/agentcall-packages"
  mkdir -p "$packages"
  if ! pnpm --filter @benree/agentcall-shared pack --pack-destination "$packages" >"$TMP/pack.log" 2>&1 ||
     ! pnpm --filter @benree/agentcall pack --pack-destination "$packages" >>"$TMP/pack.log" 2>&1; then
    fail "pnpm pack"
    tail -20 "$TMP/pack.log" | sed 's/^/    /'
    return
  fi
  ok "packed both workspaces"

  for major in 20 22 24; do
    local bin
    bin=$(node_bin_for_major "$major")
    if [ -z "$bin" ]; then
      warn "Node $major not installed (nvm install $major) — skipping that leg of the matrix"
      continue
    fi
    if consumer_leg "$major" "$bin" "$packages" >"$TMP/node$major.log" 2>&1; then
      ok "Node $major ($("$bin/node" -v)) — install, --version, --help, doctor, status"
    else
      fail "Node $major ($("$bin/node" -v))"
      tail -30 "$TMP/node$major.log" | sed 's/^/    /'
    fi
  done
}

consumer_leg() {
  local major=$1 bin=$2 packages=$3
  local prefix="$TMP/global-$major" home="$TMP/agentcall-home-$major" out="$TMP/out-$major"
  rm -rf "$prefix" "$home"; mkdir -p "$prefix" "$home"

  # A fresh PATH so the shebang (`#!/usr/bin/env node`) resolves to this leg's
  # Node, not the shell's default.
  export PATH="$bin:$PATH"
  export AGENTCALL_HOME="$home"
  export NPM_CONFIG_ENGINE_STRICT=true

  "$bin/npm" install --global --prefix "$prefix" \
    "$packages"/benree-agentcall-shared-*.tgz \
    "$packages"/benree-agentcall-[0-9]*.tgz || return 1

  local cli="$prefix/bin/agentcall"
  "$cli" --version || return 1
  "$cli" --help || return 1

  # doctor and status must both refuse an unconfigured install.
  if "$cli" doctor >"$out-doctor" 2>&1; then
    echo "doctor unexpectedly reported a clean, unconfigured install as healthy"; return 1
  fi
  grep -F "No agentcall config found" "$out-doctor" || return 1

  if "$cli" status @acme/nobody >"$out-status" 2>&1; then
    echo "status unexpectedly succeeded without a configured identity"; return 1
  fi
  grep -F "No agentcall config found" "$out-status" || return 1
}

# ---------------------------------------------------------------------------
main() {
  local mode=${1:-fast}
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/agentcall-ci.XXXXXX")
  # Keep the logs when something failed. A failing run is exactly when the full
  # output is needed — the tail printed below is not enough to tell a flake from
  # a real break, and re-running to reproduce may not reproduce.
  trap '[ "$failed" -eq 0 ] && rm -rf "$TMP"' EXIT
  BASE=$(resolve_base)

  printf '%sagentcall local CI%s  %s  mode=%s\n' "$DIM" "$OFF" "$(git rev-parse --abbrev-ref HEAD)" "$mode"

  case "$mode" in
    fast)     run_verify; run_invariants ;;
    packaged) run_packaged ;;
    all)      run_verify; run_invariants; run_packaged ;;
    # Just the mirror assertion. invariants.yml runs this so CI enforces the
    # same rule from its side; it needs no comparison base and no toolchain.
    mirror-check) inv_gate_mirrors_ci ;;
    *) echo "usage: $0 [fast|packaged|all|mirror-check]" >&2; exit 64 ;;
  esac

  echo
  if [ "$failed" -ne 0 ]; then
    printf '%sFAILED%s — see above. Nothing was pushed.\n' "$RED" "$OFF"
    printf 'Full logs: %s\n' "$TMP"
    exit 1
  fi
  if [ "$warned" -ne 0 ]; then
    printf '%sPASSED with warnings%s\n' "$YELLOW" "$OFF"
  else
    printf '%sPASSED%s\n' "$GREEN" "$OFF"
  fi
}

main "$@"
