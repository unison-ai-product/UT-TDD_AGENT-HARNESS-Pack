import type { LintResult } from "../plan/lint";

export interface DoctorTiming {
  id: string;
  duration_ms: number;
  ok: boolean;
  message_count: number;
  substeps?: { id: string; duration_ms: number }[];
}

export interface DoctorResult extends LintResult {
  timings?: DoctorTiming[];
}

export interface DoctorCheckResult {
  ok: boolean;
  messages: string[];
}

export interface DoctorResultInput {
  leadingMessages: string[];
  checks: DoctorCheckResult[];
  timings?: DoctorTiming[];
}

export function buildDoctorResult(input: DoctorResultInput): DoctorResult {
  const result: DoctorResult = {
    ok: input.checks.every((check) => check.ok),
    messages: [
      ...input.leadingMessages,
      ...input.checks.flatMap((check) => check.messages.map((message) => `doctor: ${message}`)),
    ],
  };
  if (input.timings) result.timings = input.timings;
  return result;
}
