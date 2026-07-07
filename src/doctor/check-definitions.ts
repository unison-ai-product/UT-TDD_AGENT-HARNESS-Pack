import { buildDoctorCheckDefinitionGroups } from "./check-definition-groups";
import type { DoctorCheckDefinition, DoctorOptions } from "./runner";
import type { DoctorDeps } from "./runtime-state";

export function buildFullDoctorCheckDefinitions(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): DoctorCheckDefinition[] {
  return buildDoctorCheckDefinitionGroups(deps, options).flatMap((group) => group.definitions);
}
