#!/usr/bin/env bash
# Runs the A2A TCK against a locally-running relay.
#
# Pinned deliberately: the baseline is only comparable if both the suite and
# the spec it vendors stay fixed. Bump TCK_REF on purpose, never incidentally.
set -euo pipefail

TCK_REF="5996b79f9cefa6fc390980e383e358a66fb9e49e"
TCK_DIR="${TMPDIR:-/tmp}/a2a-tck"
SUT="${1:-http://localhost:8787}"

if [ ! -d "$TCK_DIR" ]; then
  git clone https://github.com/a2aproject/a2a-tck.git "$TCK_DIR"
fi
git -C "$TCK_DIR" fetch origin
git -C "$TCK_DIR" checkout --quiet "$TCK_REF"

cd "$TCK_DIR"
uv venv --quiet
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install --quiet -e .

# `run_tck.py` hardcodes `tests/compatibility/` as the pytest path and
# APPENDS any trailing args to it rather than replacing it, so passing
# `tests/compatibility/agent_card` after `--` does not narrow the run — the
# full tree (including the unimplemented Plan 2 operations suites) still
# gets collected, every one of those fails, and `set -euo pipefail` makes
# this script exit 1 unconditionally. Invoke pytest directly on just the
# card suite instead, mirroring the flags `run_tck.py` would have built, so
# this gate only depends on `agent_card` results.
mkdir -p reports
python3 -m pytest tests/compatibility/agent_card \
  "--sut-host=$SUT" --transport=http_json -m must --tb=short -q \
  --compatibility-report=reports/compatibility \
  --html=reports/tck_report.html --self-contained-html \
  --junitxml=reports/junitreport.xml
