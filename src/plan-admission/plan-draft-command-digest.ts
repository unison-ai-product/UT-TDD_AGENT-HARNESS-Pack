/**
 * Admission-facing compatibility entrypoint.
 * The durable command/digest contract lives in kernel so plan-asset can use it
 * without creating an admission <-> asset dependency cycle.
 */
export {
  type CanonicalPlanDraftCommand,
  calculatePlanDraftCommandDigests,
  type PlanDraftCommandDigests,
} from "../kernel/plan-draft-command-digest.ts";
