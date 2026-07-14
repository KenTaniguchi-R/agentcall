export const INSTALL_SH = `#!/bin/sh
set -eu

if [ "$(uname)" != "Darwin" ]; then
  echo "agentcall currently supports macOS only." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "agentcall needs Node.js >= 20 (it ships with Claude Code / Codex setups)." >&2
  echo "Install it first: https://nodejs.org or 'brew install node'." >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "agentcall needs Node.js >= 20 (found $(node --version))." >&2
  exit 1
fi

echo "Installing agentcall..."
npm install -g @benree/agentcall

if [ -t 0 ]; then
  exec agentcall setup "$@"
else
  exec agentcall setup "$@" < /dev/tty
fi
`;
