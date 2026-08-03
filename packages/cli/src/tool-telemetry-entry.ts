// Standalone PostToolUse/PostToolUseFailure hook. Keep this import graph tiny:
// it runs once per completed tool and must never initialize an exporter.
import { writeToolHookEvent } from "./tool-telemetry-hook.js";

const MAX_INPUT_BYTES = 1024 * 1024;
let raw = "";
let bytes = 0;
let oversized = false;
for await (const chunk of process.stdin) {
  bytes += Buffer.byteLength(chunk);
  if (bytes > MAX_INPUT_BYTES) {
    raw = "";
    oversized = true;
    continue;
  }
  if (!oversized) raw += chunk;
}
if (raw) writeToolHookEvent(raw, "post");
