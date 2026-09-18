import { performance } from "node:perf_hooks";
import type { LintResult } from "../plan/lint.ts";
import { buildFullDoctorCheckDefinitions } from "./check-definitions.ts";
import {
  type DoctorRunProfileId,
  type DoctorScope,
  doctorOutputIdsForScope,
  resolveDoctorRunProfile,
} from "./profiles.ts";
import type { DoctorTiming } from "./result.ts";
import type { DoctorDeps } from "./runtime-state.ts";

export interface DoctorOptions {
  strictTelemetryProvenance?: boolean;
  strictGreenCommandDigest?: boolean;
  setupSmoke?: boolean;
  timing?: boolean;
  scope?: DoctorScope;
  profile?: DoctorRunProfileId;
}

export interface DoctorCheckRun {
  checks: LintResult[];
  /** 実際に呼び出した definition ID。envelope producer は再計算せずこの実測値を使う。 */
  checkIds: string[];
  timings: DoctorTiming[];
}

export interface DoctorCheckDefinition {
  id: string;
  profiles: readonly DoctorScope[];
  requires?: readonly string[];
  run: () => LintResult;
}

export function selectDoctorCheckDefinitions(
  definitions: readonly DoctorCheckDefinition[],
  scope: DoctorScope,
  outputIds?: readonly string[],
): DoctorCheckDefinition[] {
  const targetOutputIds = outputIds ?? doctorOutputIdsForScope(scope);
  const targetOutputIdSet = new Set(targetOutputIds);
  const filtered = definitions.filter(
    (definition) => definition.profiles.includes(scope) && targetOutputIdSet.has(definition.id),
  );

  if (outputIds === undefined) {
    return filtered;
  }

  const byId = new Map(filtered.map((definition) => [definition.id, definition] as const));
  return outputIds.flatMap((id) => {
    const definition = byId.get(id);
    return definition ? [definition] : [];
  });
}

export function collectDoctorCheckRun(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckRun {
  const profile = resolveDoctorRunProfile(options);
  const scope = profile.invocation === "registry" ? profile.scope : (options.scope ?? "full");
  const outputIds =
    profile.invocation === "registry" ? profile.outputIds : doctorOutputIdsForScope(scope);
  const outputIdSet = new Set<string>(outputIds);
  const timings: DoctorTiming[] = [];
  const record = <T extends LintResult>(id: string, run: () => T): T => {
    if (options.timing !== true) return run();
    const started = performance.now();
    const result = run();
    const timing: DoctorTiming = {
      id,
      duration_ms: Number((performance.now() - started).toFixed(3)),
      ok: result.ok,
      message_count: result.messages.length,
    };
    const substeps = (result as { timingSubsteps?: DoctorTiming["substeps"] }).timingSubsteps;
    if (substeps && substeps.length > 0) timing.substeps = substeps;
    timings.push(timing);
    return result;
  };

  const resultsById = new Map<string, LintResult>();
  const selectedDefinitions = selectDoctorCheckDefinitions(
    buildFullDoctorCheckDefinitions(deps, options),
    scope,
  ).filter((definition) => outputIdSet.has(definition.id));
  for (const definition of selectedDefinitions) {
    resultsById.set(definition.id, record(definition.id, definition.run));
  }
  const checks = outputIds.map((id) => {
    const result = resultsById.get(id);
    if (!result) {
      return {
        ok: false,
        messages: [`doctor registry - violation: missing doctor check result (${id})`],
      };
    }
    return result;
  });

  return { checks, checkIds: [...outputIds], timings };
}

export function collectDoctorChecks(deps: DoctorDeps, options: DoctorOptions = {}): LintResult[] {
  return collectDoctorCheckRun(deps, options).checks;
}
