// The shared surface every command module depends on. Deliberately NOT in
// roster.ts: that was the first command extracted, not the owner of these
// types, and six sibling modules importing from it would imply a dependency
// on roster functionality that does not exist.
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
