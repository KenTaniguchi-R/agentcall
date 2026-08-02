import { openSync } from "node:fs";
import { WriteStream } from "node:tty";

// Writes to the controlling terminal rather than stdout, so
// `agentcall setup | tee setup.log` cannot put a live credential in a log
// file. Falls back to stderr when there is no tty (CI), which is still not
// the piped stdout stream.
function ttyWrite(line: string): void {
  try {
    const out = new WriteStream(openSync("/dev/tty", "w"));
    out.write(line + "\n");
    out.end();
  } catch {
    process.stderr.write(line + "\n");
  }
}

export function printRecoveryCode(code: string, write: (s: string) => void = ttyWrite): void {
  write("");
  write("  Recovery code:  " + code);
  write("");
  write("  Save this in your password manager now. It is the only way back in");
  write("  if you lose ~/.agentcall/config.json, and it has NOT been saved to");
  write("  disk — storing it next to your token would defeat the point.");
  write("  You can mint a fresh one any time with `agentcall recovery issue`.");
  write("");
}
