import { existsSync } from "node:fs";
import { loadChangedFiles } from "../lint/change-impact";
import {
  analyzeDependencyDrift,
  type DependencyDriftResult,
  dependencyDriftMessages,
  expandRegressionScope,
  loadDependencyDriftInput,
  regressionExpansionMessages,
} from "../lint/dependency-drift";

function loadChangedFilesForDoctor(repoRoot: string): string[] {
  try {
    return loadChangedFiles(repoRoot);
  } catch {
    return [];
  }
}

export function checkDependencyDrift(repoRoot: string): {
  messages: string[];
  ok: boolean;
  result: DependencyDriftResult | null;
} {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["dependency-drift - violation: repo root could not be read"],
      ok: false,
      result: null,
    };
  }
  try {
    const result = analyzeDependencyDrift(loadDependencyDriftInput(repoRoot));
    return { messages: dependencyDriftMessages(result), ok: result.ok, result };
  } catch {
    return {
      messages: ["dependency-drift - violation: dependency graph could not be read"],
      ok: false,
      result: null,
    };
  }
}

export function checkRegressionExpansion(
  repoRoot: string,
  drift: DependencyDriftResult | null,
): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["regression-expansion - violation: repo root could not be read"],
      ok: false,
    };
  }
  if (drift == null) {
    return {
      messages: ["regression-expansion - violation: dependency drift result is unavailable"],
      ok: false,
    };
  }
  try {
    const result = expandRegressionScope(drift, loadChangedFilesForDoctor(repoRoot));
    return { messages: regressionExpansionMessages(result), ok: result.ok };
  } catch {
    return {
      messages: ["regression-expansion - violation: regression scope could not be expanded"],
      ok: false,
    };
  }
}
