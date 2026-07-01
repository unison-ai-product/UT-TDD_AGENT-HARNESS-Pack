type VerificationProfileId =
  | "bun-unit"
  | "doctor"
  | "mcp-inspector-smoke"
  | "playwright-mcp"
  | "docker-mcp-toolkit"
  | "vitest-browser-playwright"
  | "github-mcp-readonly"
  | "testcontainers"
  | "msw";

type VerificationSignal =
  | "source_change"
  | "ui_flow"
  | "db_integration"
  | "api_mock_gap"
  | "mcp_profile_changed"
  | "external_issue"
  | "workflow_policy"
  | "doc_backprop";

interface VerificationProfile {
  id: VerificationProfileId;
  label: string;
  command: string;
  sourceType: "builtin" | "mcp" | "test-foundation";
  packageName: string | null;
  executable: string | null;
  authEnv: string[];
  requiresNetwork: boolean;
  requiresDocker: boolean;
  requiresAuth: boolean;
  defaultEnabled: boolean;
  riskTier: "low" | "medium" | "high";
  installHint: string | null;
  sourceUrl?: string;
  triggerSignals?: VerificationSignal[];
  optional?: boolean;
  profileIsolation?: string;
  allowedTools?: string[];
  readOnly?: boolean;
  requiresHumanApproval?: boolean;
}

interface VerificationRecommendation {
  profile: VerificationProfile;
  signals: VerificationSignal[];
  reasons: string[];
  changedFiles: string[];
}

interface VerificationGraphEdge {
  from: string;
  to: string;
  kind: "changed_file_to_signal" | "signal_to_profile";
}

interface VerificationRecommendationResult {
  changedFiles: string[];
  recommendations: VerificationRecommendation[];
  edges: VerificationGraphEdge[];
  missingProfiles: VerificationProfileId[];
  ok: boolean;
}

type VerificationProfileGateFindingCode =
  | "missing-default-profile"
  | "unrunnable-default-profile"
  | "external-without-activation-plan"
  | "recommendation-without-signal";

interface VerificationProfileGateFinding {
  code: VerificationProfileGateFindingCode;
  profileId?: VerificationProfileId;
  message: string;
}

interface VerificationProfileGateResult {
  recommendation: VerificationRecommendationResult;
  activationPlan: ExternalProfileActivationPlan;
  defaultRunnableProfiles: VerificationProfileId[];
  externalProfiles: VerificationProfileId[];
  findings: VerificationProfileGateFinding[];
  ok: boolean;
}

interface VerificationProbeCheck {
  name: string;
  ok: boolean;
  message: string;
}

interface VerificationProbeResult {
  profile: VerificationProfile;
  ready: boolean;
  checks: VerificationProbeCheck[];
}

interface VerificationProfileRunResult {
  profile: VerificationProfile;
  status: "passed" | "failed" | "refused" | "dry-run";
  exitCode: number | null;
  command: string;
  messages: string[];
}

interface VerificationProbeDeps {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => string;
  commandOk: (command: string, args: string[]) => boolean;
  runCommand: (command: string, args: string[]) => { status: number | null };
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
}

type VerificationProfileFindingCode =
  | "unknown-profile"
  | "global-mount"
  | "credential-inline"
  | "untrusted-source"
  | "package-missing"
  | "package-mismatch"
  | "github-write-tool"
  | "broad-toolset"
  | "docker-unavailable"
  | "docker-controls-missing"
  | "external-approval-required";

interface VerificationProfileFinding {
  code: VerificationProfileFindingCode;
  severity: "error" | "warn" | "info";
  message: string;
  profileId?: string;
}

interface VerificationProfileCatalogResult {
  profiles: VerificationProfile[];
  ok: boolean;
}

interface GeneratedMcpConfigInput {
  repoRoot: string;
  selectedProfileIds: string[];
  env?: Record<string, string>;
  mounts?: string[];
  targetPath?: string;
}

interface GeneratedMcpConfigResult {
  targetPath: string;
  content: string;
  findings: VerificationProfileFinding[];
  writesCommittedConfig: boolean;
  ok: boolean;
}

interface VerificationProfileSafetyInput {
  profile: VerificationProfile;
  declaredPackages?: string[];
  expectedPackage?: string;
  allowedTools?: string[];
  requiresHumanApproval?: boolean;
  dockerAvailable?: boolean;
  dockerControlsDocumented?: boolean;
}

interface VerificationProfileSafetyResult {
  profile: VerificationProfile;
  findings: VerificationProfileFinding[];
  actions: string[];
  trusted: boolean;
  ready: boolean;
  ok: boolean;
}

interface ExternalProfileActivationInput {
  triggerSignals: VerificationSignal[];
  recommendations: VerificationRecommendation[];
  allowExternal?: boolean;
}

interface ExternalProfileActivationStep {
  profileId: VerificationProfileId;
  action: "probe-profile" | "mcp-inspector-smoke" | "human-approval" | "refuse-run";
  reason: string;
}

interface ExternalProfileActivationPlan {
  steps: ExternalProfileActivationStep[];
  findings: VerificationProfileFinding[];
  actionsTaken: string[];
  ok: boolean;
}

const VERIFICATION_EVIDENCE_SCHEMA_VERSION = "verification-evidence-v1";

interface VerificationEvidenceRecord {
  schema_version: typeof VERIFICATION_EVIDENCE_SCHEMA_VERSION;
  kind: "profile-list" | "profile-probe" | "verify-recommend" | "verify-run" | "mcp-inspect";
  id: string;
  recorded_at: string;
  payload: unknown;
}

interface VerificationEvidenceWrite {
  path: string;
  record: VerificationEvidenceRecord;
}

interface SaveVerificationEvidenceInput {
  kind: VerificationEvidenceRecord["kind"];
  id: string;
  payload: unknown;
}

interface McpInspectResult {
  profile: VerificationProfile;
  inspectorProfile: VerificationProfile;
  method: string;
  status: "ready" | "not-ready" | "refused";
  checks: VerificationProbeCheck[];
  messages: string[];
}

export type {
  ExternalProfileActivationInput,
  ExternalProfileActivationPlan,
  ExternalProfileActivationStep,
  GeneratedMcpConfigInput,
  GeneratedMcpConfigResult,
  McpInspectResult,
  SaveVerificationEvidenceInput,
  VerificationEvidenceRecord,
  VerificationEvidenceWrite,
  VerificationGraphEdge,
  VerificationProbeCheck,
  VerificationProbeDeps,
  VerificationProbeResult,
  VerificationProfile,
  VerificationProfileCatalogResult,
  VerificationProfileFinding,
  VerificationProfileFindingCode,
  VerificationProfileGateFinding,
  VerificationProfileGateFindingCode,
  VerificationProfileGateResult,
  VerificationProfileId,
  VerificationProfileRunResult,
  VerificationProfileSafetyInput,
  VerificationProfileSafetyResult,
  VerificationRecommendation,
  VerificationRecommendationResult,
  VerificationSignal,
};
export { VERIFICATION_EVIDENCE_SCHEMA_VERSION };
