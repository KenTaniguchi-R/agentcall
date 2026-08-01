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
git -C "$TCK_DIR" fetch --depth 50 origin
git -C "$TCK_DIR" checkout --quiet "$TCK_REF"

cd "$TCK_DIR"
uv venv --quiet
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install --quiet -e .

./run_tck.py --sut-host "$SUT" --transport http_json --level must -- \
  tests/compatibility/agent_card
