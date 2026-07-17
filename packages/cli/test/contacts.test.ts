import { mkdtempSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { loadContacts, saveContacts, addContact, removeContact, NAME_RE } from "../src/contacts.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-ct-")); }

describe("contacts store", () => {
  it("paths derives contactsFile from home", () => {
    expect(getPaths("/tmp/fakehome").contactsFile).toBe("/tmp/fakehome/.agentcall/contacts.json");
  });

  it("missing file loads as an empty book", () => {
    expect(loadContacts(getPaths(tempHome()))).toEqual({ contacts: [] });
  });

  it("round-trips and sets 0600/0700 perms", () => {
    const p = getPaths(tempHome());
    const book = { contacts: [{ name: "ken", address: "ken@agentcall.benree.tech", note: "coworker" }] };
    saveContacts(p, book);
    expect(loadContacts(p)).toEqual(book);
    expect(statSync(p.contactsFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });

  it("corrupt file throws an error naming the path", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, "{not json");
    expect(() => loadContacts(p)).toThrow(p.contactsFile);
  });

  it("addContact adds, then upserts case-insensitively", () => {
    const p = getPaths(tempHome());
    expect(addContact(p, "Ken", "ken@agentcall.benree.tech", "coworker")).toBe("added");
    expect(addContact(p, "ken", "ken2@agentcall.benree.tech")).toBe("updated");
    const { contacts } = loadContacts(p);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].address).toBe("ken2@agentcall.benree.tech");
  });

  it("upsert without --note preserves the existing note", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "ken@agentcall.benree.tech", "coworker, owns relay infra");
    addContact(p, "ken", "ken2@agentcall.benree.tech");
    expect(loadContacts(p).contacts[0].note).toBe("coworker, owns relay infra");
  });

  it("rejects invalid names and invalid addresses without writing", () => {
    const p = getPaths(tempHome());
    expect(() => addContact(p, "ken@home", "ken@agentcall.benree.tech")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "-ken", "ken@agentcall.benree.tech")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "ken", "not-an-address")).toThrow(/handle@host/);
    expect(loadContacts(p)).toEqual({ contacts: [] });
  });

  it("NAME_RE accepts typical names", () => {
    for (const ok of ["ken", "Ken", "my-manager", "ken_2", "a.b"]) expect(NAME_RE.test(ok)).toBe(true);
    for (const bad of ["ken@x", "", ".ken", "_ken"]) expect(NAME_RE.test(bad)).toBe(false);
  });

  it("removeContact deletes case-insensitively and rejects unknown names", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "ken@agentcall.benree.tech");
    removeContact(p, "KEN");
    expect(loadContacts(p)).toEqual({ contacts: [] });
    expect(() => removeContact(p, "ken")).toThrow(/No contact named "ken"/);
  });
});
