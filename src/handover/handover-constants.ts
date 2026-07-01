import { join } from "node:path";

const GENERATED_BY = "ut-tdd-handover";
const HANDOVER_DIR = join(".ut-tdd", "handover");
const POINTER_PATH = join(HANDOVER_DIR, "CURRENT.json");
const PLAN_DIGEST_DIR = join(".ut-tdd", "logs", "plan");
const CURRENT_PLAN_REL = join(".ut-tdd", "state", "current-plan");
const MAX_SAME_DAY_ENTRIES = 4;
const MAX_SUMMARY_PLANS = 12;
const HANDOVER_OUTSTANDING_MARKER = "機械集計 (outstanding)";

export {
  CURRENT_PLAN_REL,
  GENERATED_BY,
  HANDOVER_DIR,
  HANDOVER_OUTSTANDING_MARKER,
  MAX_SAME_DAY_ENTRIES,
  MAX_SUMMARY_PLANS,
  PLAN_DIGEST_DIR,
  POINTER_PATH,
};
