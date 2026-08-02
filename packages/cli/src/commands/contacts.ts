import { addContact, loadContacts, removeContact } from "../contacts.js";
import type { Deps } from "./deps.js";

export function contactsAdd(d: Deps, name: string, address: string, o: { note?: string }): void {
  const result = addContact(d.paths, name, address, o.note);
  d.io.log(`${result === "added" ? "Added" : "Updated"} ${name} -> ${address}`);
}

export function contactsList(d: Deps, o: { json?: boolean }): void {
  const sorted = [...loadContacts(d.paths).contacts].sort((a, b) => a.name.localeCompare(b.name));
  if (o.json) {
    d.io.log(JSON.stringify(sorted));
    return;
  }
  if (sorted.length === 0) {
    d.io.log('No contacts yet. Save one with:\n  agentcall contacts add <name> <handle@host> --note "who they are"\nThen call by name: agentcall call <name> "<message>"');
    return;
  }
  for (const c of sorted) d.io.log(`${c.name}  ${c.address}${c.note ? `  — ${c.note}` : ""}`);
}

export function contactsRemove(d: Deps, name: string): void {
  removeContact(d.paths, name);
  d.io.log(`Removed ${name}.`);
}
