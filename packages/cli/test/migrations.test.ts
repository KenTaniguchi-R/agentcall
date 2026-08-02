import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../../../apps/relay/migrations");
const historical = [
  "0001_init.sql",
  "0002_agent_kind_nullable.sql",
  "0003_cards.sql",
  "0004_rosters.sql",
  "0005_handle_recovery.sql",
];
const repair = readFileSync(join(migrationsDir, "0006_tenancy_and_roster_lifecycle.sql"), "utf8");
const auditEvents = readFileSync(join(migrationsDir, "0007_roster_audit_events.sql"), "utf8");
const joinKeys = readFileSync(join(migrationsDir, "0008_roster_join_keys.sql"), "utf8");
const orgInvites = readFileSync(join(migrationsDir, "0009_org_invite_lifecycle.sql"), "utf8");

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of historical) db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  return db;
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function tenantDatabase(): DatabaseSync {
  const db = legacyDatabase();
  db.exec(repair);
  return db;
}

describe("D1 migration reconciliation", () => {
  it("preserves legacy handles and cards under the initial tenant", () => {
    const db = legacyDatabase();
    db.exec(
      "INSERT INTO handles (handle, token_hash, agent_kind, created_at, recovery_hash) " +
        "VALUES ('ken', 'token', 'claude', 1, 'recovery'), ('caller', 'caller-token', NULL, 2, NULL); " +
        "INSERT INTO cards VALUES ('ken', '{}', 3);",
    );

    db.exec(repair);

    expect(db.prepare(
      "SELECT org, handle, token_hash, agent_kind, created_at FROM handles ORDER BY handle",
    ).all()).toEqual([
      { org: "acme", handle: "caller", token_hash: "caller-token", agent_kind: null, created_at: 2 },
      { org: "acme", handle: "ken", token_hash: "token", agent_kind: "claude", created_at: 1 },
    ]);
    expect(db.prepare("SELECT org, handle, card_json, updated_at FROM cards").get())
      .toEqual({ org: "acme", handle: "ken", card_json: "{}", updated_at: 3 });
    expect(columns(db, "handles")).toEqual(["org", "handle", "token_hash", "agent_kind", "created_at"]);
    expect(columns(db, "invites")).toEqual([
      "token_hash", "org", "created_by", "created_at", "expires_at", "used_at", "used_by",
    ]);
    expect(columns(db, "cards")).toEqual(["org", "handle", "card_json", "updated_at"]);
    expect(columns(db, "rosters")).toEqual([
      "id", "org", "join_secret_hash", "admin_secret_hash", "created_at",
    ]);
    expect(columns(db, "roster_members")).toEqual(["roster_id", "org", "handle", "joined_at"]);
    expect(columns(db, "roster_events")).toEqual([
      "id", "roster_id", "org", "kind", "actor", "subject", "at",
    ]);
  });

  it("refuses to discard a roster if the measured zero-row precondition changes", () => {
    const db = legacyDatabase();
    db.exec("INSERT INTO rosters VALUES ('existing', 'hash', 1)");

    expect(() => db.exec(repair)).toThrow(/check constraint/i);
    expect(db.prepare("SELECT id, secret_hash FROM rosters").get())
      .toEqual({ id: "existing", secret_hash: "hash" });
    db.exec("DELETE FROM rosters");
    expect(() => db.exec(repair)).not.toThrow();
  });

  it("refuses to discard an orphaned legacy roster member", () => {
    const db = legacyDatabase();
    db.exec("INSERT INTO roster_members VALUES ('missing-roster', 'orphan', 1)");

    expect(() => db.exec(repair)).toThrow(/check constraint/i);
    expect(db.prepare("SELECT roster_id, handle FROM roster_members").get())
      .toEqual({ roster_id: "missing-roster", handle: "orphan" });
  });

  it("upgrades an empty roster audit log to the complete evidence schema", () => {
    const db = tenantDatabase();

    expect(() => db.exec(auditEvents)).not.toThrow();
    expect(columns(db, "rosters")).toEqual([
      "id", "org", "join_secret_hash", "admin_secret_hash", "created_at",
      "audit_budget_used", "audit_budget_exhausted_at",
    ]);
    expect(columns(db, "roster_events")).toEqual([
      "id", "event", "action_type", "roster_id", "org", "actor", "actor_type",
      "target_type", "target_id", "actor_ip", "actor_country", "description", "at",
    ]);
  });

  it("refuses to rebuild a roster audit log after its zero-row precondition changes", () => {
    const db = tenantDatabase();
    db.exec(
      "INSERT INTO roster_events (roster_id, org, kind, actor, subject, at) " +
        "VALUES ('existing', 'acme', 'join', 'ken', 'caller', 1)",
    );

    expect(() => db.exec(auditEvents)).toThrow(/check constraint/i);
    expect(db.prepare(
      "SELECT roster_id, org, kind, actor, subject, at FROM roster_events",
    ).get()).toEqual({
      roster_id: "existing", org: "acme", kind: "join", actor: "ken", subject: "caller", at: 1,
    });
    expect(columns(db, "rosters")).not.toContain("audit_budget_used");
  });

  it("replaces the zero-user shared join secret with keyed credentials and provenance", () => {
    const db = tenantDatabase();
    db.exec(auditEvents);
    expect(() => db.exec(joinKeys)).not.toThrow();

    expect(columns(db, "rosters")).toEqual([
      "id", "org", "admin_secret_hash", "created_at", "audit_budget_used", "audit_budget_exhausted_at",
    ]);
    expect(columns(db, "roster_join_keys")).toEqual([
      "prefix", "roster_id", "org", "secret_hash", "description", "created_by",
      "created_at", "expires_at", "reusable", "used", "revoked_at",
    ]);
    expect(columns(db, "roster_members")).toEqual([
      "roster_id", "org", "handle", "joined_at", "joined_via_prefix",
    ]);
  });

  it("refuses the join-key rebuild if any roster evidence exists", () => {
    const evidence = [
      "INSERT INTO rosters (id, org, join_secret_hash, admin_secret_hash, created_at) " +
        "VALUES ('existing', 'acme', 'join', 'admin', 1)",
      "INSERT INTO roster_members (roster_id, org, handle, joined_at) VALUES ('existing', 'acme', 'ken', 1)",
      "INSERT INTO roster_events " +
        "(event, action_type, roster_id, org, actor, actor_type, target_type, target_id, description, at) " +
        "VALUES ('roster.create', 'C', 'existing', 'acme', 'ken', 'handle', 'roster', NULL, 'created', 1)",
    ];
    for (const insert of evidence) {
      const db = tenantDatabase();
      db.exec(auditEvents);
      db.exec(insert);
      expect(() => db.exec(joinKeys)).toThrow(/check constraint/i);
      expect(columns(db, "rosters")).toContain("join_secret_hash");
    }
  });

  it("adds organization invite lifecycle and a separately scoped audit ledger", () => {
    const db = tenantDatabase();
    db.exec(auditEvents);
    db.exec(joinKeys);
    db.exec(orgInvites);

    expect(columns(db, "invites")).toEqual([
      "token_hash", "org", "created_by", "created_at", "expires_at", "used_at", "used_by",
      "description", "revoked_at",
    ]);
    expect(columns(db, "org_events")).toEqual([
      "id", "event", "action_type", "org", "actor", "actor_type", "target_type", "target_id",
      "actor_ip", "actor_country", "description", "at",
    ]);
    expect(columns(db, "roster_events")).toContain("roster_id");
  });
});
