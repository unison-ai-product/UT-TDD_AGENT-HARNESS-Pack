import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkGateRunCoverage } from "../src/doctor/process-quality.ts";
import { stableId } from "../src/stable-id.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const EVIDENCE_PATH = ".ut-tdd/gate_runs/gate-run.json";
const DESIGN_PATH = "docs/design/harness/L6-function-design/bootstrap-retry-fixture.md";
const GATE_RUN_ID = "gate-run:bootstrap-retry-fixture";
const GATE_ID = "G4";
const CHECKED_AT = "2026-11-20T00:00:00.000Z";

type GateWorkflowProjection = {
  gateRuns: Record<string, unknown>[];
  workflows: Record<string, unknown>[];
  designArtifacts: Record<string, unknown>[];
  unrelatedArtifacts: Record<string, unknown>[];
};

type DatabaseState = {
  userVersion: number;
  applicationTables: string[];
  populatedApplicationTables: string[];
};

function newRepo(label: string): string {
  return mkdtempSync(join(tmpdir(), `ut-tdd-grboot-${label}-`));
}

function writeDesignFixture(repoRoot: string): void {
  const path = join(repoRoot, ...DESIGN_PATH.split("/"));
  mkdirSync(join(repoRoot, "docs", "design", "harness", "L6-function-design"), {
    recursive: true,
  });
  writeFileSync(
    path,
    [
      "---",
      "layer: L6",
      "artifact_type: design_doc",
      "status: confirmed",
      "---",
      "",
      "# Synthetic bootstrap retry fixture",
      "",
      "This document is a synthetic relation graph artifact for isolated projection tests.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeEvidence(repoRoot: string, input: { malformed?: boolean } = {}): void {
  const path = join(repoRoot, ...EVIDENCE_PATH.split("/"));
  mkdirSync(join(repoRoot, ".ut-tdd", "gate_runs"), { recursive: true });
  if (input.malformed) {
    writeFileSync(path, "{not-json\n", "utf8");
    return;
  }
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: 1,
      gate_run_id: GATE_RUN_ID,
      gate_id: GATE_ID,
      plan_id: null,
      status: "passed",
      checked_at: CHECKED_AT,
      session_id: "session-grboot-fixture",
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

function readProjection(repoRoot: string): GateWorkflowProjection {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    return {
      gateRuns: db
        .prepare("SELECT gate_run_id, gate_id, status FROM gate_runs ORDER BY gate_run_id, gate_id")
        .all(),
      workflows: db
        .prepare(
          "SELECT workflow_run_id, workflow, phase, ready_status FROM workflow_runs WHERE workflow = 'routine-gate' ORDER BY workflow_run_id",
        )
        .all(),
      designArtifacts: db
        .prepare(
          "SELECT artifact_id, path FROM artifact_registry WHERE path = ? ORDER BY artifact_id",
        )
        .all(DESIGN_PATH),
      unrelatedArtifacts: db
        .prepare("SELECT artifact_id, path FROM artifact_registry WHERE artifact_id = ?")
        .all("artifact:grboot-independent-control"),
    };
  } finally {
    db.close();
  }
}

function readDatabaseState(repoRoot: string): DatabaseState {
  const dbPath = defaultHarnessDbPath(repoRoot);
  if (!existsSync(dbPath)) {
    return {
      userVersion: 0,
      applicationTables: [],
      populatedApplicationTables: [],
    };
  }
  const db = openHarnessDb(dbPath, { repoRoot });
  try {
    const applicationTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const populatedApplicationTables = applicationTables.filter((table) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) throw new Error("unexpected table name");
      return db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== undefined;
    });
    return {
      userVersion: db.userVersion(),
      applicationTables,
      populatedApplicationTables,
    };
  } finally {
    db.close();
  }
}

function initializeSchemaOnly(repoRoot: string): void {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    migrate(db);
  } finally {
    db.close();
  }
}

function addUnrelatedArtifact(repoRoot: string): void {
  const db = openHarnessDb(defaultHarnessDbPath(repoRoot), { repoRoot });
  try {
    db.prepare(
      "INSERT INTO artifact_registry (artifact_id, artifact_type, path, pair_artifact, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "artifact:grboot-independent-control",
      "design_doc",
      "docs/other/unrelated.md",
      "",
      "current",
      "2026-11-20T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

describe("gate-run bootstrap retry oracles", () => {
  const roots: string[] = [];
  let failedFirstRun!: ReturnType<typeof checkGateRunCoverage>;
  let rollbackState!: DatabaseState;
  let retryResult!: ReturnType<typeof checkGateRunCoverage>;
  let retryFirstResult!: ReturnType<typeof checkGateRunCoverage>;
  let retryProjection!: GateWorkflowProjection;
  let normalFirstRunResult!: ReturnType<typeof checkGateRunCoverage>;
  let normalFirstRunProjection!: GateWorkflowProjection;
  let schemaOnlyInitialState!: DatabaseState;
  let schemaOnlyResult!: ReturnType<typeof checkGateRunCoverage>;
  let schemaOnlyProjection!: GateWorkflowProjection;
  let controlInvalidResult!: ReturnType<typeof checkGateRunCoverage>;
  let controlValidResult!: ReturnType<typeof checkGateRunCoverage>;
  let controlBeforeProjection!: GateWorkflowProjection;
  let controlAfterProjection!: GateWorkflowProjection;
  let controlValidProjection!: GateWorkflowProjection;

  beforeAll(() => {
    const rollbackRepo = newRepo("001");
    roots.push(rollbackRepo);
    writeEvidence(rollbackRepo, { malformed: true });
    failedFirstRun = checkGateRunCoverage(rollbackRepo);
    rollbackState = readDatabaseState(rollbackRepo);

    const retryRepo = newRepo("002-retry");
    roots.push(retryRepo);
    writeDesignFixture(retryRepo);
    writeEvidence(retryRepo, { malformed: true });
    retryFirstResult = checkGateRunCoverage(retryRepo);
    writeEvidence(retryRepo);
    retryResult = checkGateRunCoverage(retryRepo);
    retryProjection = readProjection(retryRepo);

    const normalRepo = newRepo("002-control");
    roots.push(normalRepo);
    writeDesignFixture(normalRepo);
    writeEvidence(normalRepo);
    normalFirstRunResult = checkGateRunCoverage(normalRepo);
    normalFirstRunProjection = readProjection(normalRepo);

    const schemaOnlyRepo = newRepo("003");
    roots.push(schemaOnlyRepo);
    initializeSchemaOnly(schemaOnlyRepo);
    schemaOnlyInitialState = readDatabaseState(schemaOnlyRepo);
    writeDesignFixture(schemaOnlyRepo);
    writeEvidence(schemaOnlyRepo);
    schemaOnlyResult = checkGateRunCoverage(schemaOnlyRepo);
    schemaOnlyProjection = readProjection(schemaOnlyRepo);

    const positiveControlRepo = newRepo("004");
    roots.push(positiveControlRepo);
    initializeSchemaOnly(positiveControlRepo);
    addUnrelatedArtifact(positiveControlRepo);
    writeEvidence(positiveControlRepo, { malformed: true });
    controlBeforeProjection = readProjection(positiveControlRepo);
    controlInvalidResult = checkGateRunCoverage(positiveControlRepo);
    controlAfterProjection = readProjection(positiveControlRepo);
    writeEvidence(positiveControlRepo);
    controlValidResult = checkGateRunCoverage(positiveControlRepo);
    controlValidProjection = readProjection(positiveControlRepo);
  });

  afterAll(() => {
    for (const root of roots) removeTestTree(root);
  });

  it("fixture runs retain the original invalid-evidence diagnosis and establish independent controls", () => {
    expect(failedFirstRun.ok).toBe(false);
    expect(failedFirstRun.messages.join("\n")).toContain("invalid_gate_run_evidence=1");

    expect(retryFirstResult.ok).toBe(false);
    expect(retryFirstResult.messages.join("\n")).toContain("invalid_gate_run_evidence=1");
    expect(retryResult.ok).toBe(true);
    expect(normalFirstRunResult.ok).toBe(true);
    expect(retryProjection.gateRuns).toHaveLength(1);
    expect(normalFirstRunProjection.gateRuns).toHaveLength(1);
    expect(retryProjection.workflows).toHaveLength(1);
    expect(normalFirstRunProjection.workflows).toHaveLength(1);
    expect(normalFirstRunProjection.designArtifacts).toHaveLength(1);
    expect(normalFirstRunProjection.designArtifacts[0]?.path).toBe(DESIGN_PATH);
    expect(normalFirstRunProjection.designArtifacts[0]?.artifact_id).toBeTruthy();

    expect(schemaOnlyInitialState.userVersion).toBeGreaterThan(0);
    expect(schemaOnlyInitialState.applicationTables.length).toBeGreaterThan(0);
    expect(schemaOnlyInitialState.populatedApplicationTables).toEqual([]);
    expect(schemaOnlyResult.ok).toBe(true);
    expect(schemaOnlyProjection.gateRuns).toHaveLength(1);
    expect(schemaOnlyProjection.workflows).toHaveLength(1);
  });

  it("U-GRBOOT-001 failed first attempt rolls back to an uninitialized logical state", () => {
    expect(rollbackState.userVersion).toBe(0);
    expect(rollbackState.applicationTables).toEqual([]);
    expect(rollbackState.populatedApplicationTables).toEqual([]);
  });

  it("U-GRBOOT-002 retry projection matches a normal first run", () => {
    expect(retryProjection).toEqual(normalFirstRunProjection);
  });

  it("U-GRBOOT-003 current schema-only database receives the full initial projection", () => {
    expect(schemaOnlyProjection).toEqual(normalFirstRunProjection);
  });

  it("U-GRBOOT-004 nonempty database keeps unrelated rows through invalid and valid checks", () => {
    expect(controlBeforeProjection).toEqual({
      gateRuns: [],
      workflows: [],
      designArtifacts: [],
      unrelatedArtifacts: [
        {
          artifact_id: "artifact:grboot-independent-control",
          path: "docs/other/unrelated.md",
        },
      ],
    });
    expect(controlInvalidResult.ok).toBe(false);
    expect(controlInvalidResult.messages.join("\n")).toContain("invalid_gate_run_evidence=1");
    expect(controlAfterProjection).toEqual(controlBeforeProjection);
    expect(controlValidResult.ok).toBe(true);
    expect(controlValidProjection.gateRuns).toEqual([
      { gate_run_id: GATE_RUN_ID, gate_id: GATE_ID, status: "passed" },
    ]);
    expect(controlValidProjection.workflows).toEqual([
      {
        workflow_run_id: stableId("gate-workflow", GATE_RUN_ID),
        workflow: "routine-gate",
        phase: GATE_ID,
        ready_status: "passed",
      },
    ]);
    expect(controlValidProjection.designArtifacts).toEqual([]);
    expect(controlValidProjection.unrelatedArtifacts).toEqual(
      controlBeforeProjection.unrelatedArtifacts,
    );
  });
});
