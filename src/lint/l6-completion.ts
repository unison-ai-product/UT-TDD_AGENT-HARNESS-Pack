import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
// A-120 I-3: review_evidence の有無判定は review-evidence.ts を単一正本にする
// (旧 l6-completion 版は判定ロジックが乖離し review-evidence hard gate と齟齬を生む恐れがあった)。
import { hasReviewEvidence } from "./review-evidence";
import { hasDbcTable } from "./shared";

export interface L6CompletionDoc {
  path: string;
  text: string;
}

export interface L6CompletionInputs {
  l6Docs: L6CompletionDoc[];
  l6Plans: L6CompletionDoc[];
  l7Text: string;
  gateText: string;
}

export interface L6CompletionResult {
  totalDocs: number;
  draftDocs: string[];
  missingDocPlans: string[];
  unresolvedDocPlans: string[];
  missingDocPairArtifacts: string[];
  missingL7DocRefs: string[];
  weakContractDocs: string[];
  draftPlans: string[];
  missingReviewPlans: string[];
  l7Status: string | null;
  g6Status: string | null;
  freezeInputReady: boolean;
  ready: boolean;
}

const STATUS_RE = /^status:\s*([^\s#]+)/m;
const PLAN_ID_RE = /^plan_id:\s*([^\s#]+)/m;
const DOC_PLAN_RE = /^plan:\s*([^\s#]+)/m;
const PAIR_ARTIFACT_RE =
  /^pair_artifact:\s*docs\/test-design\/harness\/L7-unit-test-design\.md\s*$/m;
const DESIGN_KIND_RE = /^kind:\s*design$/m;

function statusOf(text: string): string | null {
  return text.match(STATUS_RE)?.[1] ?? null;
}

function planIdOf(text: string, path: string): string {
  return text.match(PLAN_ID_RE)?.[1] ?? basename(path, ".md");
}

function docPlanOf(text: string): string | null {
  return text.match(DOC_PLAN_RE)?.[1] ?? null;
}

function hasUnitContractSubstance(text: string): boolean {
  const hasStructuredDbcTable = hasDbcTable(text);
  const signatureCount = (text.match(/\b[A-Za-z][A-Za-z0-9_]*\([^)]*\)\s*=>/g) ?? []).length;
  const oracleCount = (text.match(/\bU-[A-Z0-9-]+/g) ?? []).length;
  const dbcMarkerCount = (text.match(/\b(pre|post|invariant|oracle|DbC)\b/gi) ?? []).length;
  const hasLegacyExplicitMarker =
    /L6 contract marker/i.test(text) && signatureCount >= 1 && oracleCount >= 1;
  return (
    (hasStructuredDbcTable && signatureCount >= 1 && oracleCount >= 1) ||
    (signatureCount >= 1 && oracleCount >= 1 && dbcMarkerCount >= 3) ||
    hasLegacyExplicitMarker
  );
}

function gateG6Status(gateText: string): string | null {
  for (const line of gateText.split(/\r?\n/)) {
    if (!line.includes("| G6")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    return cells[1] ?? null;
  }
  return null;
}

function isPassStatus(status: string | null): boolean {
  return status !== null && /PASS/.test(status);
}

export function analyzeL6Completion(inputs: L6CompletionInputs): L6CompletionResult {
  const l6PlanPaths = new Set(inputs.l6Plans.map((plan) => plan.path.replaceAll("\\", "/")));

  const draftDocs = inputs.l6Docs
    .filter((doc) => statusOf(doc.text) !== "confirmed")
    .map((doc) => doc.path)
    .sort();
  const missingDocPlans = inputs.l6Docs
    .filter((doc) => docPlanOf(doc.text) === null)
    .map((doc) => doc.path)
    .sort();
  const unresolvedDocPlans = inputs.l6Docs
    .filter((doc) => {
      const planPath = docPlanOf(doc.text);
      return planPath !== null && !l6PlanPaths.has(planPath.replaceAll("\\", "/"));
    })
    .map((doc) => `${doc.path} -> ${docPlanOf(doc.text)}`)
    .sort();
  const missingDocPairArtifacts = inputs.l6Docs
    .filter((doc) => !PAIR_ARTIFACT_RE.test(doc.text))
    .map((doc) => doc.path)
    .sort();
  const missingL7DocRefs = inputs.l6Docs
    .filter((doc) => !inputs.l7Text.includes(basename(doc.path)))
    .map((doc) => doc.path)
    .sort();
  const weakContractDocs = inputs.l6Docs
    .filter((doc) => !hasUnitContractSubstance(doc.text))
    .map((doc) => doc.path)
    .sort();

  const l6DesignPlans = inputs.l6Plans.filter((plan) => DESIGN_KIND_RE.test(plan.text));
  const draftPlans = l6DesignPlans
    .filter((plan) => statusOf(plan.text) !== "confirmed")
    .map((plan) => planIdOf(plan.text, plan.path))
    .sort();
  const missingReviewPlans = l6DesignPlans
    .filter((plan) => statusOf(plan.text) === "confirmed" && !hasReviewEvidence(plan.text))
    .map((plan) => planIdOf(plan.text, plan.path))
    .sort();
  const l7Status = statusOf(inputs.l7Text);
  const g6Status = gateG6Status(inputs.gateText);

  const freezeInputReady =
    inputs.l6Docs.length > 0 &&
    missingDocPlans.length === 0 &&
    unresolvedDocPlans.length === 0 &&
    missingDocPairArtifacts.length === 0 &&
    missingL7DocRefs.length === 0 &&
    weakContractDocs.length === 0;

  const ready =
    inputs.l6Docs.length > 0 &&
    draftDocs.length === 0 &&
    missingDocPlans.length === 0 &&
    unresolvedDocPlans.length === 0 &&
    missingDocPairArtifacts.length === 0 &&
    missingL7DocRefs.length === 0 &&
    weakContractDocs.length === 0 &&
    draftPlans.length === 0 &&
    missingReviewPlans.length === 0 &&
    l7Status === "confirmed" &&
    isPassStatus(g6Status);

  return {
    totalDocs: inputs.l6Docs.length,
    draftDocs,
    missingDocPlans,
    unresolvedDocPlans,
    missingDocPairArtifacts,
    missingL7DocRefs,
    weakContractDocs,
    draftPlans,
    missingReviewPlans,
    l7Status,
    g6Status,
    freezeInputReady,
    ready,
  };
}

export function loadL6CompletionInputs(repoRoot: string): L6CompletionInputs {
  const l6Dir = join(repoRoot, "docs", "design", "harness", "L6-function-design");
  const planDir = join(repoRoot, "docs", "plans");
  const l6Docs = readdirSync(l6Dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const path = join(l6Dir, name);
      return {
        path: `docs/design/harness/L6-function-design/${name}`,
        text: readFileSync(path, "utf8"),
      };
    });
  const l6Plans = readdirSync(planDir)
    .filter((name) => /^PLAN-L6-.*\.md$/.test(name))
    .map((name) => {
      const path = join(planDir, name);
      return { path: `docs/plans/${name}`, text: readFileSync(path, "utf8") };
    });
  return {
    l6Docs,
    l6Plans,
    l7Text: readFileSync(
      join(repoRoot, "docs", "test-design", "harness", "L7-unit-test-design.md"),
      "utf8",
    ),
    gateText: readFileSync(join(repoRoot, "docs", "governance", "gate-design.md"), "utf8"),
  };
}

export function canLoadL6CompletionInputs(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "docs", "design", "harness", "L6-function-design")) &&
    existsSync(join(repoRoot, "docs", "plans")) &&
    existsSync(join(repoRoot, "docs", "test-design", "harness", "L7-unit-test-design.md")) &&
    existsSync(join(repoRoot, "docs", "governance", "gate-design.md"))
  );
}

export function l6CompletionMessages(result: L6CompletionResult): string[] {
  if (result.ready) {
    return [`l6-completion — OK (L6 docs ${result.totalDocs}件、L7 confirmed、G6 PASS)`];
  }
  const messages = [
    `l6-completion — not ready (docs=${result.totalDocs}, draft_docs=${result.draftDocs.length}, draft_plans=${result.draftPlans.length}, l7=${result.l7Status ?? "missing"}, g6=${result.g6Status ?? "missing"})`,
  ];
  messages.push(
    `l6-completion — freeze-inputs ${result.freezeInputReady ? "OK" : "not ready"} (trace/substance before status flip)`,
  );
  messages.push(`l6-completion — unit-contract substance gaps: ${result.weakContractDocs.length}`);
  if (result.draftDocs.length > 0) {
    messages.push(`l6-completion — draft docs: ${result.draftDocs.join(", ")}`);
  }
  if (result.missingDocPlans.length > 0) {
    messages.push(
      `l6-completion — L6 docs without owning plan: ${result.missingDocPlans.join(", ")}`,
    );
  }
  if (result.unresolvedDocPlans.length > 0) {
    messages.push(
      `l6-completion — L6 docs with unresolved owning plan: ${result.unresolvedDocPlans.join(", ")}`,
    );
  }
  if (result.missingDocPairArtifacts.length > 0) {
    messages.push(
      `l6-completion — L6 docs without L7 pair_artifact: ${result.missingDocPairArtifacts.join(", ")}`,
    );
  }
  if (result.missingL7DocRefs.length > 0) {
    messages.push(
      `l6-completion — L6 docs not referenced by L7: ${result.missingL7DocRefs.join(", ")}`,
    );
  }
  if (result.weakContractDocs.length > 0) {
    messages.push(
      `l6-completion — L6 docs without unit-contract substance: ${result.weakContractDocs.join(", ")}`,
    );
  }
  if (result.draftPlans.length > 0) {
    messages.push(`l6-completion — draft PLANs: ${result.draftPlans.join(", ")}`);
  }
  if (result.missingReviewPlans.length > 0) {
    messages.push(
      `l6-completion — confirmed PLANs without review_evidence: ${result.missingReviewPlans.join(", ")}`,
    );
  }
  return messages;
}
