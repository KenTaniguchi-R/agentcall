import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { z } from "zod";
import { parseAddress } from "@benree/agentcall-shared";
import type { MachinePaths } from "./paths.js";
import { readJsonStore } from "./json-store.js";

// Never matches "@" or "/", so a contact name can never be mistaken for an
// `@org/handle` address during resolution.
export const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const ContactSchema = z.object({
  name: z.string().regex(NAME_RE),
  address: z.string(),
  note: z.string().optional(),
});
const ContactsFileSchema = z.object({
  contacts: z.array(ContactSchema).default([]),
});
type Contact = z.infer<typeof ContactSchema>;
type ContactsFile = z.infer<typeof ContactsFileSchema>;

// Missing file -> empty book (nothing saved yet). Malformed file -> THROW
// naming the path: the file is user data, silently resetting it would lose
// every saved contact.
export function loadContacts(p: MachinePaths): ContactsFile {
  return readJsonStore(p.contactsFile, ContactsFileSchema, {
    missing: () => ({ contacts: [] }),
    corrupt: (detail) => { throw new Error(`Corrupt contacts file at ${p.contactsFile}: ${detail}`); },
  });
}

// 0600/0700 like saveLineConfig: notes are personal data.
export function saveContacts(p: MachinePaths, file: ContactsFile): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
  writeFileSync(p.contactsFile, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p.contactsFile, 0o600);
}

const byName = (contacts: Contact[], name: string) =>
  contacts.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());

export function addContact(p: MachinePaths, name: string, address: string, note?: string): "added" | "updated" {
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

export function removeContact(p: MachinePaths, name: string): void {
  const file = loadContacts(p);
  const idx = byName(file.contacts, name);
  if (idx === -1) {
    throw new Error(`No contact named "${name}" — run \`agentcall contacts list\`.`);
  }
  file.contacts.splice(idx, 1);
  saveContacts(p, file);
}

export type Resolved =
  | { ok: true; org: string; handle: string; address: string }
  | { ok: false; error: string };

// The single resolution path shared by `call`, `status`, and `card`, so the
// three commands cannot drift: "@" means a literal address, anything else is
// a contact-book lookup. `relay` is the URL the caller will actually dial;
// pass it so the host check above applies uniformly to all three.
// `org` is the calling LINE's tenant, not the machine's: the contact book is
// shared across lines (person-scoped) but the tenant check is per-call, so the
// caller passes the org of whichever line is placing this call.
export function resolveAddress(p: MachinePaths, arg: string, _relay?: string, org?: string): Resolved {
  const check = (address: string, label?: string): Resolved => {
    const parsed = parseAddress(address);
    if (!parsed) {
      return label
        ? { ok: false, error: `Contact "${label}" has an invalid address: ${address}` }
        : { ok: false, error: `Invalid address: ${address} (expected @org/handle)` };
    }
    // The cross-tenant boundary (#66). It used to derive the target org by
    // string-matching a DNS suffix; the org is now a field of the address, so
    // this reads it instead of parsing it out of a hostname.
    if (org && parsed.org !== org) {
      const who = label ? `Contact "${label}"` : `Address ${address}`;
      return { ok: false, error: `${who} belongs to organization "${parsed.org}", but this install belongs to "${org}".` };
    }
    return { ok: true, ...parsed, address };
  };

  if (arg.includes("/") || arg.startsWith("@")) return check(arg);

  const { contacts } = loadContacts(p);
  const hit = contacts.find((c) => c.name.toLowerCase() === arg.toLowerCase());
  if (!hit) {
    return { ok: false, error: `No contact named "${arg}" — run \`agentcall contacts list\`, or use a full @org/handle address.` };
  }
  return check(hit.address, hit.name);
}
