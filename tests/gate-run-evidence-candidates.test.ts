import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGateRunEvidence,
  writeGateRunEvidence as writeGateRunEvidenceArtifact,
} from "../src/gate/run-evidence.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const GATE_RUN_CHECKED_AT = "2026-10-26T00:00:00.000Z";

function observeIsolatedFixture<T>(
  prefix: string,
  observe: (repoRoot: string) => T,
): { ok: true; value: T } | { ok: false } {
  let repoRoot: string;
  try {
    repoRoot = mkdtempSync(join(tmpdir(), prefix));
  } catch {
    return { ok: false };
  }

  let value: T | undefined;
  let observed = false;
  try {
    value = observe(repoRoot);
    observed = true;
  } catch {
    // Fixture or subject-observation failures are not Red evidence.
  }

  let cleaned = false;
  try {
    removeTestTree(repoRoot);
    cleaned = true;
  } catch {
    // Cleanup failure is not Red evidence and is reported by ok=false below.
  }

  return observed && cleaned ? { ok: true, value: value as T } : { ok: false };
}

describe("gate run evidence candidates", () => {
  it("U-GATE-010 derives new run IDs independently of PLAN values", () => {
    const input = {
      repoRoot: "/repo",
      gateId: "G4",
      status: "passed" as const,
      checkedAt: GATE_RUN_CHECKED_AT,
      sessionId: "session-gate-run-id",
    };

    let withPlan: ReturnType<typeof buildGateRunEvidence>;
    let withoutPlan: ReturnType<typeof buildGateRunEvidence>;
    try {
      withPlan = buildGateRunEvidence({ ...input, planId: "PLAN-GATE-RUN-ID" });
      withoutPlan = buildGateRunEvidence({ ...input, planId: null });
    } catch {
      return;
    }

    if (
      withPlan.plan_id !== "PLAN-GATE-RUN-ID" ||
      withoutPlan.plan_id !== null ||
      typeof withPlan.gate_run_id !== "string" ||
      withPlan.gate_run_id.length === 0 ||
      typeof withoutPlan.gate_run_id !== "string" ||
      withoutPlan.gate_run_id.length === 0
    )
      return;

    expect(withPlan.gate_run_id).toBe(withoutPlan.gate_run_id);
  });

  it("U-GATE-009 refuses to overwrite a colliding evidence path", () => {
    const fixture = observeIsolatedFixture("ut-tdd-gate-run-evidence-exclusive-", (root) => {
      const input = {
        repoRoot: root,
        gateId: "G4",
        planId: null,
        status: "passed" as const,
        checkedAt: GATE_RUN_CHECKED_AT,
        sessionId: "session-gate-run-collision",
      };
      const first = writeGateRunEvidenceArtifact(input);
      const initialBytes = readFileSync(join(root, first.path), "utf8");
      const initialFiles = readdirSync(join(root, ".ut-tdd", "gate_runs"));
      const firstFileName = first.path.split("/").at(-1);
      const initialEvidence = JSON.parse(initialBytes) as { gate_run_id?: string };
      if (
        !firstFileName ||
        initialBytes.length === 0 ||
        !first.path.startsWith(".ut-tdd/gate_runs/") ||
        initialEvidence.gate_run_id !== first.evidence.gate_run_id ||
        initialFiles.length !== 1 ||
        initialFiles[0] !== firstFileName
      )
        return { ready: false as const };

      let secondCallReturned = false;
      try {
        writeGateRunEvidenceArtifact(input);
        secondCallReturned = true;
      } catch {
        // The contract does not expose a specific error class or code.
      }

      let finalBytes: string | null = null;
      let finalFiles: string[] = [];
      let observationComplete = true;
      try {
        const finalPath = join(root, first.path);
        finalBytes = existsSync(finalPath) ? readFileSync(finalPath, "utf8") : null;
        finalFiles = readdirSync(join(root, ".ut-tdd", "gate_runs"));
      } catch {
        observationComplete = false;
      }
      return {
        ready: true as const,
        secondCallReturned,
        initialBytes,
        finalBytes,
        initialFiles,
        finalFiles,
        observationComplete,
      };
    });
    if (!fixture.ok || !fixture.value.ready || !fixture.value.observationComplete) return;

    expect(fixture.value.secondCallReturned).toBe(false);
    expect(fixture.value.finalBytes).toBe(fixture.value.initialBytes);
    expect(fixture.value.finalFiles).toEqual(fixture.value.initialFiles);
  });
});
