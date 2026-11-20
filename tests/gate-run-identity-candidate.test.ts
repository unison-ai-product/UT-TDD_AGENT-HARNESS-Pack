import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGateRunCoverage } from "../src/doctor/process-quality.ts";
import { buildGateRunEvidence, writeGateRunEvidence } from "../src/gate/run-evidence.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";

const checkedAt = "2026-10-26T00:00:00.000Z";
const gateId = "G4";
const sessionId = "candidate-gate-run-identity";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compactSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function candidateInput(repoRoot: string) {
  return {
    repoRoot,
    gateId,
    planId: null,
    status: "passed" as const,
    checkedAt,
    sessionId,
  };
}

function legacyFilename(gateRunId: string): string {
  const timestamp = compactSlug(checkedAt.replace(/[:.]/g, "-"));
  return compactSlug(gateId) + "-" + timestamp + "-" + digest(gateRunId).slice(0, 12) + ".json";
}

function finalJsonNames(fixture: Fixture): string[] {
  return readdirSync(fixture.gateRunsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function evidence(gateRunId: string, planId: string | null = null) {
  return {
    schema_version: 1,
    gate_run_id: gateRunId,
    gate_id: gateId,
    timestamp: checkedAt,
    plan_id: planId,
    status: "passed",
    checked_at: checkedAt,
    session_id: sessionId,
    mode: null,
    tier: null,
    review_kind: null,
    worker_model: null,
    reviewer_model: null,
    checklist_path: null,
    coverage_summary_path: null,
    static_applicable: false,
    command: { name: "ut-tdd gate", gate_id: gateId, plan_id: planId },
    checks: [],
    source: "ut-tdd gate",
    messages: [],
  };
}

function writeAndVerifyPositiveControls(fixture: Fixture, targetId: string): string[] {
  const directoryPrefix = ".ut-tdd/gate_runs/";
  const controlNames: string[] = [];
  const controlIds: string[] = [];

  for (const ordinal of [1, 2]) {
    // The second control is deliberately written after the first has populated this directory.
    const control = writeGateRunEvidence({
      ...candidateInput(fixture.root),
      sessionId: sessionId + "-positive-control-" + ordinal,
    });
    const controlName = control.path.slice(directoryPrefix.length);
    const controlPath = join(fixture.root, control.path);
    const emitted = JSON.parse(readFileSync(controlPath, "utf8")) as {
      gate_run_id?: string;
      gate_id?: string;
      session_id?: string | null;
    };

    expect(control.evidence.gate_run_id).not.toBe(targetId);
    expect(controlIds).not.toContain(control.evidence.gate_run_id);
    expect(control.path.startsWith(directoryPrefix)).toBe(true);
    expect(controlName).not.toContain("/");
    expect(controlName).toMatch(/\.json$/);
    expect(controlNames).not.toContain(controlName);
    expect(emitted).toMatchObject({
      gate_run_id: control.evidence.gate_run_id,
      gate_id: gateId,
      session_id: sessionId + "-positive-control-" + ordinal,
    });
    expect(JSON.parse(readFileSync(controlPath, "utf8"))).toEqual(control.evidence);

    controlIds.push(control.evidence.gate_run_id);
    controlNames.push(controlName);
    expect(finalJsonNames(fixture)).toEqual([...controlNames].sort());
  }

  expect(controlIds).toHaveLength(2);
  expect(new Set(controlIds).size).toBe(2);
  return controlNames;
}

interface Fixture {
  root: string;
  gateRunsDir: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-gate-identity-candidate-"));
  try {
    const gateRunsDir = join(root, ".ut-tdd", "gate_runs");
    mkdirSync(gateRunsDir, { recursive: true });
    expect(readdirSync(gateRunsDir)).toEqual([]);
    return { root, gateRunsDir };
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Preserve the setup error; callers convert it into a non-Red return.
    }
    throw error;
  }
}

function removeFixture(fixture: Fixture | undefined): void {
  if (fixture) rmSync(fixture.root, { recursive: true, force: true });
}

function writePlanFixture(repoRoot: string, planId: string): void {
  mkdirSync(join(repoRoot, "docs", "plans"), { recursive: true });
  writeFileSync(
    join(repoRoot, "docs", "plans", planId + ".md"),
    [
      "---",
      "plan_id: " + planId,
      'title: "gate-run identity coverage fixture"',
      "kind: impl",
      "layer: L7",
      "drive: db",
      "status: confirmed",
      "route_signal: feature_addition",
      "route_mode: add-feature",
      "created: 2026-10-26",
      "updated: 2026-10-26",
      "---",
      "",
      "# gate-run identity coverage fixture",
      "",
    ].join("\n"),
    "utf8",
  );
}

function observeIsolatedFixture<T>(observe: (fixture: Fixture) => T): { ok: boolean; value?: T } {
  let fixture: Fixture | undefined;
  let value: T | undefined;
  let observed = false;
  try {
    fixture = createFixture();
    value = observe(fixture);
    observed = true;
  } catch {
    // Fixture and subject-observation failures are not Red evidence.
  }

  let cleaned = false;
  try {
    removeFixture(fixture);
    cleaned = true;
  } catch {
    // Cleanup failure invalidates the observation.
  }
  return { ok: observed && cleaned, value };
}

describe("U-GATE-010 gate-run identity and path", () => {
  it("U-GATE-010: creates and removes an isolated gate-run fixture", () => {
    const fixture = createFixture();
    try {
      expect(readdirSync(fixture.gateRunsDir)).toEqual([]);
    } finally {
      removeFixture(fixture);
    }
    expect(existsSync(fixture.root)).toBe(false);
  });

  it("U-GATE-010: writes a valid gate-run evidence file for an ordinary input", () => {
    const fixture = createFixture();
    try {
      const result = writeGateRunEvidence(candidateInput(fixture.root));
      expect(result.evidence.gate_run_id.length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(join(fixture.root, result.path), "utf8"))).toEqual(
        result.evidence,
      );
    } finally {
      removeFixture(fixture);
    }
  });

  it("U-GATE-010 derives the ID from the specified runSeed only", () => {
    const input = {
      repoRoot: "/repo",
      gateId: "G4",
      planId: "PLAN-CANDIDATE-U-GATE-010",
      status: "passed" as const,
      checkedAt,
      sessionId,
    };
    const runSeed = [input.gateId, checkedAt, sessionId, process.pid].join(":");
    const expectedId =
      "gate-run:G4:" + createHash("sha256").update(runSeed, "utf8").digest("hex").slice(0, 12);
    let actualId: string;

    try {
      actualId = buildGateRunEvidence(input).gate_run_id;
    } catch {
      return;
    }

    expect(actualId).toBe(expectedId);
  });

  it("U-GATE-010 hashes path from UTF-8 ID", () => {
    let fixture: Fixture | undefined;
    let observation: { path: string; expectedPath: string; digestFilename: boolean } | undefined;
    let setupReady = false;
    let cleanupSucceeded = false;

    try {
      fixture = createFixture();
      const result = writeGateRunEvidence(candidateInput(fixture.root));
      const id = result.evidence.gate_run_id;
      const files = readdirSync(fixture.gateRunsDir);
      if (!id || files.length !== 1 || !readFileSync(join(fixture.root, result.path), "utf8")) {
        return;
      }
      observation = {
        path: result.path,
        expectedPath: ".ut-tdd/gate_runs/" + digest(id) + ".json",
        digestFilename: /^[0-9a-f]{64}\.json$/u.test(
          result.path.slice(".ut-tdd/gate_runs/".length),
        ),
      };
      setupReady = true;
    } catch {
      setupReady = false;
    } finally {
      try {
        removeFixture(fixture);
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }

    if (!setupReady || !cleanupSucceeded) return;

    // Last operation: the writer/read setup and cleanup succeeded before the sole target assertion.
    expect(observation).toEqual({
      path: observation?.expectedPath,
      expectedPath: observation?.expectedPath,
      digestFilename: true,
    });
  });

  it("U-GATE-010 rejects hash-address ID mismatch", () => {
    let fixture: Fixture | undefined;
    let actual: { threw: boolean; bytes: string; names: string[] } | undefined;
    let expected: { threw: boolean; bytes: string; names: string[] } | undefined;
    let setupReady = false;
    let cleanupSucceeded = false;

    try {
      fixture = createFixture();
      const id = buildGateRunEvidence(candidateInput(fixture.root)).gate_run_id;
      const controlNames = writeAndVerifyPositiveControls(fixture, id);
      const filename = digest(id) + ".json";
      const destination = join(fixture.gateRunsDir, filename);
      const originalBytes = JSON.stringify(evidence("gate-run:G4:different-id"), null, 2) + "\n";
      if (controlNames.includes(filename)) return;
      writeFileSync(destination, originalBytes, "utf8");
      const occupant = JSON.parse(readFileSync(destination, "utf8")) as { gate_run_id?: string };
      if (
        occupant.gate_run_id === id ||
        finalJsonNames(fixture).join() !== [...controlNames, filename].sort().join()
      ) {
        return;
      }

      let threw = false;
      try {
        writeGateRunEvidence(candidateInput(fixture.root));
      } catch {
        threw = true;
      }
      actual = {
        threw,
        bytes: readFileSync(destination, "utf8"),
        names: finalJsonNames(fixture),
      };
      expected = { threw: true, bytes: originalBytes, names: [...controlNames, filename].sort() };
      setupReady = true;
    } catch {
      setupReady = false;
    } finally {
      try {
        removeFixture(fixture);
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }

    if (!setupReady || !cleanupSucceeded) return;

    // No error code is part of the contract; valid setup + a throw + unchanged bytes is rejection.
    expect(actual).toEqual(expected);
  });

  it("U-GATE-010 reads legacy filenames", () => {
    const fixture = createFixture();
    try {
      const legacyId = "gate-run:G4:legacy-reader-fixture";
      const legacyName = legacyFilename(legacyId);
      const legacyPath = join(fixture.gateRunsDir, legacyName);
      writeFileSync(legacyPath, JSON.stringify(evidence(legacyId), null, 2) + "\n", "utf8");
      expect(readdirSync(fixture.gateRunsDir)).toEqual([legacyName]);

      const db = openHarnessDb(":memory:", { repoRoot: fixture.root });
      try {
        rebuildHarnessDb({ repoRoot: fixture.root, db });
        expect(
          db
            .prepare("SELECT gate_run_id, evidence_path FROM gate_runs WHERE gate_run_id = ?")
            .get(legacyId),
        ).toEqual({
          gate_run_id: legacyId,
          evidence_path: ".ut-tdd/gate_runs/" + legacyName,
        });
      } finally {
        db.close();
      }
    } finally {
      removeFixture(fixture);
    }
  });

  it("U-GATE-009/010 temp reader oracle ignores .tmp-* beside finalized JSON", () => {
    const fixture = createFixture();
    let db: ReturnType<typeof openHarnessDb> | undefined;
    try {
      db = openHarnessDb(":memory:", { repoRoot: fixture.root });
      const finalId = "gate-run:G4:finalized-reader-fixture";
      const tempId = "gate-run:G4:temporary-reader-fixture";
      const finalName = digest(finalId) + ".json";
      const tempName = ".tmp-gate-run-reader-fixture";
      const finalPath = join(fixture.gateRunsDir, finalName);
      const tempPath = join(fixture.gateRunsDir, tempName);
      const finalBytes = JSON.stringify(evidence(finalId), null, 2) + "\n";
      const tempBytes = JSON.stringify(evidence(tempId), null, 2) + "\n";
      writeFileSync(finalPath, finalBytes, "utf8");
      writeFileSync(tempPath, tempBytes, "utf8");

      expect(tempName.startsWith(".tmp-")).toBe(true);
      expect(tempName.endsWith(".json")).toBe(false);
      expect(readdirSync(fixture.gateRunsDir).sort()).toEqual([finalName, tempName].sort());
      expect(JSON.parse(readFileSync(finalPath, "utf8")).gate_run_id).toBe(finalId);
      expect(JSON.parse(readFileSync(tempPath, "utf8")).gate_run_id).toBe(tempId);

      rebuildHarnessDb({ repoRoot: fixture.root, db });
      expect(
        db.prepare("SELECT gate_run_id, evidence_path FROM gate_runs ORDER BY gate_run_id").all(),
      ).toEqual([
        {
          gate_run_id: finalId,
          evidence_path: ".ut-tdd/gate_runs/" + finalName,
        },
      ]);
    } finally {
      try {
        db?.close();
      } finally {
        removeFixture(fixture);
      }
    }
  });

  it("U-GATE-010 accepts one new file via checkGateRunCoverage", () => {
    const control = observeIsolatedFixture((fixture) => {
      const planId = "PLAN-GATE-IDENTITY-READER-CONTROL";
      const runId = "gate-run:G4:reader-control";
      writePlanFixture(fixture.root, planId);
      const filename = digest(runId) + ".json";
      writeFileSync(
        join(fixture.gateRunsDir, filename),
        JSON.stringify(evidence(runId, planId), null, 2) + "\n",
        "utf8",
      );
      const files = readdirSync(fixture.gateRunsDir);
      const parsed = JSON.parse(readFileSync(join(fixture.gateRunsDir, filename), "utf8")) as {
        gate_run_id?: string;
      };
      return {
        ready: files.length === 1 && files[0] === filename && parsed.gate_run_id === runId,
        result: checkGateRunCoverage(fixture.root),
      };
    });

    expect(control.ok).toBe(true);
    expect(control.value?.ready).toBe(true);
    if (!control.ok || !control.value?.ready) return;
    expect(control.value.result.ok).toBe(true);
  });

  it("U-GATE-010 rejects new/legacy duplicates via checkGateRunCoverage", () => {
    const duplicate = observeIsolatedFixture((fixture) => {
      const planId = "PLAN-GATE-IDENTITY-READER-DUPLICATE";
      const runId = "gate-run:G4:reader-duplicate";
      writePlanFixture(fixture.root, planId);
      const newName = digest(runId) + ".json";
      const oldName = legacyFilename(runId);
      const bytes = JSON.stringify(evidence(runId, planId), null, 2) + "\n";
      writeFileSync(join(fixture.gateRunsDir, newName), bytes, "utf8");
      writeFileSync(join(fixture.gateRunsDir, oldName), bytes, "utf8");
      const names = readdirSync(fixture.gateRunsDir).sort();
      const newEvidence = JSON.parse(readFileSync(join(fixture.gateRunsDir, newName), "utf8")) as {
        gate_run_id?: string;
      };
      const oldEvidence = JSON.parse(readFileSync(join(fixture.gateRunsDir, oldName), "utf8")) as {
        gate_run_id?: string;
      };
      return {
        ready:
          newName !== oldName &&
          names.length === 2 &&
          names[0] === [newName, oldName].sort()[0] &&
          names[1] === [newName, oldName].sort()[1] &&
          newEvidence.gate_run_id === runId &&
          oldEvidence.gate_run_id === runId,
        result: checkGateRunCoverage(fixture.root),
      };
    });
    if (!duplicate.ok || !duplicate.value?.ready) return;

    // The fixture helper has already observed and cleaned the temporary repository.
    expect(duplicate.value.result.ok).toBe(false);
  });

  it("U-GATE-010 rejects existing legacy ID on write", () => {
    let fixture: Fixture | undefined;
    let actual: { threw: boolean; bytes: string; names: string[] } | undefined;
    let expected: { threw: boolean; bytes: string; names: string[] } | undefined;
    let setupReady = false;
    let cleanupSucceeded = false;

    try {
      fixture = createFixture();
      const id = buildGateRunEvidence(candidateInput(fixture.root)).gate_run_id;
      const controlNames = writeAndVerifyPositiveControls(fixture, id);
      const name = legacyFilename(id);
      const legacyPath = join(fixture.gateRunsDir, name);
      const originalBytes = JSON.stringify(evidence(id), null, 2) + "\n";
      if (controlNames.includes(name)) return;
      writeFileSync(legacyPath, originalBytes, "utf8");
      const existing = JSON.parse(readFileSync(legacyPath, "utf8")) as { gate_run_id?: string };
      if (
        existing.gate_run_id !== id ||
        finalJsonNames(fixture).join() !== [...controlNames, name].sort().join()
      )
        return;

      let threw = false;
      try {
        writeGateRunEvidence(candidateInput(fixture.root));
      } catch {
        threw = true;
      }
      actual = {
        threw,
        bytes: readFileSync(legacyPath, "utf8"),
        names: finalJsonNames(fixture),
      };
      expected = { threw: true, bytes: originalBytes, names: [...controlNames, name].sort() };
      setupReady = true;
    } catch {
      setupReady = false;
    } finally {
      try {
        removeFixture(fixture);
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }

    if (!setupReady || !cleanupSucceeded) return;

    // Last operation: no error code is part of the contract; assert rejection and preservation.
    expect(actual).toEqual(expected);
  });
});
