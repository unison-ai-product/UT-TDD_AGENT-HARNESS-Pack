import type { RelationFinding, RelationFindingCode } from "./relation-graph-types";

// ---- PLAN-L7-36: collectVerificationEvidenceProjection (U-RELGRAPH-009..010) ---

export interface VerificationProfileProjectionRow {
  verification_profile_id: string;
  name: string;
  profile_type: string;
  package_refs?: string[];
  requires_docker?: boolean;
  requires_browser?: boolean;
  requires_network?: boolean;
  green_definition_id?: string;
  trigger_signals?: string[];
  enabled?: boolean;
  evidence_path: string;
}

export interface VerificationRecommendationProjectionRow {
  verification_recommendation_id: string;
  change_set_id: string;
  plan_id: string;
  profile_id: string;
  profile_kind: string;
  reason: string;
  source_rule: string;
  accepted: boolean;
  evidence_path: string;
}

export interface McpServerRunProjectionRow {
  mcp_run_id: string;
  mcp_profile_id: string;
  session_id?: string;
  plan_id?: string;
  command: string;
  method: string;
  tool_name?: string;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  evidence_path: string;
  normalized_status: string;
}

export interface ExternalToolFindingProjectionRow {
  external_finding_id: string;
  source_run_id: string;
  source_kind: string;
  finding_type: string;
  severity: "error" | "warn" | "info";
  subject_id?: string;
  path?: string;
  status?: string;
  digest?: string;
  evidence_path: string;
}

export interface VerificationEvidenceProjection {
  verification_profiles: VerificationProfileProjectionRow[];
  verification_recommendations: VerificationRecommendationProjectionRow[];
  mcp_server_runs: McpServerRunProjectionRow[];
  external_tool_findings: ExternalToolFindingProjectionRow[];
  findings: RelationFinding[];
  ok: boolean;
}

type EvidenceRecord = Record<string, unknown>;

function asRecord(value: unknown): EvidenceRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as EvidenceRecord)
    : null;
}

function stringValue(record: EvidenceRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sortFindings(list: RelationFinding[]): RelationFinding[] {
  return [...list].sort(
    (a, b) => a.code.localeCompare(b.code) || (a.nodeId ?? "").localeCompare(b.nodeId ?? ""),
  );
}

function booleanValue(record: EvidenceRecord, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function numberValue(record: EvidenceRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(record: EvidenceRecord, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function evidenceFinding(
  code: Extract<RelationFindingCode, "invalid-evidence" | "external-not-allowed">,
  message: string,
  evidencePath?: string,
): RelationFinding {
  return {
    code,
    severity: "error",
    message,
    evidencePath,
  };
}

function projectProfile(
  profile: EvidenceRecord,
  evidencePath: string,
): VerificationProfileProjectionRow | null {
  const id = stringValue(profile, "id");
  const name = stringValue(profile, "name");
  const profileType = stringValue(profile, "profile_type");
  if (!id || !name || !profileType) return null;
  return {
    verification_profile_id: id,
    name,
    profile_type: profileType,
    package_refs: stringArrayValue(profile, "package_refs"),
    requires_docker: booleanValue(profile, "requires_docker"),
    requires_browser: booleanValue(profile, "requires_browser"),
    requires_network: booleanValue(profile, "requires_network"),
    green_definition_id: stringValue(profile, "green_definition_id"),
    trigger_signals: stringArrayValue(profile, "trigger_signals"),
    enabled: booleanValue(profile, "enabled"),
    evidence_path: evidencePath,
  };
}

function projectRecommendation(
  recommendation: EvidenceRecord,
  evidencePath: string,
): VerificationRecommendationProjectionRow | null {
  const id = stringValue(recommendation, "id");
  const changeSetId = stringValue(recommendation, "change_set_id");
  const planId = stringValue(recommendation, "plan_id");
  const profileId = stringValue(recommendation, "profile_id");
  const profileKind = stringValue(recommendation, "profile_kind");
  const reason = stringValue(recommendation, "reason");
  const sourceRule = stringValue(recommendation, "source_rule");
  if (!id || !changeSetId || !planId || !profileId || !profileKind || !reason || !sourceRule)
    return null;
  return {
    verification_recommendation_id: id,
    change_set_id: changeSetId,
    plan_id: planId,
    profile_id: profileId,
    profile_kind: profileKind,
    reason,
    source_rule: sourceRule,
    accepted: booleanValue(recommendation, "accepted") ?? false,
    evidence_path: evidencePath,
  };
}

function projectMcpRun(
  run: EvidenceRecord,
  evidencePath: string,
): McpServerRunProjectionRow | null {
  const id = stringValue(run, "id");
  const profileId = stringValue(run, "profile_id");
  const command = stringValue(run, "command");
  const method = stringValue(run, "method");
  const status = stringValue(run, "normalized_status");
  if (!id || !profileId || !command || !method || !status) return null;
  return {
    mcp_run_id: id,
    mcp_profile_id: profileId,
    session_id: stringValue(run, "session_id"),
    plan_id: stringValue(run, "plan_id"),
    command,
    method,
    tool_name: stringValue(run, "tool_name"),
    started_at: stringValue(run, "started_at"),
    completed_at: stringValue(run, "completed_at"),
    exit_code: numberValue(run, "exit_code"),
    evidence_path: evidencePath,
    normalized_status: status,
  };
}

function projectFinding(
  finding: EvidenceRecord,
  evidencePath: string,
): ExternalToolFindingProjectionRow | null {
  const id = stringValue(finding, "id");
  const sourceRunId = stringValue(finding, "source_run_id");
  const sourceKind = stringValue(finding, "source_kind");
  const findingType = stringValue(finding, "finding_type");
  const severity = stringValue(finding, "severity");
  if (!id || !sourceRunId || !sourceKind || !findingType) return null;
  const normalizedSeverity =
    severity === "error" || severity === "warn" || severity === "info" ? severity : "warn";
  return {
    external_finding_id: id,
    source_run_id: sourceRunId,
    source_kind: sourceKind,
    finding_type: findingType,
    severity: normalizedSeverity,
    subject_id: stringValue(finding, "subject_id"),
    path: stringValue(finding, "path"),
    status: stringValue(finding, "status"),
    digest: stringValue(finding, "digest"),
    evidence_path: evidencePath,
  };
}

export function collectVerificationEvidenceProjection(
  records: unknown[],
): VerificationEvidenceProjection {
  const verificationProfiles: VerificationProfileProjectionRow[] = [];
  const verificationRecommendations: VerificationRecommendationProjectionRow[] = [];
  const mcpServerRuns: McpServerRunProjectionRow[] = [];
  const externalToolFindings: ExternalToolFindingProjectionRow[] = [];
  const findings: RelationFinding[] = [];

  for (const raw of records) {
    const record = asRecord(raw);
    const evidencePath = record ? stringValue(record, "evidence_path") : undefined;
    if (!record || record.schema_version !== "verification-evidence-v1" || !evidencePath) {
      findings.push(
        evidenceFinding(
          "invalid-evidence",
          "verification evidence must include schema_version=verification-evidence-v1 and evidence_path",
          evidencePath,
        ),
      );
      continue;
    }

    const profile = asRecord(record.profile);
    if (profile) {
      const row = projectProfile(profile, evidencePath);
      if (row) verificationProfiles.push(row);
      else
        findings.push(
          evidenceFinding(
            "invalid-evidence",
            "verification profile row is missing required fields",
            evidencePath,
          ),
        );
    }

    const recommendation = asRecord(record.recommendation);
    if (recommendation) {
      const row = projectRecommendation(recommendation, evidencePath);
      if (row) verificationRecommendations.push(row);
      else
        findings.push(
          evidenceFinding(
            "invalid-evidence",
            "verification recommendation row is missing required fields",
            evidencePath,
          ),
        );
    }

    const mcpRun = asRecord(record.mcp_run);
    if (mcpRun && record.allow_external === false) {
      findings.push(
        evidenceFinding(
          "external-not-allowed",
          "external MCP/tool run evidence was supplied while allow_external=false",
          evidencePath,
        ),
      );
      continue;
    }
    if (mcpRun) {
      const row = projectMcpRun(mcpRun, evidencePath);
      if (row) mcpServerRuns.push(row);
      else
        findings.push(
          evidenceFinding(
            "invalid-evidence",
            "mcp_server_runs row is missing required fields",
            evidencePath,
          ),
        );
    }

    const rawFindings = record.findings;
    if (Array.isArray(rawFindings)) {
      for (const rawFinding of rawFindings) {
        const findingRecord = asRecord(rawFinding);
        const row = findingRecord ? projectFinding(findingRecord, evidencePath) : null;
        if (row) externalToolFindings.push(row);
        else
          findings.push(
            evidenceFinding(
              "invalid-evidence",
              "external_tool_findings row is missing required fields",
              evidencePath,
            ),
          );
      }
    }
  }

  const sortedFindings = sortFindings(findings);
  return {
    verification_profiles: verificationProfiles.sort((a, b) =>
      a.verification_profile_id.localeCompare(b.verification_profile_id),
    ),
    verification_recommendations: verificationRecommendations.sort((a, b) =>
      a.verification_recommendation_id.localeCompare(b.verification_recommendation_id),
    ),
    mcp_server_runs: mcpServerRuns.sort((a, b) => a.mcp_run_id.localeCompare(b.mcp_run_id)),
    external_tool_findings: externalToolFindings.sort((a, b) =>
      a.external_finding_id.localeCompare(b.external_finding_id),
    ),
    findings: sortedFindings,
    ok: !sortedFindings.some((f) => f.severity === "error"),
  };
}
