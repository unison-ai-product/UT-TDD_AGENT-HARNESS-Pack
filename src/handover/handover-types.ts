import type { OutstandingWork } from "../lint/outstanding";
import type { PlanDigest } from "../runtime/session-log";

type HandoverStatus = "in_progress" | "completed";

type PlanDigestRef = Pick<
  PlanDigest,
  "plan_id" | "sessions" | "commits" | "files_touched" | "failures" | "updated_at"
>;

interface HandoverPointer {
  active_plan: string | null;
  status: HandoverStatus;
  latest_doc: string | null;
  digest_summary: { commits: number; files: number; failures: number } | null;
  updated_at: string;
  generated_by?: string;
  doc_entry_count?: number;
  outstanding?: OutstandingWork;
}

interface HandoverDoc {
  date: string;
  plans: { plan_id: string; kind: string; summary: string }[];
  deliverables: { plan_id: string; commits: string[]; files: string[] }[];
  next_actions: string[];
  carry: string[];
  po_decisions: string[];
  do_not_break: string[];
}

interface PlanMeta {
  plan_id: string;
  kind: string;
  title: string;
}

interface HandoverScope {
  active_plan: string | null;
  digests: PlanDigestRef[];
}

interface HandoverArgs {
  date: string;
  dryRun?: boolean;
  complete?: boolean;
  planId?: string;
  scopeToActive?: boolean;
  sessionId?: string;
}

interface HandoverResult {
  content: string;
  pointer: HandoverPointer;
  written: string[];
}

interface HandoverDeps {
  repoRoot: string;
  now: () => string;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
  listDir: (dir: string) => string[];
}

interface HandoverScopeOpts {
  scopeToActive?: boolean;
  scopeToSession?: string;
}

interface BuildPointerInput {
  scope: HandoverScope;
  latestDoc: string | null;
  status: HandoverStatus;
  now: string;
}

interface HandoverRenderOpts {
  slimSummary?: boolean;
  maxSummaryPlans?: number;
  outstanding?: OutstandingWork;
}

interface CapRender<T> {
  renderItem: (item: T) => string[];
  breadcrumb: (remaining: number) => string;
}

export type {
  BuildPointerInput,
  CapRender,
  HandoverArgs,
  HandoverDeps,
  HandoverDoc,
  HandoverPointer,
  HandoverRenderOpts,
  HandoverResult,
  HandoverScope,
  HandoverScopeOpts,
  HandoverStatus,
  PlanDigestRef,
  PlanMeta,
};
