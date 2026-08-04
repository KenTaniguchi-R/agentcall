import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { z } from "zod";
import { parseAddress } from "@benree/agentcall-shared";
import type { MachinePaths } from "./paths.js";
import { readJsonStore } from "./json-store.js";

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
  | { ok: true; handle: string; host: string; address: string; warning?: string }
  | { ok: false; error: string };

// An address names a relay, but a call is dialled on the calling LINE's relay
// and only the handle travels — so calling "ken@agentcall.benree.tech" from a
// line registered elsewhere actually reaches whichever "ken" is on that other
// relay. This surfaces the divergence instead of letting it happen silently.
//
// A WARNING rather than a rejection, deliberately. The relay builds every
// address from a hardcoded RELAY_HOST (apps/relay/src/index.ts), so a
// self-hosted or `wrangler dev` relay hands out agentcall.benree.tech
// addresses that can never match its own host; refusing those breaks local
// development and self-hosting for a mismatch that is currently normal. The
// merge of origin/main briefly reinstated the rejection — main had never made
// this change — which would have re-broken both. Note this is distinct from
// the cross-tenant check below, which stays a hard REJECTION: that one is a
// security boundary (#66), this one is a diagnostic.
//
// `org` still participates, from main: on the real relay a tenant's addresses
// are `<handle>@<org>.agentcall.benree.tech`, so naming the expected host
// without the org prefix would make the warning itself wrong.
//
// An unparseable relay URL yields no warning — a diagnostic must not become a
// second failure mode.
function relayHostWarning(address: string, host: string, relay?: string, org?: string): string | undefined {
  if (!relay) return;
  let relayHost: string;
  try {
    relayHost = new URL(relay).host;
  } catch {
    return;
  }
  const expected = relayHost === "agentcall.benree.tech" && org ? `${org}.${relayHost}` : relayHost;
  if (!expected || expected === host) return;
  return (
    `Warning: ${address} names the relay ${host}, but this line is registered on ${expected}. ` +
    `The call goes to "${address.slice(0, address.indexOf("@"))}" on ${expected}, which may be a different agent.`
  );
}

function addressTenant(host: string): string | undefined {
  const suffix = ".agentcall.benree.tech";
  if (!host.endsWith(suffix)) return undefined;
  const org = host.slice(0, -suffix.length);
  return org && !org.includes(".") ? org : undefined;
}

// The single resolution path shared by `call`, `status`, and `card`, so the
// three commands cannot drift: "@" means a literal address, anything else is
// a contact-book lookup. `relay` is the URL the caller will actually dial;
// pass it so the host check above applies uniformly to all three.
// `org` is the calling LINE's tenant, not the machine's: the contact book is
// shared across lines (person-scoped) but the tenant check is per-call, so the
// caller passes the org of whichever line is placing this call.
export function resolveAddress(p: MachinePaths, arg: string, relay?: string, org?: string): Resolved {
  if (arg.includes("@")) {
    const parsed = parseAddress(arg);
    if (!parsed) return { ok: false, error: `Invalid address: ${arg} (expected handle@host)` };
    const targetOrg = addressTenant(parsed.host);
    if (org && targetOrg && targetOrg !== org) {
      return { ok: false, error: `Address ${arg} belongs to organization "${targetOrg}", but this install belongs to "${org}".` };
    }
    const warning = relayHostWarning(arg, parsed.host, relay, org);
    return warning ? { ok: true, ...parsed, address: arg, warning } : { ok: true, ...parsed, address: arg };
  }
  const { contacts } = loadContacts(p);
  const hit = contacts.find((c) => c.name.toLowerCase() === arg.toLowerCase());
  if (!hit) {
    return { ok: false, error: `No contact named "${arg}" — run \`agentcall contacts list\`, or use a full handle@host address.` };
  }
  const parsed = parseAddress(hit.address);
  if (!parsed) return { ok: false, error: `Contact "${hit.name}" has an invalid address: ${hit.address}` };
  const targetOrg = addressTenant(parsed.host);
  if (org && targetOrg && targetOrg !== org) {
    return {
      ok: false,
      error: `Contact "${hit.name}" belongs to organization "${targetOrg}", but this install belongs to "${org}".`,
    };
  }
  const warning = relayHostWarning(hit.address, parsed.host, relay, org);
  return warning
    ? { ok: true, ...parsed, address: hit.address, warning: `Contact "${hit.name}": ${warning}` }
    : { ok: true, ...parsed, address: hit.address };
}
