import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoctorCheckDefinitionGroups } from "../src/doctor/check-definition-groups.ts";
import {
  buildFullDoctorCheckDefinitions,
  FULL_DOCTOR_OUTPUT_IDS,
  selectDoctorCheckDefinitions,
} from "../src/doctor/check-registry.ts";
import {
  checkImplPlanTrace,
  checkOracleTestTrace,
  checkTrackedCanonical,
} from "../src/doctor/index.ts";
import type { DoctorDeps } from "../src/doctor/runtime-state.ts";
import {
  checkImplPlanTrace as checkImplPlanTraceAdapter,
  checkOracleTestTrace as checkOracleTestTraceAdapter,
  checkTrackedCanonical as checkTrackedCanonicalAdapter,
} from "../src/doctor/source-trace.ts";

describe("doctor source trace adapters", () => {
  it("keeps source/artifact trace gates fail-closed through the extracted module", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-source-trace-missing-${Date.now()}-nope`);
    const checks = [
      checkImplPlanTraceAdapter(missingRoot),
      checkTrackedCanonicalAdapter(missingRoot),
      checkOracleTestTraceAdapter(missingRoot),
    ];

    expect(checks.map((result) => result.ok)).toEqual([false, false, false]);
    for (const result of checks) {
      expect(result.messages.join("\n")).toMatch(/violation/i);
    }
  });

  it("preserves the public doctor/index re-export surface", () => {
    expect(checkImplPlanTrace).toBe(checkImplPlanTraceAdapter);
    expect(checkTrackedCanonical).toBe(checkTrackedCanonicalAdapter);
    expect(checkOracleTestTrace).toBe(checkOracleTestTraceAdapter);
  });

  it("U-PAEXRET-001: full doctorからPLAN成果物検査を退役し代表gateを保持する", () => {
    const deps: DoctorDeps = {
      repoRoot: "C:/fixture/no-repository-reads",
      now: "2026-10-21T00:00:00.000Z",
      readText: () => {
        throw new Error("registry construction must not read repository text");
      },
      listDir: () => {
        throw new Error("registry construction must not enumerate repository paths");
      },
    };
    const definitions = buildFullDoctorCheckDefinitions(deps);
    const groupDefinitions = buildDoctorCheckDefinitionGroups(deps).flatMap(
      (group) => group.definitions,
    );
    const selected = selectDoctorCheckDefinitions(definitions, "full");
    const controls = ["coding-rules", "oracle-test-trace", "g1-trace"];
    const explicitlySelectedRetirementGate = selectDoctorCheckDefinitions(definitions, "full", [
      "plan-artifact-existence",
    ]);

    for (const id of controls) {
      expect(definitions.map((definition) => definition.id)).toContain(id);
      expect(groupDefinitions.map((definition) => definition.id)).toContain(id);
      expect(FULL_DOCTOR_OUTPUT_IDS).toContain(id);
      expect(selected.map((definition) => definition.id)).toContain(id);
    }

    expect(definitions.map((definition) => definition.id)).not.toContain("plan-artifact-existence");
    expect(groupDefinitions.map((definition) => definition.id)).not.toContain(
      "plan-artifact-existence",
    );
    expect(FULL_DOCTOR_OUTPUT_IDS).not.toContain("plan-artifact-existence");
    expect(explicitlySelectedRetirementGate).toEqual([]);
  });
});
