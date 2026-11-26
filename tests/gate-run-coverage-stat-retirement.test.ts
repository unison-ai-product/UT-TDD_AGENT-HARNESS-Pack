import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadGateRunCoverageStats } from "../src/doctor/gate-run-coverage-reconciliation.ts";
import { checkGateRunCoverage } from "../src/doctor/process-quality.ts";
import * as stateDb from "../src/state-db/index.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const EVIDENCE_PATH = ".ut-tdd/gate_runs/gate-run.json";
const CHECKED_AT = "2026-11-24T00:00:00.000Z";

function newRepo(label: string): string {
  return mkdtempSync(join(tmpdir(), `ut-tdd-grcov-${label}-`));
}

function writeEvidence(
  repoRoot: string,
  input: { malformed?: boolean; gateRunId?: string; planId?: string | null } = {},
  evidencePath = EVIDENCE_PATH,
): void {
  const path = join(repoRoot, ...evidencePath.split("/"));
  mkdirSync(join(repoRoot, ".ut-tdd", "gate_runs"), { recursive: true });
  if (input.malformed) {
    writeFileSync(path, "{not-json\n", "utf8");
    return;
  }
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: 1,
      gate_run_id: input.gateRunId ?? "gate-run:grcov-fixture",
      gate_id: "G4",
      plan_id: input.planId ?? null,
      status: "passed",
      checked_at: CHECKED_AT,
      session_id: "session-grcov-fixture",
      mode: "hybrid",
      tier: "cross_agent",
      review_kind: "cross_agent",
      static_applicable: true,
      source: "ut-tdd gate",
      messages: [],
    })}\n`,
    "utf8",
  );
}

function observeStats(repoRoot: string): {
  stats: ReturnType<typeof loadGateRunCoverageStats>;
  statements: string[];
} {
  const statements: string[] = [];
  const open = stateDb.openHarnessDb;
  const spy = vi.spyOn(stateDb, "openHarnessDb").mockImplementation((path, options) => {
    const db = open(path, options);
    return {
      ...db,
      prepare(sql) {
        statements.push(sql);
        return db.prepare(sql);
      },
    };
  });
  try {
    return { stats: loadGateRunCoverageStats(repoRoot), statements };
  } finally {
    spy.mockRestore();
  }
}

function statsKeys(stats: object): string[] {
  return Object.keys(stats).sort();
}

function projection(repoRoot: string): {
  gateRuns: Record<string, unknown>[];
  workflows: Record<string, unknown>[];
} {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    return {
      gateRuns: db.prepare("SELECT * FROM gate_runs ORDER BY gate_run_id").all(),
      workflows: db
        .prepare(
          "SELECT * FROM workflow_runs WHERE workflow = 'routine-gate' ORDER BY workflow_run_id",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

function coverageReasons(): string[] {
  const sourcePath = join(headSnapshotRoot(), "src/lint/gate-run-coverage.ts");
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violation = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "GateRunCoverageViolation",
  );
  const reason = violation?.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "reason",
  );
  if (!reason?.type || !ts.isUnionTypeNode(reason.type)) {
    throw new Error("GateRunCoverageViolation.reason must declare a union");
  }
  return reason.type.types.map((member) => {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      throw new Error("GateRunCoverageViolation.reason must enumerate string literals");
    }
    return member.literal.text;
  });
}

describe("gate-run coverage stat retirement candidates", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) removeTestTree(root);
  });

  it("U-GRCOV-001 retires the unused stats field and filtered PLAN count", () => {
    const successfulRoot = newRepo("001-success");
    const existingFailureRoot = newRepo("001-existing-failure");
    const freshFailureRoot = newRepo("001-fresh-failure");
    roots.push(successfulRoot, existingFailureRoot, freshFailureRoot);

    writeEvidence(successfulRoot);
    const successful = observeStats(successfulRoot);
    expect(successful.stats.gateRuns).toBeGreaterThan(0);
    expect(successful.stats.workflowRuns).toBeGreaterThan(0);

    writeEvidence(existingFailureRoot);
    expect(checkGateRunCoverage(existingFailureRoot).ok).toBe(true);
    const existingDb = openHarnessDb(defaultHarnessDbPath(existingFailureRoot), {
      repoRoot: existingFailureRoot,
    });
    try {
      existingDb.prepare("UPDATE gate_runs SET status = 'failed'").run();
    } finally {
      existingDb.close();
    }
    const existingFailure = observeStats(existingFailureRoot);
    expect.soft(existingFailure.stats.orphanGateRuns).toBe(1);
    expect.soft(existingFailure.statements).toContain("SELECT COUNT(*) AS value FROM gate_runs");
    expect
      .soft(existingFailure.statements)
      .toContain("SELECT COUNT(*) AS value FROM workflow_runs");

    writeEvidence(freshFailureRoot, { malformed: true });
    const freshFailure = observeStats(freshFailureRoot);
    expect(freshFailure.stats.invalidEvidenceFindings).toBe(1);
    expect(freshFailure.stats.gateRuns).toBe(0);
    expect(freshFailure.stats.workflowRuns).toBe(0);

    const expectedKeys = [
      "gateRuns",
      "workflowRuns",
      "workflowPlansWithoutGateRun",
      "orphanGateRuns",
      "invalidEvidenceFindings",
    ].sort();
    for (const { stats } of [successful, existingFailure, freshFailure]) {
      expect.soft(statsKeys(stats)).toEqual(expectedKeys);
    }
    expect.soft(successful.statements).toContain("SELECT COUNT(*) AS value FROM gate_runs");
    expect.soft(successful.statements).toContain("SELECT COUNT(*) AS value FROM workflow_runs");
    const allStatements = [
      ...successful.statements,
      ...existingFailure.statements,
      ...freshFailure.statements,
    ];
    expect
      .soft(allStatements)
      .not.toContain("SELECT COUNT(*) AS value FROM gate_runs WHERE COALESCE(plan_id, '') = ''");
  });

  it("U-GRCOV-002 preserves PLAN NULL/empty decisions and mismatch rollback", () => {
    const root = newRepo("002");
    roots.push(root);
    const gateRunId = "gate-run:grcov-plan-compatibility";
    writeEvidence(root, { gateRunId, planId: null });
    const initial = checkGateRunCoverage(root);
    expect(initial.ok).toBe(true);
    expect(projection(root).gateRuns[0]?.plan_id).toBeNull();
    expect(projection(root).workflows[0]?.plan_id).toBeNull();

    const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
    try {
      db.prepare("UPDATE gate_runs SET plan_id = '' WHERE gate_run_id = ?").run(gateRunId);
      db.prepare("UPDATE workflow_runs SET plan_id = '' WHERE workflow = 'routine-gate'").run();
    } finally {
      db.close();
    }
    const legacyEmpty = checkGateRunCoverage(root);
    expect(legacyEmpty.ok).toBe(true);
    expect(projection(root).gateRuns[0]?.plan_id).toBe("");
    expect(projection(root).workflows[0]?.plan_id).toBe("");

    const mismatchDb = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
    try {
      mismatchDb.prepare("DELETE FROM workflow_runs WHERE workflow = 'routine-gate'").run();
    } finally {
      mismatchDb.close();
    }
    writeEvidence(root, { gateRunId: "gate-run:grcov-pending" }, ".ut-tdd/gate_runs/pending.json");
    const beforeCheck = projection(root);
    expect(beforeCheck.gateRuns).toHaveLength(1);
    expect(beforeCheck.workflows).toHaveLength(0);
    const rejected = checkGateRunCoverage(root);
    expect(rejected.ok).toBe(false);
    expect(rejected.messages.join("\n")).toContain("orphan_gate_run=1");
    expect(projection(root)).toEqual(beforeCheck);

    writeEvidence(root, { malformed: true });
    const invalid = checkGateRunCoverage(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.messages.join("\n")).toContain("invalid_gate_run_evidence=1");
    expect(projection(root)).toEqual(beforeCheck);
  });

  it("finds active violations in the declared gate-run coverage reason union", () => {
    expect(coverageReasons()).toEqual(
      expect.arrayContaining(["orphan_gate_run", "invalid_gate_run_evidence"]),
    );
  });

  it("U-GRCOV-003 removes the retired literal from the reason union", () => {
    expect(coverageReasons()).not.toContain("blank_plan_gate_run");
  });
});
