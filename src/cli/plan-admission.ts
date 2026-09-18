import type { Command } from "commander";
import {
  type AdmissionProjectionPort,
  checkPlanAdmission,
} from "../plan-admission/admission-check.ts";
import {
  GitAdmissionChangesAdapter,
  GitDiffAdapterError,
  readUtf8BlobAtRef,
  SystemGitCommandPort,
} from "../plan-admission/git-diff-adapter.ts";
import { parseTrackedReceiptProjection } from "../plan-admission/tracked-receipt-projection.ts";

const PROJECTION_PATH = "docs/governance/plan-admission-receipts.json";

export function registerPlanAdmissionCommands(plan: Command): void {
  plan
    .command("admission-check")
    .description("base/head Git blobとtracked receiptを照合し、規定外PLAN編集をfail-close")
    .requiredOption("--base <ref>", "比較元commit/ref")
    .requiredOption("--head <ref>", "比較先commit/ref")
    .option("--json", "JSON出力")
    .action((options: { base: string; head: string; json?: boolean }) => {
      const git = new SystemGitCommandPort(process.cwd());
      const projection = loadProjection(git, options.head);
      const result = checkPlanAdmission({
        baseRef: options.base,
        headRef: options.head,
        changes: new GitAdmissionChangesAdapter(git),
        projection,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`plan admission-check: ${result.ok ? "PASS" : "BLOCK"}\n`);
        for (const finding of result.findings) {
          const detail = "detail" in finding ? finding.detail : undefined;
          process.stdout.write(
            `  [${finding.code}] ${finding.path}${detail ? `: ${detail}` : ""}\n`,
          );
        }
      }
      process.exitCode = result.ok ? 0 : 1;
    });
}

function loadProjection(git: SystemGitCommandPort, headRef: string): AdmissionProjectionPort {
  try {
    const text = readUtf8BlobAtRef(git, headRef, PROJECTION_PATH);
    const parsed = parseTrackedReceiptProjection(text);
    if (parsed.ok) return parsed.value;
    return invalidProjection(parsed.errors);
  } catch (error) {
    const detail =
      error instanceof GitDiffAdapterError ? `${error.code}: ${error.message}` : String(error);
    return invalidProjection([detail]);
  }
}

function invalidProjection(errors: readonly string[]): AdmissionProjectionPort {
  return {
    lookup: () => undefined,
    validate: () => ({
      ok: false,
      findings: errors.map((detail) => ({ code: "projection-invalid", detail })),
    }),
  };
}
