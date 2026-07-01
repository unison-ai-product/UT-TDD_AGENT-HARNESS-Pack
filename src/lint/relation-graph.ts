/**
 * Cross-artifact relation graph projection (A-124/A-125、PLAN-L7-32 塊C span)。
 *
 * L6-31 (module-drift.md addendum) の契約 `collectRelationGraphProjection` を実装する。
 * requirements / PLAN / design / test-design / source / test / DB table / verification-profile を
 * 安定 node ID + typed edge へ正規化した **rebuildable projection** を返す。projection は authoring
 * source ではなく、raw MCP response / browser trace / screenshot / provider transcript / secret /
 * credential を行へ複製しない (sanitization invariant、U-RELGRAPH-003)。
 *
 * 本 span = collect (U-RELGRAPH-001..003) + analyzeRelationImpact (004..006)。
 * exportRelationDiagram / verification-evidence-projection (PLAN-L7-36) は別 span。
 */

import type {
  DiagramArtifact,
  ExportRelationDiagramInput,
  RelationEdge,
  RelationEdgeKind,
  RelationFinding,
  RelationGraphProjection,
  RelationGraphSourceSet,
  RelationImpactAction,
  RelationImpactInput,
  RelationImpactResult,
  RelationNode,
  RelationNodeKind,
  VerificationEvidenceInput,
  VerificationProfileRow,
} from "./relation-graph-types";
import { normalizePath } from "./shared";

export type {
  DbTableInput,
  DesignDocInput,
  DiagramArtifact,
  ExportRelationDiagramInput,
  PlanInput,
  RelationDiagramAdapter,
  RelationDiagramFormat,
  RelationEdge,
  RelationEdgeKind,
  RelationFinding,
  RelationFindingCode,
  RelationGraphProjection,
  RelationGraphSourceSet,
  RelationImpactAction,
  RelationImpactActionKind,
  RelationImpactInput,
  RelationImpactResult,
  RelationNode,
  RelationNodeKind,
  RequirementInput,
  SourceFileInput,
  TestDesignDocInput,
  TestFileInput,
  VerificationEvidenceInput,
  VerificationProfileRow,
} from "./relation-graph-types";

function nodeId(kind: RelationNodeKind, key: string): string {
  return `${kind}:${key}`;
}

/** (kind,id,path) を一意化しながら node を accumulate する。 */
function pushNode(seen: Map<string, RelationNode>, node: RelationNode): void {
  const dedupKey = `${node.kind}|${node.id}|${node.path ?? ""}`;
  if (!seen.has(dedupKey)) {
    seen.set(dedupKey, node);
  }
}

/** (from,to,kind) を一意化しながら edge を accumulate する。 */
function pushEdge(seen: Map<string, RelationEdge>, edge: RelationEdge): void {
  const dedupKey = `${edge.from}|${edge.to}|${edge.kind}`;
  if (!seen.has(dedupKey)) {
    seen.set(dedupKey, edge);
  }
}

const SENSITIVE_FIELDS: ReadonlyArray<keyof VerificationEvidenceInput> = [
  "rawMcpResponse",
  "browserTrace",
  "providerTranscript",
  "secret",
  "screenshotBlob",
];

function projectVerificationEvidence(input: VerificationEvidenceInput): {
  row: VerificationProfileRow;
  node: RelationNode;
  finding: RelationFinding;
} {
  const id = nodeId("verification-profile", input.id);
  const redactedFieldCount = SENSITIVE_FIELDS.filter(
    (field) => typeof input[field] === "string" && input[field] !== "",
  ).length;
  return {
    node: {
      id,
      kind: "verification-profile",
      path: input.evidencePath,
      label: input.classification,
    },
    row: {
      nodeId: id,
      classification: input.classification,
      evidencePath: input.evidencePath,
      redactedSummary: input.summary ?? "",
      redactedFieldCount,
    },
    finding: {
      code: "redacted-evidence",
      severity: "info",
      message: `verification evidence ${input.id}: redacted ${redactedFieldCount} sensitive field(s); only classification/count/path/summary retained`,
      nodeId: id,
      evidencePath: input.evidencePath,
    },
  };
}

/**
 * source set を node + typed edge の正規化 projection へ変換する (rebuildable、authoring source でない)。
 * 行は (kind,id,path) / (from,to,kind) で一意化し、決定的順序で返す。
 */
export function collectRelationGraphProjection(
  input: RelationGraphSourceSet,
): RelationGraphProjection {
  const nodes = new Map<string, RelationNode>();
  const edges = new Map<string, RelationEdge>();
  const findings: RelationFinding[] = [];
  const verificationProfiles: VerificationProfileRow[] = [];

  for (const req of input.requirements ?? []) {
    pushNode(nodes, { id: nodeId("requirement", req.id), kind: "requirement", path: req.path });
  }
  for (const td of input.testDesignDocs ?? []) {
    pushNode(nodes, { id: nodeId("test-design", td.id), kind: "test-design", path: td.path });
  }
  for (const src of input.sourceFiles ?? []) {
    pushNode(nodes, { id: nodeId("source", src.path), kind: "source", path: src.path });
    for (const test of src.tests ?? []) {
      pushEdge(edges, {
        from: nodeId("source", src.path),
        to: nodeId("test", test),
        kind: "covered-by",
      });
    }
  }
  for (const test of input.tests ?? []) {
    pushNode(nodes, { id: nodeId("test", test.path), kind: "test", path: test.path });
  }
  for (const design of input.designDocs ?? []) {
    pushNode(nodes, { id: nodeId("design", design.id), kind: "design", path: design.path });
    if (design.pairs) {
      pushEdge(edges, {
        from: nodeId("design", design.id),
        to: nodeId("test-design", design.pairs),
        kind: "pairs",
      });
    }
    for (const src of design.behavioralContract ?? []) {
      pushEdge(edges, {
        from: nodeId("design", design.id),
        to: nodeId("source", src),
        kind: "behavioral-contract",
      });
    }
  }
  for (const plan of input.plans ?? []) {
    pushNode(nodes, { id: nodeId("plan", plan.id), kind: "plan", path: plan.path });
    for (const req of plan.requirements ?? []) {
      pushEdge(edges, {
        from: nodeId("plan", plan.id),
        to: nodeId("requirement", req),
        kind: "derives-from",
      });
    }
    for (const src of plan.generates ?? []) {
      pushEdge(edges, {
        from: nodeId("plan", plan.id),
        to: nodeId("source", src),
        kind: "generates",
      });
    }
  }
  for (const table of input.dbTables ?? []) {
    const id = nodeId("db-table", table.name);
    pushNode(nodes, { id, kind: "db-table", path: table.path, label: table.name });
    const upstream = table.upstream ?? [];
    for (const up of upstream) {
      pushEdge(edges, { from: id, to: up, kind: "upstream" });
    }
    if (upstream.length === 0) {
      findings.push({
        code: "orphan-table",
        severity: "warn",
        message: `db table ${table.name} has no upstream requirement/ADR/PLAN reference`,
        nodeId: id,
      });
    }
  }
  for (const evidence of input.verificationEvidence ?? []) {
    const projected = projectVerificationEvidence(evidence);
    pushNode(nodes, projected.node);
    verificationProfiles.push(projected.row);
    findings.push(projected.finding);
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: sortEdges([...edges.values()]),
    verificationProfiles: verificationProfiles.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    findings: sortFindings(findings),
  };
}

function sortEdges(list: RelationEdge[]): RelationEdge[] {
  return [...list].sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  );
}

function sortFindings(list: RelationFinding[]): RelationFinding[] {
  return [...list].sort(
    (a, b) => a.code.localeCompare(b.code) || (a.nodeId ?? "").localeCompare(b.nodeId ?? ""),
  );
}

// ---- analyzeRelationImpact (U-RELGRAPH-004..006) -------------------------------

/** 変更が要求する follow-up action の種別。 */
interface GraphIndex {
  nodeById: Map<string, RelationNode>;
  edgesFrom: Map<string, RelationEdge[]>;
  edgesTo: Map<string, RelationEdge[]>;
}

function appendEdge(map: Map<string, RelationEdge[]>, key: string, edge: RelationEdge): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(edge);
  } else {
    map.set(key, [edge]);
  }
}

function buildIndex(projection: RelationGraphProjection): GraphIndex {
  const nodeById = new Map<string, RelationNode>();
  for (const node of projection.nodes) {
    nodeById.set(node.id, node);
  }
  const edgesFrom = new Map<string, RelationEdge[]>();
  const edgesTo = new Map<string, RelationEdge[]>();
  for (const edge of projection.edges) {
    appendEdge(edgesFrom, edge.from, edge);
    appendEdge(edgesTo, edge.to, edge);
  }
  return { nodeById, edgesFrom, edgesTo };
}

function targets(
  edges: RelationEdge[] | undefined,
  kind: RelationEdgeKind,
  index: GraphIndex,
): RelationNode[] {
  return (edges ?? [])
    .filter((e) => e.kind === kind)
    .map((e) => index.nodeById.get(e.to))
    .filter((n): n is RelationNode => n !== undefined);
}

function sources(
  edges: RelationEdge[] | undefined,
  kind: RelationEdgeKind,
  index: GraphIndex,
): RelationNode[] {
  return (edges ?? [])
    .filter((e) => e.kind === kind)
    .map((e) => index.nodeById.get(e.from))
    .filter((n): n is RelationNode => n !== undefined);
}

interface Expansion {
  impacted: RelationNode[];
  actions: RelationImpactAction[];
  findings: RelationFinding[];
}

function expandSource(node: RelationNode, index: GraphIndex): Expansion {
  const tests = targets(index.edgesFrom.get(node.id), "covered-by", index);
  const plans = sources(index.edgesTo.get(node.id), "generates", index);
  const actions: RelationImpactAction[] = [
    {
      kind: "review-design-contract",
      nodeId: node.id,
      reason: "source change requires L6 design contract review",
    },
    {
      kind: "reverse-backprop",
      nodeId: node.id,
      reason: "lower-layer source change may need reverse/backprop to design/requirement",
    },
  ];
  const findings: RelationFinding[] = [];
  if (tests.length > 0) {
    for (const t of tests) {
      actions.push({
        kind: "require-sibling-test",
        nodeId: t.id,
        reason: "sibling test must cover the source change",
      });
      actions.push({
        kind: "review-l7-oracle",
        nodeId: t.id,
        reason: "L7 unit oracle must reflect the source change",
      });
    }
  } else {
    actions.push({
      kind: "require-sibling-test",
      nodeId: node.id,
      reason: "no sibling test in projection — add coverage",
    });
    findings.push({
      code: "missing-test-coverage",
      severity: "warn",
      message: `source ${node.path ?? node.id} has no sibling test (covered-by) edge`,
      nodeId: node.id,
    });
  }
  for (const p of plans) {
    actions.push({
      kind: "update-plan",
      nodeId: p.id,
      reason: "owning PLAN must record the source change",
    });
  }
  return { impacted: [...tests, ...plans], actions, findings };
}

function expandDesignLike(node: RelationNode, index: GraphIndex): Expansion {
  const isDesign = node.kind === "design";
  // design -> test-design (pairs)。test-design 変更時は逆引きで paired design を得る。
  const paired = isDesign
    ? targets(index.edgesFrom.get(node.id), "pairs", index)
    : sources(index.edgesTo.get(node.id), "pairs", index);
  // behavioral contract は design 側が宣言する (design -> source の edge)。design 変更は自身の
  // edge を、test-design 変更は paired design の edge を辿る (test-design 自体は contract を持たない)。
  const contractOwners = isDesign ? [node] : paired;
  const behavioralSources = dedupeNodes(
    contractOwners.flatMap((owner) =>
      targets(index.edgesFrom.get(owner.id), "behavioral-contract", index),
    ),
  );
  const actions: RelationImpactAction[] = [
    {
      kind: "update-plan-dod",
      nodeId: node.id,
      reason: "design/test-design change updates the owning PLAN DoD",
    },
    {
      kind: "record-trace-freeze-evidence",
      nodeId: node.id,
      reason: "design/test-design change requires trace-freeze evidence",
    },
  ];
  for (const p of paired) {
    actions.push({
      kind: "update-paired-artifact",
      nodeId: p.id,
      reason: "paired design⇔test-design artifact must stay consistent",
    });
  }
  // behavioral contract edge が無ければ source test を要求しない (U-RELGRAPH-005 conditional)。
  for (const src of behavioralSources) {
    actions.push({
      kind: "require-sibling-test",
      nodeId: src.id,
      reason: "behavioral-contract edge requires source test update",
    });
  }
  return { impacted: [...paired, ...behavioralSources], actions, findings: [] };
}

function expandDbTable(node: RelationNode, index: GraphIndex): Expansion {
  const upstreamEdges = (index.edgesFrom.get(node.id) ?? []).filter((e) => e.kind === "upstream");
  const actions: RelationImpactAction[] = [
    {
      kind: "rebuild-db-table",
      nodeId: node.id,
      reason: "physical-data change requires DB table rebuild contract check",
    },
  ];
  const impacted: RelationNode[] = [];
  for (const edge of upstreamEdges) {
    // upstream は requirement/ADR/PLAN を指す。ADR 等は projection に未 materialize でも
    // review action は要る (review は edge target id 基準、impacted は実在 node のみ)。
    actions.push({
      kind: "review-upstream",
      nodeId: edge.to,
      reason: "DB table change must trace to upstream requirement/ADR/PLAN",
    });
    const target = index.nodeById.get(edge.to);
    if (target) {
      impacted.push(target);
    }
  }
  return { impacted, actions, findings: [] };
}

function expandNode(node: RelationNode, index: GraphIndex): Expansion {
  if (node.kind === "source") {
    return expandSource(node, index);
  }
  if (node.kind === "design" || node.kind === "test-design") {
    return expandDesignLike(node, index);
  }
  if (node.kind === "db-table") {
    return expandDbTable(node, index);
  }
  return { impacted: [], actions: [], findings: [] };
}

function detectStaleEdges(
  projection: RelationGraphProjection,
  index: GraphIndex,
): RelationFinding[] {
  const findings: RelationFinding[] = [];
  for (const edge of projection.edges) {
    // from (edge の所有 node) は kind を問わず projection 内に実在すべき。
    // to は構造 edge では実在必須だが、upstream の target (requirement/ADR/PLAN) のみ
    // 未 materialize な外部 governance 参照を許す (ADR は node kind を持たない)。
    const targetExternal = edge.kind === "upstream";
    const dangling =
      !index.nodeById.has(edge.from) || (!targetExternal && !index.nodeById.has(edge.to));
    if (dangling) {
      findings.push({
        code: "stale-edge",
        severity: "error",
        message: `stale edge ${edge.from} -[${edge.kind}]-> ${edge.to}: endpoint node missing from projection`,
        nodeId: edge.from,
      });
    }
  }
  return findings;
}

function dedupeNodes(list: RelationNode[]): RelationNode[] {
  const seen = new Map<string, RelationNode>();
  for (const n of list) {
    if (!seen.has(n.id)) {
      seen.set(n.id, n);
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function dedupeActions(list: RelationImpactAction[]): RelationImpactAction[] {
  const seen = new Map<string, RelationImpactAction>();
  for (const a of list) {
    const key = `${a.kind}|${a.nodeId}`;
    if (!seen.has(key)) {
      seen.set(key, a);
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.nodeId.localeCompare(b.nodeId),
  );
}

/**
 * 変更 path を projection node へ突合し、edge を辿って波及 node + 必須 follow-up action を返す。
 * projection に node が無い変更 path / 端点欠落 edge は finding + ok=false にし、
 * 弱い analyzeChangeImpact へ無音で fallback しない (U-RELGRAPH-006)。
 */
function nodesForChangedPath(path: string, nodeByPath: Map<string, RelationNode>): RelationNode[] {
  const exact = nodeByPath.get(path);
  if (exact) {
    return [exact];
  }

  const childPrefix = `${path.replace(/\/+$/u, "")}/`;
  return [...nodeByPath.entries()]
    .filter(([nodePath]) => nodePath.startsWith(childPrefix))
    .map(([, node]) => node)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function analyzeRelationImpact(input: RelationImpactInput): RelationImpactResult {
  const index = buildIndex(input.projection);
  const nodeByPath = new Map<string, RelationNode>();
  for (const node of input.projection.nodes) {
    if (node.path) {
      nodeByPath.set(normalizePath(node.path), node);
    }
  }

  const changedNodes: RelationNode[] = [];
  const impacted: RelationNode[] = [];
  const actions: RelationImpactAction[] = [];
  const findings: RelationFinding[] = detectStaleEdges(input.projection, index);

  for (const raw of input.changedPaths) {
    const path = normalizePath(raw);
    const nodes = nodesForChangedPath(path, nodeByPath);
    if (nodes.length === 0) {
      findings.push({
        code: "missing-projection",
        severity: "error",
        message: `changed path ${path} has no relation-graph node; impact cannot be analyzed (no silent change-impact fallback)`,
      });
      continue;
    }
    for (const node of nodes) {
      changedNodes.push(node);
      const expansion = expandNode(node, index);
      impacted.push(...expansion.impacted);
      actions.push(...expansion.actions);
      findings.push(...expansion.findings);
    }
  }

  const sortedFindings = sortFindings(findings);
  return {
    changedNodes: dedupeNodes(changedNodes),
    impacted: dedupeNodes(impacted),
    actions: dedupeActions(actions),
    findings: sortedFindings,
    ok: !sortedFindings.some((f) => f.severity === "error"),
  };
}

// ---- PLAN-L7-36: exportRelationDiagram (U-RELGRAPH-007..008) ------------------

function diagramNodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function quotedLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function relationDiagramRows(snapshot: RelationGraphProjection): {
  nodes: RelationNode[];
  edges: RelationEdge[];
} {
  return {
    nodes: [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: sortEdges(snapshot.edges),
  };
}

function renderMermaid(snapshot: RelationGraphProjection): string {
  const { nodes, edges } = relationDiagramRows(snapshot);
  const lines = ["flowchart TD"];
  for (const node of nodes) {
    lines.push(`  ${diagramNodeId(node.id)}["${quotedLabel(node.id)}"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${diagramNodeId(edge.from)} -->|${edge.kind}| ${diagramNodeId(edge.to)}`);
  }
  return lines.join("\n");
}

function renderDot(snapshot: RelationGraphProjection): string {
  const { nodes, edges } = relationDiagramRows(snapshot);
  const lines = ["digraph relation_graph {"];
  for (const node of nodes) {
    lines.push(`  "${node.id}" [label="${quotedLabel(node.id)}"];`);
  }
  for (const edge of edges) {
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.kind}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderD2(snapshot: RelationGraphProjection): string {
  const { nodes, edges } = relationDiagramRows(snapshot);
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${diagramNodeId(node.id)}: "${quotedLabel(node.id)}"`);
  }
  for (const edge of edges) {
    lines.push(`${diagramNodeId(edge.from)} -> ${diagramNodeId(edge.to)}: "${edge.kind}"`);
  }
  return lines.join("\n");
}

export function exportRelationDiagram(input: ExportRelationDiagramInput): DiagramArtifact {
  if (input.format === "mermaid") {
    return {
      format: "mermaid",
      content: renderMermaid(input.snapshot),
      findings: [],
      ok: true,
      invokedAdapters: [],
    };
  }

  const available = new Set(input.availableAdapters ?? []);
  if (!available.has(input.format)) {
    return {
      format: input.format,
      content: "",
      findings: [
        {
          code: "unavailable-adapter",
          severity: "warn",
          message: `${input.format} diagram adapter is unavailable; no install or external command was invoked`,
        },
      ],
      ok: false,
      invokedAdapters: [],
    };
  }

  return {
    format: input.format,
    content: input.format === "dot" ? renderDot(input.snapshot) : renderD2(input.snapshot),
    findings: [],
    ok: true,
    invokedAdapters: [input.format],
  };
}

export * from "./relation-graph-evidence";
