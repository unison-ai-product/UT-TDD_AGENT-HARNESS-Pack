import type { OutstandingWork } from "../lint/outstanding.ts";

type HandoverStatus = "in_progress" | "completed";

interface HandoverPointer {
  active_plan: string | null;
  status: HandoverStatus;
  digest_summary: { commits: number; files: number; failures: number } | null;
  updated_at: string;
  generated_by?: string;
  outstanding?: OutstandingWork;
}

interface HandoverArgs {
  date: string;
  dryRun?: boolean;
  complete?: boolean;
}

interface HandoverResult {
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

interface BuildPointerInput {
  status: HandoverStatus;
  now: string;
}

export type {
  BuildPointerInput,
  HandoverArgs,
  HandoverDeps,
  HandoverPointer,
  HandoverResult,
  HandoverStatus,
};
