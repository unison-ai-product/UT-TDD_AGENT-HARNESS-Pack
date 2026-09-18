import type { ProjectionEvent } from "../contracts/projection-store.ts";

export interface ProjectionPlanSource {
  readonly path: string;
  readonly content: string;
}

export interface ProjectedPlan {
  readonly planId: string;
  readonly kind: string;
  readonly layer: string;
  readonly drive: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly routeMode?: string;
}

export interface PlanProjectionContext {
  readonly stableId: (prefix: string, value: string) => string;
  readonly hash: (value: string) => string;
}

export interface PlanProjectionResult {
  readonly plans: ReadonlyMap<string, ProjectedPlan>;
  readonly writes: readonly ProjectionEvent[];
}

/** Captured PLAN sources を純粋な projection write列へ変換する。 */
export function projectPlanSources(
  sources: readonly ProjectionPlanSource[],
  context: PlanProjectionContext,
): PlanProjectionResult {
  const plans = new Map<string, ProjectedPlan>();
  const writes: ProjectionEvent[] = [];
  for (const source of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    const planId = frontmatterValue(source.content, "plan_id");
    if (!planId) continue;
    const kind = frontmatterValue(source.content, "kind");
    const layer = frontmatterValue(source.content, "layer");
    const drive = frontmatterValue(source.content, "drive");
    const status = frontmatterValue(source.content, "status") || "draft";
    const updatedAt =
      frontmatterValue(source.content, "updated") || frontmatterValue(source.content, "created");
    const routeMode = frontmatterValue(source.content, "route_mode");
    const decisionOutcome =
      frontmatterValue(source.content, "decision_outcome") ||
      frontmatterValue(source.content, "decision") ||
      "";
    plans.set(planId, { planId, kind, layer, drive, status, updatedAt, routeMode });
    const artifactId = context.stableId("artifact", source.path);
    const searchId = context.stableId("plan", planId);
    writes.push(
      {
        table: "plan_registry",
        id: planId,
        row: {
          plan_id: planId,
          kind,
          layer,
          drive,
          status,
          parent: "",
          route_mode: routeMode,
          updated_at: updatedAt,
          decision_outcome: decisionOutcome,
          source_hash: context.hash(source.content),
        },
      },
      {
        table: "artifact_registry",
        id: artifactId,
        row: {
          artifact_id: artifactId,
          artifact_type: "markdown_doc",
          path: source.path,
          pair_artifact: "",
          status: "current",
          updated_at: updatedAt,
        },
      },
      {
        table: "search_index",
        id: searchId,
        row: {
          search_id: searchId,
          subject_type: "plan",
          subject_id: planId,
          path: source.path,
          title: frontmatterValue(source.content, "title") || planId,
          tokens: `${planId} ${kind} ${layer} ${drive}`,
          summary: status || "plan",
          updated_at: updatedAt,
        },
      },
    );
  }
  return { plans, writes };
}

function frontmatterValue(content: string, key: string): string {
  const frontmatter = markdownFrontmatter(content);
  if (!frontmatter) return "";
  const match = frontmatter.match(new RegExp(`^${key}:\\s*"?([^"\\r\\n]+)"?`, "m"));
  return match?.[1]?.trim() ?? "";
}

function markdownFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? "";
}
