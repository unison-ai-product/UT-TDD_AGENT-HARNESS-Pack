import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

// Keep this transport guard aligned with typed custody rejections, including
// provider-failure results; it is not a second source for the custody contract.
const REVIEW_VERDICT_REJECTION_REASONS = new Set([
  "verdict_file_missing",
  "invalid_review_attestation",
  "review_identity_mismatch",
  "reviewer_exit_nonzero",
  "verdict_identity_mismatch",
  "same_family_reviewer_denied",
  "verdict_path_identity_mismatch",
  "verdict_file_unreadable",
  "verdict_absent",
  "verdict_absent_after_provider_failure",
  "verdict_ambiguous",
  "verdict_unknown",
  "flag_without_findings",
  "findings_on_pass",
]);

function rejectedReviewResult(output: unknown): ReviewVerdictProjectionResult | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const review = (output as Record<string, unknown>).review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return undefined;
  const result = review as Record<string, unknown>;
  if (
    result.ok !== false ||
    typeof result.reason !== "string" ||
    !REVIEW_VERDICT_REJECTION_REASONS.has(result.reason)
  )
    return undefined;
  return { ok: false, reason: result.reason };
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
  const resolved = input.cliPath
    ? { ok: true as const, path: input.cliPath }
    : resolveLiveReviewDelegationEntrypoint(input.repoRoot, process.argv[1]);
  if (!resolved.ok) return resolved;
  const cliPath = resolved.path;
  const child = spawnSync(process.execPath, [cliPath, input.provider, ...input.args], {
    cwd: input.repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (child.status !== 0) {
    try {
      const rejection = rejectedReviewResult(JSON.parse(child.stdout) as unknown);
      if (rejection) return rejection;
    } catch {
      // A missing or malformed result remains an execution failure.
    }
    return { ok: false, reason: "reviewer_execution_failed" };
  }
  try {
    const execution = JSON.parse(child.stdout) as { review?: ReviewVerdictProjectionResult };
    return execution.review ?? { ok: false, reason: "review_receipt_missing" };
  } catch {
    return { ok: false, reason: "review_receipt_invalid" };
  }
}

type LiveReviewEntrypointResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly reason:
        | "consumer_runtime_absent"
        | "consumer_runtime_resolution_denied"
        | "consumer_runtime_identity_mismatch";
    };

/** Preserve source-checkout delegation while consumer execution uses only its sealed wrapper. */
export function resolveLiveReviewDelegationEntrypoint(
  repoRoot: string,
  invokedCliPath: string | undefined,
): LiveReviewEntrypointResult {
  const sourceCli = join(repoRoot, "src", "cli.ts");
  const packagePath = join(repoRoot, "package.json");
  const wrapper = join(repoRoot, ".ut-tdd", "bin", "ut-tdd.mjs");
  const pointerPath = join(repoRoot, ".ut-tdd", "runtime", "activation", "active.json");
  try {
    const sourcePackage = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name?: unknown;
      utTdd?: { artifactProfile?: unknown };
    };
    if (
      sourcePackage.name === "ut-tdd" &&
      sourcePackage.utTdd?.artifactProfile === "source" &&
      existsSync(sourceCli)
    ) {
      return { ok: true, path: sourceCli };
    }
  } catch {
    // No source-checkout identity: resolve only the consumer-local sealed runtime.
  }
  if (!existsSync(wrapper) || !existsSync(pointerPath)) {
    return { ok: false, reason: "consumer_runtime_absent" };
  }
  if (!invokedCliPath) return { ok: false, reason: "consumer_runtime_resolution_denied" };
  let pointer: { entry_path?: unknown };
  try {
    pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { entry_path?: unknown };
  } catch {
    return { ok: false, reason: "consumer_runtime_resolution_denied" };
  }
  if (typeof pointer.entry_path !== "string") {
    return { ok: false, reason: "consumer_runtime_resolution_denied" };
  }
  try {
    const invoked = realpathSync.native(invokedCliPath);
    const samePath = (left: string, right: string) =>
      process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    const activeEntry = realpathSync.native(pointer.entry_path);
    if (!samePath(invoked, activeEntry)) {
      return { ok: false, reason: "consumer_runtime_identity_mismatch" };
    }
    return { ok: true, path: realpathSync.native(wrapper) };
  } catch {
    return { ok: false, reason: "consumer_runtime_absent" };
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
      (
        opts: {
          memoryId: string;
          memoryPath: string;
          pr: string;
          head: string;
          revision: string;
          authorFamily: string;
          operationId?: string;
          json?: boolean;
        },
        command: Command,
      ) => {
        const json = command.optsWithGlobals<{ json?: boolean }>().json;
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
          if (json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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
    .action((opts: { envelope: string; json?: boolean }, command: Command) => {
      const json = command.optsWithGlobals<{ json?: boolean }>().json;
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
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else if (result.ok) process.stdout.write("review live-consume: completed\n");
        else process.stderr.write(`review live-consume: ${result.reason}\n`);
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
