import type { LintResult } from "../plan/lint";

export interface DoctorCheckResult {
  ok: boolean;
  messages: string[];
}

export interface DoctorResultInput {
  leadingMessages: string[];
  checks: DoctorCheckResult[];
}

export function buildDoctorResult(input: DoctorResultInput): LintResult {
  return {
    ok: input.checks.every((check) => check.ok),
    messages: [
      ...input.leadingMessages,
      ...input.checks.flatMap((check) => check.messages.map((message) => `doctor: ${message}`)),
    ],
  };
}
