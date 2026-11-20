import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { selectSessionStartDigest } from "../../src/handover/session-start-digest.ts";
import { recommendSkillsForText } from "../../src/skill-engine/recommend.ts";
import { type HarnessDb, openHarnessDb } from "../../src/state-db/index.ts";
import { migrate } from "../../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../../src/state-db/projection-writer.ts";
import { clearRebuildableProjectionTables } from "../../src/state-db/sqlite-projection-rebuild.ts";
import { removeTestTree } from "../support/temp-tree.ts";
import {
  cleanupPlanretS3MigrationFixtures,
  createIssueOnlyCatalogFixture,
  createLegacyDatabase,
  databaseState,
} from "./plan-mechanism-retirement-s3-migration.ts";

/** L6 §3 の PLAN 用の表 9 件。 */
export const PLAN_TABLES = [
  "plan_registry",
  "schedule_entries",
  "activation_entries",
  "activation_schedule_reviews",
  "execution_readiness_projection",
  "roadmap_rollups",
  "roadmap_band_coverage",
  "roadmap_gate_progress",
  "github_review_lane_receipts",
] as const;
/** (g) の保存対象 12 表のうち Project V2 用の永続表 3 件。 */
export const PROJECT_TABLES = [
  "github_object_bindings",
  "github_project_item_projection",
  "github_projection_outbox",
] as const;
export const PRESERVED_TABLES = [...PLAN_TABLES, ...PROJECT_TABLES] as const;

const tableAlt = PLAN_TABLES.join("|");
const READER_FILES = [
  "src/elicitation/context.ts",
  "src/handover/session-start-digest.ts",
  "src/skill-engine/recommend.ts",
  "src/state-db/scope-preview.ts",
];

export interface Source {
  path: string;
  lines: string[];
}

export function sources(root: string): Source[] {
  const paths = execFileSync("git", ["ls-files", "src", "scripts", ".github"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  return paths.flatMap((path) => {
    try {
      return [{ path, lines: readFileSync(join(root, path), "utf8").split(/\r?\n/) }];
    } catch {
      return [];
    }
  });
}

function lineHits(root: string, pattern: RegExp, only?: string[]): string[] {
  return sources(root)
    .filter((s) => !only || only.includes(s.path))
    .flatMap((s) => s.lines.flatMap((l, i) => (pattern.test(l) ? [`${s.path}:${i + 1}`] : [])));
}

export const scanA = (root: string) => lineHits(root, new RegExp(String.raw`\b(${tableAlt})\b`));
export const scanB = (root: string) => lineHits(root, /harness-ledger/);
export const scanC = (root: string) =>
  lineHits(
    root,
    new RegExp(
      String.raw`\b(DROP\s+TABLE|VACUUM|DELETE\s+FROM)\b[^\n]*\b(${tableAlt}|harness-ledger)\b`,
      "i",
    ),
  );

const FS_CHECKS = new Set(["existsSync", "statSync", "lstatSync", "readdirSync", "accessSync"]);
const DOCS_PLANS = /docs(?:[/\\]+|["'`,\s]+)plans/;
const CODE_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** binding 名 (分割代入を含む) の識別子名。 */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

type Binding = { init: ts.Expression | undefined } | null;

/** scope node が「直接」持つ宣言から name を探す。入れ子の関数・ブロックへは潜らない。 */
function directBinding(scope: ts.Node, name: string): Binding {
  const fromList = (list: ts.VariableDeclarationList): Binding => {
    for (const d of list.declarations)
      if (bindingNames(d.name).includes(name))
        return { init: ts.isIdentifier(d.name) ? d.initializer : undefined };
    return null;
  };
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters)
      if (bindingNames(p.name).includes(name)) return { init: undefined };
    return null;
  }
  if (ts.isCatchClause(scope)) {
    const v = scope.variableDeclaration;
    return v && bindingNames(v.name).includes(name) ? { init: undefined } : null;
  }
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const i = scope.initializer;
    return i && ts.isVariableDeclarationList(i) ? fromList(i) : null;
  }
  const statements = ts.isCaseBlock(scope)
    ? scope.clauses.flatMap((c) => [...c.statements])
    : ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)
      ? [...scope.statements]
      : [];
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      const b = fromList(st.declarationList);
      if (b) return b;
    } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) return { init: undefined };
  }
  return null;
}

/** 参照の位置から外側へ scope をたどり、最初に見つかった束縛を返す (shadowing)。 */
function resolveBinding(id: ts.Identifier): Binding {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    const b = directBinding(n, id.text);
    if (b) return b;
  }
  return null;
}

/** 式 (と、式が参照する識別子の束縛の初期化式) に docs/plans が現れるか。 */
function reachesDocsPlans(node: ts.Node, seen = new Set<ts.Node>()): boolean {
  if (DOCS_PLANS.test(node.getText())) return true;
  const ids: ts.Identifier[] = [];
  const collect = (n: ts.Node): void => {
    const isPropName = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
    if (ts.isIdentifier(n) && !isPropName) ids.push(n);
    ts.forEachChild(n, collect);
  };
  collect(node);
  return ids.some((id) => {
    const init = resolveBinding(id)?.init;
    if (!init || seen.has(init)) return false;
    seen.add(init);
    return reachesDocsPlans(init, seen);
  });
}

/** 1 file の source から、docs/plans の実在を確かめる呼び出しの行 (1 始まり) を返す。 */
export function scanDSource(path: string, text: string): number[] {
  if (!CODE_FILE.test(path) || !/plans/.test(text)) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name.text
          : "";
      if (FS_CHECKS.has(callee) && n.arguments.some((a) => reachesDocsPlans(a))) {
        lines.push(file.getLineAndCharacterOfPosition(n.getStart()).line + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return lines;
}

export const scanD = (root: string) =>
  sources(root).flatMap((s) =>
    scanDSource(s.path, s.lines.join("\n")).map((line) => `${s.path}:${line}`),
  );
export const scanE = (root: string) => lineHits(root, /delete\w*ProjectV2\w*/i);
export const scanF = (root: string) => {
  const readers = lineHits(
    root,
    new RegExp(String.raw`\b(FROM|JOIN)\s+(${tableAlt})\b`, "i"),
    READER_FILES,
  );
  const writers = lineHits(root, /\b(verifiedReviewLaneDigests|projectGithubReviewLaneReceipts)\b/);
  const catchers = sources(root)
    .filter((s) => s.lines.some((l) => new RegExp(String.raw`\b(${tableAlt})\b`).test(l)))
    .flatMap((s) =>
      s.lines.flatMap((l, i) => (/no such table/i.test(l) ? [`${s.path}:${i + 1}`] : [])),
    );
  return [...readers, ...writers, ...catchers];
};

const roots: string[] = [];
const opened: HarnessDb[] = [];
export function cleanupPlanretS7Fixtures(): void {
  // Windows は開いたままの DB file を消せない (EPERM)。tree を消す前に閉じる。
  for (const db of opened.splice(0)) db.close();
  for (const root of roots.splice(0)) removeTestTree(root);
  // 旧 DB の root は s3 helper が所有する。db は上で閉じたので、ここで消してよい。
  cleanupPlanretS3MigrationFixtures();
}

function tempDb(): { root: string; db: HarnessDb } {
  const root = mkdtempSync(join(tmpdir(), "planret-s7-"));
  roots.push(root);
  mkdirSync(join(root, ".ut-tdd"), { recursive: true });
  const db = openHarnessDb(join(root, ".ut-tdd", "harness.db"), { repoRoot: root });
  opened.push(db);
  return { root, db };
}

function tableNamesOf(db: HarnessDb): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name)),
  );
}

/** 表ごとの { ddl, columns, rows }。存在しない表は null。 */
export function tableShape(db: HarnessDb, tables: readonly string[]) {
  const present = tableNamesOf(db);
  return Object.fromEntries(
    tables.map((t) => {
      if (!present.has(t)) return [t, null];
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t)?.sql;
      const columns = db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => String(c.name));
      const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0);
      return [t, { ddl, columns, rows: n }];
    }),
  );
}

/** 008: registry に無い plan_registry (3 行) と schedule_entries (2 行) を持つ DB。 */
export function runScenario008() {
  const { db } = tempDb();
  db.exec("CREATE TABLE plan_registry (plan_id TEXT PRIMARY KEY, legacy_note TEXT)");
  db.exec("CREATE TABLE schedule_entries (schedule_entry_id TEXT PRIMARY KEY, plan_id TEXT)");
  for (const id of ["PLAN-A", "PLAN-B", "PLAN-C"])
    db.prepare("INSERT INTO plan_registry (plan_id) VALUES (?)").run(id);
  for (const id of ["S-1", "S-2"])
    db.prepare("INSERT INTO schedule_entries (schedule_entry_id, plan_id) VALUES (?, ?)").run(
      id,
      "PLAN-A",
    );
  const names = ["plan_registry", "schedule_entries"];
  const before = tableShape(db, names);
  migrate(db);
  const second = migrate(db);
  clearRebuildableProjectionTables(db);
  return { before, after: tableShape(db, names), second, db };
}

/** 008: migrate のあとで 2 表を取り除いた DB (表が欠けていても registry 側が要求しないことの確認用)。 */
export function runScenario008Absent() {
  const { db } = tempDb();
  migrate(db);
  db.exec("PRAGMA foreign_keys = OFF");
  for (const t of ["schedule_entries", "plan_registry"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
  return db;
}

const emptyBackstop = { ok: true, detections: [], pagesScanned: 0 };

function outputs(db: HarnessDb) {
  return {
    recommend: recommendSkillsForText(db, "refactor the login module"),
    digest: selectSessionStartDigest(db, [], { postMergeBackstop: emptyBackstop }),
  };
}

/** (g): 新規 DB と旧表入り DB (PLAN 用の表に行あり) の出力・保存状態の比較。 */
export function runScenarioG() {
  const fresh = tempDb().db;
  migrate(fresh);
  const legacy = createLegacyDatabase().db;
  opened.push(legacy);
  legacy
    .prepare(
      `INSERT INTO schedule_entries (schedule_entry_id, plan_id, current_location, rag, status, source_path)
       VALUES ('SCH-LEGACY', 'PLAN-L6-01', 'L6', 'RED', 'active', 'docs/plans/PLAN-L6-01.md')`,
    )
    .run();
  const before = tableShape(legacy, PRESERVED_TABLES);
  migrate(legacy);
  const freshOut = outputs(fresh);
  const legacyOut = outputs(legacy);
  return {
    freshOut,
    legacyOut,
    leaked: JSON.stringify(legacyOut).includes("PLAN-L6-01"),
    before,
    after: tableShape(legacy, PRESERVED_TABLES),
  };
}

const SCALE_PROFILES_PATH = "docs/governance/vmodel-document-scale-profiles.md";
const table = (rows: readonly (readonly string[])[]) =>
  rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");

/** (j) の source: defer 行 (現行の入力契約が要る旧 ID 付き) と adopt 行を持つ document scale profile。投影先の required_plan_id は NULL でなければならない。 */
function writeScaleProfileSource(root: string): void {
  const profileHeader = [
    "profile_id",
    "profile_axis",
    "profile_rank",
    "description",
    "default_status",
    "default_detail",
    "scope_policy",
  ];
  const entryHeader = [
    "profile_id",
    "doc_type_id",
    "decision",
    "detail_override",
    "status_override",
    "reason",
    "required_plan_id",
  ];
  const sep = (header: readonly string[]) => header.map(() => "---");
  const body = [
    table([
      ["field", "value"],
      ["---", "---"],
      ["size_profile_count", "2"],
      ["product_profile_count", "0"],
      ["profile_count", "2"],
      ["decision_count", "2"],
    ]),
    table([
      profileHeader,
      sep(profileHeader),
      ["PLANRET-J-A", "size", "10", "defer fixture", "required", "standard", "minimal"],
      ["PLANRET-J-B", "size", "20", "adopt fixture", "required", "standard", "minimal"],
    ]),
    table([
      entryHeader,
      sep(entryHeader),
      ["PLANRET-J-A", "DOC-L0-CHARTER", "defer", "lite", "minimal", "Issue で追う", "PLAN-L6-01"],
      ["PLANRET-J-B", "DOC-L0-CHARTER", "adopt", "standard", "required", "採用", ""],
    ]),
  ].join("\n\n");
  writeFileSync(join(root, SCALE_PROFILES_PATH), `${body}\n`, "utf8");
  // catalog の provenance は tracked な commit と照合されるので、書き換えた source も commit する。
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, stdio: "ignore" });
  git("add", "--", SCALE_PROFILES_PATH);
  git(
    "-c",
    "user.name=UT-TDD test",
    "-c",
    "user.email=",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "document scale profile defer fixture",
  );
}

function projectScaleProfiles(root: string, db: HarnessDb) {
  // 保存対象 12 表は、migrate 後・rebuild の前後で DDL も行数も変わらない (rebuild の経路での保存違反を捕まえる)。
  const preservedBefore = tableShape(db, PRESERVED_TABLES);
  let thrown: string | null = null;
  try {
    rebuildHarnessDb({ repoRoot: root, db, skipTokenTelemetry: true });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  const preservedAfter = tableShape(db, PRESERVED_TABLES);
  const entries = db
    .prepare(
      `SELECT profile_id, doc_type_id, decision, required_plan_id
         FROM document_scale_profile_entries ORDER BY profile_id`,
    )
    .all()
    .map((r) => ({ ...r }));
  const reviewCount = Number(
    db.prepare("SELECT COUNT(*) AS n FROM document_scale_profile_reviews").get()?.n ?? 0,
  );
  const ddl = ddlOf(db);
  // 表そのものが defer + NULL を受けるか (旧 CHECK の有無) を、投影とは別に確かめる。
  // 投影済みの defer 行を NULL に UPDATE するので、FK と一意制約は保たれ、CHECK だけが効く。
  let deferNullUpdate: string | null = null;
  db.exec("SAVEPOINT planret_j_probe");
  try {
    db.prepare(
      "UPDATE document_scale_profile_entries SET required_plan_id = NULL WHERE decision = 'defer'",
    ).run();
    const n = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM document_scale_profile_entries
            WHERE decision = 'defer' AND required_plan_id IS NULL`,
        )
        .get()?.n ?? 0,
    );
    if (n !== 1) deferNullUpdate = `probe target is ${n} rows, expected 1`;
  } catch (error) {
    deferNullUpdate = error instanceof Error ? error.message : String(error);
  } finally {
    db.exec("ROLLBACK TO planret_j_probe");
    db.exec("RELEASE planret_j_probe");
  }
  // migrate の再適用は何も変えない。
  const beforeRemigrate = databaseState(db);
  const remigrate = migrate(db);
  const remigrateUnchanged = JSON.stringify(databaseState(db)) === JSON.stringify(beforeRemigrate);
  return {
    thrown,
    entries,
    reviewCount,
    ddl,
    deferNullUpdate,
    preservedBefore,
    preservedAfter,
    remigrateApplied: remigrate.applied,
    remigrateUnchanged,
  };
}

function ddlOf(db: HarnessDb): string {
  return String(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'document_scale_profile_entries'").get()
      ?.sql ?? "",
  );
}

const SEED_PLAN_ROW = `INSERT INTO schedule_entries
  (schedule_entry_id, plan_id, current_location, rag, status, source_path)
  VALUES ('SCH-LEGACY-J', 'PLAN-L6-01', 'L6', 'RED', 'active', 'docs/plans/PLAN-L6-01.md')`;

/**
 * 旧 CHECK を持つ現行版 (v30) の DB。v29 の frozen DDL から、v30 の変更 (vmodel_item_target_edges の再作成)
 * だけを手で当てて作る。`migrate` で作らないのは、Green の後の `migrate` が v30 を超えるためである。
 */
function createV30LegacyDatabase() {
  const legacy = createLegacyDatabase();
  opened.push(legacy.db);
  const ref = tempDb().db;
  migrate(ref);
  const edgeDdl = String(
    ref
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("vmodel_item_target_edges")?.sql ?? "",
  );
  legacy.db.exec("DROP TABLE vmodel_item_target_edges");
  legacy.db.exec(edgeDdl);
  legacy.db.setUserVersion(30);
  return legacy;
}

export type ScenarioJVariant = "fresh" | "v29" | "v30";

/**
 * (j): 新規 DB / 旧 CHECK 入り v29 / 旧 CHECK 入り v30 のそれぞれで、migrate してから、
 * 旧 ID 付き defer 行の source を rebuild で投影する。
 */
export function runScenarioJ(variant: ScenarioJVariant) {
  let target: { root: string; db: HarnessDb };
  if (variant === "fresh") {
    target = tempDb();
  } else if (variant === "v29") {
    target = createLegacyDatabase();
    opened.push(target.db);
  } else {
    target = createV30LegacyDatabase();
  }
  createIssueOnlyCatalogFixture(target.root);
  writeScaleProfileSource(target.root);
  const before =
    variant === "fresh" ? null : { ddl: ddlOf(target.db), version: target.db.userVersion() };
  if (variant !== "fresh") target.db.exec(SEED_PLAN_ROW);
  const migrated = migrate(target.db);
  const afterMigrate = {
    applied: migrated.applied,
    version: target.db.userVersion(),
    ddl: ddlOf(target.db),
  };
  return { before, afterMigrate, ...projectScaleProfiles(target.root, target.db) };
}
