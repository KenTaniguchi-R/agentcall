import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { MachinePaths } from "./paths.js";
import { writeJsonAtomic } from "./json-store.js";

export const PersonSchema = z.object({ primary_line: z.string() });
export type Person = z.infer<typeof PersonSchema>;

export function loadPerson(m: MachinePaths): Person {
  if (!existsSync(m.personFile)) {
    throw new Error(`No agentcall install found. Run \`agentcall setup\` first.`);
  }
  try {
    return PersonSchema.parse(JSON.parse(readFileSync(m.personFile, "utf8")));
  } catch (e) {
    throw new Error(
      `Corrupt person.json at ${m.personFile}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Temp-file-plus-rename: person.json is read by every person-scoped command,
// so a half-written file would break the whole CLI rather than one feature.
// rename(2) within a directory is atomic, so a reader sees either the old
// file or the new one.
export function savePerson(m: MachinePaths, person: Person): void {
  writeJsonAtomic(m.personFile, person);
}

// The primary line is what places every outgoing call, so a dangling pointer
// has to be handled rather than thrown at the user mid-call. One line is
// unambiguous and gets repaired silently; several is a decision only the
// owner can make.
export function resolvePrimary(m: MachinePaths, lineNames: string[]): string {
  if (lineNames.length === 0) {
    throw new Error("This machine has no agentcall lines. Run `agentcall setup` first.");
  }
  let recorded: string | undefined;
  if (existsSync(m.personFile)) recorded = loadPerson(m).primary_line;
  if (recorded !== undefined && lineNames.includes(recorded)) return recorded;

  if (lineNames.length === 1) {
    savePerson(m, { primary_line: lineNames[0]! });
    return lineNames[0]!;
  }
  throw new Error(
    `No usable primary line (person.json names ${recorded === undefined ? "nothing" : `"${recorded}"`}, ` +
      `which does not exist). Pick one with: agentcall line primary <${lineNames.join("|")}>`,
  );
}
