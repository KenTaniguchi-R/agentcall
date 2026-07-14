import type { Paths } from "./paths.js";

// Shape verified against the installed @anthropic-ai/sandbox-runtime README
// (`npm view @anthropic-ai/sandbox-runtime readme`): settings are flat
// top-level `filesystem` / `network` objects, not nested under a
// `permissions` key. `filesystem.allowWrite` is an allow-only list (nothing
// writable unless listed); `filesystem.denyRead` blocks read access to
// specific paths while everything else stays readable by default.
export function srtSettings(p: Paths): object {
  return {
    filesystem: {
      allowWrite: [p.publicDir, "~/.claude", "~/.claude.json", "/tmp", "/private/tmp", "/var/folders"],
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.agentcall", "~/.config"],
    },
    network: { allowedDomains: ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io", "claude.ai"] },
  };
}
