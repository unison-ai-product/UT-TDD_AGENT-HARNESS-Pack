import {
  inferTaskDifficulty,
  PROPOSAL_SUBAGENT_LANES,
  type ProposalSubagentLaneName,
  type TaskDifficulty,
} from "../team/model-policy";
import {
  classifyDrive,
  evaluateRouteCommand,
  type Finding,
  scoreTaskComplexity,
} from "../workflow/contracts";
import {
  BASELINE_DOCUMENT_PACK,
  KIND_PATTERNS,
  PROPOSAL_COVERAGE_GUARDRAILS,
  PROPOSAL_DOCUMENT_COVERAGE_ROUTING_TEST_DOC,
  RISK_TERMS,
  UNCERTAINTY_TERMS,
} from "./classify-policy";
import {
  DOCUMENT_PACKS,
  type DocumentPack,
  doc,
  LEVEL_RANK,
  LLM_SHRINK_TERMS,
  RANK_LEVEL,
  RESEARCH_ADOPTION_BY_PATTERN,
  RESEARCH_REJECTION_KEYWORDS,
  RESEARCH_REJECTION_RULES,
} from "./proposal-coverage-data";

/**
 * FR-L1-39 public task classification surface.
 *
 * Composes the existing deterministic contracts (`classifyDrive` = FR-L1-41,
 * `scoreTaskComplexity` = FR-L1-39, `inferTaskDifficulty`) and adds kind
 * inference plus escalation-risk flagging (CLAUDE.md safety boundary). The
 * `ut-tdd task classify` CLI is the public I/O that feeds plan lint / gate /
 * skill suggest.
 */

export type TaskKind =
  | "design"
  | "add-feature"
  | "refactor"
  | "troubleshoot"
  | "poc"
  | "reverse"
  | "unknown";

export interface TaskClassification {
  kind: TaskKind;
  drive: string;
  drive_confidence: number;
  route: {
    mode: string | null;
    exit_code: 0 | 1 | 2;
    recommended_command: string | null;
    requires_human_approval: boolean;
    approval_status: string;
    escalation_boundaries: string[];
  };
  size: "S" | "M" | "L";
  complexity_score: number;
  difficulty: TaskDifficulty;
  risk_flags: string[];
  findings: Finding[];
}

export type DesignDocGranularity = "G0" | "G1" | "G2" | "G3" | "G4" | "G5";

export interface RequiredDocument {
  id: string;
  path: string;
  reason: string;
}

export type ResearchAdoptionDisposition =
  | "incorporate"
  | "reference"
  | "exclude"
  | "ut-tdd-specific";

export interface ResearchAdoptionDecision {
  pattern: string;
  disposition: ResearchAdoptionDisposition;
  sources: string[];
  use_cases: string[];
  incorporated_as: string[];
  not_incorporated: string[];
  reason: string;
}

export type RecommendedSubagentRole = "docs" | "se" | "qa" | "uiux" | "tl";
export type RecommendedSubagentTier = ProposalSubagentLaneName;

export interface RecommendedSubagent {
  role: RecommendedSubagentRole;
  tier: RecommendedSubagentTier;
  model: string;
  purpose: string;
  parallelizable: boolean;
  parallel_slots: number;
  closing_authority: boolean;
  ownership: string;
  guard: string;
  reason: string;
}

export interface ProposalDocumentCoverage {
  granularity: DesignDocGranularity;
  patterns: string[];
  required_design_docs: RequiredDocument[];
  required_test_docs: RequiredDocument[];
  required_evidence: string[];
  required_gates: string[];
  research_adoption: ResearchAdoptionDecision[];
  research_rejections: ResearchAdoptionDecision[];
  recommended_subagents: RecommendedSubagent[];
  risk_flags: string[];
  escalators: string[];
  guardrails: string[];
  findings: Finding[];
}

export interface ClassifyTaskInput {
  text: string;
  affected_files?: string[];
  dependencies?: string[];
}

// Match each risk term as a whole word (with an optional trailing plural), not a
// raw substring. Substring matching wrongly flagged "production" inside
// "reproduction", "schema" inside "schematic", and "secret" inside "secretary" -
// the same false-positive class the bare-"auth"/"author" exclusion already guards.
// The trailing `s?` keeps safety-relevant plurals (credentials, payments, schemas)
// so the escalation signal does not regress into false negatives.
const RISK_PATTERNS: { term: string; pattern: RegExp }[] = RISK_TERMS.map((term) => ({
  term,
  pattern: new RegExp(`\\b${term}s?\\b`, "i"),
}));

function inferKind(text: string): TaskKind {
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

function riskFlags(text: string): string[] {
  return RISK_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}

function inferUncertainty(text: string): number {
  const lower = text.toLowerCase();
  return UNCERTAINTY_TERMS.some((term) => lower.includes(term)) ? 0.7 : 0.3;
}

function sizeProxy(input: ClassifyTaskInput): number {
  const files = input.affected_files?.length ?? 0;
  if (files > 0) return files;
  const length = input.text.length;
  if (length < 80) return 1;
  if (length < 300) return 3;
  return 6;
}

export function classifyTask(input: ClassifyTaskInput): TaskClassification {
  const { text } = input;
  const drive = classifyDrive({
    plan: text,
    code_delta: input.affected_files,
    dependency_delta: input.dependencies,
  });
  const complexity = scoreTaskComplexity({
    size: sizeProxy(input),
    dependencies: input.dependencies?.length ?? 0,
    uncertainty: inferUncertainty(text),
    affected_artifacts: input.affected_files?.length ?? 1,
  });
  const difficulty = inferTaskDifficulty({ task: text });
  const risk = riskFlags(text);
  const route = evaluateRouteCommand({ signal: text });

  const findings: Finding[] = [...drive.findings, ...complexity.findings];
  if (risk.length > 0) {
    findings.push({
      code: "escalation-risk",
      severity: "warn",
      evidence_path: "",
      message: `task references escalation-sensitive areas: ${risk.join(", ")}`,
    });
  }

  return {
    kind: inferKind(text),
    drive: drive.drive,
    drive_confidence: drive.confidence,
    route: {
      mode: route.mode,
      exit_code: route.exit_code,
      recommended_command: route.recommended_command?.command ?? null,
      requires_human_approval: route.approval.required,
      approval_status: route.approval.status,
      escalation_boundaries: route.escalation_boundaries.map((boundary) => boundary.term),
    },
    size: complexity.class,
    complexity_score: complexity.score,
    difficulty: difficulty.difficulty,
    risk_flags: risk,
    findings,
  };
}

function includesAny(normalizedText: string, terms: string[]): boolean {
  return terms.some((term) => normalizedText.includes(term.toLowerCase()));
}

function addUniqueDocs(target: RequiredDocument[], docs: RequiredDocument[]) {
  const existing = new Set(target.map((d) => d.id));
  for (const d of docs) {
    if (existing.has(d.id)) continue;
    target.push(d);
    existing.add(d.id);
  }
}

function addUniqueStrings(target: string[], values: string[]) {
  const existing = new Set(target);
  for (const value of values) {
    if (existing.has(value)) continue;
    target.push(value);
    existing.add(value);
  }
}

function addUniqueResearchDecisions(
  target: ResearchAdoptionDecision[],
  decisions: ResearchAdoptionDecision[],
) {
  const existing = new Set(target.map((d) => d.pattern));
  for (const decision of decisions) {
    if (existing.has(decision.pattern)) continue;
    target.push(decision);
    existing.add(decision.pattern);
  }
}

function maxGranularity(levels: DesignDocGranularity[]): DesignDocGranularity {
  const maxRank = Math.max(...levels.map((level) => LEVEL_RANK[level]));
  return RANK_LEVEL[maxRank] ?? "G0";
}

function researchAdoptionForPacks(packs: DocumentPack[]): ResearchAdoptionDecision[] {
  return packs.map((pack) => RESEARCH_ADOPTION_BY_PATTERN[pack.pattern]).filter(Boolean);
}

function rejectedResearchForText(normalizedText: string): ResearchAdoptionDecision[] {
  return RESEARCH_REJECTION_KEYWORDS.filter(({ keywords }) =>
    includesAny(normalizedText, keywords),
  ).map(({ decision }) => decision);
}

function subagent(input: {
  role: RecommendedSubagentRole;
  tier: RecommendedSubagentTier;
  purpose: string;
  parallelizable: boolean;
  reason: string;
}): RecommendedSubagent {
  const { role, tier, purpose, parallelizable, reason } = input;
  const lane = PROPOSAL_SUBAGENT_LANES[tier];
  return {
    role,
    tier,
    model: lane.model,
    purpose,
    parallelizable,
    parallel_slots: parallelizable ? lane.max_parallel : 1,
    closing_authority: lane.closing_authority,
    ownership: lane.ownership,
    guard: lane.guard,
    reason,
  };
}

function recommendedSubagentsForCoverage(input: {
  task: TaskClassification;
  granularity: DesignDocGranularity;
  patterns: string[];
  escalators: string[];
}): RecommendedSubagent[] {
  const risky = input.task.risk_flags.length > 0 || LEVEL_RANK[input.granularity] >= LEVEL_RANK.G4;
  const discovery = input.patterns.includes("discovery");
  const uiux = input.patterns.some((pattern) =>
    ["screen-ui", "frontend-design", "ux-research-usability"].includes(pattern),
  );
  const implementationHeavy = input.patterns.some((pattern) =>
    [
      "api-if",
      "data-db",
      "backend-function",
      "batch-report",
      "report-output",
      "async-job-flow",
      "notification-message",
      "common-component",
      "workflow-gate",
      "agent-orchestration",
    ].includes(pattern),
  );
  const recommendations: RecommendedSubagent[] = [
    subagent({
      role: "docs",
      tier: "T2-mini",
      purpose: "template research, adoption split, and document inventory expansion",
      parallelizable: true,
      reason:
        "research and catalog work is broad but low-risk, so mini is the default cost-saving lane",
    }),
  ];

  const cheapWorker =
    !risky &&
    (LEVEL_RANK[input.granularity] <= LEVEL_RANK.G2 ||
      ["trivial", "simple"].includes(input.task.difficulty));
  if (cheapWorker) {
    recommendations.push(
      subagent({
        role: "se",
        tier: "T2-spark",
        purpose: "bounded low-risk implementation or lint/test patch",
        parallelizable: true,
        reason: "small stable work can use spark for speed while keeping reviewer gates light",
      }),
    );
  }

  if (implementationHeavy || input.escalators.includes("multi_pattern_union")) {
    recommendations.push(
      subagent({
        role: "se",
        tier: "T1-worker",
        purpose: "cross-artifact implementation or classifier/lint wiring",
        parallelizable: true,
        reason: "multi-document or implementation-heavy work needs the normal worker tier",
      }),
    );
  }

  if (uiux) {
    recommendations.push(
      subagent({
        role: "uiux",
        tier: risky ? "T0-frontier" : "T2-mini",
        purpose: "screen, usability, accessibility, and visual evidence review",
        parallelizable: !risky,
        reason: risky
          ? "risky UI/UX work needs high-tier judgement"
          : "UI/UX template review can run cheaply as a sidecar",
      }),
    );
  }

  if (risky || discovery) {
    recommendations.push(
      subagent({
        role: "qa",
        tier: risky ? "T0-frontier" : "T1-worker",
        purpose: risky
          ? "risk gate, negative test, and approval-evidence review"
          : "research decision and oracle sufficiency review",
        parallelizable: false,
        reason: risky
          ? "G4/G5 risk cannot be closed by a cheap worker alone"
          : "discovery needs judgement before scope can shrink",
      }),
    );
  }

  if (input.escalators.includes("low_drive_confidence")) {
    recommendations.push(
      subagent({
        role: "tl",
        tier: "T0-frontier",
        purpose: "routing decision when drive classification is uncertain",
        parallelizable: false,
        reason: "unclear routing must increase judgement rather than reduce documents",
      }),
    );
  }

  return recommendations;
}

export function classifyProposalDocumentCoverage(
  input: ClassifyTaskInput,
): ProposalDocumentCoverage {
  const task = classifyTask(input);
  const normalizedText =
    `${input.text} ${(input.affected_files ?? []).join(" ")} ${(input.dependencies ?? []).join(" ")}`.toLowerCase();
  const matched = DOCUMENT_PACKS.filter((pack) => includesAny(normalizedText, pack.keywords));
  const packs = matched.length > 0 ? matched : [BASELINE_DOCUMENT_PACK];
  const designDocs: RequiredDocument[] = [];
  const testDocs: RequiredDocument[] = [];
  const evidence: string[] = [];
  const gates: string[] = [];
  const levels = packs.map((pack) => pack.level);
  const escalators: string[] = [];
  const researchAdoption = researchAdoptionForPacks(packs);
  const researchRejections: ResearchAdoptionDecision[] = [];
  addUniqueResearchDecisions(researchRejections, rejectedResearchForText(normalizedText));

  for (const pack of packs) {
    addUniqueDocs(designDocs, pack.designDocs);
    addUniqueDocs(testDocs, pack.testDocs);
    addUniqueStrings(evidence, pack.evidence);
    addUniqueStrings(gates, pack.gates);
  }
  addUniqueDocs(testDocs, [PROPOSAL_DOCUMENT_COVERAGE_ROUTING_TEST_DOC]);

  if (task.risk_flags.length > 0) {
    levels.push("G4");
    escalators.push("risk_flags");
    addUniqueDocs(designDocs, [
      doc("nfr", "docs/design/harness/L1-requirements/nfr.md", "risk-sensitive proposal"),
      doc(
        "technical-requirements",
        "docs/design/harness/L1-requirements/technical-requirements.md",
        "risk-sensitive technical boundary",
      ),
    ]);
    addUniqueDocs(testDocs, [
      doc(
        "system-test-design",
        "docs/test-design/harness/L9-system-test-design.md",
        "risk-sensitive system behavior",
      ),
    ]);
    addUniqueStrings(evidence, ["human_approval", "risk_review"]);
    addUniqueStrings(gates, ["risk-approval"]);
  }

  if (task.drive_confidence < 0.7) {
    levels.push("G3");
    escalators.push("low_drive_confidence");
    addUniqueStrings(evidence, ["drive_classification_review"]);
  }

  if (matched.length > 1) {
    escalators.push("multi_pattern_union");
    addUniqueStrings(evidence, ["cross_artifact_trace"]);
  }

  const shrinkAttempt = includesAny(normalizedText, LLM_SHRINK_TERMS);
  const findings: Finding[] = [...task.findings];
  if (shrinkAttempt) {
    findings.push({
      code: "llm-shrinkage-ignored",
      severity: "warn",
      evidence_path: "",
      message: "scope-reduction wording does not remove required documents",
    });
    addUniqueResearchDecisions(researchRejections, [RESEARCH_REJECTION_RULES[2]]);
  }

  const granularity = maxGranularity(levels);

  return {
    granularity,
    patterns: packs.map((pack) => pack.pattern),
    required_design_docs: designDocs,
    required_test_docs: testDocs,
    required_evidence: evidence,
    required_gates: gates,
    research_adoption: researchAdoption,
    research_rejections: researchRejections,
    recommended_subagents: recommendedSubagentsForCoverage({
      task,
      granularity,
      patterns: packs.map((pack) => pack.pattern),
      escalators,
    }),
    risk_flags: task.risk_flags,
    escalators,
    guardrails: [...PROPOSAL_COVERAGE_GUARDRAILS],
    findings,
  };
}
