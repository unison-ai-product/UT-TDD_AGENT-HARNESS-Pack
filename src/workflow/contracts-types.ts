type Severity = "info" | "warn" | "error";

interface Finding {
  code: string;
  severity: Severity;
  evidence_path: string;
  message: string;
}

interface ContractResult {
  ok: boolean;
  findings: Finding[];
  evidence_paths: string[];
}

interface ProjectionRef {
  table: string;
  id: string;
  evidence_path: string;
}

interface TestCaseEvidence {
  oracle_id?: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  duration_ms?: number;
  message?: string;
  artifact_path?: string;
}

interface TestRunEvidenceInput {
  plan_id?: string;
  command: string;
  runner: string;
  scope: string;
  started_at: string;
  completed_at: string;
  exit_code: number;
  evidence_path: string;
  output_digest?: string;
  cases?: TestCaseEvidence[];
}

interface CommandEvidence {
  kind: string;
  completed_at: string;
  exit_code: number;
  evidence_path: string;
}

export type {
  CommandEvidence,
  ContractResult,
  Finding,
  ProjectionRef,
  Severity,
  TestCaseEvidence,
  TestRunEvidenceInput,
};
