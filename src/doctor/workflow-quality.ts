import { existsSync } from "node:fs";
import {
  analyzeFrontendDesignCoverage,
  frontendDesignCoverageMessages,
  loadFrontendDesignCoverageInput,
} from "../lint/frontend-design-coverage";
import {
  analyzeG8IntegrationWorkflow,
  canLoadG8IntegrationWorkflowInput,
  g8IntegrationWorkflowMessages,
  loadG8IntegrationWorkflowInput,
} from "../lint/g8-integration-workflow";
import {
  analyzeG9SystemWorkflow,
  canLoadG9SystemWorkflowInput,
  g9SystemWorkflowMessages,
  loadG9SystemWorkflowInput,
} from "../lint/g9-system-workflow";
import {
  analyzeG10UxWorkflow,
  canLoadG10UxWorkflowInput,
  g10UxWorkflowMessages,
  loadG10UxWorkflowInput,
} from "../lint/g10-ux-workflow";
import {
  analyzeImprovementBacklog,
  loadBacklog as loadImprovementBacklog,
} from "../lint/improvement-backlog";
import { analyzeLintWiring, lintWiringMessages, loadLintWiringInput } from "../lint/lint-wiring";
import {
  analyzeProposalDocumentCoverage,
  loadProposalDocumentCoverageLintInput,
  proposalDocumentCoverageMessages,
} from "../lint/proposal-document-coverage";
import {
  analyzeRightArmGatePlanning,
  loadRightArmGatePlanningInput,
  rightArmGatePlanningMessages,
} from "../lint/right-arm-gate-planning";
import { classifyProposalDocumentCoverage } from "../task/classify";

/**
 * improvement-backlog lint を hard gate 検査 (PLAN-L7-95、要件 §1.10.G.12 の「構造健全性検証」配線)。
 * IMP 行の malformed/dup/invalid status・candidate/incomplete/unparseable と
 * lower-layer backprop 分類欠落を fail-close。
 */
export function checkImprovementBacklog(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeImprovementBacklog(loadImprovementBacklog(repoRoot));
    const bad =
      r.malformedIds.length +
      r.duplicateIds.length +
      r.invalidStatus.length +
      r.invalidCandidate.length +
      r.incompleteRows.length +
      r.unparseableRows.length +
      r.missingBackpropClassification.length;
    if (bad === 0) {
      return {
        messages: [
          `improvement-backlog — OK (backlog 書式健全, entries=${r.total}, open=${r.openCount}, 死蔵行 0, backprop分類欠落 0)`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `improvement-backlog — violation: malformed=${r.malformedIds.length}, dup=${r.duplicateIds.length}, invalidStatus=${r.invalidStatus.length}, invalidCandidate=${r.invalidCandidate.length}, incomplete=${r.incompleteRows.length}, unparseable=${r.unparseableRows.length}, missingBackpropClassification=${r.missingBackpropClassification.length}`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: ["improvement-backlog — violation: docs/improvement-backlog.md could not be read"],
      ok: false,
    };
  }
}

export function checkRightArmGatePlanning(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeRightArmGatePlanning(loadRightArmGatePlanningInput(repoRoot));
    return { messages: rightArmGatePlanningMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["right-arm-gate-planning - violation: G8-G14 carry docs could not be read"],
      ok: false,
    };
  }
}

/**
 * lint-wiring meta-gate を hard gate 検査 (PLAN-L7-95、IMP-006)。
 * すべての src/lint module が runtime 経路から到達可能 or DEFERRED 登録済みを fail-close。
 */
export function checkLintWiring(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeLintWiring(loadLintWiringInput(repoRoot));
    return { messages: lintWiringMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["lint-wiring — violation: src/lint modules could not be scanned"],
      ok: false,
    };
  }
}

export function checkFrontendDesignCoverage(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["frontend-design-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeFrontendDesignCoverage(loadFrontendDesignCoverageInput(repoRoot));
    return { messages: frontendDesignCoverageMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["frontend-design-coverage - violation: FE design coverage check could not run"],
      ok: false,
    };
  }
}

export function checkProposalDocumentCoverage(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["proposal-document-coverage - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeProposalDocumentCoverage(
      loadProposalDocumentCoverageLintInput(repoRoot, classifyProposalDocumentCoverage),
    );
    return { messages: proposalDocumentCoverageMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["proposal-document-coverage - violation: document coverage routing could not run"],
      ok: false,
    };
  }
}

export function checkG8IntegrationWorkflow(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!canLoadG8IntegrationWorkflowInput(repoRoot)) {
    return {
      messages: [
        "g8-integration-workflow - violation: L8 test design or gates.md could not be read",
      ],
      ok: false,
    };
  }
  try {
    const r = analyzeG8IntegrationWorkflow(loadG8IntegrationWorkflowInput(repoRoot));
    return { messages: g8IntegrationWorkflowMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["g8-integration-workflow - violation: G8 workflow check could not run"],
      ok: false,
    };
  }
}

export function checkG9SystemWorkflow(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!canLoadG9SystemWorkflowInput(repoRoot)) {
    return {
      messages: ["g9-system-workflow - violation: L9 test design or gates.md could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeG9SystemWorkflow(loadG9SystemWorkflowInput(repoRoot));
    return { messages: g9SystemWorkflowMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["g9-system-workflow - violation: G9 workflow check could not run"],
      ok: false,
    };
  }
}

export function checkG10UxWorkflow(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  if (!canLoadG10UxWorkflowInput(repoRoot)) {
    return {
      messages: ["g10-ux-workflow - violation: L10 UX design or gates.md could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeG10UxWorkflow(loadG10UxWorkflowInput(repoRoot));
    return { messages: g10UxWorkflowMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["g10-ux-workflow - violation: G10 workflow check could not run"],
      ok: false,
    };
  }
}
