import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { GitAuthoringProvenance } from "../../src/disposition/adapters/git-authoring-provenance.ts";
import { loadTrackedCatalogInput } from "../../src/disposition/adapters/tracked-vmodel-loader.ts";
import { DocumentDispositionCatalog } from "../../src/disposition/domain/document-disposition-catalog.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";
import { migrate } from "../../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../../src/state-db/projection-writer.ts";
import { projectVmodelAuthoring } from "../../src/state-db/vmodel-projections.ts";
import {
  heavyAfterAll,
  heavyAfterEach,
  heavyBeforeAll,
  heavyBeforeEach,
} from "../support/hook-bounds.ts";
import { removeTestTree } from "../support/temp-tree.ts";
import { headSnapshotRoot } from "../support/workspace-roots.ts";

const tables = [
  "vmodel_sources",
  "vmodel_categories",
  "vmodel_meta_source_mappings",
  "vmodel_semantic_items",
  "vmodel_source_item_edges",
  "vmodel_source_target_edges",
  "vmodel_item_target_edges",
  "document_scale_profiles",
] as const;
const repoRoot = headSnapshotRoot();

describe("I-DISP-001 V-model projection", () => {
  it("materializes exact tracked identities and is a delete/rebuild fixed point", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectVmodelAuthoring(repoRoot, db);
      expect(count(db, "vmodel_sources")).toBe(109);
      expect(count(db, "vmodel_categories")).toBe(21);
      expect(count(db, "vmodel_meta_source_mappings")).toBe(1);
      expect(count(db, "vmodel_semantic_items")).toBe(163);
      expect(count(db, "vmodel_item_target_edges")).toBe(163);
      expect(
        Number(
          db
            .prepare("SELECT COUNT(*) AS count FROM findings WHERE source = ?")
            .get("vmodel-item-target")?.count ?? 0,
        ),
      ).toBe(163);
      expect(count(db, "document_scale_profiles")).toBe(8);
      const first = snapshot(db);
      projectVmodelAuthoring(repoRoot, db);
      expect(snapshot(db)).toEqual(first);
      clear(db);
      projectVmodelAuthoring(repoRoot, db);
      expect(snapshot(db)).toEqual(first);
    } finally {
      db.close();
    }
  });

  describe("CANDIDATE-U-DISPPTR-007 rebuild boundary", () => {
    const targetPath = "docs/design/harness/L0-planning/charter.md";
    const alternatePath = "docs/design/harness/L4-basic-design/architecture.md";
    const dispositionPath = "docs/governance/vmodel-document-disposition-catalog.md";
    const sourceTargetPath = "docs/governance/vmodel-source-target-edges.md";
    let tempRoot: string;
    let negativeRoot: string;
    let originalDisposition: string;
    let originalSourceTargets: string;

    heavyBeforeAll(["db", 120000], () => {
      tempRoot = createDocsGitFixture({ ensureTracked: targetPath });
      negativeRoot = createDocsGitFixture({ ensureTracked: targetPath });
      originalDisposition = readFileSync(join(negativeRoot, dispositionPath), "utf8");
      originalSourceTargets = readFileSync(join(negativeRoot, sourceTargetPath), "utf8");
    }); // 54s measured, bounded per #1063

    heavyAfterAll("teardown", () => {
      removeTestTree(tempRoot);
      removeTestTree(negativeRoot);
    });

    it("rebuilds the normal fixture through V-model and spec-IR projections", () => {
      const db = openHarnessDb(":memory:");
      try {
        const result = rebuildFixture(tempRoot, db);
        expect(result.ok).toBe(true);
        expect(
          db
            .prepare(
              "SELECT authoring_source_path, projection_table FROM document_catalog_entries WHERE doc_type_id = ?",
            )
            .get("DOC-L0-CHARTER"),
        ).toMatchObject({
          authoring_source_path: targetPath,
          projection_table: "spec_defs",
        });
        expect(
          db
            .prepare(
              "SELECT edge_id, target_type, target_ref FROM vmodel_source_target_edges WHERE edge_id IN (?, ?) ORDER BY edge_id",
            )
            .all("EDGE-001", "EDGE-071"),
        ).toEqual([
          { edge_id: "EDGE-001", target_type: "artifact_path", target_ref: targetPath },
          { edge_id: "EDGE-071", target_type: "artifact_path", target_ref: targetPath },
        ]);
        expect(count(db, "spec_defs")).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });

    describe("ID/slot-only binding", () => {
      heavyBeforeEach("db", () => {
        prepareFixtureCatalogEdits(negativeRoot, [
          { path: dispositionPath, rowId: "ZIP-DOC-001", cells: { 4: "`DOC-L0-CHARTER`" } },
          { path: dispositionPath, rowId: "ZIP-DOC-071", cells: { 4: "`DOC-L0-CHARTER`" } },
          {
            path: sourceTargetPath,
            rowId: "EDGE-001",
            cells: { 4: "`target_slot`", 5: "`DOC-L0-CHARTER`" },
          },
          {
            path: sourceTargetPath,
            rowId: "EDGE-071",
            cells: { 4: "`target_slot`", 5: "`DOC-L0-CHARTER`" },
          },
        ]);
      });

      heavyAfterEach("db", () =>
        restoreFixtureCatalog(
          negativeRoot,
          dispositionPath,
          sourceTargetPath,
          originalDisposition,
          originalSourceTargets,
        ),
      );

      it.fails("rejects slot-only ZIP-DOC-001/071 bindings after a valid physical-path rebuild", () => {
        expectRebuildRejectsWithoutChangingProjection(tempRoot, negativeRoot);
      });
    });

    describe("different tracked path", () => {
      heavyBeforeEach("db", () => {
        prepareFixtureCatalogEdits(
          negativeRoot,
          [
            { path: dispositionPath, rowId: "ZIP-DOC-001", cells: { 4: `\`${alternatePath}\`` } },
            { path: dispositionPath, rowId: "ZIP-DOC-071", cells: { 4: `\`${alternatePath}\`` } },
            {
              path: sourceTargetPath,
              rowId: "EDGE-001",
              cells: { 5: `\`${alternatePath}\`` },
            },
            {
              path: sourceTargetPath,
              rowId: "EDGE-071",
              cells: { 5: `\`${alternatePath}\`` },
            },
          ],
          alternatePath,
        );
      });

      heavyAfterEach("db", () =>
        restoreFixtureCatalog(
          negativeRoot,
          dispositionPath,
          sourceTargetPath,
          originalDisposition,
          originalSourceTargets,
        ),
      );

      it.fails("rejects ZIP-DOC-001/071 bindings to another tracked regular file after baseline rebuild", () => {
        expectRebuildRejectsWithoutChangingProjection(tempRoot, negativeRoot);
      });
    });

    it.fails("rejects a tracked charter target whose physical entity is missing and preserves committed projections", () => {
      const db = openHarnessDb(":memory:");
      try {
        const baseline = rebuildFixture(tempRoot, db);
        expect(baseline.ok).toBe(true);
        const before = rebuildProjectionSnapshot(db);
        rmSync(join(tempRoot, targetPath));

        let rebuildFailure: unknown;
        try {
          // No test-owned transaction: the real rebuild must reject inside its
          // projection transaction and preserve the earlier committed snapshot.
          rebuildFixture(tempRoot, db);
        } catch (error) {
          rebuildFailure = error;
        }

        expect(rebuildFailure).toBeInstanceOf(Error);
        expect(rebuildProjectionSnapshot(db)).toEqual(before);
      } finally {
        db.close();
      }
    });
  });

  it("rolls back deletion when tracked provenance is tampered", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      projectVmodelAuthoring(repoRoot, db);
      const before = snapshot(db);
      const provenance = new GitAuthoringProvenance(repoRoot);
      let projectionFailure: unknown;
      db.exec("BEGIN IMMEDIATE");
      try {
        clear(db);
        projectVmodelAuthoring(repoRoot, db, {
          provenance,
          read: (path) =>
            path.endsWith("vmodel-source-manifest.md")
              ? new TextEncoder().encode("tampered")
              : readFileSync(path),
        });
      } catch (error) {
        projectionFailure = error;
      } finally {
        db.exec("ROLLBACK");
      }
      expect(projectionFailure).toBeInstanceOf(Error);
      expect(String(projectionFailure)).toContain("catalog-provenance-invalid");
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

function count(db: ReturnType<typeof openHarnessDb>, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function snapshot(db: ReturnType<typeof openHarnessDb>) {
  return {
    ...Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
    ),
    findings: db
      .prepare("SELECT * FROM findings WHERE source = ? ORDER BY finding_id")
      .all("vmodel-item-target"),
  };
}

function rebuildProjectionSnapshot(db: ReturnType<typeof openHarnessDb>) {
  const projectionTables = [...tables, "document_catalog_entries", "spec_defs"];
  return Object.fromEntries(
    projectionTables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
  );
}

function expectCharterEdges(db: ReturnType<typeof openHarnessDb>, targetPath: string): void {
  expect(
    db
      .prepare(
        "SELECT edge_id, target_type, target_ref FROM vmodel_source_target_edges WHERE edge_id IN (?, ?) ORDER BY edge_id",
      )
      .all("EDGE-001", "EDGE-071"),
  ).toEqual([
    { edge_id: "EDGE-001", target_type: "artifact_path", target_ref: targetPath },
    { edge_id: "EDGE-071", target_type: "artifact_path", target_ref: targetPath },
  ]);
}

const trackedCatalogPaths = [
  "docs/governance/vmodel-source-manifest.md",
  "docs/governance/vmodel-document-disposition-catalog.md",
  "docs/governance/vmodel-semantic-item-catalog.md",
  "docs/governance/vmodel-source-target-edges.md",
  "docs/governance/vmodel-item-target-ledger.md",
] as const;

function prepareFixtureCatalogEdits(
  root: string,
  edits: Array<{ path: string; rowId: string; cells: Record<number, string> }>,
  expectedTrackedRegularPath?: string,
): void {
  const paths = [...new Set(edits.map((edit) => edit.path))];
  for (const path of paths) chmodSync(join(root, path), 0o644);
  for (const edit of edits) updateFixtureTableRow(root, edit);
  execFileSync("git", ["add", "--", ...paths], { cwd: root, stdio: "ignore" });
  commitFixtureIndex(root);
  expect(
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    }),
  ).toBe("");
  validateTrackedFixtureCatalog(root);
  if (expectedTrackedRegularPath) {
    const absolutePath = join(root, expectedTrackedRegularPath);
    expect(lstatSync(absolutePath).isFile()).toBe(true);
    expect(
      execFileSync("git", ["ls-files", "--stage", "--", expectedTrackedRegularPath], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toMatch(/^100644\s/m);
  }
}

function restoreFixtureCatalog(
  root: string,
  dispositionPath: string,
  sourceTargetPath: string,
  originalDisposition: string,
  originalSourceTargets: string,
): void {
  for (const path of [dispositionPath, sourceTargetPath]) chmodSync(join(root, path), 0o644);
  writeFileSync(join(root, dispositionPath), originalDisposition, "utf8");
  writeFileSync(join(root, sourceTargetPath), originalSourceTargets, "utf8");
  execFileSync("git", ["add", "--", dispositionPath, sourceTargetPath], {
    cwd: root,
    stdio: "ignore",
  });
  commitFixtureIndex(root);
  expect(
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    }),
  ).toBe("");
  validateTrackedFixtureCatalog(root);
}

function validateTrackedFixtureCatalog(root: string): void {
  const bundle = Object.fromEntries(
    trackedCatalogPaths.map((path) => [path, readFileSync(join(root, path))]),
  );
  const input = loadTrackedCatalogInput(
    bundle,
    new GitAuthoringProvenance(root).receipts(trackedCatalogPaths),
  );
  expect(DocumentDispositionCatalog.create(input).ok).toBe(true);
}

function expectRebuildRejectsWithoutChangingProjection(
  baselineRoot: string,
  negativeRoot: string,
): void {
  const db = openHarnessDb(":memory:");
  try {
    const baseline = rebuildFixture(baselineRoot, db);
    expect(baseline.ok).toBe(true);
    expectCharterEdges(db, "docs/design/harness/L0-planning/charter.md");
    const before = rebuildProjectionSnapshot(db);

    let rebuildFailure: unknown;
    try {
      rebuildFixture(negativeRoot, db);
    } catch (error) {
      rebuildFailure = error;
    }
    expect(rebuildFailure).toBeInstanceOf(Error);
    expect(rebuildProjectionSnapshot(db)).toEqual(before);
  } finally {
    db.close();
  }
}

function updateFixtureTableRow(
  root: string,
  edit: { path: string; rowId: string; cells: Record<number, string> },
): void {
  const path = join(root, edit.path);
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => {
    const firstCell = line.split("|")[1]?.trim().replace(/^`|`$/g, "");
    return firstCell === edit.rowId;
  });
  if (lineIndex < 0) throw new Error(`fixture row not found: ${edit.path} ${edit.rowId}`);
  const cells = lines[lineIndex].split("|");
  for (const [index, value] of Object.entries(edit.cells)) {
    const cellIndex = Number(index);
    if (cellIndex >= cells.length - 1) throw new Error(`fixture cell out of range: ${index}`);
    cells[cellIndex] = ` ${value} `;
  }
  lines[lineIndex] = cells.join("|");
  writeFileSync(path, lines.join("\n"), "utf8");
}

function rebuildFixture(root: string, db: ReturnType<typeof openHarnessDb>) {
  return rebuildHarnessDb({
    repoRoot: root,
    db,
    skipTokenTelemetry: true,
    relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
    documentExports: {
      document_export_runs: [],
      document_export_datasets: [],
      document_export_artifacts: [],
      findings: [],
      actionsTaken: [],
      ok: true,
    },
  });
}

function clear(db: ReturnType<typeof openHarnessDb>): void {
  for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${table}`);
  db.prepare("DELETE FROM findings WHERE source = ?").run("vmodel-item-target");
}

function createDocsGitFixture(fixtureOptions: { ensureTracked?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "ut-t1-disposition-target-fixture-"));
  const plansRoot = join(repoRoot, "docs", "plans");
  cpSync(join(repoRoot, "docs"), join(root, "docs"), {
    recursive: true,
    filter: (source) => source !== plansRoot && !source.startsWith(`${plansRoot}${sep}`),
  });
  const makeDirectoriesWritable = (directory: string): void => {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) makeDirectoriesWritable(join(directory, entry.name));
    }
  };
  makeDirectoriesWritable(join(root, "docs"));
  const legacyPlanPath = "docs/plans/PLAN-L7-417-source-disposition-profile-projection.md";
  const destination = join(root, legacyPlanPath);
  mkdirSync(dirname(destination), { recursive: true });
  // This legacy PLAN is fixture-only; keep the test independent of the source-repo copy.
  writeFileSync(
    destination,
    [
      "---",
      "plan_id: PLAN-L7-417-source-disposition-profile-projection",
      'title: "PLAN-L7-417 (add-impl): source disposition / semantic catalog / profile projection"',
      "kind: add-impl",
      "layer: L7",
      "drive: db",
      "status: confirmed",
      "route_mode: add-feature",
      "created: 2026-07-10",
      "updated: 2026-07-10",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  if (fixtureOptions.ensureTracked) {
    const extraPath = join(root, fixtureOptions.ensureTracked);
    if (!existsSync(extraPath)) {
      // Small missing-file fixtures are added to the Git index before the
      // worktree entry is removed by the calling test.
      mkdirSync(dirname(extraPath), { recursive: true });
      writeFileSync(extraPath, "tracked fixture path\n", "utf8");
    }
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, ".gitignore"), "/.ut-tdd/logs/feedback-lifecycle.jsonl\n", "utf8");
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "docs", ".gitignore"], {
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
      "test fixture",
    ],
    { cwd: root, stdio: "ignore" },
  );
  return root;
}

function commitFixtureIndex(root: string): void {
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
      "add disposition target boundary fixtures",
    ],
    { cwd: root, stdio: "ignore" },
  );
}
