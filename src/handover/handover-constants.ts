import { join } from "node:path";

const GENERATED_BY = "ut-tdd-handover";
const HANDOVER_DIR = join(".ut-tdd", "handover");
const POINTER_PATH = join(HANDOVER_DIR, "CURRENT.json");

export { GENERATED_BY, HANDOVER_DIR, POINTER_PATH };
