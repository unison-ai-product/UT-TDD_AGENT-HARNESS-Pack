import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeG8IntegrationWorkflow,
  canLoadG8IntegrationWorkflowInput,
  g8IntegrationWorkflowMessages,
  loadG8IntegrationWorkflowInput,
} from "../lint/g8-integration-workflow.ts";
import {
  analyzeG9SystemWorkflow,
  g9SystemWorkflowMessages,
  loadG9SystemWorkflowInput,
} from "../lint/g9-system-workflow.ts";
import {
  analyzeG10UxWorkflow,
  g10UxWorkflowMessages,
  loadG10UxWorkflowInput,
} from "../lint/g10-ux-workflow.ts";
import { readGateAssetText } from "../lint/gate-confirm.ts";
import {
  analyzeImplPlanTrace,
  implPlanTraceMessages,
  loadImplPlanTraceInput,
} from "../lint/impl-plan-trace.ts";
import {
  analyzeOracleTestTrace,
  loadOracleTestTraceInput,
  oracleTestTraceMessages,
} from "../lint/oracle-test-trace.ts";
import { lintPlanWithGate } from "../plan/lint.ts";
import { resolveDesignRoot, resolveVModelRoots } from "../shared/design-root.ts";
import {
  analyzePairFreeze,
  analyzeVerificationGroups,
  designLayerFromPath,
  isDesignSubDoc,
  loadPairDocs,
  loadVerificationPlanEvidence,
  type PairDoc,
  pairFreezeMessages,
  verificationGroupMessages,
} from "../vmodel/lint.ts";
import {
  loadCompiledRightArmRegistry,
  VMODEL_CONTRACT_PATH,
} from "../vmodel-contract/adapters/yaml-contract-loader.ts";
import { evaluateRightArmStaticGate } from "./right-arm-static.ts";

const REVIEW_ONLY_STATIC_GATES = new Set(["G0.5", "R4"]);

export interface StaticGateInput {
  gate: string;
  repoRoot?: string;
  coverageSummaryPath?: string;
  coverageThreshold?: number;
}

export interface StaticGateResult {
  gate: string;
  passed: boolean;
  applicable: boolean;
  messages: string[];
  reasons?: CoverageFailureReason[];
}

export type CoverageFailureReason =
  | "coverage_evidence_missing"
  | "coverage_summary_unreadable"
  | "coverage_below_threshold";

export interface CoverageSummaryResult {
  ok: boolean;
  pct: number | null;
  threshold: number;
  message: string;
  reasons?: CoverageFailureReason[];
}

export interface LayerPairGateResult {
  ok: boolean;
  gate: string;
  layer: string;
  total: number;
  confirmed: number;
  placeholder: number;
  draft: number;
  orphanPaths: string[];
  mockMissing: boolean;
  messages: string[];
}

type IstanbulCoverageSummary = {
  total?: {
    lines?: { pct?: unknown };
    statements?: { pct?: unknown };
  };
};

function gateKey(gate: string): string {
  return gate.trim().toUpperCase();
}

export function analyzeLayerPairGate(
  docs: PairDoc[],
  gate: string,
  layerInput: string | { layer: string; l10PairPath: string },
): LayerPairGateResult {
  const layer = typeof layerInput === "string" ? layerInput : layerInput.layer;
  const l10PairPath =
    typeof layerInput === "string"
      ? "docs/test-design/harness/L10-ux-validation-test-design.md"
      : layerInput.l10PairPath;
  const pair = analyzePairFreeze(docs);
  const layerDocs = docs.filter(
    (doc) => isDesignSubDoc(doc) && designLayerFromPath(doc.path) === layer,
  );
  const orphanPaths = pair.orphans
    .filter((orphan) => designLayerFromPath(orphan.path) === layer)
    .map((orphan) => orphan.path)
    .sort();
  const confirmed = layerDocs.filter((doc) => doc.status === "confirmed").length;
  const placeholder = layerDocs.filter((doc) => doc.status === "placeholder").length;
  const draft = layerDocs.length - confirmed - placeholder;
  // wireframe mock は L2↔L10 pair の ③ doc を指す (旧 self-pair は PLAN-RECOVERY-09 で撤去)
  const mockMissing =
    layer === "L2" &&
    !layerDocs.some(
      (doc) => doc.path.endsWith("/wireframe.md") && doc.pairArtifact === l10PairPath,
    );
  const ok = layerDocs.length > 0 && draft === 0 && orphanPaths.length === 0 && !mockMissing;
  const head = `${gate.toLowerCase()}-pair`;
  const details = `${layer} total=${layerDocs.length}, confirmed=${confirmed}, placeholder=${placeholder}, draft=${draft}, orphans=${orphanPaths.length}`;
  const messages = ok
    ? [`${head} - OK (${details})`]
    : [
        `${head} - violation (${details}${mockMissing ? ", mock=missing" : ""})`,
        ...(orphanPaths.length > 0 ? [`${head} - orphan paths: ${orphanPaths.join(", ")}`] : []),
      ];
  return {
    ok,
    gate,
    layer,
    total: layerDocs.length,
    confirmed,
    placeholder,
    draft,
    orphanPaths,
    mockMissing,
    messages,
  };
}

function evaluateLayerPairGate(gate: string, layer: string, repoRoot: string): StaticGateResult {
  const testDesignRoot = resolveVModelRoots(repoRoot).testDesignRoot;
  const result = analyzeLayerPairGate(loadPairDocs(repoRoot), gate, {
    layer,
    l10PairPath: `${testDesignRoot}/L10-ux-validation-test-design.md`,
  });
  return { gate, applicable: true, passed: result.ok, messages: result.messages };
}

function combineStaticGates(gate: string, parts: StaticGateResult[]): StaticGateResult {
  return {
    gate,
    applicable: parts.some((part) => part.applicable),
    passed: parts.every((part) => part.passed),
    messages: parts.flatMap((part) => part.messages),
  };
}

export function readCoverageSummary(path: string, threshold = 80): CoverageSummaryResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      pct: null,
      threshold,
      message: `g7-coverage - violation: coverage summary not found (${path}); run test coverage before G7`,
      reasons: ["coverage_evidence_missing"],
    };
  }

  let parsed: IstanbulCoverageSummary;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as IstanbulCoverageSummary;
  } catch {
    return {
      ok: false,
      pct: null,
      threshold,
      message: `g7-coverage - violation: coverage summary is not valid JSON (${path})`,
      reasons: ["coverage_summary_unreadable"],
    };
  }

  const pct =
    typeof parsed?.total?.lines?.pct === "number"
      ? parsed.total.lines.pct
      : typeof parsed?.total?.statements?.pct === "number"
        ? parsed.total.statements.pct
        : null;
  if (pct == null) {
    return {
      ok: false,
      pct: null,
      threshold,
      message: `g7-coverage - violation: coverage summary missing total.lines.pct (${path})`,
      reasons: ["coverage_summary_unreadable"],
    };
  }
  const ok = pct >= threshold;
  return {
    ok,
    pct,
    threshold,
    message: ok
      ? `g7-coverage - OK (${pct}% >= ${threshold}%)`
      : `g7-coverage - violation: ${pct}% < ${threshold}%`,
    ...(!ok ? { reasons: ["coverage_below_threshold"] as CoverageFailureReason[] } : {}),
  };
}

function evaluateG7(input: StaticGateInput, repoRoot: string): StaticGateResult {
  const docs = loadPairDocs(repoRoot);
  const pair = analyzePairFreeze(docs);
  const groups = analyzeVerificationGroups(
    docs,
    pair.orphans,
    loadVerificationPlanEvidence(repoRoot),
  );
  const l0l7 = groups.find((g) => g.id === "L0-L7");

  const impl = analyzeImplPlanTrace(loadImplPlanTraceInput(repoRoot));
  const oracle = analyzeOracleTestTrace(loadOracleTestTraceInput(repoRoot));
  const coveragePath =
    input.coverageSummaryPath ?? join(repoRoot, "coverage", "coverage-summary.json");
  const coverage = readCoverageSummary(coveragePath, input.coverageThreshold ?? 80);

  const messages = [
    ...pairFreezeMessages(pair),
    ...(l0l7 ? verificationGroupMessages([l0l7]) : ["g7-static - violation: L0-L7 group missing"]),
    ...implPlanTraceMessages(impl),
    ...oracleTestTraceMessages(oracle),
    coverage.message,
  ];
  const passed = pair.ok && Boolean(l0l7?.frozen) && impl.ok && oracle.ok && coverage.ok;

  return {
    gate: input.gate,
    applicable: true,
    passed,
    ...(coverage.reasons ? { reasons: coverage.reasons } : {}),
    messages: passed
      ? [
          `g7-static - OK (4 artifact trace proxies + implementation evidence + coverage)`,
          ...messages,
        ]
      : [`g7-static - failed (G7 requires trace evidence and coverage >=80%)`, ...messages],
  };
}

export function evaluateStaticGate(input: StaticGateInput): StaticGateResult {
  const repoRoot = input.repoRoot ?? process.cwd();
  const key = gateKey(input.gate);

  try {
    if (
      ["G1", "G1-TRACE", "G2", "G3", "G3-TRACE", "G4", "G5", "G6", "G7"].includes(key) &&
      !statSync(repoRoot).isDirectory()
    ) {
      throw new Error("repo root is not a directory");
    }
    if (key === "G1" || key === "G1-TRACE") {
      const result = lintPlanWithGate(undefined, repoRoot, "G1-trace");
      return combineStaticGates(input.gate, [
        evaluateLayerPairGate(input.gate, "L1", repoRoot),
        { gate: input.gate, applicable: true, passed: result.ok, messages: result.messages },
      ]);
    }
    if (key === "G2") {
      return evaluateLayerPairGate(input.gate, "L2", repoRoot);
    }
    if (key === "G3" || key === "G3-TRACE") {
      const result = lintPlanWithGate(undefined, repoRoot, "G3-trace");
      return combineStaticGates(input.gate, [
        evaluateLayerPairGate(input.gate, "L3", repoRoot),
        { gate: input.gate, applicable: true, passed: result.ok, messages: result.messages },
      ]);
    }
    if (key === "G4") return evaluateLayerPairGate(input.gate, "L4", repoRoot);
    if (key === "G5") return evaluateLayerPairGate(input.gate, "L5", repoRoot);
    if (key === "G6") return evaluateLayerPairGate(input.gate, "L6", repoRoot);
    if (key === "G7") return evaluateG7(input, repoRoot);
    if (key === "G8") {
      if (canLoadG8IntegrationWorkflowInput(repoRoot)) {
        const workflow = analyzeG8IntegrationWorkflow(loadG8IntegrationWorkflowInput(repoRoot));
        const registry = loadCompiledRightArmRegistry(
          repoRoot,
          readGateAssetText(repoRoot, VMODEL_CONTRACT_PATH),
        );
        const obligation = registry.obligations.find((entry) => entry.gate === key);
        if (!obligation) throw new Error(`contract has no obligation for ${key}`);
        return {
          gate: input.gate,
          applicable: true,
          passed: workflow.ok,
          messages: [
            ...g8IntegrationWorkflowMessages(workflow),
            `未判定 (review): ${obligation.approvalRole}`,
          ],
        };
      }
      const result = evaluateRightArmStaticGate(key, repoRoot);
      return { gate: input.gate, applicable: true, ...result };
    }
    if (key === "G9") {
      if (resolveDesignRoot(repoRoot) === "docs/design/harness") {
        const workflow = analyzeG9SystemWorkflow(loadG9SystemWorkflowInput(repoRoot));
        const registry = loadCompiledRightArmRegistry(
          repoRoot,
          readGateAssetText(repoRoot, VMODEL_CONTRACT_PATH),
        );
        const obligation = registry.obligations.find((entry) => entry.gate === key);
        if (!obligation) throw new Error(`contract has no obligation for ${key}`);
        return {
          gate: input.gate,
          applicable: true,
          passed: workflow.ok,
          messages: [
            ...g9SystemWorkflowMessages(workflow),
            `未判定 (review): ${obligation.approvalRole}`,
          ],
        };
      }
      const result = evaluateRightArmStaticGate(key, repoRoot);
      return { gate: input.gate, applicable: true, ...result };
    }
    if (key === "G10") {
      if (resolveDesignRoot(repoRoot) === "docs/design/harness") {
        const workflow = analyzeG10UxWorkflow(loadG10UxWorkflowInput(repoRoot));
        const registry = loadCompiledRightArmRegistry(
          repoRoot,
          readGateAssetText(repoRoot, VMODEL_CONTRACT_PATH),
        );
        const obligation = registry.obligations.find((entry) => entry.gate === key);
        if (!obligation) throw new Error(`contract has no obligation for ${key}`);
        return {
          gate: input.gate,
          applicable: true,
          passed: workflow.ok,
          messages: [
            ...g10UxWorkflowMessages(workflow),
            `未判定 (review): ${obligation.approvalRole}`,
          ],
        };
      }
      const result = evaluateRightArmStaticGate(key, repoRoot);
      return { gate: input.gate, applicable: true, ...result };
    }
    if (key === "G11" || key === "G12" || key === "G13") {
      const result = evaluateRightArmStaticGate(key, repoRoot);
      return { gate: input.gate, applicable: true, ...result };
    }
  } catch (e) {
    return {
      gate: input.gate,
      applicable: true,
      passed: false,
      messages: [`static gate - violation: deterministic check could not run (${String(e)})`],
    };
  }

  if (REVIEW_ONLY_STATIC_GATES.has(key)) {
    return {
      gate: input.gate,
      applicable: false,
      passed: true,
      messages: ["static gate - n/a (review-tier gate has no deterministic static check)"],
    };
  }

  return {
    gate: input.gate,
    applicable: false,
    passed: false,
    messages: ["static gate - violation: no deterministic check registered for this gate"],
  };
}
