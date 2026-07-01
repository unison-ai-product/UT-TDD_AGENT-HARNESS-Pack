import { describe, expect, it } from "vitest";
import {
  catalogToolAdapters,
  normalizeToolAdapterRun,
  planDiagramRefresh,
  probeToolAdapter,
  type ToolAdapterProbeDeps,
} from "../src/lint/tool-adapter";

function deps(over: Partial<ToolAdapterProbeDeps> = {}): ToolAdapterProbeDeps {
  return {
    repoRoot: "/repo",
    declaredPackages: [],
    executableOk: () => false,
    ...over,
  };
}

describe("tool adapter probes (U-TOOLADAPTER-001..010)", () => {
  it("U-TOOLADAPTER-001: catalog contains graph and diagram candidates with metadata", () => {
    const result = catalogToolAdapters();

    expect(result.adapters.map((adapter) => adapter.id)).toEqual([
      "d2",
      "dependency-cruiser",
      "graphviz-dot",
      "knip",
      "madge",
      "mermaid",
    ]);
    for (const adapter of result.adapters) {
      expect(adapter.triggerSignals.length).toBeGreaterThan(0);
      expect(adapter.outputFormats.length).toBeGreaterThan(0);
      expect(adapter.riskTier).toMatch(/^(low|medium|high)$/);
    }
  });

  it("U-TOOLADAPTER-002: optional adapters are disabled/unavailable until readiness is proven", () => {
    const result = catalogToolAdapters();

    expect(result.adapters.every((adapter) => adapter.defaultEnabled === false)).toBe(true);
    expect(result.adapters.every((adapter) => adapter.availableByDefault === false)).toBe(true);
  });

  it("U-TOOLADAPTER-003: missing package declaration is a readiness finding, not install", () => {
    const result = probeToolAdapter("dependency-cruiser", deps());

    expect(result?.ready).toBe(false);
    expect(result?.findings).toEqual([
      expect.objectContaining({ code: "package-missing", severity: "warn" }),
    ]);
    expect(result?.actionsTaken).toEqual([]);
  });

  it("U-TOOLADAPTER-004: missing executable is unavailable-adapter finding and stays scoped", () => {
    const result = probeToolAdapter(
      "graphviz-dot",
      deps({ executableOk: (command) => command !== "dot" }),
    );

    expect(result?.ready).toBe(false);
    expect(result?.findings).toEqual([
      expect.objectContaining({ code: "unavailable-adapter", severity: "warn" }),
    ]);
  });

  it("U-TOOLADAPTER-005: repo-external or home scan scope is refused", () => {
    const result = probeToolAdapter(
      "knip",
      deps({ declaredPackages: ["knip"], scanScope: "/Users/example" }),
    );

    expect(result?.ready).toBe(false);
    expect(result?.findings).toEqual([
      expect.objectContaining({ code: "scope-outside-workspace", severity: "error" }),
    ]);
  });

  it("U-TOOLADAPTER-006: tool run evidence normalizes into tool_runs rows", () => {
    const projection = normalizeToolAdapterRun({
      adapterId: "dependency-cruiser",
      evidencePath: ".ut-tdd/evidence/tool-adapter/depcruise.json",
      command: "depcruise src --output-type json",
      version: "16.0.0",
      inputScope: "src",
      exitCode: 0,
      status: "passed",
    });

    expect(projection.tool_runs).toEqual([
      expect.objectContaining({
        adapter_id: "dependency-cruiser",
        evidence_path: ".ut-tdd/evidence/tool-adapter/depcruise.json",
        normalized_status: "passed",
      }),
    ]);
  });

  it("U-TOOLADAPTER-007: dependency evidence normalizes edges and findings without raw gate truth", () => {
    const projection = normalizeToolAdapterRun({
      adapterId: "madge",
      evidencePath: ".ut-tdd/evidence/tool-adapter/madge.json",
      command: "madge src --json",
      inputScope: "src",
      exitCode: 1,
      status: "failed",
      dependencyEdges: [{ from: "src/a.ts", to: "src/b.ts", kind: "cycle" }],
      findings: [{ type: "cycle", severity: "error", subject: "src/a.ts" }],
      rawOutput: "raw cycle output must stay out",
    });

    expect(projection.dependency_edges).toEqual([
      expect.objectContaining({ from_path: "src/a.ts", to_path: "src/b.ts", edge_kind: "cycle" }),
    ]);
    expect(projection.findings).toEqual([
      expect.objectContaining({ finding_type: "cycle", severity: "error" }),
    ]);
    expect(JSON.stringify(projection)).not.toContain("raw cycle output");
  });

  it("U-TOOLADAPTER-008: Knip dead-node evidence becomes review findings, not auto-fix", () => {
    const projection = normalizeToolAdapterRun({
      adapterId: "knip",
      evidencePath: ".ut-tdd/evidence/tool-adapter/knip.json",
      command: "knip --reporter json",
      inputScope: ".",
      exitCode: 1,
      status: "failed",
      findings: [{ type: "unused-file", severity: "warn", path: "src/unused.ts" }],
    });

    expect(projection.findings).toEqual([
      expect.objectContaining({ finding_type: "unused-file", path: "src/unused.ts" }),
    ]);
    expect(projection.actionsTaken).toEqual([]);
  });

  it("U-TOOLADAPTER-009: stale diagram artifact requires refresh before review evidence", () => {
    const plan = planDiagramRefresh({
      graphSnapshotDigest: "sha256:new",
      requestedFormat: "mermaid",
      artifacts: [{ path: "docs/graph.md", format: "mermaid", sourceDigest: "sha256:old" }],
      adapterReady: true,
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({ action: "refresh", path: "docs/graph.md" }),
    ]);
    expect(plan.ok).toBe(false);
  });

  it("U-TOOLADAPTER-010: DOT/D2 renderer requests without readiness return findings", () => {
    const plan = planDiagramRefresh({
      graphSnapshotDigest: "sha256:new",
      requestedFormat: "d2",
      artifacts: [],
      adapterReady: false,
    });

    expect(plan.actions).toEqual([]);
    expect(plan.findings).toEqual([
      expect.objectContaining({ code: "renderer-unavailable", severity: "warn" }),
    ]);
  });
});
