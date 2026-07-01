import { describe, expect, it } from "vitest";
import {
  analyzeDependencyDrift,
  type DependencyDriftInput,
  dependencyDriftMessages,
  expandRegressionScope,
  loadDependencyDriftInput,
} from "../src/lint/dependency-drift";

const input: DependencyDriftInput = {
  sourceDocs: [
    {
      path: "src/schema/index.ts",
      text: "export const SCHEMA = true;",
    },
    {
      path: "src/lint/audit.ts",
      text: 'import { SCHEMA } from "../schema/index"; export const audit = SCHEMA;',
    },
    {
      path: "src/doctor/index.ts",
      text: 'import { audit } from "../lint/audit"; export const doctor = audit;',
    },
    {
      path: "src/runtime/bad.ts",
      text: 'import { audit } from "../lint/audit"; export const bad = audit;',
    },
  ],
  testDocs: [
    {
      path: "tests/audit.test.ts",
      text: 'import { audit } from "../src/lint/audit"; audit;',
    },
    {
      path: "tests/doctor.test.ts",
      text: 'import { doctor } from "../src/doctor/index"; doctor;',
    },
  ],
};

describe("dependency-drift and regression expansion (PLAN-REVERSE-42)", () => {
  it("U-DEPD-001: allowed dependency graph is green and emits stable module edges", () => {
    const result = analyzeDependencyDrift({
      sourceDocs: input.sourceDocs.filter((d) => d.path !== "src/runtime/bad.ts"),
      testDocs: input.testDocs,
    });

    expect(result.ok).toBe(true);
    expect(result.moduleEdges).toContainEqual({ from: "doctor", to: "lint" });
    expect(result.moduleEdges).toContainEqual({ from: "lint", to: "schema" });
    expect(dependencyDriftMessages(result)[0]).toContain("OK");
  });

  it("U-DEPD-002: disallowed module dependency is surfaced as drift", () => {
    const result = analyzeDependencyDrift(input);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "disallowed-module-dependency",
        fromModule: "runtime",
        toModule: "lint",
        path: "src/runtime/bad.ts",
      }),
    );
  });

  it("U-DEPD-003: module cycles are surfaced deterministically", () => {
    const result = analyzeDependencyDrift({
      sourceDocs: [
        { path: "src/lint/a.ts", text: 'import "../doctor/b";' },
        { path: "src/doctor/b.ts", text: 'import "../lint/a";' },
      ],
      testDocs: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "module-cycle",
        cycle: ["doctor", "lint", "doctor"],
      }),
    );
  });

  it("U-REGEXP-001: changed source expands to direct tests and dependent module tests", () => {
    const drift = analyzeDependencyDrift(input);
    const scope = expandRegressionScope(drift, ["src/lint/audit.ts"]);

    expect(scope.ok).toBe(true);
    expect(scope.changedModules).toEqual(["lint"]);
    expect(scope.affectedModules).toEqual(["doctor", "lint"]);
    expect(scope.testPaths).toEqual(["tests/audit.test.ts", "tests/doctor.test.ts"]);
  });

  it("U-REGEXP-002: missing regression coverage is a finding, not a silent fallback", () => {
    const drift = analyzeDependencyDrift({
      sourceDocs: [{ path: "src/export/document-export.ts", text: "export const x = 1;" }],
      testDocs: [],
    });
    const scope = expandRegressionScope(drift, ["src/export/document-export.ts"]);

    expect(scope.ok).toBe(false);
    expect(scope.findings).toContainEqual(
      expect.objectContaining({
        code: "missing-regression-test",
        module: "export",
      }),
    );
  });

  it("U-REGEXP-003: CLI subprocess smoke tests count as cli regression coverage", () => {
    const drift = analyzeDependencyDrift({
      sourceDocs: [{ path: "src/cli.ts", text: "export const programName = 'ut-tdd';" }],
      testDocs: [
        {
          path: "tests/runtime-hook-entrypoints.test.ts",
          text: 'const cliPath = join(repoRoot, "src", "cli.ts"); spawnSync("bun", [cliPath, "doctor"]);',
        },
      ],
    });
    const scope = expandRegressionScope(drift, ["src/cli.ts"]);

    expect(scope.ok).toBe(true);
    expect(scope.testPaths).toEqual(["tests/runtime-hook-entrypoints.test.ts"]);
  });

  it("U-REGEXP-004: deleted source modules are not treated as live regression targets", () => {
    const drift = analyzeDependencyDrift({
      sourceDocs: [
        { path: "src/skill-engine/recommend.ts", text: "export const recommend = true;" },
      ],
      testDocs: [
        {
          path: "tests/skill-recommend.test.ts",
          text: 'import "../src/skill-engine/recommend";',
        },
      ],
    });
    const scope = expandRegressionScope(drift, [
      "src/skills/recommend.ts",
      "src/skill-engine/recommend.ts",
    ]);

    expect(scope.ok).toBe(true);
    expect(scope.changedModules).toEqual(["skill-engine"]);
  });

  it("IT-ASSET-03: runtime may import the roster boundary through agent-slots only", () => {
    const result = analyzeDependencyDrift({
      sourceDocs: [
        {
          path: "src/runtime/agent-slots.ts",
          text: 'export { resolveRosterCapability } from "./agent-slots-roster";',
        },
        {
          path: "src/runtime/agent-slots-roster.ts",
          text: "export const resolveRosterCapability = () => 'ok';",
        },
        {
          path: "src/runtime/agent-guard.ts",
          text: "export const guard = true;",
        },
      ],
      testDocs: [],
    });

    expect(result.ok).toBe(true);
    expect(result.sourceFileEdges).toContainEqual({
      from: "src/runtime/agent-slots.ts",
      to: "src/runtime/agent-slots-roster.ts",
    });
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ code: "runtime-roster-boundary" }),
    );
  });

  it("IT-ASSET-03: roster reverse imports and guard-to-roster imports fail closed", () => {
    const result = analyzeDependencyDrift({
      sourceDocs: [
        {
          path: "src/runtime/agent-slots-roster.ts",
          text: 'import { guard } from "./agent-guard"; export const roster = guard;',
        },
        {
          path: "src/runtime/agent-guard.ts",
          text: 'import { roster } from "./agent-slots-roster"; export const guard = roster;',
        },
      ],
      testDocs: [],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "runtime-roster-boundary",
          fromPath: "src/runtime/agent-slots-roster.ts",
          toPath: "src/runtime/agent-guard.ts",
        }),
        expect.objectContaining({
          code: "runtime-roster-boundary",
          fromPath: "src/runtime/agent-guard.ts",
          toPath: "src/runtime/agent-slots-roster.ts",
        }),
      ]),
    );
  });

  it("IT-ASSET-03: real repo keeps runtime roster boundary acyclic and one-way", () => {
    const result = analyzeDependencyDrift(loadDependencyDriftInput(process.cwd()));

    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ code: "runtime-roster-boundary" }),
    );
    expect(result.sourceFileEdges).toContainEqual({
      from: "src/runtime/agent-slots.ts",
      to: "src/runtime/agent-slots-roster.ts",
    });
    expect(
      result.sourceFileEdges.filter((edge) => edge.to === "src/runtime/agent-slots-roster.ts"),
    ).toEqual([
      {
        from: "src/runtime/agent-slots.ts",
        to: "src/runtime/agent-slots-roster.ts",
      },
    ]);
  });
});
