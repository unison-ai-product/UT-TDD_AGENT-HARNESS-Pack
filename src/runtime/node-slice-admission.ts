import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  type GitObjectId,
  gitObjectIdSchema,
  NODE_SLICE_INPUT_REGISTRY,
  receiptDigestSchema,
  type SliceAdmissionReceipt,
  type SliceId,
  type SliceProducer,
  sliceAdmissionPreimage,
  sliceAdmissionReceiptSchema,
  sliceIdSchema,
  sliceProducerSchema,
} from "../schema/node-slice-admission.ts";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const nodeRequire = createRequire(import.meta.url);

export type SliceInputEvidence = {
  digest: string;
  kind: string;
  producer: string;
  subject_revision: string;
  decision: "approved" | "rejected";
};

export interface NodeSliceAdmissionInput {
  readonly repoRoot?: string;
  readonly slice_id?: SliceId;
  readonly sliceId?: SliceId;
  readonly subject_revision?: GitObjectId | string;
  readonly subjectRevision?: GitObjectId | string;
  readonly predecessor_receipt_digest?: string | null;
  readonly predecessorReceiptDigest?: string | null;
  readonly required_input_receipt_digests?: readonly string[];
  readonly requiredInputReceiptDigests?: readonly string[];
  readonly producer: SliceProducer | string;
  readonly history?: readonly SliceAdmissionReceipt[];
  readonly requiredInputs?: readonly SliceInputEvidence[];
  readonly canonicalPredecessorCommits?: readonly string[];
  /** The one command authority allowed to mint the historical backfill. */
  readonly commandAuthority?: string;
}

export interface NodeSliceAdmissionResult {
  readonly ok: boolean;
  readonly receipt: SliceAdmissionReceipt;
  readonly reason?: string;
}

export class NodeSliceAdmissionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "NodeSliceAdmissionError";
    this.code = code;
  }
}

const expectedProducer = (slice: SliceId): SliceProducer =>
  ({
    d0: "d0-design-owner",
    f0a: "f0a-toolchain-owner",
    f0b: "f0b-sealed-build-owner",
    f0c: "f0c-ci-owner",
    q0: "q0-qualification-owner",
  })[slice] as SliceProducer;

const requiredCount = (slice: SliceId): number => ({ d0: 5, f0a: 1, f0b: 1, f0c: 1, q0: 2 })[slice];

function toGitObjectId(value: string | undefined): GitObjectId {
  if (!value) throw new NodeSliceAdmissionError("subject-revision-missing");
  if (gitObjectIdSchema.safeParse(value).success) return value as GitObjectId;
  throw new NodeSliceAdmissionError("subject-revision-invalid");
}

function normalizedDigest(value: string): string {
  if (!receiptDigestSchema.safeParse(value).success) {
    throw new NodeSliceAdmissionError("receipt-digest-invalid");
  }
  return value;
}

interface ReceiptInput {
  readonly slice: SliceId;
  readonly subjectRevision: GitObjectId;
  readonly predecessor: string | null;
  readonly required: readonly string[];
  readonly decision: "approved" | "rejected";
  readonly producer: SliceProducer;
}

function makeReceipt(input: ReceiptInput): SliceAdmissionReceipt {
  const unsigned = {
    schema_version: "node-slice-admission.v1" as const,
    slice_id: input.slice,
    predecessor_receipt_digest: input.predecessor,
    subject_revision: input.subjectRevision,
    required_input_receipt_digests: [...input.required],
    decision: input.decision,
    producer: input.producer,
  };
  return sliceAdmissionReceiptSchema.parse({
    ...unsigned,
    receipt_digest: digest(sliceAdmissionPreimage(unsigned)),
  });
}

interface RejectionInput {
  readonly producer: SliceProducer;
  readonly reason: string;
  readonly predecessor?: string | null;
  readonly required?: readonly string[];
}

function reject(
  slice: SliceId,
  subject: GitObjectId,
  input: RejectionInput,
): NodeSliceAdmissionResult {
  // Rejection receipts must remain schema-valid even when the rejected input
  // contains duplicate or malformed digests. Approved receipts preserve the
  // exact set; only the audit receipt is canonicalized for safe serialization.
  const safeRequired = [
    ...new Set(
      (input.required ?? []).filter((value) => receiptDigestSchema.safeParse(value).success),
    ),
  ];
  return {
    ok: false,
    reason: input.reason,
    receipt: makeReceipt({
      slice,
      subjectRevision: subject,
      predecessor: input.predecessor ?? null,
      required: safeRequired,
      decision: "rejected",
      producer: input.producer,
    }),
  };
}

function git(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new NodeSliceAdmissionError("git-object-unavailable");
  }
}

/**
 * Checks history completeness before ancestor checks. A shallow or filtered
 * repository is never allowed to turn an unknown graph into an approval.
 */
export function assertCompleteGitHistory(repoRoot: string, commits: readonly string[]): void {
  if (!existsSync(resolve(repoRoot, ".git")))
    throw new NodeSliceAdmissionError("history_incomplete");
  if (git(repoRoot, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new NodeSliceAdmissionError("history_incomplete");
  }
  try {
    const shallowPath = git(repoRoot, ["rev-parse", "--git-path", "shallow"]);
    if (existsSync(shallowPath) && readFileSync(shallowPath, "utf8").trim()) {
      throw new NodeSliceAdmissionError("history_incomplete");
    }
  } catch (error) {
    if (error instanceof NodeSliceAdmissionError) throw error;
    // A repository without a shallow file is complete for this check.
  }
  let promisor = "";
  try {
    promisor = git(repoRoot, [
      "config",
      "--get-regexp",
      "^(remote\\..*\\.promisor|extensions\\.partialclonefilter)$",
    ]);
  } catch {
    // `git config --get-regexp` exits 1 when the repository has no matching
    // key; that is the normal complete-history case.
  }
  if (promisor.length > 0) throw new NodeSliceAdmissionError("history_incomplete");
  for (const commit of commits) {
    try {
      execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${commit}^{commit}`], {
        stdio: "ignore",
      });
    } catch {
      throw new NodeSliceAdmissionError("history_incomplete");
    }
  }
}

export function assertAncestorClosure(
  repoRoot: string,
  ancestors: readonly string[],
  candidate: string,
): void {
  assertCompleteGitHistory(repoRoot, [...ancestors, candidate]);
  for (const ancestor of ancestors) {
    try {
      execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, candidate], {
        stdio: "ignore",
      });
    } catch {
      throw new NodeSliceAdmissionError("not_ancestor");
    }
  }
}

function validateTransition(
  input: NodeSliceAdmissionInput,
  slice: SliceId,
  subject: GitObjectId,
): NodeSliceAdmissionResult | null {
  const producer = input.producer;
  if (!sliceProducerSchema.safeParse(producer).success || producer !== expectedProducer(slice)) {
    return reject(slice, subject, { producer: expectedProducer(slice), reason: "wrong-producer" });
  }
  const history = input.history ?? [];
  for (const item of history) {
    try {
      sliceAdmissionReceiptSchema.parse(item);
      if (digest(sliceAdmissionPreimage(item)) !== item.receipt_digest)
        return reject(slice, subject, {
          producer: expectedProducer(slice),
          reason: "history-receipt-invalid",
        });
    } catch {
      return reject(slice, subject, {
        producer: expectedProducer(slice),
        reason: "history-receipt-invalid",
      });
    }
  }
  const approved = history.filter((item) => item.decision === "approved");
  const duplicate = approved.find(
    (item) => item.slice_id === slice && item.subject_revision === subject,
  );
  if (duplicate)
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: "replay",
      predecessor: duplicate.predecessor_receipt_digest,
    });
  const predecessorSlice = NODE_SLICE_INPUT_REGISTRY[slice].predecessor;
  const predecessor = input.predecessor_receipt_digest ?? input.predecessorReceiptDigest ?? null;
  if (predecessorSlice === null) {
    if (predecessor !== null)
      return reject(slice, subject, {
        producer: expectedProducer(slice),
        reason: "unexpected-predecessor",
        predecessor,
      });
  } else {
    const prior = approved.find(
      (item) => item.slice_id === predecessorSlice && item.receipt_digest === predecessor,
    );
    if (!prior) {
      const rejectedPrior = history.find(
        (item) =>
          item.slice_id === predecessorSlice &&
          item.receipt_digest === predecessor &&
          item.decision === "rejected",
      );
      if (rejectedPrior) {
        return reject(slice, subject, {
          producer: expectedProducer(slice),
          reason: "rejected-prerequisite",
          predecessor,
        });
      }
      return reject(slice, subject, {
        producer: expectedProducer(slice),
        reason: "missing-prerequisite",
        predecessor,
      });
    }
    if (slice === "f0c" && prior.subject_revision !== subject) {
      return reject(slice, subject, {
        producer: expectedProducer(slice),
        reason: "predecessor-subject-mismatch",
        predecessor,
      });
    }
    if (prior.subject_revision !== subject && input.repoRoot && input.canonicalPredecessorCommits) {
      assertAncestorClosure(
        input.repoRoot,
        input.canonicalPredecessorCommits,
        subject.slice(subject.indexOf(":") + 1),
      );
    }
  }
  const required = input.required_input_receipt_digests ?? input.requiredInputReceiptDigests ?? [];
  try {
    required.forEach(normalizedDigest);
  } catch (error) {
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: error instanceof Error ? error.message : "invalid-input",
      predecessor,
      required: [],
    });
  }
  if (required.length !== requiredCount(slice)) {
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: "required-input-set-mismatch",
      predecessor,
      required,
    });
  }
  if (new Set(required).size !== required.length) {
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: "required-input-set-mismatch",
      predecessor,
      required,
    });
  }
  const evidence = input.requiredInputs ?? [];
  if (evidence.length !== required.length) {
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: "required-input-evidence-mismatch",
      predecessor,
      required,
    });
  }
  const expectedKinds: readonly string[] = NODE_SLICE_INPUT_REGISTRY[slice].requiredKinds;
  const expectedEvidenceProducer = expectedProducer(slice);
  if (
    evidence.some(
      (item) =>
        !receiptDigestSchema.safeParse(item.digest).success ||
        (slice !== "d0" && expectedKinds.indexOf(item.kind) < 0) ||
        item.producer !== expectedEvidenceProducer ||
        item.subject_revision !== subject ||
        !required.includes(item.digest),
    )
  ) {
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: "required-input-evidence-mismatch",
      predecessor,
      required,
    });
  }
  if (evidence.some((item) => item.decision === "rejected")) {
    return reject(slice, subject, {
      producer: expectedProducer(slice),
      reason: "rejected-prerequisite",
      predecessor,
      required,
    });
  }
  return null;
}

/** Pure admission kernel: no process spawn, receipt write, or ambient state mutation. */
export function admitNodeSlice(input: NodeSliceAdmissionInput): NodeSliceAdmissionResult {
  const slice = input.slice_id ?? input.sliceId;
  if (!slice || !sliceIdSchema.safeParse(slice).success) {
    throw new NodeSliceAdmissionError("slice-invalid");
  }
  const subject = toGitObjectId(input.subject_revision ?? input.subjectRevision);
  const failure = validateTransition(input, slice, subject);
  if (failure) return failure;
  const predecessor = input.predecessor_receipt_digest ?? input.predecessorReceiptDigest ?? null;
  const required = input.required_input_receipt_digests ?? input.requiredInputReceiptDigests ?? [];
  const producer = input.producer as SliceProducer;
  const receipt = makeReceipt({
    slice,
    subjectRevision: subject,
    predecessor,
    required,
    decision: "approved",
    producer,
  });
  return { ok: true, receipt };
}

export function assertNodeSliceAdmitted(input: NodeSliceAdmissionInput): SliceAdmissionReceipt {
  const result = admitNodeSlice(input);
  if (!result.ok) throw new NodeSliceAdmissionError(result.reason ?? "slice-admission-rejected");
  return result.receipt;
}

export const admitSlice = admitNodeSlice;
export const verifyNodeSliceAdmission = admitNodeSlice;

// This is deliberately a closed, historical input set.  It is not another
// trust root and it is never accepted by the normal D0/F0a registry route.
export const LEGACY_D0_SOURCE_HEAD = "8b339ec75dffd72ef4701431305065986e01b2ea";
export const LEGACY_D0_MERGE_COMMIT = "f38974da31eb243f53c7cae392a3108a1db765dd";
export const LEGACY_D0_INTEGRITY_DIGEST =
  "sha256:d883335e37dc6595b5fcd47dd69bbcf8d89969338a109af0c2e5514049b07807";
export const LEGACY_F0A_SOURCE_HEAD = "76d0f9c7219a8290fc809b5036d6d02f9b05fb88";
export const LEGACY_F0A_TREE = "1b63e413ad4f6500cc02e8df36391d0de0571b92";
export const LEGACY_F0A_MERGE_COMMIT = "12aadde9ff56e8b39c0813b988384e2e5eed00ab";
export const LEGACY_F0A_CUSTODY_DIGEST =
  "sha256:96e326f3e5b88aede486da9f363fd03c06a7c1297a55c58ff92706ae8cfd6ff7";

type LegacyD0Record = {
  sequence: number;
  previous_record_digest: string | null;
  record_digest: string;
  command_id: string;
  receipt_id: string;
  receipt_digest: string;
  decision_digest: string;
  binding: {
    path: string;
    plan_id: string;
    asset_id: string;
    revision: number;
    content_digest: string;
  };
};
export type LegacyGitRow = { path: string; blob_oid: string; content_digest: string };
export type LegacyD0AdmissionBackfillReceipt = {
  schema_version: "legacy-d0-admission-backfill.v1";
  row_id: "legacy.d0-admission";
  source_head: string;
  merge_commit: string;
  records: readonly LegacyD0Record[];
  git_rows: readonly LegacyGitRow[];
  integrity_digest: typeof LEGACY_D0_INTEGRITY_DIGEST;
  family_status: "unverified_family";
  review_authority: "none";
  producer: "d0-design-owner";
};
export type LegacyF0aCustodyBackfillReceipt = {
  schema_version: "legacy-f0a-custody-backfill.v1";
  row_id: "legacy.f0a-custody";
  source_head: string;
  tree: string;
  merge_commit: string;
  predecessor_integrity_digest: typeof LEGACY_D0_INTEGRITY_DIGEST;
  git_rows: readonly LegacyGitRow[];
  custody_digest: typeof LEGACY_F0A_CUSTODY_DIGEST;
  family_status: "unverified_family";
  review_authority: "none";
  producer: "f0a-toolchain-owner";
};
export interface LegacyBackfillState {
  readonly d0?: LegacyD0AdmissionBackfillReceipt;
  readonly f0a?: LegacyF0aCustodyBackfillReceipt;
}
export interface LegacyBackfillInput {
  readonly repoRoot: string;
  readonly candidateRevision?: string;
  readonly subjectRevision?: string;
  readonly commandAuthority: string;
  readonly state?: LegacyBackfillState;
}
export interface LegacyBackfillResult {
  readonly state: LegacyBackfillState;
  readonly exactly_once: true;
}

interface DurableStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}
interface DurableDb {
  exec(sql: string): unknown;
  prepare(sql: string): DurableStatement;
  close(): void;
}
function durableBackfillCommit(
  repoRoot: string,
  candidate: string,
  state: LegacyBackfillState,
): void {
  const ledgerPath = resolve(repoRoot, ".ut-tdd", "ledger", "cutover-ledger.db");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => DurableDb;
  };
  const db = new DatabaseSync(ledgerPath);
  const payload = stable({ candidate, state });
  try {
    db.exec(
      "PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS node_legacy_backfill (operation TEXT PRIMARY KEY, candidate TEXT NOT NULL, payload TEXT NOT NULL, payload_digest TEXT NOT NULL);",
    );
    db.exec("BEGIN IMMEDIATE;");
    if (
      db
        .prepare("SELECT operation FROM node_legacy_backfill WHERE operation = ?")
        .get("issue-484-f0b") !== undefined
    ) {
      db.exec("ROLLBACK;");
      throw new NodeSliceAdmissionError("legacy-backfill-replay");
    }
    db.prepare(
      "INSERT INTO node_legacy_backfill(operation, candidate, payload, payload_digest) VALUES (?, ?, ?, ?)",
    ).run("issue-484-f0b", candidate, payload, digest(payload));
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction may already be closed */
    }
    if (error instanceof NodeSliceAdmissionError) throw error;
    throw new NodeSliceAdmissionError("legacy-backfill-atomic-commit-failed");
  } finally {
    db.close();
  }
}

const LEGACY_D0_COMMANDS = [
  "pr154-d0-admission-l4-20260724",
  "pr154-d0-admission-l5-20260724",
  "pr154-d0-admission-l6-20260724",
  "pr154-d0-admission-l7-20260724",
] as const;
const LEGACY_D0_GIT_ROWS: readonly LegacyGitRow[] = [
  {
    path: "docs/plans/PLAN-L4-33-node-control-plane-redesign.md",
    blob_oid: "f4ea2ae1f014d9643ed0ed0795be94283bc4ba0a",
    content_digest: "sha256:84e90801e17de89de530fb717dba50426ad5c9d051e8e65108f7c810cae4c0ea",
  },
  {
    path: "docs/plans/PLAN-L5-26-node-generation-activation.md",
    blob_oid: "fc8f716f6e231fbd76e8e4e65263169993c73ef5",
    content_digest: "sha256:eee16d3545ffbc47e19c71b4c8cd5a2c4ece2024af395e1362ae7756cae12e29",
  },
  {
    path: "docs/plans/PLAN-L6-93-node-bootstrap-contract.md",
    blob_oid: "0f90a9f34094f5a709aef6abdaeb1c250a7bc368",
    content_digest: "sha256:b63c50fa7d2505ad9a6a32473e335fb6503faa7e5651b440a91fda84902fb770",
  },
  {
    path: "docs/plans/PLAN-L7-458-node-self-hosted-bun-ban-foundation.md",
    blob_oid: "9a3ec263f52f4416cec25a1635d47564a8ea9cd1",
    content_digest: "sha256:9e8c9f837c34aaebe7ce129d4ab926a8ed31c21c2db8b035961b9f1088baa1fb",
  },
];
const LEGACY_F0A_GIT_ROWS: readonly LegacyGitRow[] = [
  {
    path: ".node-version",
    blob_oid: "3fe3b1570a5187e1f51cb2467a99647b2ba3ea54",
    content_digest: "sha256:55ce66383dffcaf804e6d3b03993b0d332cb5d7c38e26e9f92fb78ab040dc70c",
  },
  {
    path: "bun.lock",
    blob_oid: "0094ddf84b84ba2dfb1b6523ddc6b4772735d58d",
    content_digest: "sha256:de95274175f588a95f91bb0e9bb7492c0abc5d833b29791926c49ac97a22f04d",
  },
  {
    path: "docs/governance/repository-structure.md",
    blob_oid: "c1942b0b76f734d44c2beba60ca3bcea3f62b031",
    content_digest: "sha256:62453b2b3a5592f23499d032b380fbecd46b140d44d05b8cc2cad6f2ddd67052",
  },
  {
    path: "package-lock.json",
    blob_oid: "779dab80cd3246f4baf0e9a36716c0e6912ce5e0",
    content_digest: "sha256:d3e5b50a79989ad9a237276c3fedd046f2c9ac5f3f51a45482c250d3292d6d27",
  },
  {
    path: "package.json",
    blob_oid: "67effe80d7bead8892edbc9b6707f858696dfb57",
    content_digest: "sha256:2225baafca86dcf942ec2f482a2f15d3dc2ecb2b61cb22bb7ad6287150eea3ea",
  },
  {
    path: "src/lint/toolchain-pin.ts",
    blob_oid: "bb82e637b62167ed656d3c4f429926735aa53a36",
    content_digest: "sha256:be0d7443bfa88696d37dfc4894f5bcfd4c0fea281f88fe97885e294ee8cc8311",
  },
  {
    path: "tests/hook-native-launcher.test.ts",
    blob_oid: "1841c944a0339d3b948650fb17d04a03cf2e3904",
    content_digest: "sha256:6a3a6632049882252e1d04671367ddd3892616a90fd987d76698f8fe4e85f060",
  },
  {
    path: "tests/toolchain-pin.test.ts",
    blob_oid: "67d3c84e5870b2b226d97843a3df3d267390ba0a",
    content_digest: "sha256:4d8b6aade2879d54d9f36574462a4d164d5348b91a3cdddc8db1b92e8a4f3211",
  },
];

function gitBytes(repoRoot: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function verifyLegacyGitRows(
  repoRoot: string,
  commit: string,
  rows: readonly LegacyGitRow[],
): void {
  for (const row of rows) {
    const oid = git(repoRoot, ["rev-parse", `${commit}:${row.path}`]);
    if (oid !== row.blob_oid) throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
    const contentDigest = `sha256:${createHash("sha256")
      .update(gitBytes(repoRoot, ["show", `${commit}:${row.path}`]))
      .digest("hex")}`;
    if (contentDigest !== row.content_digest)
      throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
  }
}
function legacyD0Records(repoRoot: string): LegacyD0Record[] {
  let source: { records?: unknown[] };
  try {
    source = JSON.parse(
      gitBytes(repoRoot, [
        `show`,
        `${LEGACY_D0_MERGE_COMMIT}:docs/governance/plan-admission-receipts.json`,
      ]).toString("utf8"),
    ) as { records?: unknown[] };
  } catch {
    throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
  }
  const found = LEGACY_D0_COMMANDS.map((command) =>
    source.records?.find((record) => (record as { command_id?: string }).command_id === command),
  );
  if (found.some((record) => !record))
    throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
  const records = found.map((record) => {
    const value = record as Record<string, unknown>;
    const keys = [
      "sequence",
      "previous_record_digest",
      "record_digest",
      "command_id",
      "receipt_id",
      "receipt_digest",
      "decision_digest",
      "binding",
    ];
    if (
      Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) => !(key in value))
    )
      throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
    const binding = value.binding as Record<string, unknown>;
    if (
      !binding ||
      Object.keys(binding).length !== 5 ||
      ["path", "plan_id", "asset_id", "revision", "content_digest"].some((key) => !(key in binding))
    )
      throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
    return value as unknown as LegacyD0Record;
  });
  const preimage = stable(records);
  if (`sha256:${digest(preimage)}` !== LEGACY_D0_INTEGRITY_DIGEST)
    throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
  return records;
}

/** Mint both historical receipts only after every fixed Git binding verifies. */
export function backfillLegacySliceAdmissions(input: LegacyBackfillInput): LegacyBackfillResult {
  if (input.commandAuthority !== "#484" && input.commandAuthority !== "issue-484-admission-kernel")
    throw new NodeSliceAdmissionError("wrong-command-authority");
  if (input.state?.d0 || input.state?.f0a)
    throw new NodeSliceAdmissionError("legacy-backfill-replay");
  const candidate = input.candidateRevision ?? input.subjectRevision;
  if (!candidate || !/^[0-9a-f]{40}$/i.test(candidate))
    throw new NodeSliceAdmissionError("subject-revision-invalid");
  assertAncestorClosure(
    input.repoRoot,
    [LEGACY_D0_MERGE_COMMIT, LEGACY_F0A_MERGE_COMMIT],
    candidate.toLowerCase(),
  );
  assertAncestorClosure(input.repoRoot, [LEGACY_D0_SOURCE_HEAD], LEGACY_D0_MERGE_COMMIT);
  assertAncestorClosure(input.repoRoot, [LEGACY_F0A_SOURCE_HEAD], LEGACY_F0A_MERGE_COMMIT);
  assertAncestorClosure(input.repoRoot, [LEGACY_D0_MERGE_COMMIT], LEGACY_F0A_MERGE_COMMIT);
  const d0Records = legacyD0Records(input.repoRoot);
  verifyLegacyGitRows(input.repoRoot, LEGACY_D0_MERGE_COMMIT, LEGACY_D0_GIT_ROWS);
  if (git(input.repoRoot, ["rev-parse", `${LEGACY_F0A_SOURCE_HEAD}^{tree}`]) !== LEGACY_F0A_TREE)
    throw new NodeSliceAdmissionError("legacy_evidence_unavailable");
  verifyLegacyGitRows(input.repoRoot, LEGACY_F0A_SOURCE_HEAD, LEGACY_F0A_GIT_ROWS);
  const d0: LegacyD0AdmissionBackfillReceipt = {
    schema_version: "legacy-d0-admission-backfill.v1",
    row_id: "legacy.d0-admission",
    source_head: LEGACY_D0_SOURCE_HEAD,
    merge_commit: LEGACY_D0_MERGE_COMMIT,
    records: d0Records,
    git_rows: LEGACY_D0_GIT_ROWS,
    integrity_digest: LEGACY_D0_INTEGRITY_DIGEST,
    family_status: "unverified_family",
    review_authority: "none",
    producer: "d0-design-owner",
  };
  const f0a: LegacyF0aCustodyBackfillReceipt = {
    schema_version: "legacy-f0a-custody-backfill.v1",
    row_id: "legacy.f0a-custody",
    source_head: LEGACY_F0A_SOURCE_HEAD,
    tree: LEGACY_F0A_TREE,
    merge_commit: LEGACY_F0A_MERGE_COMMIT,
    predecessor_integrity_digest: LEGACY_D0_INTEGRITY_DIGEST,
    git_rows: LEGACY_F0A_GIT_ROWS,
    custody_digest: LEGACY_F0A_CUSTODY_DIGEST,
    family_status: "unverified_family",
    review_authority: "none",
    producer: "f0a-toolchain-owner",
  };
  const state = Object.freeze({ d0: Object.freeze(d0), f0a: Object.freeze(f0a) });
  durableBackfillCommit(input.repoRoot, candidate.toLowerCase(), state);
  return { state, exactly_once: true };
}

export const mintLegacyD0AndF0aBackfill = backfillLegacySliceAdmissions;
