import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import type { LiveReviewWakeRoutingFailure } from "../feedback/live-review-projection.ts";
import {
  type CanonicalReviewWake,
  consumeLiveReview,
  dispatchLiveReview,
  LiveReviewWakeError,
} from "../feedback/live-review-projection.ts";
import { resolveRepositoryRoot } from "../feedback/repository-root.ts";
import type { ReviewVerdictProjectionResult } from "../feedback/review-attestation.ts";
import { issueReviewRequest } from "../feedback/review-attestation.ts";
import {
  canonicalAuthoredMemoryPath,
  readCanonicalMemoryByIdentity,
  resolveMemoryTaskFile,
  writeMemory,
} from "../memory/service.ts";
import {
  buildClaudeProviderReviewInboxEntry,
  decodeClaudeInboxEntry,
  publishClaudeInboxEntry,
  resolveLiveClaudeTarget,
} from "../runtime/claude-memory-wake.ts";
import { detectMode } from "../runtime/detect.ts";
import { requireProjectMemoryRoot } from "../runtime/project-memory-root.ts";
import { resolveRuntimeSessionId } from "../skill-engine/recommend.ts";

export interface LiveReviewCommandDeps {
  readonly repoRoot: () => string;
  readonly providerAvailable: (provider: "codex" | "claude") => boolean;
  readonly validateReviewSubject: (
    repoRoot: string,
    pr: number,
    exactHead: string,
  ) => LiveReviewSubjectValidationResult;
  readonly runReview: (input: {
    repoRoot: string;
    provider: "codex" | "claude";
    args: readonly string[];
  }) => ReviewVerdictProjectionResult;
  readonly publishReceipt: (
    repoRoot: string,
    projection: Extract<ReviewVerdictProjectionResult, { ok: true }>,
  ) => void;
  readonly resolveWakeTarget: (
    repoRoot: string,
    provider: "codex" | "claude",
  ) =>
    | { readonly ok: true; readonly workspaceId: string; readonly sessionId: string }
    | { readonly ok: false; readonly reason: LiveReviewWakeRoutingFailure };
  /** Optional provider-native wake surface. Absent Codex surfaces fail closed. */
  readonly publishCodexReviewWake?: (repoRoot: string, wake: CanonicalReviewWake) => void;
}

export type LiveReviewSubjectValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "exact_head_not_found"
        | "pull_request_head_unavailable"
        | "pull_request_head_mismatch";
    };

interface ReviewSubjectCommandResult {
  readonly status: number | null;
  readonly stdout: string;
}

/** Resolve the review subject from Git and GitHub before any canonical request is written. */
export function validateLiveReviewSubject(input: {
  readonly repoRoot: string;
  readonly pr: number;
  readonly head: string;
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => ReviewSubjectCommandResult;
}): LiveReviewSubjectValidationResult {
  const run =
    input.run ??
    ((command: string, args: readonly string[], cwd: string) => {
      const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { status: result.status, stdout: result.stdout ?? "" };
    });
  const object = run("git", ["cat-file", "-e", `${input.head}^{commit}`], input.repoRoot);
  if (object.status !== 0) return { ok: false, reason: "exact_head_not_found" };

  const pullRequest = run(
    "gh",
    ["pr", "view", String(input.pr), "--json", "headRefOid", "--jq", ".headRefOid"],
    input.repoRoot,
  );
  const observedHead = pullRequest.stdout.trim().toLowerCase();
  if (pullRequest.status !== 0 || !/^[0-9a-f]{40}$/.test(observedHead)) {
    return { ok: false, reason: "pull_request_head_unavailable" };
  }
  if (observedHead !== input.head.toLowerCase()) {
    return { ok: false, reason: "pull_request_head_mismatch" };
  }
  return { ok: true };
}

export function executeLiveReviewDelegation(input: {
  repoRoot: string;
  provider: "codex" | "claude";
  args: readonly string[];
  cliPath?: string;
}): ReviewVerdictProjectionResult {
  const child = spawnSync(
    process.execPath,
    [input.cliPath ?? join(input.repoRoot, "src", "cli.ts"), input.provider, ...input.args],
    { cwd: input.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (child.status !== 0) return { ok: false, reason: "reviewer_execution_failed" };
  try {
    const execution = JSON.parse(child.stdout) as { review?: ReviewVerdictProjectionResult };
    return execution.review ?? { ok: false, reason: "review_receipt_missing" };
  } catch {
    return { ok: false, reason: "review_receipt_invalid" };
  }
}

function publishLiveReviewReceipt(
  repoRoot: string,
  projection: Extract<ReviewVerdictProjectionResult, { ok: true }>,
): void {
  const project = requireProjectMemoryRoot(repoRoot);
  const receipt = projection.receipt;
  const body = [
    `PR #${receipt.pr} exact HEAD ${receipt.head} のcanonical review receipt。`,
    `verdict=${receipt.verdict ?? "none"} blocking=${receipt.blockingFindings?.length ?? 0}`,
    `reviewRevision=${receipt.reviewRevision}`,
    `reviewerFamily=${receipt.reviewerFamily}`,
    `receiptDigest=${projection.digest}`,
  ].join("\n");
  writeMemory({
    repoRoot: project.canonicalProjectRoot,
    input: {
      kind: "feedback",
      title: `PR #${receipt.pr} canonical review receipt ${projection.digest}`,
      body,
      tags: ["pr", "claude-review", "canonical-receipt"],
    },
  });
  execFileSync("gh", ["pr", "comment", String(receipt.pr), "--body", body], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// Kept as a public compatibility export for CLI consumers and the path-boundary tests.
export { canonicalAuthoredMemoryPath } from "../memory/service.ts";

export function registerLiveReviewCommands(
  review: Command,
  overrides: Partial<LiveReviewCommandDeps> = {},
): void {
  const deps: LiveReviewCommandDeps = {
    repoRoot: () => resolveRepositoryRoot(process.cwd()),
    providerAvailable: (provider) => detectMode()[provider],
    validateReviewSubject: (repoRoot, pr, exactHead) =>
      validateLiveReviewSubject({ repoRoot, pr, head: exactHead }),
    runReview: ({ repoRoot, provider, args }) =>
      executeLiveReviewDelegation({ repoRoot, provider, args }),
    publishReceipt: publishLiveReviewReceipt,
    resolveWakeTarget: (repoRoot) => resolveLiveClaudeTarget(repoRoot),
    ...overrides,
  };
  review
    .command("live-dispatch")
    .description("persist a canonical review request before publishing a typed Claude wake")
    .requiredOption("--memory-id <id>", "canonical HARNESS memory identity")
    .requiredOption("--memory-path <path>", "canonical HARNESS memory path")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption("--head <sha>", "exact pull request HEAD")
    .requiredOption("--revision <id>", "review revision identity")
    .requiredOption("--author-family <family>", "author family (codex|claude)")
    .option("--operation-id <id>", "stable wake operation identity")
    .option("--json", "JSON output")
    .action(
      (opts: {
        memoryId: string;
        memoryPath: string;
        pr: string;
        head: string;
        revision: string;
        authorFamily: string;
        operationId?: string;
        json?: boolean;
      }) => {
        try {
          const repoRoot = resolveRepositoryRoot(deps.repoRoot());
          const project = requireProjectMemoryRoot(repoRoot);
          const memoryPath = canonicalAuthoredMemoryPath(
            project.canonicalProjectRoot,
            opts.memoryPath,
          );
          const memory = readCanonicalMemoryByIdentity({
            repoRoot: project.canonicalProjectRoot,
            memoryPath,
            memoryId: opts.memoryId,
          });
          if (!memory) throw new Error("review_memory_identity_mismatch");
          const requestedAt = new Date().toISOString();
          const result = dispatchLiveReview({
            repoRoot,
            request: {
              memoryId: opts.memoryId,
              memoryPath: memory.source_path,
              pr: Number(opts.pr),
              exactHead: opts.head,
              reviewRevision: opts.revision,
              authorFamily: opts.authorFamily as "codex" | "claude",
              requestedAt,
            },
            ports: {
              validateSubject: ({ repoRoot, pr, exactHead }) =>
                deps.validateReviewSubject(repoRoot, pr, exactHead),
              issueRequest: issueReviewRequest,
              providerAvailable: deps.providerAvailable,
              publishReviewWake: (wake) => {
                if (wake.reviewer === "codex") {
                  if (!deps.publishCodexReviewWake) {
                    throw new LiveReviewWakeError("codex_review_wake_unavailable");
                  }
                  deps.publishCodexReviewWake(repoRoot, wake);
                  return;
                }
                const target = deps.resolveWakeTarget(repoRoot, "claude");
                if (!target.ok) throw new LiveReviewWakeError(target.reason);
                const project = requireProjectMemoryRoot(repoRoot);
                const notification = buildClaudeProviderReviewInboxEntry({
                  memory,
                  projectId: project.projectId,
                  operationId: opts.operationId?.trim() || `review-${wake.requestDigest}`,
                  workspaceId: target.workspaceId,
                  producer: { provider: "codex", sessionId: resolveRuntimeSessionId() },
                  target: { scope: "session", provider: "claude", sessionId: target.sessionId },
                  requestDigest: wake.requestDigest,
                  requestPath: wake.requestPath,
                  pr: wake.request.pr,
                  exactHead: wake.request.exactHead,
                  reviewRevision: wake.request.reviewRevision,
                  authorFamily: wake.request.authorFamily,
                });
                publishClaudeInboxEntry(repoRoot, notification);
              },
            },
          });
          const output = { ...result, requestedAt };
          if (opts.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
          else
            process.stdout.write(
              `review live-dispatch: ${result.ok ? "published" : result.reason}\n`,
            );
          process.exitCode = result.ok ? 0 : 1;
        } catch (error) {
          process.stderr.write(
            `review live-dispatch: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );

  review
    .command("live-consume")
    .description("consume one strict v3 review envelope through the canonical delegation CLI")
    .requiredOption("--envelope <path>", "v3 Claude review inbox envelope")
    .option("--json", "JSON output")
    .action((opts: { envelope: string; json?: boolean }) => {
      try {
        const repoRoot = resolveRepositoryRoot(deps.repoRoot());
        const envelope = decodeClaudeInboxEntry(readFileSync(opts.envelope, "utf8"));
        if (!envelope || envelope.purpose !== "review") {
          throw new Error("invalid_review_envelope");
        }
        const result = consumeLiveReview({
          repoRoot,
          envelope,
          ports: {
            providerAvailable: deps.providerAvailable,
            resolveTaskFile: (input) => resolveLiveReviewTaskFile(repoRoot, input),
            runReview: ({ provider, args }) => deps.runReview({ repoRoot, provider, args }),
            publishReceipt: (projection) => deps.publishReceipt(repoRoot, projection),
          },
        });
        if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else
          process.stdout.write(`review live-consume: ${result.ok ? "completed" : result.reason}\n`);
        process.exitCode = result.ok ? 0 : 1;
      } catch (error) {
        process.stderr.write(
          `review live-consume: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}

export function resolveLiveReviewTaskFile(
  repoRoot: string,
  input: { memoryId: string; memoryPath: string },
): string | null {
  const project = requireProjectMemoryRoot(repoRoot);
  return resolveMemoryTaskFile({ repoRoot: project.canonicalProjectRoot, ...input });
}
