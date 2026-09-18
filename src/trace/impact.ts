import type { HarnessDb } from "../state-db/index.ts";

export interface TraceImpactNode {
  spec_id: string;
  spec_kind: string;
  layer: string;
  sub_doc: string;
  owner_path: string;
  title: string;
}

export interface TraceImpactEdge {
  from_spec_id: string;
  to_spec_id: string;
  relation_kind: string;
  evidence_path: string;
}

export interface TraceImpactFinding {
  code: "trace-impact-root-missing" | "trace-impact-empty-projection";
  severity: "error" | "warn";
  message: string;
}

export interface TraceImpactResult {
  ok: boolean;
  root?: TraceImpactNode;
  upstream: TraceImpactNode[];
  downstream: TraceImpactNode[];
  tests: TraceImpactNode[];
  edges: TraceImpactEdge[];
  findings: TraceImpactFinding[];
}

interface SpecDefRecord {
  spec_id: string;
  spec_kind: string;
  layer: string;
  sub_doc: string;
  owner_path: string;
  section_anchor: string;
  title: string;
}

interface SpecRelationRecord {
  from_spec_id: string;
  to_spec_id: string;
  relation_kind: string;
  evidence_path: string;
}

interface FlowEdge {
  from: string;
  to: string;
  relation_kind: string;
  evidence_path: string;
}

function rowToNode(row: SpecDefRecord): TraceImpactNode {
  return {
    spec_id: row.spec_id,
    spec_kind: row.spec_kind,
    layer: row.layer,
    sub_doc: row.sub_doc,
    owner_path: row.owner_path,
    title: row.title,
  };
}

function isTestNode(node: TraceImpactNode | undefined): boolean {
  if (!node) return false;
  const text = `${node.spec_id} ${node.spec_kind} ${node.title}`.toLowerCase();
  return text.includes("test") || text.includes("oracle");
}

function normalizedFlowEdges(relations: SpecRelationRecord[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const relation of relations) {
    const common = {
      relation_kind: relation.relation_kind,
      evidence_path: relation.evidence_path,
    };
    if (relation.relation_kind === "traces_from" || relation.relation_kind === "requires") {
      edges.push({ from: relation.to_spec_id, to: relation.from_spec_id, ...common });
      continue;
    }
    if (relation.relation_kind === "pairs") {
      edges.push({ from: relation.from_spec_id, to: relation.to_spec_id, ...common });
      edges.push({ from: relation.to_spec_id, to: relation.from_spec_id, ...common });
      continue;
    }
    edges.push({ from: relation.from_spec_id, to: relation.to_spec_id, ...common });
  }
  return edges;
}

function traverse(
  start: string,
  edges: FlowEdge[],
  direction: "downstream" | "upstream",
): { ids: string[]; edges: TraceImpactEdge[] } {
  const seen = new Set<string>([start]);
  const queue = [start];
  const ids: string[] = [];
  const usedEdges: TraceImpactEdge[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const matches =
      direction === "downstream"
        ? edges.filter((edge) => edge.from === current)
        : edges.filter((edge) => edge.to === current);
    for (const edge of matches) {
      const next = direction === "downstream" ? edge.to : edge.from;
      usedEdges.push({
        from_spec_id: edge.from,
        to_spec_id: edge.to,
        relation_kind: edge.relation_kind,
        evidence_path: edge.evidence_path,
      });
      if (seen.has(next)) continue;
      seen.add(next);
      ids.push(next);
      queue.push(next);
    }
  }
  return { ids, edges: usedEdges };
}

function uniqueEdges(edges: TraceImpactEdge[]): TraceImpactEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from_spec_id}\0${edge.to_spec_id}\0${edge.relation_kind}\0${edge.evidence_path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyzeTraceImpact(db: HarnessDb, specId: string): TraceImpactResult {
  const id = specId.trim();
  const defs = db
    .prepare(
      "SELECT spec_id, spec_kind, layer, sub_doc, owner_path, section_anchor, title FROM spec_defs ORDER BY spec_id",
    )
    .all() as unknown as SpecDefRecord[];
  if (defs.length === 0) {
    return {
      ok: false,
      upstream: [],
      downstream: [],
      tests: [],
      edges: [],
      findings: [
        {
          code: "trace-impact-empty-projection",
          severity: "warn",
          message: "spec_defs is empty; run `ut-tdd db rebuild` before trace impact traversal",
        },
      ],
    };
  }
  const idDefs = defs.filter((row) => row.section_anchor.startsWith("spec.defines:"));
  const defsById = new Map(idDefs.map((row) => [row.spec_id, rowToNode(row)]));
  const root = defsById.get(id);
  if (!root) {
    return {
      ok: false,
      upstream: [],
      downstream: [],
      tests: [],
      edges: [],
      findings: [
        {
          code: "trace-impact-root-missing",
          severity: "error",
          message: `spec id not found: ${id}`,
        },
      ],
    };
  }
  const relations = db
    .prepare(
      "SELECT from_spec_id, to_spec_id, relation_kind, evidence_path FROM spec_relations WHERE status = 'active' ORDER BY relation_id",
    )
    .all() as unknown as SpecRelationRecord[];
  const flowEdges = normalizedFlowEdges(
    relations.filter(
      (relation) => defsById.has(relation.from_spec_id) && defsById.has(relation.to_spec_id),
    ),
  );
  const upstreamTraversal = traverse(id, flowEdges, "upstream");
  const downstreamTraversal = traverse(id, flowEdges, "downstream");
  const downstream = downstreamTraversal.ids
    .map((nodeId) => defsById.get(nodeId))
    .filter((node): node is TraceImpactNode => node !== undefined);
  const testIds = new Set(
    downstream
      .filter((node) => isTestNode(node))
      .map((node) => node.spec_id)
      .concat(
        flowEdges
          .filter((edge) => edge.from === id && edge.relation_kind === "tests")
          .map((edge) => edge.to),
      ),
  );
  return {
    ok: true,
    root,
    upstream: upstreamTraversal.ids
      .map((nodeId) => defsById.get(nodeId))
      .filter((node): node is TraceImpactNode => node !== undefined),
    downstream: downstream.filter((node) => !testIds.has(node.spec_id)),
    tests: [...testIds]
      .map((nodeId) => defsById.get(nodeId))
      .filter((node): node is TraceImpactNode => node !== undefined),
    edges: uniqueEdges([...upstreamTraversal.edges, ...downstreamTraversal.edges]),
    findings: [],
  };
}
