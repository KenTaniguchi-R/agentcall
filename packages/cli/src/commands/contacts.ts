import { getMachinePaths } from "../paths.js";
import { addContact, loadContacts, removeContact } from "../contacts.js";

export function register(program: { command(name: string): any }): void {
  const contacts = program.command("contacts").description("manage your local address book of callable agents");
  contacts.command("add").description("save (or update) a contact so you can call them by name")
    .argument("<name>", "short name to call them by (no @)").argument("<address>", "their @org/handle")
    .option("--note <note>", "who they are and what to ask them about")
    .action((name: string, address: string, o: { note?: string }) => {
      try {
        const result = addContact(getMachinePaths(), name, address, o.note);
        console.log(`${result === "added" ? "Added" : "Updated"} ${name} -> ${address}`);
      } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });
  contacts.command("list").description("list saved contacts (name, address, who they are)").option("--json", "print the raw contacts array")
    .action((o: { json?: boolean }) => {
      try {
        const sorted = [...loadContacts(getMachinePaths()).contacts].sort((a, b) => a.name.localeCompare(b.name));
        if (o.json) { console.log(JSON.stringify(sorted)); return; }
        if (sorted.length === 0) {
          console.log('No contacts yet. Save one with:\n  agentcall contacts add <name> <@org/handle> --note "who they are"\nThen call by name: agentcall call <name> "<message>"');
          return;
        }
        for (const c of sorted) console.log(`${c.name}  ${c.address}${c.note ? `  — ${c.note}` : ""}`);
      } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });
  contacts.command("remove").description("delete a contact").argument("<name>", "contact name to delete")
    .action((name: string) => {
      try { removeContact(getMachinePaths(), name); console.log(`Removed ${name}.`); }
      catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });
}
