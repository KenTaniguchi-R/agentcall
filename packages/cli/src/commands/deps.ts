// The shared surface every command module depends on. Deliberately NOT in
// roster.ts: that was the first command extracted, not the owner of these
// types, and six sibling modules importing from it would imply a dependency
// on roster functionality that does not exist.
//
// Error-handling contract for every command action (enforced by run() in
// index.ts, not here — see index.ts:16-31): throw a plain Error and run()
// prints the bare message and sets exit 1; throw ExitOnly and run() sets
// exit 1 and prints nothing, because the failure was already reported some
// other way; set process.exitCode yourself ONLY when the exit code run()
// can't express (i.e. not 0 or 1) is needed, and say why at that call site —
// status (exit 2 on offline) and doctor (forwards runDoctor's arbitrary
// code) are the only two sanctioned instances of this third case.
import { ask } from "../tty.js";
import { getPaths, type Paths } from "../paths.js";

// One injected I/O surface for every command. Injected rather than calling
// console directly because vitest runs files in parallel and a process-wide
// console spy is shared mutable state between suites.
export type Io = {
  log(s: string): void;
  error(s: string): void;
  ask(q: string): Promise<string>;
};
export type Deps = { paths: Paths; io: Io };

export function realDeps(): Deps {
  return {
    paths: getPaths(),
    io: { log: (s) => console.log(s), error: (s) => console.error(s), ask },
  };
}

// Thrown by a command that must exit non-zero WITHOUT printing anything —
// the failure has already been reported to the user by other means. search
// uses it for the every-roster-failed case, which prints per-roster errors
// in its loop and then needs exit 1 without a redundant summary line.
export class ExitOnly extends Error {}
