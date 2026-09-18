import { canonicalField, sha256 } from "./canonical-frame.ts";
import {
  type DocumentDispositionInput,
  validateDocumentDisposition,
} from "./document-disposition.ts";
import {
  type DocumentDelta,
  type DocumentDeltaDecision,
  type DocumentDeltaFinding,
  type DocumentMemberIdentity,
  replayDocumentDeltas,
} from "./replay-document-deltas.ts";

export type DocumentMembershipRuleId =
  | "doc-disposition-missing"
  | "doc-disposition-phantom"
  | "doc-disposition-duplicate"
  | "doc-disposition-incomplete"
  | "doc-delta-unregistered";

export interface DocumentClosureFinding {
  readonly findingId: string;
  readonly ruleId: DocumentMembershipRuleId;
  readonly subjectIdentity: string;
  readonly evidenceDigest: string;
  readonly exitCode: 1;
  readonly kind?: DocumentDeltaFinding["kind"];
  readonly reasonCode?: string;
  readonly sequence?: number;
}

export interface DocumentSnapshotView {
  readonly snapshotDigest: string;
  readonly members: readonly DocumentMemberIdentity[];
}

export interface DocumentDispositionLedgerView {
  readonly ledgerId: string;
  readonly records: readonly DocumentDispositionInput[];
  readonly deltas: readonly DocumentDelta[];
  readonly decisions: readonly DocumentDeltaDecision[];
  readonly deltaChainDigest: string;
}

export interface AnalyzeRepositoryDocumentClosureInput {
  readonly baselineSnapshot: DocumentSnapshotView;
  readonly finalSnapshot: DocumentSnapshotView;
  readonly ledger: DocumentDispositionLedgerView;
  readonly policyRevision: string;
}

export interface DocumentClosureResult {
  readonly finalSnapshotDigest: string;
  readonly deltaChainDigest: string;
  readonly effective?: readonly DocumentMemberIdentity[];
  readonly reductionDigest?: string;
  readonly findings: readonly DocumentClosureFinding[];
  readonly routeRequirements: readonly never[];
  readonly closure: "closed" | "blocked";
  readonly exitCode: 0 | 1;
}

const encoder = new TextEncoder();

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function finding(args: {
  readonly ruleId: DocumentMembershipRuleId;
  readonly subjectIdentity: string;
  readonly input: AnalyzeRepositoryDocumentClosureInput;
  readonly evidenceFields?: readonly Uint8Array[];
}): DocumentClosureFinding {
  const { ruleId, subjectIdentity, input, evidenceFields = [] } = args;
  const evidenceDigest = sha256([
    canonicalField("baseline_snapshot_digest", input.baselineSnapshot.snapshotDigest),
    canonicalField("final_snapshot_digest", input.finalSnapshot.snapshotDigest),
    canonicalField("policy_revision", input.policyRevision),
    canonicalField("subject_identity", subjectIdentity),
    ...evidenceFields,
  ]);
  const findingId = `document-closure-finding:sha256:${sha256([
    canonicalField("rule_id", ruleId),
    canonicalField("subject_identity", subjectIdentity),
    canonicalField("evidence_digest", evidenceDigest),
    canonicalField("policy_revision", input.policyRevision),
  ])}`;
  return { findingId, ruleId, subjectIdentity, evidenceDigest, exitCode: 1 };
}

function count(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function caseFoldCollisions(paths: readonly string[]): readonly string[][] {
  const groups = new Map<string, Set<string>>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    const group = groups.get(folded) ?? new Set<string>();
    group.add(path);
    groups.set(folded, group);
  }
  return [...groups.values()]
    .map((group) => [...group].sort(compareUtf8))
    .filter((group) => group.length > 1)
    .sort((left, right) => compareUtf8(left.join("|"), right.join("|")));
}

export function analyzeRepositoryDocumentClosure(
  input: AnalyzeRepositoryDocumentClosureInput,
): DocumentClosureResult {
  const baselinePaths = input.baselineSnapshot.members.map(({ path }) => path);
  const recordPaths = input.ledger.records.map(({ baselinePath }) => baselinePath);
  const recordCounts = count(recordPaths);
  const invalidPaths = new Set<string>();
  const findings: DocumentClosureFinding[] = [];

  for (const [path, occurrences] of recordCounts) {
    if (occurrences < 2) continue;
    invalidPaths.add(path);
    findings.push(finding({ ruleId: "doc-disposition-duplicate", subjectIdentity: path, input }));
  }

  for (const record of input.ledger.records) {
    const validation = validateDocumentDisposition(record);
    if (validation.ok || invalidPaths.has(record.baselinePath)) continue;
    findings.push(
      finding({
        ruleId: "doc-disposition-incomplete",
        subjectIdentity: record.baselinePath,
        input,
        evidenceFields: [
          canonicalField("missing_fields", validation.missingFields.join("\0")),
          canonicalField("disposition", record.disposition),
          canonicalField("application_status", record.applicationStatus),
          canonicalField("applicability_kind", record.applicability.kind),
        ],
      }),
    );
  }

  for (const collision of caseFoldCollisions([...baselinePaths, ...recordPaths])) {
    for (const path of collision) invalidPaths.add(path);
    findings.push(
      finding({
        ruleId: "doc-disposition-duplicate",
        subjectIdentity: collision.join("|"),
        input,
      }),
    );
  }

  const recordSet = new Set(recordPaths);
  for (const path of baselinePaths) {
    if (!recordSet.has(path) && !invalidPaths.has(path)) {
      findings.push(finding({ ruleId: "doc-disposition-missing", subjectIdentity: path, input }));
    }
  }

  const baselineSet = new Set(baselinePaths);
  for (const path of recordSet) {
    if (!baselineSet.has(path) && !invalidPaths.has(path)) {
      findings.push(finding({ ruleId: "doc-disposition-phantom", subjectIdentity: path, input }));
    }
  }

  const deltaResult = replayDocumentDeltas({
    ledgerId: input.ledger.ledgerId,
    baseline: input.baselineSnapshot.members,
    final: input.finalSnapshot.members,
    deltas: input.ledger.deltas,
    decisions: input.ledger.decisions,
    baselineSnapshotDigest: input.baselineSnapshot.snapshotDigest,
    finalSnapshotDigest: input.finalSnapshot.snapshotDigest,
    expectedDeltaChainDigest: input.ledger.deltaChainDigest,
    policyRevision: input.policyRevision,
  });
  for (const deltaFinding of deltaResult.findings) {
    findings.push({ ...deltaFinding, exitCode: 1 });
  }

  findings.sort(
    (left, right) =>
      compareUtf8(left.ruleId, right.ruleId) ||
      compareUtf8(left.subjectIdentity, right.subjectIdentity) ||
      compareUtf8(left.findingId, right.findingId),
  );

  return {
    finalSnapshotDigest: input.finalSnapshot.snapshotDigest,
    deltaChainDigest: deltaResult.deltaChainDigest,
    ...(deltaResult.ok && findings.length === 0
      ? { effective: deltaResult.effective, reductionDigest: deltaResult.reductionDigest }
      : {}),
    findings,
    routeRequirements: [],
    closure: findings.length === 0 ? "closed" : "blocked",
    exitCode: findings.length === 0 ? 0 : 1,
  };
}
