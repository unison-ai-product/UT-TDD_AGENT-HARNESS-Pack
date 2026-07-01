import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeImplPlanTrace,
  implPlanTraceMessages,
  loadImplPlanTraceInput,
} from "../lint/impl-plan-trace";
import {
  analyzeOracleTestTrace,
  loadOracleTestTraceInput,
  oracleTestTraceMessages,
} from "../lint/oracle-test-trace";
import { lintPlanWithGate } from "../plan/lint";
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
} from "../vmodel/lint";

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
}

export interface CoverageSummaryResult {
  ok: boolean;
  pct: number | null;
  threshold: number;
  message: string;
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
  layer: string,
): LayerPairGateResult {
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
  const mockMissing =
    layer === "L2" &&
    !layerDocs.some((doc) => doc.path.endsWith("/wireframe.md") && doc.pairArtifact === "self");
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
  const result = analyzeLayerPairGate(loadPairDocs(repoRoot), gate, layer);
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
    };
  }

  const pct =
    typeof parsed.total?.lines?.pct === "number"
      ? parsed.total.lines.pct
      : typeof parsed.total?.statements?.pct === "number"
        ? parsed.total.statements.pct
        : null;
  if (pct == null) {
    return {
      ok: false,
      pct: null,
      threshold,
      message: `g7-coverage - violation: coverage summary missing total.lines.pct (${path})`,
    };
  }
  return {
    ok: pct >= threshold,
    pct,
    threshold,
    message:
      pct >= threshold
        ? `g7-coverage - OK (${pct}% >= ${threshold}%)`
        : `g7-coverage - violation: ${pct}% < ${threshold}%`,
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
