import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { GitAuthoringProvenance } from "../../src/disposition/adapters/git-authoring-provenance.ts";
import { parseStrictMarkdownTable } from "../../src/disposition/adapters/strict-markdown-table.ts";
import { buildTrackedTargetRegistry } from "../../src/disposition/adapters/tracked-target-registry.ts";
import { loadTrackedCatalogInput } from "../../src/disposition/adapters/tracked-vmodel-loader.ts";
import {
  reconcileDispositionTarget,
  resolveCanonicalTarget,
  type TargetKind,
} from "../../src/disposition/domain/target-resolver.ts";
import { openHarnessDb } from "../../src/state-db/index.ts";
import { migrate } from "../../src/state-db/migration.ts";
import { projectVmodelAuthoring } from "../../src/state-db/vmodel-projections.ts";
import { heavyAfterAll, heavyBeforeAll } from "../support/hook-bounds.ts";
import { headSnapshotRoot } from "../support/workspace-roots.ts";

const issueOnlyCatalogPaths = [
  "docs/governance/vmodel-source-manifest.md",
  "docs/governance/vmodel-document-disposition-catalog.md",
  "docs/governance/vmodel-semantic-item-catalog.md",
  "docs/governance/vmodel-source-target-edges.md",
  "docs/governance/vmodel-item-target-ledger.md",
] as const;

const projectionSupportPaths = [
  "docs/governance/vmodel-document-scale-profiles.md",
  "docs/governance/vmodel-document-catalog.md",
] as const;

const issueOnlyTargetHeaders = [
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
] as const;

let issueOnlyFixtureRoot: string;

heavyBeforeAll(["db", 120000], () => {
  issueOnlyFixtureRoot = createIssueOnlyFixture();
}); // 48s measured, bounded per #1063

heavyAfterAll("teardown", () => {
  if (issueOnlyFixtureRoot) rmSync(issueOnlyFixtureRoot, { recursive: true, force: true });
});

describe("U-DISPPTR-001 issue-only projection", () => {
  it("precondition: issue-only ledger has 163 complete authored target rows", () => {
    const rows = authoredIssueOnlyTargetRows(issueOnlyFixtureRoot);
    expect(rows).toHaveLength(163);
    expect(new Set(rows.map((row) => row.edge_id)).size).toBe(163);
    expect(new Set(rows.map((row) => row.item_id)).size).toBe(163);
    expect(rows.every((row) => row.target_status === "pending_review")).toBe(true);
    expect(rows.every((row) => row.target_kind === null)).toBe(true);
    expect(rows.every((row) => row.target_ref === null)).toBe(true);
    expect(rows.every((row) => row.issue === null)).toBe(true);
    expect(
      projectionSupportPaths.every((path) => existsSync(join(issueOnlyFixtureRoot, path))),
    ).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.edge_id.length > 0 &&
          row.item_id.length > 0 &&
          row.reason.length > 0 &&
          row.source_digest.length > 0,
      ),
    ).toBe(true);
    const normalizedTempDirectory = resolve(tmpdir());
    const normalizedFixtureRoot = resolve(issueOnlyFixtureRoot);
    const fixtureRelativePath = relative(normalizedTempDirectory, normalizedFixtureRoot);
    expect(fixtureRelativePath).not.toBe("");
    expect(fixtureRelativePath).not.toBe("..");
    expect(fixtureRelativePath.startsWith(`..${sep}`)).toBe(false);
    expect(isAbsolute(fixtureRelativePath)).toBe(false);
  });

  it("precondition: tracked source targets exist and resolve in the fixture", () => {
    const targets = parseStrictMarkdownTable(
      readFileSync(join(issueOnlyFixtureRoot, "docs/governance/vmodel-source-target-edges.md")),
      {
        subjectId: "docs/governance/vmodel-source-target-edges.md",
        expectedHeaders: ["edge_id", "source_id", "disposition", "target_type", "target_ref"],
      },
    );
    const dispositions = parseStrictMarkdownTable(
      readFileSync(
        join(issueOnlyFixtureRoot, "docs/governance/vmodel-document-disposition-catalog.md"),
      ),
      {
        subjectId: "docs/governance/vmodel-document-disposition-catalog.md",
        expectedHeaders: [
          "source_id",
          "source_title",
          "disposition",
          "target",
          "profile / 判断理由",
        ],
      },
    );
    if (!targets.ok) throw new Error(JSON.stringify(targets.findings));
    if (!dispositions.ok) throw new Error(JSON.stringify(dispositions.findings));
    const families = targets.rows
      .filter((row) => row.target_type === "artifact_family")
      .map((row) => row.target_ref);
    const registry = buildTrackedTargetRegistry(issueOnlyFixtureRoot, families);
    const resolvedEdges = targets.rows.map((row) =>
      resolveCanonicalTarget(
        { kind: row.target_type as TargetKind, ref: row.target_ref },
        registry,
      ),
    );
    expect(targets.rows.length).toBeGreaterThan(0);
    expect(resolvedEdges.every((result) => result.ok)).toBe(true);
    for (const source of dispositions.rows) {
      const edges = targets.rows.filter((edge) => edge.source_id === source.source_id);
      if (edges.length !== 1) continue;
      expect(
        reconcileDispositionTarget(
          {
            displayRef: source.target,
            edge: { kind: edges[0].target_type as TargetKind, ref: edges[0].target_ref },
          },
          registry,
        ).ok,
      ).toBe(true);
    }
  });

  it("loads the issue-only item-target ledger without a plan_id header", () => {
    const bundle = Object.fromEntries(
      issueOnlyCatalogPaths.map((catalogPath) => [
        catalogPath,
        readFileSync(join(issueOnlyFixtureRoot, catalogPath)),
      ]),
    );
    const receipts = new GitAuthoringProvenance(issueOnlyFixtureRoot).receipts(
      issueOnlyCatalogPaths,
    );
    let loadFailure: unknown;
    let loaded: ReturnType<typeof loadTrackedCatalogInput> | undefined;
    try {
      loaded = loadTrackedCatalogInput(bundle, receipts);
    } catch (error) {
      loadFailure = error;
    }
    expect(loadFailure).toBeUndefined();
    expect(loaded?.itemTargetEdges).toHaveLength(163);
  });

  it("projects every issue-only target column unchanged", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const expected = authoredIssueOnlyTargetRows(issueOnlyFixtureRoot);
      let projectionFailure: unknown;
      try {
        projectVmodelAuthoring(issueOnlyFixtureRoot, db);
      } catch (error) {
        projectionFailure = error;
      }
      expect(projectionFailure).toBeUndefined();
      expect(
        Number(db.prepare("SELECT COUNT(*) AS count FROM vmodel_semantic_items").get()?.count ?? 0),
      ).toBe(163);
      expect(
        Number(
          db.prepare("SELECT COUNT(*) AS count FROM vmodel_item_target_edges").get()?.count ?? 0,
        ),
      ).toBe(163);
      const itemTargetColumns = db
        .prepare("PRAGMA table_info(vmodel_item_target_edges)")
        .all()
        .map((column) => column.name);
      expect(itemTargetColumns).toContain("issue");
      expect(itemTargetColumns).not.toContain("plan_id");
      expect(itemTargetColumns).not.toContain("design_path");
      const projectedTargets = db
        .prepare(
          `SELECT edge_id, item_id, target_status, target_kind, target_ref, issue, reason, source_digest
           FROM vmodel_item_target_edges ORDER BY edge_id`,
        )
        .all();
      expect(projectedTargets).toEqual(expected);
    } finally {
      db.close();
    }
  });
});

function authoredIssueOnlyTargetRows(rootDirectory: string) {
  const ledgerRelativePath = "docs/governance/vmodel-item-target-ledger.md";
  const parsed = parseStrictMarkdownTable(
    new TextEncoder().encode(readFileSync(join(rootDirectory, ledgerRelativePath), "utf8")),
    { subjectId: ledgerRelativePath, expectedHeaders: issueOnlyTargetHeaders, expectedRows: 163 },
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings));
  const optionalValue = (value: string) => (value === "—" ? null : value);
  return parsed.rows
    .map((row) => ({
      edge_id: row.edge_id,
      item_id: row.item_id,
      target_status: row.target_status,
      target_kind: optionalValue(row.target_kind),
      target_ref: optionalValue(row.target_ref),
      issue: optionalValue(row.issue),
      reason: row.判断理由,
      source_digest: row.source_digest,
    }))
    .sort((left, right) => left.edge_id.localeCompare(right.edge_id));
}

function createIssueOnlyFixture(): string {
  const snapshotRoot = headSnapshotRoot();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ut-1375-issue-only-projection-"));
  try {
    const plansRoot = join(snapshotRoot, "docs", "plans");
    cpSync(join(snapshotRoot, "docs"), join(fixtureRoot, "docs"), {
      recursive: true,
      filter: (source) => source !== plansRoot && !source.startsWith(`${plansRoot}${sep}`),
    });
    const makeDirectoriesWritable = (directory: string): void => {
      chmodSync(directory, 0o755);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) makeDirectoriesWritable(join(directory, entry.name));
      }
    };
    makeDirectoriesWritable(join(fixtureRoot, "docs"));
    const issueOnlyLedgerFile = join(fixtureRoot, "docs/governance/vmodel-item-target-ledger.md");
    const originalLedger = readFileSync(issueOnlyLedgerFile, "utf8");
    if (!/\|\s*判断理由\s*\|\s*issue\s*\|/.test(originalLedger)) {
      throw new Error("issue-only fixture requires the issue header");
    }
    execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot, stdio: "ignore" });
    execFileSync("git", ["add", "--", "docs"], { cwd: fixtureRoot, stdio: "ignore" });
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
        "issue-only projection fixture",
      ],
      { cwd: fixtureRoot, stdio: "ignore" },
    );
    return fixtureRoot;
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}
