import { writeSync } from "node:fs";
import { usePrivateTmpdir } from "./private-tmpdir.ts";

export class CandidatePreconditionFailure extends Error {}

function candidateDiagnostic(candidate: string, outcome: string, details?: unknown): void {
  try {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    writeSync(2, `[snapshot-lifecycle ${candidate}] ${outcome}${suffix}\n`);
  } catch {
    // Diagnostic I/O must not affect whether the contract assertions run.
  }
}

export async function verifySnapshotCandidate(
  candidate: string,
  cleanup: () => void,
  action: (assertionsReached: () => void) => Promise<void>,
): Promise<void> {
  // candidate の fixture と runner の snapshot dir を他テストファイルの一時 dir と分ける (#1755)。
  usePrivateTmpdir();
  let reachedAssertions = false;
  let actionFailed = false;
  let actionFailure: unknown;
  try {
    await action(() => {
      reachedAssertions = true;
      candidateDiagnostic(candidate, "contract-assertions-reached");
    });
  } catch (error) {
    actionFailed = true;
    actionFailure = error;
    if (error instanceof CandidatePreconditionFailure) {
      candidateDiagnostic(candidate, "precondition-not-met", error.message);
    } else if (reachedAssertions) {
      candidateDiagnostic(candidate, "contract-assertions-failed", String(error));
    } else {
      candidateDiagnostic(candidate, "pre-assertion-exception", String(error));
    }
  }

  const failures: unknown[] = [];
  if (actionFailed) failures.push(actionFailure);
  else if (!reachedAssertions)
    failures.push(
      new Error(`snapshot candidate ${candidate} completed without reaching contract assertions`),
    );

  try {
    cleanup();
  } catch (error) {
    candidateDiagnostic(candidate, "cleanup-failed", String(error));
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `snapshot candidate ${candidate} failed during execution or cleanup`,
    );
  candidateDiagnostic(candidate, "contract-assertions-completed");
}
