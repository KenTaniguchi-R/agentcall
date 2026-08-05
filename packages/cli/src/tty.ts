import { closeSync, openSync } from "node:fs";
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

// Whether a question could actually be answered, mirroring defaultOpen's
// fallback chain. The last resort there is process.stdin, and in a container
// build or a CI step that stdin is closed: readline's question callback never
// fires, so the prompt does not fail — it hangs. A caller that has a hard
// failure available (setup without an invite) must choose it over asking.
export function canPrompt(): boolean {
  if (process.stdin.isTTY) return true;
  try {
    closeSync(openSync("/dev/tty", "r+"));
    return true;
  } catch {
    return false;
  }
}

// Masks the typed answer so a Room invite (a bearer credential — whoever
// holds it can join) doesn't sit in scrollback or over someone's shoulder.
// Overriding readline's `_writeToOutput` is the standard technique for this
// in Node (the same one `inquirer`/`prompts`/`read` use) — it's not a
// documented public API, but it's been stable for well over a decade and
// avoids both a new dependency and the much larger surface of hand-rolling
// raw-mode keypress capture (backspace, paste, Ctrl-C, terminal restore).
export function createHiddenPrompter(
  open: () => PromptStreams = defaultOpen,
): (question: string) => Promise<string> {
  let streams: PromptStreams | undefined;
  return (question) =>
    new Promise((resolve) => {
      streams ??= open();
      const { input, output } = streams;
      input.ref?.();
      const rl = createInterface({ input, output }) as ReturnType<typeof createInterface> & {
        _writeToOutput?(text: string): void;
      };
      let echoing = true;
      rl._writeToOutput = (text: string) => {
        if (echoing) output.write(text);
      };
      rl.question(question, (answer) => {
        echoing = true;
        rl.close();
        output.write("\n");
        input.unref?.();
        resolve(answer);
      });
      // Suppress echo only after the prompt text itself has been written —
      // otherwise the question text is hidden along with the answer.
      echoing = false;
    });
}

export const hiddenAsk = createHiddenPrompter();

export interface RoomLineListener {
  /** Registers a handler for each complete line of typed input. */
  onLine(handler: (line: string) => void): void;
  /** Writes text to the terminal without disturbing the input line. */
  print(text: string): void;
  close(): void;
}

// Unlike ask()/hiddenAsk() (open, ask one question, close), this keeps one
// readline interface open indefinitely and fires a callback per line — so a
// caller can react to typed input (e.g. "/start") while something else, like
// room-poll.ts's setTimeout-driven ticks, keeps running in the same event
// loop between lines. Nothing here blocks.
export function createLineListener(open: () => PromptStreams = defaultOpen): RoomLineListener {
  const streams = open();
  const { input, output } = streams;
  input.ref?.();
  const rl = createInterface({ input, output, terminal: false });
  return {
    onLine: (handler) => rl.on("line", handler),
    print: (text) => output.write(text),
    close: () => {
      rl.close();
      input.unref?.();
    },
  };
}
