import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DriveDbRegistrationStats } from "../lint/drive-db-registration";
import { loadReviewPlans } from "../lint/review-evidence";
import { defaultHarnessDbPath, type HarnessDb, openHarnessDb } from "./index";
import { migrate } from "./migration";
import { rebuildHarnessDb } from "./projection-writer";

function count(db: HarnessDb, sql: string): number {
  const row = db.prepare(sql).get();
  return Number(row?.value ?? 0);
}

function stableHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function frontmatterValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?`, "m"));
  return match?.[1]?.trim() ?? "";
}

function aggregatePlanRegistryFingerprint(entries: Array<[string, string]>): string {
  return stableHash(
    entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([planId, sourceHash]) => `${planId}\0${sourceHash}`)
      .join("\n"),
  );
}

export function collectCurrentPlanRegistryFingerprint(repoRoot: string = process.cwd()): string {
  const plansDir = join(repoRoot, "docs", "plans");
  if (!existsSync(plansDir)) return aggregatePlanRegistryFingerprint([]);
  const entries: Array<[string, string]> = [];
  for (const name of readdirSync(plansDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const content = readFileSync(join(plansDir, name), "utf8");
    const planId = frontmatterValue(content, "plan_id");
    if (!planId) continue;
    entries.push([planId, stableHash(content)]);
  }
  return aggregatePlanRegistryFingerprint(entries);
}

function collectProjectedPlanRegistryFingerprint(db: HarnessDb): string | undefined {
  try {
    const rows = db
      .prepare("SELECT plan_id, source_hash FROM plan_registry ORDER BY plan_id")
      .all() as Array<{ plan_id?: unknown; source_hash?: unknown }>;
    return aggregatePlanRegistryFingerprint(
      rows.map((row) => [String(row.plan_id ?? ""), String(row.source_hash ?? "")]),
    );
  } catch {
    return undefined;
  }
}

export function collectDriveDbRegistrationStats(db: HarnessDb): DriveDbRegistrationStats {
  const modes = db
    .prepare("SELECT DISTINCT mode FROM drive_runs WHERE mode <> '' ORDER BY mode")
    .all()
    .map((row) => String(row.mode));
  return {
    planCount: count(db, "SELECT COUNT(*) AS value FROM plan_registry"),
    planRegistryFingerprint: collectProjectedPlanRegistryFingerprint(db),
    driveRuns: count(db, "SELECT COUNT(*) AS value FROM drive_runs"),
    plansWithoutDriveRun: count(
      db,
      `SELECT COUNT(*) AS value
       FROM plan_registry p
       WHERE NOT EXISTS (SELECT 1 FROM drive_runs d WHERE d.plan_id = p.plan_id)`,
    ),
    workflowRuns: count(db, "SELECT COUNT(*) AS value FROM workflow_runs"),
    workflowOrphans: count(
      db,
      `SELECT COUNT(*) AS value
       FROM workflow_runs w
       LEFT JOIN drive_runs d ON d.drive_run_id = w.drive_run_id
       WHERE d.drive_run_id IS NULL`,
    ),
    modelRuns: count(db, "SELECT COUNT(*) AS value FROM model_runs"),
    // session-scoped token telemetry rows (role='session', plan_id='', written by projectTokenUsage
    // from `ut-tdd telemetry scan`) are inherently NOT PLAN-linked, so they must be excluded from the
    // orphan check — otherwise running a scan would trip drive-db-registration (PLAN-L7-58). genuine
    // orphans = non-session runs that SHOULD trace to a PLAN but do not. NULL role is not a
    // telemetry session marker and must still be counted as an orphan.
    modelOrphans: count(
      db,
      `SELECT COUNT(*) AS value
       FROM model_runs m
       LEFT JOIN plan_registry p ON p.plan_id = m.plan_id
       WHERE p.plan_id IS NULL AND COALESCE(m.role, '') <> 'session'`,
    ),
    skillRecommendations: count(db, "SELECT COUNT(*) AS value FROM skill_recommendations"),
    skillRecommendationOrphans: count(
      db,
      `SELECT COUNT(*) AS value
       FROM skill_recommendations s
       LEFT JOIN plan_registry p ON p.plan_id = s.plan_id
       WHERE p.plan_id IS NULL`,
    ),
    skillInvocations: count(db, "SELECT COUNT(*) AS value FROM skill_invocations"),
    skillInvocationOrphans: count(
      db,
      `SELECT COUNT(*) AS value
       FROM skill_invocations s
       LEFT JOIN plan_registry p ON p.plan_id = s.plan_id
       WHERE p.plan_id IS NULL`,
    ),
    registeredHookEvents: count(
      db,
      `SELECT COUNT(*) AS value
       FROM hook_events h
       JOIN plan_registry p ON p.plan_id = h.plan_id`,
    ),
    hookOrphans: count(
      db,
      `SELECT COUNT(*) AS value
       FROM hook_events h
       LEFT JOIN plan_registry p ON p.plan_id = h.plan_id
       WHERE p.plan_id IS NULL`,
    ),
    modes,
  };
}

export function loadDriveDbRegistrationStats(
  repoRoot: string = process.cwd(),
): DriveDbRegistrationStats | null {
  const dbPath = defaultHarnessDbPath(repoRoot);
  if (!existsSync(dbPath)) return null;
  const db = openHarnessDb(dbPath, { repoRoot });
  try {
    migrate(db);
    return {
      ...collectDriveDbRegistrationStats(db),
      expectedPlanCount: loadReviewPlans(repoRoot).length,
      expectedPlanRegistryFingerprint: collectCurrentPlanRegistryFingerprint(repoRoot),
    };
  } finally {
    db.close();
  }
}

export function loadOrBuildDriveDbRegistrationStats(
  repoRoot: string = process.cwd(),
): DriveDbRegistrationStats | null {
  let persisted: DriveDbRegistrationStats | null = null;
  try {
    persisted = loadDriveDbRegistrationStats(repoRoot);
  } catch {
    persisted = null;
  }
  if (persisted) return persisted;

  const db = openHarnessDb(":memory:", { repoRoot });
  try {
    rebuildHarnessDb({ repoRoot, db });
    return {
      ...collectDriveDbRegistrationStats(db),
      expectedPlanCount: loadReviewPlans(repoRoot).length,
      expectedPlanRegistryFingerprint: collectCurrentPlanRegistryFingerprint(repoRoot),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
