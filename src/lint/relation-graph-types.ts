type RelationNodeKind =
  | "requirement"
  | "plan"
  | "design"
  | "test-design"
  | "source"
  | "test"
  | "db-table"
  | "verification-profile"
  | "external-tool"
  | "diagram";

type RelationEdgeKind =
  | "derives-from"
  | "generates"
  | "pairs"
  | "covered-by"
  | "upstream"
  | "behavioral-contract";

type RelationFindingCode =
  | "orphan-table"
  | "redacted-evidence"
  | "unavailable-adapter"
  | "invalid-evidence"
  | "external-not-allowed"
  | "missing-projection"
  | "stale-edge"
  | "missing-test-coverage";

interface RelationNode {
  id: string;
  kind: RelationNodeKind;
  path?: string;
  label?: string;
}

interface RelationEdge {
  from: string;
  to: string;
  kind: RelationEdgeKind;
}

interface RelationFinding {
  code: RelationFindingCode;
  severity: "error" | "warn" | "info";
  message: string;
  nodeId?: string;
  evidencePath?: string;
}

interface RequirementInput {
  id: string;
  path?: string;
}

interface PlanInput {
  id: string;
  path?: string;
  requirements?: string[];
  generates?: string[];
}

interface DesignDocInput {
  id: string;
  path: string;
  pairs?: string;
  behavioralContract?: string[];
}

interface TestDesignDocInput {
  id: string;
  path: string;
}

interface SourceFileInput {
  path: string;
  tests?: string[];
}

interface TestFileInput {
  path: string;
}

interface DbTableInput {
  name: string;
  upstream?: string[];
  path?: string;
}

interface VerificationEvidenceInput {
  id: string;
  evidencePath: string;
  classification: string;
  summary?: string;
  rawMcpResponse?: string;
  browserTrace?: string;
  providerTranscript?: string;
  secret?: string;
  screenshotBlob?: string;
}

interface RelationGraphSourceSet {
  requirements?: RequirementInput[];
  plans?: PlanInput[];
  designDocs?: DesignDocInput[];
  testDesignDocs?: TestDesignDocInput[];
  sourceFiles?: SourceFileInput[];
  tests?: TestFileInput[];
  dbTables?: DbTableInput[];
  verificationEvidence?: VerificationEvidenceInput[];
}

interface VerificationProfileRow {
  nodeId: string;
  classification: string;
  evidencePath: string;
  redactedSummary: string;
  redactedFieldCount: number;
}

interface RelationGraphProjection {
  nodes: RelationNode[];
  edges: RelationEdge[];
  verificationProfiles: VerificationProfileRow[];
  findings: RelationFinding[];
}

type RelationImpactActionKind =
  | "require-sibling-test"
  | "review-design-contract"
  | "review-l7-oracle"
  | "update-plan"
  | "reverse-backprop"
  | "update-paired-artifact"
  | "update-plan-dod"
  | "record-trace-freeze-evidence"
  | "rebuild-db-table"
  | "review-upstream";

interface RelationImpactAction {
  kind: RelationImpactActionKind;
  nodeId: string;
  reason: string;
}

interface RelationImpactInput {
  changedPaths: string[];
  projection: RelationGraphProjection;
}

interface RelationImpactResult {
  changedNodes: RelationNode[];
  impacted: RelationNode[];
  actions: RelationImpactAction[];
  findings: RelationFinding[];
  ok: boolean;
}

type RelationDiagramFormat = "mermaid" | "dot" | "d2";
type RelationDiagramAdapter = Exclude<RelationDiagramFormat, "mermaid">;

interface ExportRelationDiagramInput {
  snapshot: RelationGraphProjection;
  format: RelationDiagramFormat;
  availableAdapters?: RelationDiagramAdapter[];
}

interface DiagramArtifact {
  format: RelationDiagramFormat;
  content: string;
  findings: RelationFinding[];
  ok: boolean;
  invokedAdapters: RelationDiagramAdapter[];
}

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
};
