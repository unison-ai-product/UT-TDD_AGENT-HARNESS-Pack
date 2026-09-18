import { buildDoctorCheckDefinitionGroups } from "./check-definition-groups.ts";
import type { DoctorCheckDefinition, DoctorOptions } from "./runner.ts";
import type { DoctorDeps } from "./runtime-state.ts";

export function buildFullDoctorCheckDefinitions(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckDefinition[] {
  return buildDoctorCheckDefinitionGroups(deps, options).flatMap((group) => group.definitions);
}
