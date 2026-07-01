import { normalizePath } from "./shared";

export type ToolAdapterId =
  | "dependency-cruiser"
  | "knip"
  | "madge"
  | "graphviz-dot"
  | "mermaid"
  | "d2";

export type ToolAdapterFindingCode =
  | "package-missing"
  | "unavailable-adapter"
  | "scope-outside-workspace"
  | "renderer-unavailable";

export interface ToolAdapterFinding {
  code: ToolAdapterFindingCode;
  severity: "error" | "warn" | "info";
  message: string;
  adapterId?: ToolAdapterId;
}

export interface ToolAdapterProfile {
  id: ToolAdapterId;
  label: string;
  packageName: string | null;
  executable: string | null;
  triggerSignals: string[];
  outputFormats: string[];
  riskTier: "low" | "medium" | "high";
  defaultEnabled: boolean;
  availableByDefault: boolean;
}

export interface ToolAdapterCatalogResult {
  adapters: ToolAdapterProfile[];
  ok: boolean;
}

export interface ToolAdapterProbeDeps {
  repoRoot: string;
  declaredPackages: string[];
  executableOk: (command: string) => boolean;
  scanScope?: string;
}

export interface ToolAdapterProbeResult {
  adapter: ToolAdapterProfile;
  ready: boolean;
  findings: ToolAdapterFinding[];
  actionsTaken: string[];
}

export interface ToolAdapterRunEvidence {
  adapterId: ToolAdapterId;
  evidencePath: string;
  command: string;
  version?: string;
  inputScope: string;
  exitCode: number;
  status: "passed" | "failed";
  dependencyEdges?: Array<{ from: string; to: string; kind: string }>;
  findings?: Array<{
    type: string;
    severity: "error" | "warn" | "info";
    subject?: string;
    path?: string;
  }>;
  rawOutput?: string;
}

export interface ToolRunProjectionRow {
  tool_run_id: string;
  adapter_id: ToolAdapterId;
  command: string;
  version?: string;
  input_scope: string;
  exit_code: number;
  evidence_path: string;
  normalized_status: string;
}

export interface DependencyEdgeProjectionRow {
  source_run_id: string;
  from_path: string;
  to_path: string;
  edge_kind: string;
  evidence_path: string;
}

export interface DiagramArtifactProjectionRow {
  source_run_id: string;
  format: string;
  evidence_path: string;
}

export interface ToolFindingProjectionRow {
  source_run_id: string;
  finding_type: string;
  severity: "error" | "warn" | "info";
  subject?: string;
  path?: string;
  evidence_path: string;
}

export interface ToolAdapterProjection {
  tool_runs: ToolRunProjectionRow[];
  dependency_edges: DependencyEdgeProjectionRow[];
  diagram_artifacts: DiagramArtifactProjectionRow[];
  findings: ToolFindingProjectionRow[];
  actionsTaken: string[];
  ok: boolean;
}

export interface DiagramRefreshArtifact {
  path: string;
  format: "mermaid" | "dot" | "d2";
  sourceDigest: string;
}

export interface DiagramRefreshInput {
  graphSnapshotDigest: string;
  requestedFormat: "mermaid" | "dot" | "d2";
  artifacts: DiagramRefreshArtifact[];
  adapterReady: boolean;
}

export interface DiagramRefreshAction {
  action: "refresh" | "mark-stale" | "noop";
  path: string;
  reason: string;
}

export interface DiagramRefreshPlan {
  actions: DiagramRefreshAction[];
  findings: ToolAdapterFinding[];
  ok: boolean;
}

const ADAPTERS: Record<ToolAdapterId, ToolAdapterProfile> = {
  "dependency-cruiser": {
    id: "dependency-cruiser",
    label: "dependency-cruiser dependency graph",
    packageName: "dependency-cruiser",
    executable: null,
    triggerSignals: ["source_change", "dependency_graph"],
    outputFormats: ["json", "dot"],
    riskTier: "medium",
    defaultEnabled: false,
    availableByDefault: false,
  },
  knip: {
    id: "knip",
    label: "Knip dead code/dependency detector",
    packageName: "knip",
    executable: null,
    triggerSignals: ["source_change", "dead_node"],
    outputFormats: ["json"],
    riskTier: "medium",
    defaultEnabled: false,
    availableByDefault: false,
  },
  madge: {
    id: "madge",
    label: "Madge dependency graph",
    packageName: "madge",
    executable: null,
    triggerSignals: ["source_change", "dependency_graph"],
    outputFormats: ["json", "dot"],
    riskTier: "medium",
    defaultEnabled: false,
    availableByDefault: false,
  },
  "graphviz-dot": {
    id: "graphviz-dot",
    label: "Graphviz DOT renderer",
    packageName: null,
    executable: "dot",
    triggerSignals: ["diagram_render"],
    outputFormats: ["svg", "png"],
    riskTier: "low",
    defaultEnabled: false,
    availableByDefault: false,
  },
  mermaid: {
    id: "mermaid",
    label: "Mermaid text diagram renderer",
    packageName: "@mermaid-js/mermaid-cli",
    executable: null,
    triggerSignals: ["diagram_render"],
    outputFormats: ["mermaid", "svg"],
    riskTier: "low",
    defaultEnabled: false,
    availableByDefault: false,
  },
  d2: {
    id: "d2",
    label: "D2 diagram renderer",
    packageName: "@terrastruct/d2",
    executable: "d2",
    triggerSignals: ["diagram_render"],
    outputFormats: ["d2", "svg"],
    riskTier: "low",
    defaultEnabled: false,
    availableByDefault: false,
  },
};

function finding(input: {
  code: ToolAdapterFindingCode;
  message: string;
  severity?: "error" | "warn" | "info";
  adapterId?: ToolAdapterId;
}): ToolAdapterFinding {
  return {
    code: input.code,
    severity: input.severity ?? "warn",
    message: input.message,
    adapterId: input.adapterId,
  };
}

export function catalogToolAdapters(): ToolAdapterCatalogResult {
  return {
    adapters: Object.values(ADAPTERS).sort((a, b) => a.id.localeCompare(b.id)),
    ok: true,
  };
}

function inWorkspace(repoRoot: string, scope: string): boolean {
  const repo = normalizePath(repoRoot).replace(/\/$/, "");
  const normalized = normalizePath(scope).replace(/\/$/, "");
  return normalized === "." || normalized === repo || normalized.startsWith(`${repo}/`);
}

export function probeToolAdapter(
  id: string,
  deps: ToolAdapterProbeDeps,
): ToolAdapterProbeResult | null {
  const adapter = ADAPTERS[id as ToolAdapterId];
  if (!adapter) return null;
  const findings: ToolAdapterFinding[] = [];
  if (adapter.packageName && !deps.declaredPackages.includes(adapter.packageName)) {
    findings.push(
      finding({
        code: "package-missing",
        message: `${adapter.packageName} is not declared; do not install implicitly`,
        adapterId: adapter.id,
      }),
    );
  }
  if (adapter.executable && !deps.executableOk(adapter.executable)) {
    findings.push(
      finding({
        code: "unavailable-adapter",
        message: `${adapter.executable} executable is unavailable`,
        adapterId: adapter.id,
      }),
    );
  }
  if (deps.scanScope && !inWorkspace(deps.repoRoot, deps.scanScope)) {
    findings.push(
      finding({
        code: "scope-outside-workspace",
        message: `${deps.scanScope} is outside workspace root`,
        severity: "error",
        adapterId: adapter.id,
      }),
    );
  }
  return {
    adapter,
    ready: findings.length === 0,
    findings,
    actionsTaken: [],
  };
}

function runId(input: ToolAdapterRunEvidence): string {
  return `${input.adapterId}:${normalizePath(input.evidencePath)}`;
}

export function normalizeToolAdapterRun(input: ToolAdapterRunEvidence): ToolAdapterProjection {
  const sourceRunId = runId(input);
  return {
    tool_runs: [
      {
        tool_run_id: sourceRunId,
        adapter_id: input.adapterId,
        command: input.command,
        version: input.version,
        input_scope: normalizePath(input.inputScope),
        exit_code: input.exitCode,
        evidence_path: normalizePath(input.evidencePath),
        normalized_status: input.status,
      },
    ],
    dependency_edges: (input.dependencyEdges ?? [])
      .map((edge) => ({
        source_run_id: sourceRunId,
        from_path: normalizePath(edge.from),
        to_path: normalizePath(edge.to),
        edge_kind: edge.kind,
        evidence_path: normalizePath(input.evidencePath),
      }))
      .sort((a, b) => a.from_path.localeCompare(b.from_path) || a.to_path.localeCompare(b.to_path)),
    diagram_artifacts: ADAPTERS[input.adapterId].outputFormats
      .filter((format) => format === "mermaid" || format === "dot" || format === "d2")
      .map((format) => ({
        source_run_id: sourceRunId,
        format,
        evidence_path: normalizePath(input.evidencePath),
      })),
    findings: (input.findings ?? [])
      .map((item) => ({
        source_run_id: sourceRunId,
        finding_type: item.type,
        severity: item.severity,
        subject: item.subject,
        path: item.path ? normalizePath(item.path) : undefined,
        evidence_path: normalizePath(input.evidencePath),
      }))
      .sort(
        (a, b) =>
          a.finding_type.localeCompare(b.finding_type) ||
          (a.path ?? "").localeCompare(b.path ?? ""),
      ),
    actionsTaken: [],
    ok:
      input.status === "passed" &&
      !(input.findings ?? []).some((item) => item.severity === "error"),
  };
}

export function planDiagramRefresh(input: DiagramRefreshInput): DiagramRefreshPlan {
  const findings: ToolAdapterFinding[] = [];
  if ((input.requestedFormat === "dot" || input.requestedFormat === "d2") && !input.adapterReady) {
    findings.push(
      finding({
        code: "renderer-unavailable",
        message: `${input.requestedFormat} renderer is unavailable; no implicit install or invocation`,
      }),
    );
    return { actions: [], findings, ok: false };
  }
  const actions = input.artifacts
    .filter((artifact) => artifact.format === input.requestedFormat)
    .map((artifact): DiagramRefreshAction => {
      if (artifact.sourceDigest === input.graphSnapshotDigest) {
        return { action: "noop", path: artifact.path, reason: "diagram source digest is current" };
      }
      return {
        action: "refresh",
        path: artifact.path,
        reason: "diagram source digest is stale",
      };
    });
  return {
    actions,
    findings,
    ok: actions.every((action) => action.action === "noop"),
  };
}
