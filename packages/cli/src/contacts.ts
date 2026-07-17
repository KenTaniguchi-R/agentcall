import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { z } from "zod";
import { parseAddress } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

// Never matches anything containing "@", so a contact name can never be
// mistaken for a handle@host address during resolution.
export const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const ContactSchema = z.object({
  name: z.string().regex(NAME_RE),
  address: z.string(),
  note: z.string().optional(),
});
const ContactsFileSchema = z.object({
  contacts: z.array(ContactSchema).default([]),
});
export type Contact = z.infer<typeof ContactSchema>;
export type ContactsFile = z.infer<typeof ContactsFileSchema>;

// Missing file -> empty book (nothing saved yet). Malformed file -> THROW
// naming the path: the file is user data, silently resetting it would lose
// every saved contact.
export function loadContacts(p: Paths): ContactsFile {
  if (!existsSync(p.contactsFile)) return { contacts: [] };
  try {
    return ContactsFileSchema.parse(JSON.parse(readFileSync(p.contactsFile, "utf8")));
  } catch (e) {
    throw new Error(`Corrupt contacts file at ${p.contactsFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 0600/0700 like saveConfig: notes are personal data.
export function saveContacts(p: Paths, file: ContactsFile): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
  writeFileSync(p.contactsFile, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p.contactsFile, 0o600);
}

const byName = (contacts: Contact[], name: string) =>
  contacts.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());

export function addContact(p: Paths, name: string, address: string, note?: string): "added" | "updated" {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid contact name "${name}" — start with a letter or digit, then letters, digits, ".", "_", "-" (no @).`);
  }
  if (!parseAddress(address)) {
    throw new Error(`Invalid address: ${address} (expected handle@host)`);
  }
  const file = loadContacts(p);
  const idx = byName(file.contacts, name);
  if (idx === -1) {
    file.contacts.push(note === undefined ? { name, address } : { name, address, note });
    saveContacts(p, file);
    return "added";
  }
  // An omitted note preserves the existing one: updating an address should
  // not destroy the relationship note.
  const kept = note ?? file.contacts[idx].note;
  file.contacts[idx] = kept === undefined ? { name, address } : { name, address, note: kept };
  saveContacts(p, file);
  return "updated";
}

export function removeContact(p: Paths, name: string): void {
  const file = loadContacts(p);
  const idx = byName(file.contacts, name);
  if (idx === -1) {
    throw new Error(`No contact named "${name}" — run \`agentcall contacts list\`.`);
  }
  file.contacts.splice(idx, 1);
  saveContacts(p, file);
}

export type Resolved =
  | { ok: true; handle: string; host: string; address: string }
  | { ok: false; error: string };

// The single resolution path shared by `call`, `status`, and `card`, so the
// three commands cannot drift: "@" means a literal address, anything else is
// a contact-book lookup.
export function resolveAddress(p: Paths, arg: string): Resolved {
  if (arg.includes("@")) {
    const parsed = parseAddress(arg);
    if (!parsed) return { ok: false, error: `Invalid address: ${arg} (expected handle@host)` };
    return { ok: true, ...parsed, address: arg };
  }
  const { contacts } = loadContacts(p);
  const hit = contacts.find((c) => c.name.toLowerCase() === arg.toLowerCase());
  if (!hit) {
    return { ok: false, error: `No contact named "${arg}" — run \`agentcall contacts list\`, or use a full handle@host address.` };
  }
  const parsed = parseAddress(hit.address);
  if (!parsed) return { ok: false, error: `Contact "${hit.name}" has an invalid address: ${hit.address}` };
  return { ok: true, ...parsed, address: hit.address };
}
