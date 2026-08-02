import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function appendPrivateLogLine(file: string, line: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  appendFileSync(file, line + "\n", { mode: 0o600 });
  // appendFileSync's mode applies only on creation. Re-assert it so an older
  // umask-created log is repaired the next time AgentCall writes to it.
  chmodSync(file, 0o600);
}
