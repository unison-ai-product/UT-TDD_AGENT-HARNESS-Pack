import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeForwardFreezeContracts,
  analyzePairFreeze,
  analyzeRefactorQaReleaseContracts,
  analyzeVerificationGroups,
  forwardFreezeContractMessages,
  loadPairDocs,
  loadRefactorQaReleaseContractInput,
  refactorQaReleaseContractMessages,
  verificationGroupMessages,
  verificationGroupsOk,
} from "../vmodel/lint.ts";
import {
  parseUpgradeFrontier,
  upgradeFrontierMessage,
  upgradeFrontierViolations,
} from "../vmodel/upgrade-frontier.ts";

/** active upgrade frontier (vmodel-upgrade-schedule.md) を hard gate として検査する。 */
export function checkRoadmap(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["roadmap - violation: repo root could not be read"], ok: false };
  }
  try {
    const upgradeSchedulePath = join(repoRoot, "docs", "governance", "vmodel-upgrade-schedule.md");
    if (!existsSync(upgradeSchedulePath)) {
      return {
        messages: ["roadmap - violation: active upgrade schedule authoring source is missing"],
        ok: false,
      };
    }
    const activeUpgradeFrontier = parseUpgradeFrontier(readFileSync(upgradeSchedulePath, "utf8"));
    const upgradeViolations = upgradeFrontierViolations(activeUpgradeFrontier);
    return {
      messages: [upgradeFrontierMessage(activeUpgradeFrontier), ...upgradeViolations],
      ok: upgradeViolations.length === 0,
    };
  } catch {
    return { messages: ["roadmap - violation: 工程表を読み込めず検査できません"], ok: false };
  }
}

export function checkVerificationGroupsResult(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    if (!statSync(repoRoot).isDirectory()) throw new Error("repo root is not a directory");
    const docs = loadPairDocs(repoRoot);
    const { orphans } = analyzePairFreeze(docs);
    const groups = analyzeVerificationGroups(docs, orphans);
    return { messages: verificationGroupMessages(groups), ok: verificationGroupsOk(groups) };
  } catch {
    return {
      messages: ["verification - violation: verification group lint could not run"],
      ok: false,
    };
  }
}

export function checkVerificationGroups(repoRoot: string): string[] {
  return checkVerificationGroupsResult(repoRoot).messages;
}

export function checkForwardFreezeContractsResult(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const result = analyzeForwardFreezeContracts(loadPairDocs(repoRoot));
    return { messages: forwardFreezeContractMessages(result), ok: result.ok };
  } catch {
    return {
      messages: [
        "forward-freeze-contracts - violation: forward freeze contract lint could not run",
      ],
      ok: false,
    };
  }
}

export function checkRefactorQaReleaseContractsResult(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const result = analyzeRefactorQaReleaseContracts(loadRefactorQaReleaseContractInput(repoRoot));
    return { messages: refactorQaReleaseContractMessages(result), ok: result.ok };
  } catch {
    return {
      messages: [
        "refactor-qa-release-contracts - violation: refactor/QA release contract lint could not run",
      ],
      ok: false,
    };
  }
}
