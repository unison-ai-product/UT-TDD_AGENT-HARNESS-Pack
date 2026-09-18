import { describe, expect, it } from "vitest";
import {
  createIndexSql,
  createTableSql,
  createTriggerSql,
  primaryKeyColumnsOf,
  type TableDef,
  validateTableDef,
} from "../src/schema/harness-db.ts";
import {
  enumCheck,
  foreignKey,
  reference,
  requiredCol,
} from "../src/schema/harness-db-table-builders.ts";
import { openHarnessDb } from "../src/state-db/index.ts";

const constrainedTable: TableDef = {
  name: "child_rows",
  columns: [
    requiredCol("parent_id"),
    requiredCol("ordinal", "INTEGER"),
    {
      ...reference("owner_id", { table: "parents", column: "parent_id", onDelete: "CASCADE" }),
      notNull: true,
    },
    requiredCol("status"),
  ],
  primaryKey: ["parent_id", "ordinal"],
  unique: [["owner_id", "ordinal"]],
  foreignKeys: [
    foreignKey(["parent_id"], {
      table: "parents",
      columns: ["parent_id"],
      onDelete: "RESTRICT",
    }),
  ],
  checks: [
    enumCheck("status", ["draft", "confirmed"]),
    {
      kind: "or",
      expressions: [
        { kind: "compare", column: "ordinal", operator: ">=", value: 0 },
        { kind: "is-null", column: "owner_id" },
      ],
    },
  ],
};

describe("typed harness.db constraints", () => {
  it("renders NOT NULL/FK/UNIQUE/CHECK/composite PK without changing legacy metadata", () => {
    const sql = createTableSql(constrainedTable);
    expect(sql).toContain("PRIMARY KEY (parent_id, ordinal)");
    expect(sql).toContain(
      "owner_id TEXT NOT NULL REFERENCES parents (parent_id) ON DELETE CASCADE",
    );
    expect(sql).toContain("UNIQUE (owner_id, ordinal)");
    expect(sql).toContain(
      "FOREIGN KEY (parent_id) REFERENCES parents (parent_id) ON DELETE RESTRICT",
    );
    expect(sql).toContain("CHECK (status IN ('draft', 'confirmed'))");
    expect(primaryKeyColumnsOf(constrainedTable)).toEqual(["parent_id", "ordinal"]);
    expect(
      createTableSql({ name: "legacy", columns: [{ name: "id", type: "TEXT", primaryKey: true }] }),
    ).toContain("id TEXT PRIMARY KEY");
  });

  it("lets SQLite enforce every declared constraint", () => {
    const db = openHarnessDb(":memory:");
    try {
      db.exec("CREATE TABLE parents (parent_id TEXT PRIMARY KEY)");
      db.exec(createTableSql(constrainedTable));
      db.prepare("INSERT INTO parents (parent_id) VALUES (?)").run("P1");
      db.prepare(
        "INSERT INTO child_rows (parent_id, ordinal, owner_id, status) VALUES (?, ?, ?, ?)",
      ).run("P1", 1, "P1", "draft");
      expect(() =>
        db
          .prepare(
            "INSERT INTO child_rows (parent_id, ordinal, owner_id, status) VALUES (?, ?, ?, ?)",
          )
          .run("P1", 1, "P1", "draft"),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO child_rows (parent_id, ordinal, owner_id, status) VALUES (?, ?, ?, ?)",
          )
          .run("missing", 2, "P1", "draft"),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO child_rows (parent_id, ordinal, owner_id, status) VALUES (?, ?, ?, ?)",
          )
          .run("P1", 2, "P1", "unknown"),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO child_rows (parent_id, ordinal, owner_id, status) VALUES (?, ?, ?, ?)",
          )
          .run("P1", 3, null, "draft"),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    [{ ...constrainedTable, name: "bad; DROP TABLE parents" }, /SQL/],
    [{ ...constrainedTable, unique: [["owner_id); DROP TABLE parents;--"]] }, /SQL/],
    [{ ...constrainedTable, checks: [{ kind: "in", column: "status", values: [] }] }, /値が空/],
    [
      {
        ...constrainedTable,
        foreignKeys: [foreignKey(["parent_id"], { table: "parents", columns: ["id", "extra"] })],
      },
      /列数/,
    ],
    [{ ...constrainedTable, primaryKey: ["parent_id", "parent_id"] }, /重複/],
  ] as const)("rejects malformed typed metadata before DDL execution", (table, message) => {
    expect(() => validateTableDef(table as TableDef)).toThrow(message);
  });

  it("quotes CHECK values instead of treating them as SQL", () => {
    const sql = createTableSql({
      name: "safe_values",
      columns: [requiredCol("status")],
      checks: [enumCheck("status", ["ok'); DROP TABLE parents;--"])],
    });
    expect(sql).toContain("'ok''); DROP TABLE parents;--'");
  });

  it("renders typed partial UNIQUE indexes and append-only triggers", () => {
    expect(
      createIndexSql({
        name: "uq_active",
        table: "child_rows",
        columns: ["owner_id", "ordinal"],
        unique: true,
        predicate: { kind: "equals", column: "status", value: "draft" },
      }),
    ).toBe(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_active ON child_rows (owner_id, ordinal) WHERE status = 'draft'",
    );
    expect(
      createTriggerSql({
        name: "trg_child_rows_no_update",
        table: "child_rows",
        timing: "BEFORE",
        event: "UPDATE",
        action: { kind: "raise-abort", message: "append-only:child_rows" },
      }),
    ).toContain("RAISE(ABORT, 'append-only:child_rows')");
  });
});
