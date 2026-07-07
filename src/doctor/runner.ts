import { performance } from "node:perf_hooks";
import type { LintResult } from "../plan/lint";
import { buildFullDoctorCheckDefinitions } from "./check-definitions";
import {
  type DoctorRunProfileId,
  type DoctorScope,
  doctorOutputIdsForScope,
  resolveDoctorRunProfile,
} from "./profiles";
import type { DoctorTiming } from "./result";
import type { DoctorDeps } from "./runtime-state";

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
): DoctorCheckDefinition[] {
  const outputIds = new Set(doctorOutputIdsForScope(scope));
  return definitions.filter(
    (definition) => definition.profiles.includes(scope) && outputIds.has(definition.id),
  );
}

export function collectDoctorCheckRun(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckRun {
  const profile = resolveDoctorRunProfile(options);
  const scope = profile.invocation === "registry" ? profile.scope : (options.scope ?? "full");
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
  for (const definition of selectDoctorCheckDefinitions(
    buildFullDoctorCheckDefinitions(deps, options),
    scope,
  )) {
    resultsById.set(definition.id, record(definition.id, definition.run));
  }
  const checks = doctorOutputIdsForScope(scope).map((id) => {
    const result = resultsById.get(id);
    if (!result) {
      return {
        ok: false,
        messages: [`doctor registry - violation: missing full doctor check result (${id})`],
      };
    }
    return result;
  });

  return { checks, timings };
}

export function collectDoctorChecks(deps: DoctorDeps, options: DoctorOptions = {}): LintResult[] {
  return collectDoctorCheckRun(deps, options).checks;
}
