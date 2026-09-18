import type { Command } from "commander";
import {
  type ForwardCliEnvelope,
  ForwardWorkflowApplication,
} from "../application/forward-workflow.ts";
import type { ForwardEventName } from "../domain/transition-policy.ts";
import type { ForwardEvidenceEvaluator, ForwardSubject } from "../domain/types.ts";
import type { ForwardLedgerPort } from "../ports/forward-ledger.ts";
import type { ForwardProjectionPort } from "../ports/forward-projection.ts";

export interface ForwardWorkflowCliDeps {
  readonly application?: ForwardWorkflowApplication;
  readonly createApplication?: () => ForwardWorkflowApplication;
}

export function registerForwardWorkflowCommands(
  program: Command,
  deps: ForwardWorkflowCliDeps = {},
): void {
  const workflow = program
    .command("workflow")
    .description("append-only Forward FSM workflow query and transition");
  workflow
    .command("status")
    .requiredOption("--plan <subjectId>")
    .option("--revision <revision>", "subject revision", "1")
    .option("--source-commit <commit>", "tracked source commit", "unknown")
    .action((options: CliOptions) => {
      render(deps, "status", subject(options));
    });
  workflow
    .command("transition")
    .requiredOption("--plan <subjectId>")
    .requiredOption("--event <event>")
    .option("--command-id <id>")
    .option("--revision <revision>", "subject revision", "1")
    .option("--source-commit <commit>", "tracked source commit", "unknown")
    .action((options: CliOptions) => {
      render(deps, "transition", {
        ...subject(options),
        event: options.event as ForwardEventName,
        commandId: options.commandId,
        evidence: [],
      });
    });
  workflow
    .command("explain")
    .requiredOption("--plan <subjectId>")
    .requiredOption("--event <event>")
    .option("--revision <revision>", "subject revision", "1")
    .option("--source-commit <commit>", "tracked source commit", "unknown")
    .action((options: CliOptions) => {
      render(deps, "explain", {
        ...subject(options),
        event: options.event as ForwardEventName,
        evidence: [],
      });
    });
}

export function composeUnavailableForwardWorkflowApplication(deps: {
  readonly ledger: ForwardLedgerPort;
  readonly projection: ForwardProjectionPort;
  readonly evidencePolicy: ForwardEvidenceEvaluator;
}): ForwardWorkflowApplication {
  return new ForwardWorkflowApplication(deps);
}

function render(
  deps: ForwardWorkflowCliDeps,
  command: "status" | "transition" | "explain",
  input:
    | ForwardSubject
    | (ForwardSubject & {
        readonly event: ForwardEventName;
        readonly commandId?: string;
        readonly evidence?: readonly never[];
      }),
): void {
  const application = deps.application ?? deps.createApplication?.();
  if (!application) {
    const unavailable = forwardUnavailableEnvelope(command, input);
    process.stdout.write(`${JSON.stringify(unavailable)}\n`);
    process.stderr.write("workflow: forward-ledger-unavailable\n");
    process.exitCode = 3;
    return;
  }
  const result =
    command === "status"
      ? application.status(input)
      : command === "explain"
        ? application.explain(input, input as never)
        : application.transition(input as never);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.exitCode !== 0) process.stderr.write(`workflow ${command}: ${result.ruleId}\n`);
  process.exitCode = result.exitCode;
}

function forwardUnavailableEnvelope(
  command: "status" | "transition" | "explain",
  input: ForwardSubject,
): ForwardCliEnvelope {
  return {
    schemaVersion: "forward-cli/v1",
    command,
    planId: input.subjectId,
    subjectId: input.subjectId,
    subjectRevision: input.subjectRevision,
    state: null,
    currentState: null,
    event: null,
    nextState: null,
    verdict: "deny",
    ruleId: "forward-ledger-unavailable",
    evidence: { required: [], accepted: [], rejected: [] },
    digest: `sha256:${"0".repeat(64)}`,
    exitCode: 3,
  };
}

interface CliOptions {
  readonly plan: string;
  readonly revision: string;
  readonly sourceCommit: string;
  readonly event: string;
  readonly commandId?: string;
}

function subject(options: CliOptions): ForwardSubject {
  return {
    subjectId: options.plan,
    subjectRevision: Number(options.revision),
    sourceCommit: options.sourceCommit,
  };
}
