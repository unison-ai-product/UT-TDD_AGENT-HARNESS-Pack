import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitAuthoringProvenance } from "../../src/disposition/adapters/git-authoring-provenance.ts";
import { type HarnessDb, openHarnessDb } from "../../src/state-db/index.ts";
import { removeTestTree } from "../support/temp-tree.ts";

export const BASE_COMMIT = "a63b226437297ee0b62ab8bdc0e2c778bbd6c341";
export const ISSUE_URL = "https://github.com/example/repo/issues/12";
export const EDGE_TABLE = "vmodel_item_target_edges";
export const ISSUE_LEDGER_PATH = "docs/governance/vmodel-item-target-ledger.md";
export const CATALOG_PATHS = [
  "docs/governance/vmodel-source-manifest.md",
  "docs/governance/vmodel-document-disposition-catalog.md",
  "docs/governance/vmodel-semantic-item-catalog.md",
  "docs/governance/vmodel-source-target-edges.md",
  ISSUE_LEDGER_PATH,
  "docs/governance/vmodel-document-scale-profiles.md",
  "docs/governance/vmodel-document-catalog.md",
] as const;
export const DROP_SENTINEL = "planret-019-injected-after-drop";

interface FrozenSchemaFixture {
  baseCommit: string;
  ddlSha256: string;
  schemaDdls: string[];
}

const roots: string[] = [];

export function frozenSchema(): FrozenSchemaFixture {
  const path = join(process.cwd(), "tests/fixtures/planret-s3-base-schema-v29.json");
  return JSON.parse(readFileSync(path, "utf8")) as FrozenSchemaFixture;
}

export function createLegacyDatabase() {
  const root = mkdtempSync(join(tmpdir(), "planret-s3-v29-"));
  roots.push(root);
  mkdirSync(join(root, ".ut-tdd"), { recursive: true });
  const db = openHarnessDb(join(root, ".ut-tdd", "harness.db"), { repoRoot: root });
  // seed 全体を 1 transaction にする (autocommit だと 162 DDL + INSERT ごとに journal を commit し、Windows で遅い。#1673)。
  db.exec("BEGIN");
  try {
    seedLegacyDatabase(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return { root, db };
}

function seedLegacyDatabase(db: HarnessDb): void {
  for (const ddl of frozenSchema().schemaDdls) db.exec(ddl);
  db.prepare("INSERT INTO plan_registry (plan_id) VALUES (?)").run("PLAN-L6-01");
  db.prepare("INSERT INTO plan_registry (plan_id) VALUES (?)").run("PLAN-L6-02");
  db.prepare(
    "INSERT INTO vmodel_categories (category_id, category_name, row_digest) VALUES (?, ?, ?)",
  ).run("CAT-PLANRET", "migration fixture", "digest-category");
  db.prepare(
    `INSERT INTO vmodel_semantic_items
      (item_id, item_name, category_id, source_status, source_ref, source_file, row_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "ITEM-PLANRET-019",
    "migration fixture item",
    "CAT-PLANRET",
    "adopted",
    "ZIP-DOC-001",
    "fixture.md",
    "digest-item",
  );
  db.prepare(
    `INSERT INTO ${EDGE_TABLE}
      (edge_id, item_id, target_status, target_kind, target_ref, plan_id, reason, source_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "EDGE-PLANRET-019",
    "ITEM-PLANRET-019",
    "defer",
    "plan_alias",
    "PLAN-L6-01",
    "PLAN-L6-01",
    "legacy fixture defer",
    "digest-edge",
  );
  db.setUserVersion(29);
}

function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[] = [],
): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function writeFixture(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${content.trimEnd()}\n`, "utf8");
}

export function createIssueOnlyCatalogFixture(root: string): void {
  const digest = "a".repeat(64);
  writeFixture(
    root,
    CATALOG_PATHS[0],
    markdownTable(
      ["field", "value"],
      [
        ["audited_on", "2026-11-04"],
        ["sha256", digest],
        ["numbered_source_documents", "1"],
        ["semantic_catalog_categories", "1"],
        ["semantic_catalog_items", "1"],
        ["source_target_edges", "1"],
      ],
    ),
  );
  writeFixture(
    root,
    CATALOG_PATHS[1],
    markdownTable(
      ["source_id", "source_title", "disposition", "target", "profile / 判断理由"],
      [["ZIP-DOC-001", "fixture", "defer", "DOC-L0-CHARTER", "Issue-backed defer fixture"]],
    ),
  );
  writeFixture(
    root,
    CATALOG_PATHS[2],
    [
      markdownTable(["category_id", "category_name"], [["CAT-PLANRET", "fixture"]]),
      markdownTable(
        ["item_id", "item_name", "category_id", "source_status", "source_ref", "source_file"],
        [
          [
            "ITEM-PLANRET-019",
            "fixture item",
            "CAT-PLANRET",
            "adopted",
            "ZIP-DOC-001",
            "fixture.md",
          ],
        ],
      ),
      markdownTable(["meta_source_ref", "allowed_source_status", "source_file_policy", "reason"]),
    ].join("\n\n"),
  );
  writeFixture(
    root,
    CATALOG_PATHS[3],
    markdownTable(
      ["edge_id", "source_id", "disposition", "target_type", "target_ref"],
      [["SOURCE-TARGET-019", "ZIP-DOC-001", "defer", "target_slot", "DOC-L0-CHARTER"]],
    ),
  );
  writeFixture(
    root,
    ISSUE_LEDGER_PATH,
    markdownTable(
      [
        "edge_id",
        "item_id",
        "項目名",
        "category_id",
        "source_ref",
        "source_digest",
        "target_status",
        "target_kind",
        "target_ref",
        "判断理由",
        "issue",
      ],
      [
        [
          "ITEM-TARGET-019",
          "ITEM-PLANRET-019",
          "fixture item",
          "CAT-PLANRET",
          "ZIP-DOC-001",
          digest,
          "defer",
          "target_slot",
          "DOC-L0-CHARTER",
          "Issue-backed defer fixture",
          ISSUE_URL,
        ],
      ],
    ),
  );
  writeFixture(
    root,
    CATALOG_PATHS[5],
    [
      markdownTable(
        ["field", "value"],
        [
          ["size_profile_count", "0"],
          ["product_profile_count", "0"],
          ["profile_count", "0"],
          ["decision_count", "0"],
        ],
      ),
      markdownTable([
        "profile_id",
        "profile_axis",
        "profile_rank",
        "description",
        "default_status",
        "default_detail",
        "scope_policy",
      ]),
      markdownTable([
        "profile_id",
        "doc_type_id",
        "decision",
        "detail_override",
        "status_override",
        "reason",
        "required_plan_id",
      ]),
    ].join("\n\n"),
  );
  writeFixture(
    root,
    CATALOG_PATHS[6],
    markdownTable(
      [
        "doc_type_id",
        "layer",
        "sub_doc",
        "category",
        "requirement_class",
        "applicability",
        "default_status",
        "source_doc_family",
        "authoring_source_path",
        "projection_table",
        "profile_controlled",
        "skip_reason_required",
      ],
      [
        [
          "DOC-L0-CHARTER",
          "L0",
          "charter",
          "planning",
          "core",
          "in_scope",
          "required",
          "vmodel-core",
          "docs/design/L0-planning/charter.md",
          "spec_defs",
          "false",
          "false",
        ],
      ],
    ),
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", "docs/governance"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=UT-TDD test",
      "-c",
      "user.email=ut-tdd-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "issue-only catalog fixture",
    ],
    { cwd: root, stdio: "ignore" },
  );
}

export function createTrackedIssueFixture() {
  const root = mkdtempSync(join(tmpdir(), "planret-s3-issue-catalog-"));
  roots.push(root);
  createIssueOnlyCatalogFixture(root);
  return { root, receipts: new GitAuthoringProvenance(root).receipts(CATALOG_PATHS) };
}

export function cleanupPlanretS3MigrationFixtures(): void {
  for (const root of roots.splice(0)) removeTestTree(root);
}

export function databaseState(db: HarnessDb) {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  const rows = Object.fromEntries(
    objects
      .filter((object) => object.type === "table")
      .map((object) => {
        const table = String(object.name);
        const quoted = `"${table.replaceAll('"', '""')}"`;
        const values = db
          .prepare(`SELECT * FROM ${quoted}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return [table, values];
      }),
  );
  return { objects, rows, userVersion: db.userVersion() };
}

export function withDbExec(
  db: HarnessDb,
  exec: HarnessDb["exec"],
  prepare: HarnessDb["prepare"] = (sql) => db.prepare(sql),
  setUserVersion: HarnessDb["setUserVersion"] = (version) => db.setUserVersion(version),
): HarnessDb {
  return {
    path: db.path,
    driver: db.driver,
    exec,
    prepare,
    userVersion: () => db.userVersion(),
    setUserVersion,
    close: () => {},
  };
}

export function edgeTableSql(db: HarnessDb): string {
  return String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(EDGE_TABLE)
      ?.sql,
  );
}

export function isTargetTableDrop(sql: string): boolean {
  const target = EDGE_TABLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifier =
    "(?:" + target + '|\\"' + target + '\\"|`' + target + "`|\\[" + target + "\\])";
  const schema = '(?:(?:main|\\"main\\"|`main`|\\[main\\])\\s*\\.\\s*)?';
  return new RegExp(
    `^DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+${schema}${identifier}\\s*;?$`,
    "i",
  ).test(sql.trim());
}

export function tableRows(db: HarnessDb, table: string): string[] {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  return db
    .prepare(`SELECT * FROM ${quoted}`)
    .all()
    .map((row) => JSON.stringify(row))
    .sort();
}

export function nonTargetState(state: ReturnType<typeof databaseState>) {
  return {
    objects: state.objects.filter((object) => object.tbl_name !== EDGE_TABLE),
    rows: Object.fromEntries(Object.entries(state.rows).filter(([table]) => table !== EDGE_TABLE)),
  };
}
