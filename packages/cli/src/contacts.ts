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
// .loose() (zod 4's passthrough mode) preserves unknown top-level keys across
// a load+save round-trip, so future fields survive being written back by a
// version of the CLI that doesn't know about them yet.
const ContactsFileSchema = z
  .object({
    contacts: z.array(ContactSchema).default([]),
  })
  .loose();
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
  | { ok: true; handle: string; host: string; address: string; warning?: string }
  | { ok: false; error: string };

// An address names a relay, but every command sends the call to the *configured*
// relay and only uses the handle — so with a custom AGENTCALL_RELAY, calling
// "ken@agentcall.benree.tech" actually reaches whichever "ken" is registered on
// that other relay. This surfaces the divergence instead of letting it happen
// silently.
//
// A warning rather than a rejection, deliberately: the relay builds every
// address from a hardcoded RELAY_HOST (apps/relay/src/index.ts), so a
// self-hosted or `wrangler dev` relay hands out agentcall.benree.tech
// addresses that can never match its own host. Refusing those would break
// local development and self-hosting for a mismatch that is currently normal.
// An unparseable relay URL yields no warning — a diagnostic must not become a
// second failure mode.
function relayHostWarning(address: string, host: string, relay?: string): string | undefined {
  if (!relay) return undefined;
  let relayHost: string;
  try {
    relayHost = new URL(relay).host;
  } catch {
    return undefined;
  }
  if (!relayHost || relayHost === host) return undefined;
  return (
    `Warning: ${address} names the relay ${host}, but this install is configured for ${relayHost}. ` +
    `The call goes to "${address.slice(0, address.indexOf("@"))}" on ${relayHost}, which may be a different agent.`
  );
}

// The single resolution path shared by `call`, `status`, and `card`, so the
// three commands cannot drift: "@" means a literal address, anything else is
// a contact-book lookup. `relay` is the URL the caller will actually dial;
// pass it so the host check above applies uniformly to all three.
export function resolveAddress(p: Paths, arg: string, relay?: string): Resolved {
  if (arg.includes("@")) {
    const parsed = parseAddress(arg);
    if (!parsed) return { ok: false, error: `Invalid address: ${arg} (expected handle@host)` };
    const warning = relayHostWarning(arg, parsed.host, relay);
    return warning ? { ok: true, ...parsed, address: arg, warning } : { ok: true, ...parsed, address: arg };
  }
  const { contacts } = loadContacts(p);
  const hit = contacts.find((c) => c.name.toLowerCase() === arg.toLowerCase());
  if (!hit) {
    return { ok: false, error: `No contact named "${arg}" — run \`agentcall contacts list\`, or use a full handle@host address.` };
  }
  const parsed = parseAddress(hit.address);
  if (!parsed) return { ok: false, error: `Contact "${hit.name}" has an invalid address: ${hit.address}` };
  const warning = relayHostWarning(hit.address, parsed.host, relay);
  return warning
    ? { ok: true, ...parsed, address: hit.address, warning }
    : { ok: true, ...parsed, address: hit.address };
}
