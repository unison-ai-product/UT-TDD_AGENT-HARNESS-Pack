import type { RedactedCommandArgs } from "./redacted-command-args.ts";

export interface EvidenceError {
  readonly ruleId: string;
  readonly message: string;
}

export const EVIDENCE_KINDS = [
  "scope-approval",
  "pair-artifact-declaration",
  "design-pair-review",
  "red-test-run",
  "targeted-test-run",
  "implementation-digest",
  "trace-materialization",
  "trace-closure",
  "green-test-run",
  "independent-review",
  "gate-run",
  "acceptance-decision",
  "retention-decision",
  "exception-context",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_PRODUCERS = ["human", "po", "codex", "claude", "ci"] as const;
export type EvidenceProducer = (typeof EVIDENCE_PRODUCERS)[number];

export interface EvidenceClaimsByKind {
  readonly "scope-approval": { readonly decision: "approved"; readonly approver: string };
  readonly "pair-artifact-declaration": { readonly artifactIds: readonly string[] };
  readonly "design-pair-review": {
    readonly verdict: "approved" | "rejected";
    readonly reviewerId: string;
  };
  readonly "red-test-run": {
    readonly expectedFindingIds: readonly string[];
    readonly observedFindingIds: readonly string[];
    readonly todoCount: number;
    readonly skipCount: number;
  };
  readonly "targeted-test-run": TestRunClaims;
  readonly "implementation-digest": { readonly implementationDigest: string };
  readonly "trace-materialization": { readonly traceIds: readonly string[] };
  readonly "trace-closure": {
    readonly orphanCount: number;
    readonly staleCount: number;
    readonly traceDigest: string;
  };
  readonly "green-test-run": TestRunClaims;
  readonly "independent-review": {
    readonly verdict: "approved" | "rejected";
    readonly reviewerId: string;
    readonly reviewedAt: string;
  };
  readonly "gate-run": {
    readonly gateIds: readonly string[];
    readonly failedGateIds: readonly string[];
  };
  readonly "acceptance-decision": {
    readonly decision: "accepted" | "rejected";
    readonly decidedBy: string;
  };
  readonly "retention-decision": {
    readonly decision: "retain" | "archive";
    readonly decidedBy: string;
  };
  readonly "exception-context": {
    readonly action: "block" | "reject" | "supersede" | "reopen" | "resume";
    readonly actor: string;
    readonly reason: string;
    readonly resumeState?: string;
    readonly replacementSubjectId?: string;
  };
}

interface TestRunClaims {
  readonly runnerId: string;
  readonly testIds: readonly string[];
}

export type EvidenceClaims = EvidenceClaimsByKind[EvidenceKind];

export interface EvidenceAttestation {
  readonly schemaVersion: "evidence-attestation/v1";
  readonly algorithm: "hmac-sha256";
  readonly authorityId: string;
  readonly keyVersion: string;
  readonly signature: string;
}

export interface EvidenceRecordInput<K extends EvidenceKind = EvidenceKind> {
  readonly evidenceId: string;
  readonly evidenceKind: K;
  readonly subjectId: string;
  readonly subjectRevision: number;
  readonly sourceCommit: string;
  readonly commandArgs: RedactedCommandArgs;
  readonly claims: EvidenceClaimsByKind[K];
  readonly outputDigest: string;
  readonly exitCode: number;
  readonly producer: EvidenceProducer;
  readonly producedAt: string;
  readonly expiresAt?: string;
  readonly supersedesEvidenceId?: string;
}

export interface StoredEvidenceRecord {
  readonly evidenceId: string;
  readonly evidenceKind: EvidenceKind;
  readonly subjectId: string;
  readonly subjectRevision: number;
  readonly sourceCommit: string;
  readonly commandArgs: {
    readonly schemaVersion: "redacted-argv/v1";
    readonly values: readonly string[];
  };
  readonly claims: EvidenceClaims;
  readonly outputDigest: string;
  readonly exitCode: number;
  readonly producer: EvidenceProducer;
  readonly producedAt: string;
  readonly expiresAt: string | null;
  readonly supersedesEvidenceId: string | null;
  readonly recordDigest: string;
  readonly attestation: EvidenceAttestation | null;
}

export type EvidenceExitRule =
  | { readonly kind: "exact"; readonly expected: number }
  | { readonly kind: "nonzero" }
  | { readonly kind: "any" };

export type EvidenceClaimsRule =
  | { readonly kind: "recorded" }
  | { readonly kind: "review-approved" }
  | { readonly kind: "red-observed" }
  | { readonly kind: "trace-clean" }
  | { readonly kind: "gate-passed" }
  | {
      readonly kind: "decision";
      readonly expected: "accepted" | "rejected" | "retain" | "archive";
    };
