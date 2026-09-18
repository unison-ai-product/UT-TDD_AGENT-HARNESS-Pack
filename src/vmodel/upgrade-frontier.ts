import { VALID_STATUSES } from "../schema/index.ts";

export interface UpgradeFrontierEntry {
  planId: string;
  rag: string;
  status: string;
  currentLocation: string;
  blockedReason: string;
}

const REQUIRED_COLUMNS = [
  "plan_id",
  "current_location",
  "rag",
  "status",
  "blocked_reason",
] as const;
const VALID_RAGS = new Set(["green", "yellow", "red"]);
const VALID_STATUS_SET = new Set<string>(VALID_STATUSES);

function cells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/^`|`$/g, ""));
}

export function parseUpgradeFrontier(markdown: string): UpgradeFrontierEntry[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const header = cells(line);
    return header.includes("plan_id") && header.includes("rag") && header.includes("status");
  });
  if (headerIndex < 0) throw new Error("upgrade schedule table is missing");
  const header = cells(lines[headerIndex]);
  const missingColumns = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missingColumns.length > 0) {
    throw new Error(`upgrade schedule columns are missing: ${missingColumns.join(",")}`);
  }
  const separators = cells(lines[headerIndex + 1] ?? "");
  if (
    separators.length !== header.length ||
    separators.some((separator) => !/^:?-{3,}:?$/.test(separator))
  ) {
    throw new Error("upgrade schedule separator row is invalid");
  }
  const indexOf = (name: string) => header.indexOf(name);
  const entries: UpgradeFrontierEntry[] = [];
  const seenPlanIds = new Set<string>();
  let rowCount = 0;
  for (
    let index = headerIndex + 2;
    index < lines.length && lines[index].startsWith("|");
    index += 1
  ) {
    const row = cells(lines[index]);
    const entry = {
      planId: row[indexOf("plan_id")] ?? "",
      rag: row[indexOf("rag")] ?? "",
      status: row[indexOf("status")] ?? "",
      currentLocation: row[indexOf("current_location")] ?? "",
      blockedReason: row[indexOf("blocked_reason")] ?? "",
    };
    rowCount += 1;
    if (!entry.planId) throw new Error(`upgrade schedule row ${rowCount} has no plan_id`);
    if (seenPlanIds.has(entry.planId)) {
      throw new Error(`upgrade schedule has duplicate plan_id: ${entry.planId}`);
    }
    if (!entry.rag || !entry.status || !entry.currentLocation) {
      throw new Error(`upgrade schedule row ${entry.planId} has an empty required value`);
    }
    if (!VALID_RAGS.has(entry.rag)) {
      throw new Error(`upgrade schedule row ${entry.planId} has invalid rag=${entry.rag}`);
    }
    if (!VALID_STATUS_SET.has(entry.status)) {
      throw new Error(`upgrade schedule row ${entry.planId} has invalid status=${entry.status}`);
    }
    seenPlanIds.add(entry.planId);
    if (entry.planId && (entry.rag !== "green" || entry.status === "draft")) entries.push(entry);
  }
  if (rowCount === 0) throw new Error("upgrade schedule table has no rows");
  return entries;
}

export function upgradeFrontierMessage(entries: UpgradeFrontierEntry[]): string {
  if (entries.length === 0) return "active-upgrade-frontier — CLEAR";
  return `active-upgrade-frontier — IN-PROGRESS (${entries.length}: ${entries
    .map((entry) => `${entry.planId}[${entry.rag}/${entry.status}]`)
    .join(", ")})`;
}

export function upgradeFrontierViolations(entries: UpgradeFrontierEntry[]): string[] {
  return entries
    .filter((entry) => entry.rag === "red")
    .map(
      (entry) =>
        `active-upgrade-frontier - violation: ${entry.planId} is red (${entry.blockedReason || entry.currentLocation})`,
    );
}
