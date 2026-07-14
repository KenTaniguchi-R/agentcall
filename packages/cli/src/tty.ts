import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";

interface PromptStreams {
  input: NodeJS.ReadableStream & { ref?(): void; unref?(): void };
  output: NodeJS.WritableStream;
}

// Interactive shells prompt over stdin/stdout — the standard readline path.
// When stdin is piped (e.g. `agentcall setup | tee log`), fall back to the
// controlling terminal via /dev/tty, as tty streams rather than fs streams:
// a blocked fs read on a tty can't be cancelled, so a leftover read from an
// earlier prompt swallows the line typed into the next one (the "setup hangs
// forever on the handle prompt" bug).
function defaultOpen(): PromptStreams {
  if (process.stdin.isTTY) return { input: process.stdin, output: process.stdout };
  try {
    const fd = openSync("/dev/tty", "r+");
    return { input: new ReadStream(fd), output: new WriteStream(fd) };
  } catch {
    /* no controlling tty (CI, some runners) */
    return { input: process.stdin, output: process.stdout };
  }
}

// Returns an ask() that opens the terminal once, lazily, and reuses it for
// every question. Opening per question is what hung setup: two readers on
// one tty race for the typed line, and the loser waits forever.
export function createPrompter(open: () => PromptStreams = defaultOpen): (question: string) => Promise<string> {
  let streams: PromptStreams | undefined;
  return (question) =>
    new Promise((resolve) => {
      streams ??= open();
      const { input, output } = streams;
      // ref/unref bracket each question so the idle tty handle doesn't keep
      // the process alive after the last answer (the CLI never calls
      // process.exit; it relies on the event loop draining).
      input.ref?.();
      const rl = createInterface({ input, output });
      rl.question(question, (answer) => {
        rl.close();
        input.unref?.();
        resolve(answer);
      });
    });
}

// Process-wide prompter shared by every interactive question the CLI asks.
export const ask = createPrompter();
