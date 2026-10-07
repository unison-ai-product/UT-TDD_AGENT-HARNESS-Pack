import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";
import { bindPlanSourceToAdmission } from "../src/plan-admission/plan-content-binding.ts";
import type { PlanDraftCommand } from "../src/plan-admission/plan-draft-service.ts";
import {
  canonicalPlanPayload,
  deriveTrackedReceiptId,
  sha,
  stableJson,
} from "../src/plan-admission/plan-revision-command-assembler.ts";
import type { PlanAdmissionRequest } from "../src/plan-admission/policy.ts";
import {
  type CommitObj,
  LEGACY_BOOTSTRAP_UNSUPPORTED,
  RECEIPT_PATH,
  RECHAIN_ACTOR,
  type RechainInput,
  type TreeMap,
  verifierDigestOf,
  verifyRechainDelta,
} from "../src/plan-admission/rechain-verifier.ts";
import {
  parseTrackedReceiptProjection,
  TRACKED_RECEIPT_SCHEMA,
  type TrackedReceiptRecord,
  trackedReceiptRecordDigest,
} from "../src/plan-admission/tracked-receipt-projection.ts";
import {
  type TrackedReceiptDraftPayload,
  type TrackedReceiptDraftReceipt,
  type TrackedReceiptProjectionReader,
  TrackedReceiptRenderer,
} from "../src/plan-admission/tracked-receipt-renderer.ts";
import { parseLegacyPlanSource } from "../src/plan-asset/adapters/legacy-plan-inventory.ts";
import { derivePlanRevisionDigests } from "../src/plan-asset/ledger/plan-revision-ledger.ts";

// ---------------------------------------------------------------------------
// fixture helpers (すべて in-memory。実 repository / process.cwd() は読まない)
// ---------------------------------------------------------------------------

const PLAN_ID = "PLAN-L6-999-rechain-test";
const PLAN_PATH = `docs/plans/${PLAN_ID}.md`;
const ASSET_ID = "plan:test:rechain999";
const OTHER_PLAN_ID = "PLAN-L6-888-other";
const OTHER_PLAN_PATH = `docs/plans/${OTHER_PLAN_ID}.md`;
const UNTOUCHED_PATH = "src/example/untouched.ts";

function baseFrontmatterOther(): Record<string, unknown> {
  return {
    plan_id: PLAN_ID,
    title: "rechain test",
    kind: "add-design",
    layer: "L6",
    drive: "agent",
    route_signal: "feature_addition",
    route_mode: "add-feature",
    status: "draft",
    sub_doc: "function-spec",
    // frontmatterSchema (§1.8 / §1.9 / §1.10 E) の必須項目。TrackedReceiptRenderer.render() の
    // selfVerify() は frontmatterSchema.safeParse を通すため、fixture もこれを満たす必要がある。
    agent_slots: [{ role: "tl", slot_label: "TL - rechain verifier fixture" }],
    dependencies: { parent: "docs/plans/PLAN-RECOVERY-16-plan-revision-authoring.md" },
  };
}

function bodyFor(items: readonly string[]): string {
  const list = items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return `# rechain test\n\n本文固定テキスト。\n\n## 8. 記録\n${list}\n`;
}

function admissionFor(
  revision: number,
  overrides?: Partial<PlanAdmissionRequest>,
): PlanAdmissionRequest {
  return {
    routeSignal: "feature_addition",
    routeMode: "add-feature",
    kind: "add-design",
    layer: "L6",
    drive: "agent",
    branch: "work/add-feature-issue999-s2-rechain-verifier",
    status: "draft",
    subDoc: "function-spec",
    issue: {
      provider: "github",
      issueId: 999,
      episodeId: "E4-999-rechain",
      projectionState: "unprojected",
    },
    origin: {
      planId: "PLAN-RECOVERY-16-plan-revision-authoring",
      revision: 7,
      digest: `sha256:${"a".repeat(64)}`,
    },
    reentry: { targetPlanId: PLAN_ID, targetRevision: revision, phase: "forward_merge" },
    escapeReason: "S2 実装のための再検証",
    ...overrides,
  };
}

interface RevisionInput {
  frontmatterOther: Record<string, unknown>;
  generates: readonly unknown[];
  items: readonly string[];
  admission: PlanAdmissionRequest;
  binding: { path: string; planId: string; assetId: string; revision: number };
  commandId: string;
  admittedAt: string;
  /** この PLAN 資産の直前までの確定 record 列 (このチェーンで初めての場合は省略 = []). */
  priorRecords?: readonly TrackedReceiptRecord[];
  /** ledger の basePayloadDigest (直前 revision の canonical payload digest)。 */
  basePayloadDigest: string;
  /** ledger input の baseRevision。省略時は binding.revision - 1 (正規の append)。 */
  baseRevision?: number;
  /** 省略時は re-chain の契約定数 (R 側 record)。H / prior record は別値を渡す。 */
  actor?: string;
  /** 省略時は M (R 側 record の契約値)。 */
  sourceCommit?: string;
}

const GENESIS_PAYLOAD_DIGEST = sha("genesis");
const AUTHOR_ACTOR = "ut-tdd-author";
const R_ADMITTED_AT = "2026-09-28T01:00:00.000Z";
const H_ADMITTED_AT = "2026-09-28T00:00:00.000Z";

/** plan-ledger-rehydrator と同じ規則: receipt を除いた frontmatter の canonical payload digest。 */
function payloadDigestOf(content: string): string {
  const parsed = parseLegacyPlanSource(content);
  if (!parsed) throw new Error("fixture-plan-unparseable");
  const { admission_receipt: _receipt, ...receiptFree } = parsed.frontmatter;
  return sha(stableJson(receiptFree));
}

/** production の derivePlanRevisionDigests で certificateDigest を組む (fixture は値を捏造しない)。 */
function certificateDigestFor(params: RevisionInput, preSource: string): string {
  const bound = bindPlanSourceToAdmission({
    source: preSource,
    planId: params.binding.planId,
    admission: params.admission,
  });
  const current = canonicalPlanPayload(bound.source);
  return derivePlanRevisionDigests({
    commandId: params.commandId,
    assetId: params.binding.assetId,
    planId: params.binding.planId,
    baseRevision: params.baseRevision ?? params.binding.revision - 1,
    basePayloadDigest: params.basePayloadDigest,
    canonicalPayloadJson: current.payload,
    contentDigest: bound.contentDigest.replace(/^sha256:/, ""),
    bodyDigest: sha(current.body),
    sourcePath: params.binding.path,
    sourceCommit: params.sourceCommit ?? COMMITS.M,
    actor: params.actor ?? RECHAIN_ACTOR,
    reason: params.admission.escapeReason ?? `route:${params.admission.routeSignal}`,
    routeTupleDigest: sha(stableJson(params.admission)),
    certificateId: deriveTrackedReceiptId(params.commandId),
    occurredAt: params.admittedAt,
  }).certificateDigest;
}

/**
 * PLAN-L6-711 §2.3-6 condition 6 / Codex Sol r1 FLAG (PR #724 finding 2): admission_receipt の
 * frontmatter/projection 構造を fixture 側で手組みせず、production の
 * `TrackedReceiptRenderer.render()` (tracked-receipt-renderer.ts) をそのまま呼んで生成する。
 * renderer/verifier の shape drift が green のまま埋もれることを防ぐ。
 */
function makeRevision(params: RevisionInput): { content: string; record: TrackedReceiptRecord } {
  const fm = { ...params.frontmatterOther, generates: params.generates };
  const body = bodyFor(params.items);
  const preSource = `---\n${stringify(fm)}---\n${body}`;
  const priorRecords = params.priorRecords ?? [];
  const reader: TrackedReceiptProjectionReader = { read: () => receiptFile(priorRecords) };
  const renderer = new TrackedReceiptRenderer(reader);
  const receipt: TrackedReceiptDraftReceipt = {
    assetId: params.binding.assetId,
    revision: params.binding.revision,
    certificateId: deriveTrackedReceiptId(params.commandId),
    commandPayloadDigest: `sha256:${sha(`${params.commandId}-command-payload`)}`,
    // renderer は certificateDigest を計算しない。ledger の derivePlanRevisionDigests で導く。
    certificateDigest: certificateDigestFor(params, preSource),
  };
  const command: PlanDraftCommand<TrackedReceiptDraftPayload> = {
    commandId: params.commandId,
    commandPayloadDigest: receipt.commandPayloadDigest,
    planId: params.binding.planId,
    recordedAt: params.admittedAt,
    payload: { admission: params.admission },
    source: { path: params.binding.path, content: preSource },
    projectionPath: RECEIPT_PATH,
  };
  const [source, projection] = renderer.render(command, receipt);
  const parsedProjection = parseTrackedReceiptProjection(projection.content);
  if (!parsedProjection.ok)
    throw new Error(`fixture-projection-invalid:${parsedProjection.errors.join(",")}`);
  const record = parsedProjection.value.records.at(-1);
  if (!record) throw new Error("fixture-projection-empty");
  return { content: source.content, record };
}

function toJsonRecord(record: TrackedReceiptRecord): Record<string, unknown> {
  return {
    sequence: record.sequence,
    previous_record_digest: record.previousRecordDigest,
    record_digest: record.recordDigest,
    command_id: record.commandId,
    receipt_id: record.receiptId,
    receipt_digest: record.receiptDigest,
    decision_digest: record.decisionDigest,
    binding: {
      path: record.binding.path,
      plan_id: record.binding.planId,
      asset_id: record.binding.assetId,
      revision: record.binding.revision,
      content_digest: record.binding.contentDigest,
    },
  };
}

function receiptFile(records: readonly TrackedReceiptRecord[]): string {
  return `${JSON.stringify(
    { schema_version: TRACKED_RECEIPT_SCHEMA, records: records.map(toJsonRecord) },
    null,
    2,
  )}\n`;
}

/** content-addressed な fake blob store。同内容は同 oid。 */
function makeBlobStore() {
  const blobs: Record<string, string> = {};
  const put = (content: string): string => {
    const oid = sha(content).slice(0, 40);
    blobs[oid] = content;
    return oid;
  };
  return { blobs, put };
}

const COMMITS = {
  base: "commit-base-0000000000000000000000",
  H: "commit-H-0000000000000000000000000",
  X: "commit-X-0000000000000000000000000",
  R: "commit-R-0000000000000000000000000",
  M: "commit-M-0000000000000000000000000",
};

function commitObjs(): { H: CommitObj; X: CommitObj; R: CommitObj } {
  return {
    H: { oid: COMMITS.H, parents: [COMMITS.base], tree: "tree-H" },
    X: { oid: COMMITS.X, parents: [COMMITS.H, COMMITS.M], tree: "tree-X" },
    R: { oid: COMMITS.R, parents: [COMMITS.X], tree: "tree-R" },
  };
}

interface Baseline {
  input: RechainInput;
  assetId: string;
  hRecord: TrackedReceiptRecord;
  rRecord: TrackedReceiptRecord;
  /** base / M が既に持つ、同 asset の直前 record (revision 1)。 */
  priorRecord: TrackedReceiptRecord;
  baseContent: string;
  admissionH: PlanAdmissionRequest;
  blobs: Record<string, string>;
}

const BASE_GENERATES = [{ artifact_path: PLAN_PATH, artifact_type: "markdown_doc" }];
const BASE_ITEMS = ["起票 (rev 1)。"];

/** base / M の PLAN と、その revision 1 record (receipt revision 5 以降、M に同 asset の record が必要)。 */
function makePrior(assetId: string): { content: string; record: TrackedReceiptRecord } {
  return makeRevision({
    frontmatterOther: baseFrontmatterOther(),
    generates: BASE_GENERATES,
    items: BASE_ITEMS,
    admission: admissionFor(1),
    binding: { path: PLAN_PATH, planId: PLAN_ID, assetId, revision: 1 },
    commandId: "plan-revise:issue-998:prior:plan:r1",
    admittedAt: "2026-09-27T00:00:00.000Z",
    basePayloadDigest: GENESIS_PAYLOAD_DIGEST,
    actor: AUTHOR_ACTOR,
    sourceCommit: COMMITS.base,
  });
}

/** R 側 record の既定引数 (binding revision 2、command_id は H の ":rechain-1"、prior = [P])。 */
function rParams(b: Baseline, over: Partial<RevisionInput> = {}): RevisionInput {
  const generates = [
    ...BASE_GENERATES,
    { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
  ];
  return {
    frontmatterOther: baseFrontmatterOther(),
    generates,
    items: [...BASE_ITEMS, "rev 2 (S2): 検証器を実装した。"],
    admission: b.admissionH,
    binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: b.assetId, revision: 2 },
    commandId: `${b.hRecord.commandId}:rechain-1`,
    admittedAt: R_ADMITTED_AT,
    priorRecords: [b.priorRecord],
    basePayloadDigest: payloadDigestOf(b.baseContent),
    ...over,
  };
}

/** R の PLAN と receipt (prior の後ろに records を連結) を差し替える。 */
function installR(
  tampered: Mutable<RechainInput>,
  content: string,
  records: readonly TrackedReceiptRecord[],
): void {
  const oid = sha(content).slice(0, 40);
  tampered.blobs[oid] = content;
  tampered.trees.R[PLAN_PATH] = oid;
  const receipt = receiptFile(records);
  const receiptOid = sha(receipt).slice(0, 40);
  tampered.blobs[receiptOid] = receipt;
  tampered.trees.R[RECEIPT_PATH] = receiptOid;
}

/** Set A: 同一 PLAN に対する main 側の同時改訂は無い、単純な正系 fixture。M は同 asset の
 * revision 1 record P を持ち、H / R はその上の revision 2 を append する。
 * `extraGenerates` は U-RECHAIN-001 が要求する「generates 追加 2 件」を満たすための追加分。 */
function buildBaseline(
  overrides: {
    extraGenerates?: readonly { artifact_path: string; artifact_type: string }[];
    assetId?: string;
  } = {},
): Baseline {
  const { blobs, put } = makeBlobStore();
  const assetId = overrides.assetId ?? ASSET_ID;
  const prior = makePrior(assetId);

  const untouchedV1 = "export const value = 1;\n";
  const untouchedV2 = "export const value = 2; // main が更新\n";

  const admissionH = admissionFor(2);
  const hGenerates = [
    ...BASE_GENERATES,
    { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
    ...(overrides.extraGenerates ?? []),
  ];
  const hItems = [...BASE_ITEMS, "rev 2 (S2): 検証器を実装した。"];
  const { content: hContent, record: hRecord } = makeRevision({
    frontmatterOther: baseFrontmatterOther(),
    generates: hGenerates,
    items: hItems,
    admission: admissionH,
    binding: { path: PLAN_PATH, planId: PLAN_ID, assetId, revision: 2 },
    commandId: "plan-revise:issue-999:s2:plan:r1:h1",
    admittedAt: H_ADMITTED_AT,
    priorRecords: [prior.record],
    basePayloadDigest: payloadDigestOf(prior.content),
    actor: AUTHOR_ACTOR,
    sourceCommit: COMMITS.base,
  });

  const stub: Baseline = {
    input: undefined as unknown as RechainInput,
    assetId,
    hRecord,
    rRecord: undefined as unknown as TrackedReceiptRecord,
    priorRecord: prior.record,
    baseContent: prior.content,
    admissionH,
    blobs,
  };
  const { content: rContent, record: rRecord } = makeRevision(
    rParams(stub, { generates: hGenerates, items: hItems }),
  );

  const baseTree: TreeMap = {
    [PLAN_PATH]: put(prior.content),
    [RECEIPT_PATH]: put(receiptFile([prior.record])),
    [UNTOUCHED_PATH]: put(untouchedV1),
  };
  const hTree: TreeMap = {
    [PLAN_PATH]: put(hContent),
    [RECEIPT_PATH]: put(receiptFile([prior.record, hRecord])),
    [UNTOUCHED_PATH]: baseTree[UNTOUCHED_PATH],
  };
  const mTree: TreeMap = {
    [PLAN_PATH]: baseTree[PLAN_PATH],
    [RECEIPT_PATH]: baseTree[RECEIPT_PATH],
    [UNTOUCHED_PATH]: put(untouchedV2),
  };
  const xTree: TreeMap = { ...mTree };
  const rTree: TreeMap = {
    [PLAN_PATH]: put(rContent),
    [RECEIPT_PATH]: put(receiptFile([prior.record, rRecord])),
    [UNTOUCHED_PATH]: xTree[UNTOUCHED_PATH],
  };

  const input: RechainInput = {
    commits: { ...commitObjs(), M: COMMITS.M, base: COMMITS.base },
    trees: { base: baseTree, H: hTree, M: mTree, X: xTree, R: rTree },
    blobs,
    admission: { [hRecord.recordDigest]: admissionH },
    intermediatePlans: {},
  };

  return { ...stub, input, rRecord };
}

// テストでは tree/blob/admission を局所的に上書きするため、readonly を外した深いコピーを返す。
type Mutable<T> = T extends PlanAdmissionRequest ? T : { -readonly [K in keyof T]: Mutable<T[K]> };
function clone(input: RechainInput): Mutable<RechainInput> {
  return JSON.parse(JSON.stringify(input)) as Mutable<RechainInput>;
}

// ---------------------------------------------------------------------------
// U-RECHAIN-012c: PlanAdmissionRequest の各 field を個別に改変する table-driven oracle
// (§2.3-6 condition 6 / CANDIDATE-U-RECHAIN-012 の全 field 展開)。
// ---------------------------------------------------------------------------

/** JSON round-trip での深い draft コピーに dot-path で値を書き込む (union literal 型を迂回する)。 */
function setDraftPath(draft: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor: Record<string, unknown> = draft;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const next = cursor[key];
    const nextObject: Record<string, unknown> =
      next && typeof next === "object" ? { ...(next as Record<string, unknown>) } : {};
    cursor[key] = nextObject;
    cursor = nextObject;
  }
  cursor[segments[segments.length - 1]] = value;
}

function mutateAdmissionField(
  admission: PlanAdmissionRequest,
  path: string,
  value: unknown,
): PlanAdmissionRequest {
  const draft = JSON.parse(JSON.stringify(admission)) as Record<string, unknown>;
  setDraftPath(draft, path, value);
  return draft as unknown as PlanAdmissionRequest;
}

/** PLAN-L6-711 §2.3-6 condition 6 / U-RECHAIN-012 が列挙する全 field。reentry.targetRevision は
 * 唯一の許容差分なので対象外。 */
const ADMISSION_FIELD_MUTATIONS: readonly { field: string; path: string; value: unknown }[] = [
  { field: "routeMode", path: "routeMode", value: "reverse" },
  { field: "kind", path: "kind", value: "reverse" },
  { field: "layer", path: "layer", value: "cross" },
  { field: "workflowPhase", path: "workflowPhase", value: "R1" },
  { field: "routeSignal", path: "routeSignal", value: "regression" },
  { field: "drive", path: "drive", value: "human" },
  { field: "branch", path: "branch", value: "work/mutated-branch-for-test" },
  { field: "status", path: "status", value: "confirmed" },
  { field: "subDoc", path: "subDoc", value: "test-design" },
  {
    field: "issue",
    path: "issue",
    value: {
      provider: "github",
      issueId: 12345,
      episodeId: "E4-999-mutated",
      projectionState: "unprojected",
    },
  },
  {
    field: "origin",
    path: "origin",
    value: {
      planId: "PLAN-L6-777-mutated",
      revision: 99,
      digest: `sha256:${"f".repeat(64)}`,
    },
  },
  { field: "transitionDirection", path: "transitionDirection", value: "implementation_to_design" },
  { field: "implementationDisposition", path: "implementationDisposition", value: "preserved" },
  { field: "reentry.targetPlanId", path: "reentry.targetPlanId", value: OTHER_PLAN_ID },
  { field: "reentry.phase", path: "reentry.phase", value: "not-forward-merge" },
  {
    field: "implementationTarget",
    path: "implementationTarget",
    value: { targetPlanId: OTHER_PLAN_ID, targetRevision: 1 },
  },
  { field: "escapeReason", path: "escapeReason", value: "改変された理由 (table-driven)" },
  { field: "supersedes", path: "supersedes", value: ["PLAN-L6-777-old"] },
];

/**
 * H の tracked receipt を保ったまま、R の receipt record の一部 field だけを書き換え、
 * `record_digest` と frontmatter `admission_receipt` (command_id/receipt_id/receipt_digest) を
 * 自己整合に揃え直す。攻撃者が record 内部の digest chain だけを再計算して verifier を
 * 通そうとするケースを再現する (U-RECHAIN-012d〜f)。
 */
function forgeRReceiptRecord(
  input: RechainInput,
  mutate: (record: Record<string, unknown>) => void,
): Mutable<RechainInput> {
  const tampered = clone(input);
  const rPlanOid = tampered.trees.R[PLAN_PATH];
  const rReceiptOid = tampered.trees.R[RECEIPT_PATH];
  const planContent = tampered.blobs[rPlanOid];
  const receiptParsed = JSON.parse(tampered.blobs[rReceiptOid]) as {
    schema_version: string;
    records: Record<string, unknown>[];
  };
  const recordJson = receiptParsed.records[receiptParsed.records.length - 1];
  mutate(recordJson);
  recordJson.record_digest = trackedReceiptRecordDigestFromJson(recordJson);
  const newReceiptContent = `${JSON.stringify(receiptParsed, null, 2)}\n`;
  const newReceiptOid = sha(newReceiptContent).slice(0, 40);
  tampered.blobs[newReceiptOid] = newReceiptContent;
  tampered.trees.R[RECEIPT_PATH] = newReceiptOid;

  // frontmatter の admission_receipt も同じ値へ揃え、自己整合な偽造にする (record 内 digest を
  // 信用しない検証だけを単独で確かめるため。plan-admission-receipt-binding-mismatch を道連れに
  // しない)。
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(planContent);
  if (!match) throw new Error("fixture-plan-content-unparseable");
  const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
  frontmatter.admission_receipt = {
    ...(frontmatter.admission_receipt as Record<string, unknown>),
    command_id: recordJson.command_id,
    receipt_id: recordJson.receipt_id,
    receipt_digest: recordJson.receipt_digest,
  };
  const newPlanContent = `---\n${stringify(frontmatter)}---\n${match[2]}`;
  const newPlanOid = sha(newPlanContent).slice(0, 40);
  tampered.blobs[newPlanOid] = newPlanContent;
  tampered.trees.R[PLAN_PATH] = newPlanOid;
  return tampered;
}

// ---------------------------------------------------------------------------
// U-RECHAIN-001: 簿記のみの re-chain は pass する
// ---------------------------------------------------------------------------

describe("verifyRechainDelta", () => {
  it("U-RECHAIN-001: 簿記のみの re-chain (receipt 1件・generates追加2件・§8注記1行) は pass する", () => {
    const { input } = buildBaseline({
      extraGenerates: [
        { artifact_path: "tests/rechain-verifier.test.ts", artifact_type: "test_code" },
      ],
    });
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.verifierDigest.startsWith("sha256:")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-002: PLAN / receipt 以外の path に R が 1 byte 追加 → fail
  // -------------------------------------------------------------------------
  it("U-RECHAIN-002: R が非簿記 path に 1 byte 追加すると fail する", () => {
    const { input, blobs } = buildBaseline();
    const tampered = clone(input);
    const tamperedContent = "export const value = 2; // main が更新\n// 手で追記\n";
    const oid = sha(tamperedContent).slice(0, 40);
    tampered.blobs = { ...blobs, [oid]: tamperedContent };
    tampered.trees = {
      ...tampered.trees,
      R: { ...tampered.trees.R, [UNTOUCHED_PATH]: oid },
    };
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("nonbookkeeping-r-mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-003: PLAN 本文の append-only 領域外に手で変更 → fail
  // -------------------------------------------------------------------------
  it("U-RECHAIN-003: append-only 領域外を手で書き換えた R は fail する", () => {
    const b = buildBaseline();
    const { content: tamperedContent, record: tamperedRecord } = makeRevision(
      rParams(b, {
        frontmatterOther: { ...baseFrontmatterOther(), title: "rechain test (手で改変)" },
      }),
    );
    const tampered = clone(b.input);
    installR(tampered, tamperedContent, [b.priorRecord, tamperedRecord]);

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(
        verdict.reasons.some(
          (r) => r.startsWith("plan-frontmatter-conflict") || r.startsWith("plan-strip-mismatch"),
        ),
      ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-004: 追加 record の数・対象が H と異なる → fail
  // -------------------------------------------------------------------------
  it("U-RECHAIN-004a: admission map の件数が H の追加 record 数と異なると fail する", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    tampered.admission = {};
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toContain("admission-count-mismatch");
  });

  it("U-RECHAIN-004b: R の追加 record が別 PLAN を bind すると fail する", () => {
    const b = buildBaseline();
    const { record: wrongPlanRecord } = makeRevision(
      rParams(b, {
        frontmatterOther: { ...baseFrontmatterOther(), plan_id: OTHER_PLAN_ID },
        binding: {
          path: OTHER_PLAN_PATH,
          planId: OTHER_PLAN_ID,
          assetId: "plan:test:other888",
          revision: 1,
        },
        basePayloadDigest: GENESIS_PAYLOAD_DIGEST,
      }),
    );
    const tampered = clone(b.input);
    const receipt = receiptFile([b.priorRecord, wrongPlanRecord]);
    const oid = sha(receipt).slice(0, 40);
    tampered.blobs[oid] = receipt;
    tampered.trees.R[RECEIPT_PATH] = oid;

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("receipt-append-binding-mismatch"))).toBe(
        true,
      );
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-005: content_digest 不一致 / chain 不連続 → fail
  // -------------------------------------------------------------------------
  it("U-RECHAIN-005a: record の content_digest が R の PLAN と不一致なら fail する", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    const rReceiptOid = tampered.trees.R[RECEIPT_PATH];
    const parsed = JSON.parse(tampered.blobs[rReceiptOid]);
    parsed.records.at(-1).binding.content_digest = `sha256:${"0".repeat(64)}`;
    // record_digest はもう再計算できない (private) ので、record_digest も無効値へ揃えて
    // "parse失敗" ではなく "digestが一致しない" 経路を通す代わりに、record自体を破棄せず
    // digest再計算関数を使って作り直す。
    const rebuilt = trackedReceiptRecordDigestFromJson(parsed.records.at(-1));
    parsed.records.at(-1).record_digest = rebuilt;
    const newContent = `${JSON.stringify(parsed, null, 2)}\n`;
    const newOid = sha(newContent).slice(0, 40);
    tampered.blobs[newOid] = newContent;
    tampered.trees.R[RECEIPT_PATH] = newOid;

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(
        verdict.reasons.some(
          (r) =>
            r.startsWith("plan-content-digest-mismatch") ||
            r.startsWith("plan-admission-receipt-binding"),
        ),
      ).toBe(true);
  });

  it("U-RECHAIN-005b: R の receipt chain が M の tail と不連続なら fail する", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    const rReceiptOid = tampered.trees.R[RECEIPT_PATH];
    const parsed = JSON.parse(tampered.blobs[rReceiptOid]);
    parsed.records.at(-1).previous_record_digest = `sha256:${"9".repeat(64)}`;
    const newContent = `${JSON.stringify(parsed, null, 2)}\n`;
    const newOid = sha(newContent).slice(0, 40);
    tampered.blobs[newOid] = newContent;
    tampered.trees.R[RECEIPT_PATH] = newOid;

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-006: commit 構造 (親の直接束縛)
  // -------------------------------------------------------------------------
  it("U-RECHAIN-006a: R の親が X でないと fail する (余分な commit を挟む)", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    tampered.commits.R = { ...tampered.commits.R, parents: ["commit-extra-0000000000000000"] };
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toContain("commit-structure-r-parent");
  });

  it("U-RECHAIN-006b: X の親の順序が逆だと fail する", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    tampered.commits.X = { ...tampered.commits.X, parents: [COMMITS.M, COMMITS.H] };
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toContain("commit-structure-x-parents");
  });

  it("U-RECHAIN-006c: (正系) commits.M が H 分岐後の 2+ commit (merge commit を含む履歴) を指していても、oid/親構造の束縛だけで pass する (件数ベースではない)", () => {
    // RechainInput は commits.M を不透明な oid としてしか運ばない (§2.6-1)。M が実際に
    // 何本の commit (merge commit を含む) を経て origin/main へ積まれていても、検証器の
    // §2.3-4 (rev 5) 判定は X.parents[1] === M / R.parents === [X] という親 oid の束縛だけで
    // 決まり、`H..R` の commit 数 (--first-parent なし) では判定しない (m1 の反証: 件数判定
    // だったら M の内部 commit 数で結果が変わってしまう)。buildBaseline() の commits.M は
    // その「不透明な多 commit 履歴を指す 1 個の oid」の代表例であり、これがそのまま pass
    // することが本 oracle の正系である。
    const { input } = buildBaseline();
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-007: main と PR の双方が append-only 領域へ追記 → 決定的に連結
  // -------------------------------------------------------------------------
  it("U-RECHAIN-007: main と PR の双方が generates/§8 に追記した場合、連結されて pass する", () => {
    const { blobs, put } = makeBlobStore();
    const baseFm = baseFrontmatterOther();
    const prior = makePrior(ASSET_ID);

    // main 側で既に別 PR が revision 2 として同じ PLAN を改訂済み
    const concurrentGenerates = [
      ...BASE_GENERATES,
      { artifact_path: "docs/plans/PLAN-L6-999-concurrent-note.md", artifact_type: "markdown_doc" },
    ];
    const concurrentItems = [...BASE_ITEMS, "rev 2 (concurrent): 別 PR が先に merge した。"];
    const { content: mContent, record: mRecord } = makeRevision({
      frontmatterOther: baseFm,
      generates: concurrentGenerates,
      items: concurrentItems,
      admission: admissionFor(2),
      binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: ASSET_ID, revision: 2 },
      commandId: "plan-revise:issue-777:concurrent:plan:r1:c1",
      admittedAt: "2026-09-28T00:30:00.000Z",
      priorRecords: [prior.record],
      basePayloadDigest: payloadDigestOf(prior.content),
      actor: AUTHOR_ACTOR,
      sourceCommit: COMMITS.base,
    });

    // PR 側 (H) は base から自分の追加だけを append する
    const admissionH = admissionFor(2);
    const hGenerates = [
      ...BASE_GENERATES,
      { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
    ];
    const hItems = [...BASE_ITEMS, "rev 2 (S2): 検証器を実装した。"];
    const { content: hContent, record: hRecord } = makeRevision({
      frontmatterOther: baseFm,
      generates: hGenerates,
      items: hItems,
      admission: admissionH,
      binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: ASSET_ID, revision: 2 },
      commandId: "plan-revise:issue-999:s2:plan:r1:h1",
      admittedAt: H_ADMITTED_AT,
      priorRecords: [prior.record],
      basePayloadDigest: payloadDigestOf(prior.content),
      actor: AUTHOR_ACTOR,
      sourceCommit: COMMITS.base,
    });

    // R は M (= concurrent 済み) の後ろへ PR の追加分だけを revision 3 として連結する
    const expectedGenerates = [...concurrentGenerates, hGenerates[hGenerates.length - 1]];
    const expectedItems = [...concurrentItems, hItems[hItems.length - 1]];
    if (!admissionH.reentry) throw new Error("fixture-admission-missing-reentry");
    const admissionR = { ...admissionH, reentry: { ...admissionH.reentry, targetRevision: 3 } };
    const rBase = {
      frontmatterOther: baseFm,
      admission: admissionR,
      binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: ASSET_ID, revision: 3 },
      commandId: "plan-revise:issue-999:s2:plan:r1:h1:rechain-1",
      admittedAt: R_ADMITTED_AT,
      priorRecords: [prior.record, mRecord],
      basePayloadDigest: payloadDigestOf(mContent),
    };
    const { content: rContent, record: rRecord } = makeRevision({
      ...rBase,
      generates: expectedGenerates,
      items: expectedItems,
    });

    const baseTree: TreeMap = {
      [PLAN_PATH]: put(prior.content),
      [RECEIPT_PATH]: put(receiptFile([prior.record])),
    };
    const hTree: TreeMap = {
      [PLAN_PATH]: put(hContent),
      [RECEIPT_PATH]: put(receiptFile([prior.record, hRecord])),
    };
    const mTree: TreeMap = {
      [PLAN_PATH]: put(mContent),
      [RECEIPT_PATH]: put(receiptFile([prior.record, mRecord])),
    };
    const xTree: TreeMap = { [PLAN_PATH]: mTree[PLAN_PATH], [RECEIPT_PATH]: mTree[RECEIPT_PATH] };
    const rTree: TreeMap = {
      [PLAN_PATH]: put(rContent),
      [RECEIPT_PATH]: put(receiptFile([prior.record, mRecord, rRecord])),
    };

    const input: RechainInput = {
      commits: { ...commitObjs(), M: COMMITS.M, base: COMMITS.base },
      trees: { base: baseTree, H: hTree, M: mTree, X: xTree, R: rTree },
      blobs,
      admission: { [hRecord.recordDigest]: admissionH },
      intermediatePlans: {},
    };

    const verdict = verifyRechainDelta(input);
    expect(verdict.ok).toBe(true);

    // mutation: 連結順を逆にする (PR の追加を先頭へ) → byte 不一致で fail する
    const { content: reversedContent, record: reversedRecord } = makeRevision({
      ...rBase,
      generates: [hGenerates[hGenerates.length - 1], ...concurrentGenerates],
      items: [hItems[hItems.length - 1], ...concurrentItems],
    });
    const badInput = clone(input);
    installR(badInput, reversedContent, [prior.record, mRecord, reversedRecord]);

    const badVerdict = verifyRechainDelta(badInput);
    expect(badVerdict.ok).toBe(false);
    if (!badVerdict.ok)
      expect(badVerdict.reasons.some((r) => r.startsWith("plan-strip-mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-011: 成果物所有 (待機中に main が再所有した path)
  // -------------------------------------------------------------------------
  it("U-RECHAIN-011a: PR が追加した artifact_path が M の tree に既存なら fail する", () => {
    const { input, blobs } = buildBaseline();
    const tampered = clone(input);
    const conflictingContent = "// 既に main 側で作成された\n";
    const oid = sha(conflictingContent).slice(0, 40);
    tampered.blobs = { ...blobs, [oid]: conflictingContent };
    tampered.trees.M = { ...tampered.trees.M, "src/plan-admission/rechain-verifier.ts": oid };
    tampered.trees.X = { ...tampered.trees.X, "src/plan-admission/rechain-verifier.ts": oid };
    tampered.trees.R = { ...tampered.trees.R, "src/plan-admission/rechain-verifier.ts": oid };

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("artifact-reowned-tree"))).toBe(true);
  });

  it("U-RECHAIN-011b: PR が追加した artifact_path を別 PLAN が M で既に宣言していれば fail する", () => {
    const { input, blobs } = buildBaseline();
    const otherPlanContent = `---\n${stringify({
      plan_id: OTHER_PLAN_ID,
      title: "other",
      kind: "add-design",
      layer: "L6",
      drive: "agent",
      route_signal: "feature_addition",
      route_mode: "add-feature",
      status: "draft",
      generates: [
        { artifact_path: OTHER_PLAN_PATH, artifact_type: "markdown_doc" },
        { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
      ],
    })}---\n${bodyFor(["起票。"])}`;
    const oid = sha(otherPlanContent).slice(0, 40);
    const tampered = clone(input);
    tampered.blobs = { ...blobs, [oid]: otherPlanContent };
    tampered.trees.M = { ...tampered.trees.M, [OTHER_PLAN_PATH]: oid };

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("artifact-reowned-generates"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-012: admission の意味の不変
  // -------------------------------------------------------------------------
  it("U-RECHAIN-012a: A_H の digest が H の tracked decision_digest と一致しない候補は fail する", () => {
    const { input, hRecord } = buildBaseline();
    const tampered = clone(input);
    const wrongCandidate = admissionFor(1, { escapeReason: "改変された理由" });
    tampered.admission = { [hRecord.recordDigest]: wrongCandidate };
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("admission-candidate-unverified"))).toBe(
        true,
      );
  });

  it("U-RECHAIN-012b: R の admission が A_H から reentry.targetRevision 以外で改変されていれば fail する (record 内 digest を信用しない)", () => {
    const b = buildBaseline();
    const forgedAdmission = { ...b.admissionH, escapeReason: "偽装された理由" };
    const { content: forgedContent, record: forgedRecord } = makeRevision(
      rParams(b, { admission: forgedAdmission }),
    );
    const tampered = clone(b.input);
    installR(tampered, forgedContent, [b.priorRecord, forgedRecord]);

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(
        verdict.reasons.some(
          (r) =>
            r.startsWith("admission-decision-digest-mismatch") ||
            r.startsWith("admission-field-drift"),
        ),
      ).toBe(true);
  });

  it.each(
    ADMISSION_FIELD_MUTATIONS,
  )("U-RECHAIN-012c: PlanAdmissionRequest.$field を改変した候補は、digest を正しく再計算しても H の tracked decision_digest と一致せず fail する ($field)", ({
    path,
    value,
  }) => {
    const { input, hRecord } = buildBaseline();
    const admissionH = input.admission[hRecord.recordDigest];
    const mutated = mutateAdmissionField(admissionH, path, value);
    const tampered = clone(input);
    tampered.admission = { [hRecord.recordDigest]: mutated };
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("admission-candidate-unverified"))).toBe(
        true,
      );
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-012 拡張 (Codex Sol r1 FLAG, PR #724): command_id / receipt_id / receipt_digest を
  // record 内の値だけで信用せず、H から独立に再導出して束縛する (§2.3-6 condition 6)。
  // -------------------------------------------------------------------------
  it("U-RECHAIN-012d: R の command_id が H の command_id + :rechain-<n> 以外なら、record と frontmatter を自己整合に揃え直しても fail する", () => {
    const { input } = buildBaseline();
    const tampered = forgeRReceiptRecord(input, (record) => {
      record.command_id = "plan-revise:attacker:arbitrary-command-id";
    });
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("rechain-command-id-mismatch"))).toBe(true);
  });

  it("U-RECHAIN-012e: command_id の suffix 形式が正しくても、receipt_id が正規式 (certificate:sha(command_id)) と一致しなければ fail する", () => {
    const { input, hRecord } = buildBaseline();
    const tampered = forgeRReceiptRecord(input, (record) => {
      record.command_id = `${hRecord.commandId}:rechain-1`;
      record.receipt_id = "certificate:0000000000000000000000000000000000000000";
    });
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("rechain-receipt-id-mismatch"))).toBe(true);
  });

  it("U-RECHAIN-012f: R の receipt_digest が H 自身の receipt_digest をそのまま使い回していれば、再導出値と一致せず fail する", () => {
    const { input, hRecord } = buildBaseline();
    const tampered = forgeRReceiptRecord(input, (record) => {
      record.receipt_digest = hRecord.receiptDigest;
    });
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("receipt_digest_mismatch"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-014: 非簿記 path の両側変更は git merge が成立しても fail する
  // -------------------------------------------------------------------------
  it("U-RECHAIN-014: 非簿記 path を H と M の両側が別々に変えていれば、git merge が成立していても fail する", () => {
    const { input, blobs } = buildBaseline();
    const tampered = clone(input);
    const hSideChange = "export const value = 1; // PR 側の変更\n";
    const mSideChange = "export const value = 2; // main 側の変更\n";
    const mergedLookingResult = "export const value = 3; // 両側を git が自動 merge した体\n";
    const hOid = sha(hSideChange).slice(0, 40);
    const mOid = sha(mSideChange).slice(0, 40);
    const mergedOid = sha(mergedLookingResult).slice(0, 40);
    tampered.blobs = {
      ...blobs,
      [hOid]: hSideChange,
      [mOid]: mSideChange,
      [mergedOid]: mergedLookingResult,
    };
    tampered.trees.H = { ...tampered.trees.H, [UNTOUCHED_PATH]: hOid };
    tampered.trees.M = { ...tampered.trees.M, [UNTOUCHED_PATH]: mOid };
    tampered.trees.X = { ...tampered.trees.X, [UNTOUCHED_PATH]: mergedOid };
    tampered.trees.R = { ...tampered.trees.R, [UNTOUCHED_PATH]: mergedOid };

    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("nonbookkeeping-both-sides-changed"))).toBe(
        true,
      );
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-015: base = merge-base(H, M) (stacked PR)
  // -------------------------------------------------------------------------
  it("U-RECHAIN-015: base に先行 merge 済みの stacked PR (C) を含めれば、PR 自身の追加だけが再適用されて pass する", () => {
    const { blobs, put } = makeBlobStore();
    const baseFm = baseFrontmatterOther();
    const prior = makePrior(ASSET_ID);
    const ancientBaseTree: TreeMap = {
      [PLAN_PATH]: put(prior.content),
      [RECEIPT_PATH]: put(receiptFile([prior.record])),
    };

    // C: 先に stacked PR A が merge 済みの状態 (merge-base はここになる)
    const cGenerates = [
      ...BASE_GENERATES,
      { artifact_path: "src/plan-admission/stacked-a-module.ts", artifact_type: "source_module" },
    ];
    const cItems = [...BASE_ITEMS, "rev 2 (stacked PR A): 先行実装。"];
    const { content: cContent, record: cRecord } = makeRevision({
      frontmatterOther: baseFm,
      generates: cGenerates,
      items: cItems,
      admission: admissionFor(2),
      binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: ASSET_ID, revision: 2 },
      commandId: "plan-revise:issue-700:stacked-a:plan:r1:c1",
      admittedAt: "2026-09-27T12:00:00.000Z",
      priorRecords: [prior.record],
      basePayloadDigest: payloadDigestOf(prior.content),
      actor: AUTHOR_ACTOR,
      sourceCommit: COMMITS.base,
    });
    const realBaseTree: TreeMap = {
      [PLAN_PATH]: put(cContent),
      [RECEIPT_PATH]: put(receiptFile([prior.record, cRecord])),
    };

    // H: PR B は C の上に自分の追加だけを積む
    const admissionH = admissionFor(3);
    const hGenerates = [
      ...cGenerates,
      { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
    ];
    const hItems = [...cItems, "rev 3 (S2): 検証器を実装した。"];
    const { content: hContent, record: hRecord } = makeRevision({
      frontmatterOther: baseFm,
      generates: hGenerates,
      items: hItems,
      admission: admissionH,
      binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: ASSET_ID, revision: 3 },
      commandId: "plan-revise:issue-999:s2:plan:r1:h1",
      admittedAt: H_ADMITTED_AT,
      priorRecords: [prior.record, cRecord],
      basePayloadDigest: payloadDigestOf(cContent),
      actor: AUTHOR_ACTOR,
      sourceCommit: COMMITS.base,
    });
    const hTree: TreeMap = {
      [PLAN_PATH]: put(hContent),
      [RECEIPT_PATH]: put(receiptFile([prior.record, cRecord, hRecord])),
    };

    // M: C の merge 後、他に誰もこの PLAN を触っていない
    const mTree: TreeMap = realBaseTree;
    const xTree: TreeMap = { [PLAN_PATH]: mTree[PLAN_PATH], [RECEIPT_PATH]: mTree[RECEIPT_PATH] };

    const { content: rContent, record: rRecord } = makeRevision({
      frontmatterOther: baseFm,
      generates: hGenerates,
      items: hItems,
      admission: admissionH, // revision 変化なし (M 側の latest は base と同じ 2)
      binding: { path: PLAN_PATH, planId: PLAN_ID, assetId: ASSET_ID, revision: 3 },
      commandId: "plan-revise:issue-999:s2:plan:r1:h1:rechain-1",
      admittedAt: R_ADMITTED_AT,
      priorRecords: [prior.record, cRecord],
      basePayloadDigest: payloadDigestOf(cContent),
    });
    const rTree: TreeMap = {
      [PLAN_PATH]: put(rContent),
      [RECEIPT_PATH]: put(receiptFile([prior.record, cRecord, rRecord])),
    };

    const goodInput: RechainInput = {
      commits: { ...commitObjs(), M: COMMITS.M, base: "commit-C" },
      trees: { base: realBaseTree, H: hTree, M: mTree, X: xTree, R: rTree },
      blobs,
      admission: { [hRecord.recordDigest]: admissionH },
      intermediatePlans: {},
    };
    const verdict = verifyRechainDelta(goodInput);
    expect(verdict.ok).toBe(true);

    // mutation: base を C 以前 (ancient) に戻すと、C の追加が PR 自身の追加として
    // 二重に数えられ、admission の対応が崩れて fail する。
    const badInput: RechainInput = {
      ...goodInput,
      commits: { ...goodInput.commits, base: "commit-ancient" },
      trees: { ...goodInput.trees, base: ancientBaseTree },
    };
    const badVerdict = verifyRechainDelta(badInput);
    expect(badVerdict.ok).toBe(false);
    if (!badVerdict.ok) expect(badVerdict.reasons).toContain("admission-count-mismatch");
  });

  // -------------------------------------------------------------------------
  // U-RECHAIN-016: verifierDigest は入力の canonical digest であり、key の挿入順に依存しない
  // -------------------------------------------------------------------------
  it("U-RECHAIN-016: verifierDigest は stableJson による canonical digest で、key の挿入順に依存しない", () => {
    const { input: inputA } = buildBaseline();
    const inputB: RechainInput = {
      ...inputA,
      blobs: Object.fromEntries(Object.entries(inputA.blobs).reverse()),
      admission: Object.fromEntries(Object.entries(inputA.admission).reverse()),
      intermediatePlans: Object.fromEntries(Object.entries(inputA.intermediatePlans).reverse()),
    };

    const verdictA = verifyRechainDelta(inputA);
    const verdictB = verifyRechainDelta(inputB);
    expect(verdictA.ok).toBe(true);
    expect(verdictB.ok).toBe(true);
    if (!verdictA.ok || !verdictB.ok) return;
    expect(verdictA.verifierDigest).toBe(verdictB.verifierDigest);
    expect(verdictA.verifierDigest).toBe(verifierDigestOf(inputA));
    expect(verdictA.verifierDigest).toBe(
      `sha256:${sha(`ut-tdd.rechain-verifier.v2\n${stableJson(inputA)}`)}`,
    );

    // mutation: JSON.stringify は key の挿入順に依存するため、挿入順を変えた入力からは
    // 異なる digest になってしまう (stableJson を使わなければ決定的にならないことの確認)。
    const jsonDigestA = sha(`ut-tdd.rechain-verifier.v2\n${JSON.stringify(inputA)}`);
    const jsonDigestB = sha(`ut-tdd.rechain-verifier.v2\n${JSON.stringify(inputB)}`);
    expect(jsonDigestA).not.toBe(jsonDigestB);

    // mutation: domain separator (schema version 行) を変えると、同じ stableJson(input) でも
    // 異なる digest になる (§2.6-5 の "先頭行は domain separator 兼 schema version" の固定)。
    const differentVersionDigest = `sha256:${sha(`ut-tdd.rechain-verifier.v1\n${stableJson(inputA)}`)}`;
    expect(verdictA.verifierDigest).not.toBe(differentVersionDigest);
  });
});

function trackedReceiptRecordDigestFromJson(record: Record<string, unknown>): string {
  return trackedReceiptRecordDigest({
    sequence: record.sequence as number,
    previousRecordDigest: record.previous_record_digest as string | null,
    commandId: record.command_id as string,
    receiptId: record.receipt_id as string,
    receiptDigest: record.receipt_digest as string,
    decisionDigest: record.decision_digest as string,
    binding: {
      path: (record.binding as Record<string, unknown>).path as string,
      planId: (record.binding as Record<string, unknown>).plan_id as string,
      assetId: (record.binding as Record<string, unknown>).asset_id as string,
      revision: (record.binding as Record<string, unknown>).revision as number,
      contentDigest: (record.binding as Record<string, unknown>).content_digest as string,
    },
  });
}

// ---------------------------------------------------------------------------
// U-RECHAIN-017 / 018: receipt_digest の再導出と、同一 asset 複数 record の base chain
// ---------------------------------------------------------------------------

describe("verifyRechainDelta receipt_digest 再導出 (receipt revision 5)", () => {
  it("U-RECHAIN-017a: receipt_digest だけを任意値に置き換え (frontmatter・record digest は整合) ても fail する [m: 再導出を省くと pass]", () => {
    const { input } = buildBaseline();
    const tampered = forgeRReceiptRecord(input, (record) => {
      record.receipt_digest = `sha256:${"f".repeat(64)}`;
    });
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons).toEqual([`receipt_digest_mismatch:${PLAN_PATH}`]);
    }
  });

  it("U-RECHAIN-017b: actor を契約定数以外にして導いた receipt_digest は fail する", () => {
    const b = buildBaseline();
    const { content, record } = makeRevision(rParams(b, { actor: "someone-else" }));
    const tampered = clone(b.input);
    installR(tampered, content, [b.priorRecord, record]);
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toEqual([`receipt_digest_mismatch:${PLAN_PATH}`]);
  });

  it("U-RECHAIN-017c: sourceCommit が M でない receipt_digest は fail する", () => {
    const b = buildBaseline();
    const { content, record } = makeRevision(rParams(b, { sourceCommit: COMMITS.H }));
    const tampered = clone(b.input);
    installR(tampered, content, [b.priorRecord, record]);
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toEqual([`receipt_digest_mismatch:${PLAN_PATH}`]);
  });

  // legacy bootstrap 除外の判定は U-RECHAIN-019 で固定する (receipt revision 6)。
});

interface TwoRecordScenario {
  input: RechainInput;
  r1: { content: string; record: TrackedReceiptRecord };
  r2: { content: string; record: TrackedReceiptRecord };
  prior: { content: string; record: TrackedReceiptRecord };
  rebuild: (over: Partial<RevisionInput>) => Mutable<RechainInput>;
}

/** 同一 asset に対し H が 2 件 append していた re-chain (M 側の最新 revision n = 1)。 */
function buildTwoRecordScenario(): TwoRecordScenario {
  const { blobs, put } = makeBlobStore();
  const baseFm = baseFrontmatterOther();
  const prior = makePrior(ASSET_ID);
  const g1 = [
    ...BASE_GENERATES,
    { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
  ];
  const g2 = [
    ...g1,
    { artifact_path: "tests/rechain-verifier.test.ts", artifact_type: "test_code" },
  ];
  const i1 = [...BASE_ITEMS, "rev 2: 検証器。"];
  const i2 = [...i1, "rev 3: テスト。"];
  const a1 = admissionFor(2);
  const a2 = admissionFor(3);
  const bind = (revision: number) => ({
    path: PLAN_PATH,
    planId: PLAN_ID,
    assetId: ASSET_ID,
    revision,
  });

  const h1 = makeRevision({
    frontmatterOther: baseFm,
    generates: g1,
    items: i1,
    admission: a1,
    binding: bind(2),
    commandId: "plan-revise:issue-999:s2:plan:r1:h1",
    admittedAt: H_ADMITTED_AT,
    priorRecords: [prior.record],
    basePayloadDigest: payloadDigestOf(prior.content),
    actor: AUTHOR_ACTOR,
    sourceCommit: COMMITS.base,
  });
  const h2 = makeRevision({
    frontmatterOther: baseFm,
    generates: g2,
    items: i2,
    admission: a2,
    binding: bind(3),
    commandId: "plan-revise:issue-999:s2:plan:r1:h2",
    admittedAt: H_ADMITTED_AT,
    priorRecords: [prior.record, h1.record],
    basePayloadDigest: payloadDigestOf(h1.content),
    actor: AUTHOR_ACTOR,
    sourceCommit: COMMITS.base,
  });
  const r1 = makeRevision({
    frontmatterOther: baseFm,
    generates: g1,
    items: i1,
    admission: a1,
    binding: bind(2),
    commandId: `${h1.record.commandId}:rechain-1`,
    admittedAt: R_ADMITTED_AT,
    priorRecords: [prior.record],
    basePayloadDigest: payloadDigestOf(prior.content),
  });
  const r2Params: RevisionInput = {
    frontmatterOther: baseFm,
    generates: g2,
    items: i2,
    admission: a2,
    binding: bind(3),
    commandId: `${h2.record.commandId}:rechain-1`,
    admittedAt: R_ADMITTED_AT,
    priorRecords: [prior.record, r1.record],
    basePayloadDigest: payloadDigestOf(r1.content),
  };
  const r2 = makeRevision(r2Params);

  const baseTree: TreeMap = {
    [PLAN_PATH]: put(prior.content),
    [RECEIPT_PATH]: put(receiptFile([prior.record])),
  };
  const hTree: TreeMap = {
    [PLAN_PATH]: put(h2.content),
    [RECEIPT_PATH]: put(receiptFile([prior.record, h1.record, h2.record])),
  };
  const rTree: TreeMap = {
    [PLAN_PATH]: put(r2.content),
    [RECEIPT_PATH]: put(receiptFile([prior.record, r1.record, r2.record])),
  };
  const input: RechainInput = {
    commits: { ...commitObjs(), M: COMMITS.M, base: COMMITS.base },
    trees: { base: baseTree, H: hTree, M: { ...baseTree }, X: { ...baseTree }, R: rTree },
    blobs,
    admission: { [h1.record.recordDigest]: a1, [h2.record.recordDigest]: a2 },
    intermediatePlans: { [r1.record.binding.contentDigest]: r1.content },
  };
  const rebuild: TwoRecordScenario["rebuild"] = (over) => {
    const forged = makeRevision({ ...r2Params, ...over });
    const tampered = clone(input);
    installR(tampered, forged.content, [prior.record, r1.record, forged.record]);
    return tampered;
  };
  return { input, r1, r2, prior, rebuild };
}

describe("verifyRechainDelta 同一 asset 複数 record の base chain (U-RECHAIN-018)", () => {
  it("U-RECHAIN-018a: 正系 (1 件目 base=(n, M の digest)、2 件目 base=(n+1, 中間 blob の digest)) は pass する", () => {
    const { input } = buildTwoRecordScenario();
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("U-RECHAIN-018b [m1]: 2 件目の base を M (n, M の digest) に固定した receipt_digest は fail する", () => {
    const s = buildTwoRecordScenario();
    const input = s.rebuild({
      baseRevision: 1,
      basePayloadDigest: payloadDigestOf(s.prior.content),
    });
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toEqual([`receipt_digest_mismatch:${PLAN_PATH}`]);
  });

  it("U-RECHAIN-018c [m2]: 中間 blob を 1 byte 変えると intermediate_plan_digest_mismatch で fail する", () => {
    const s = buildTwoRecordScenario();
    const tampered = clone(s.input);
    tampered.intermediatePlans[s.r1.record.binding.contentDigest] = `${s.r1.content}x`;
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("intermediate_plan_digest_mismatch"))).toBe(
        true,
      );
  });

  it("U-RECHAIN-018d [m3]: 中間 blob を渡さないと intermediate_plan_missing で fail する (R の blob で代用しない)", () => {
    const s = buildTwoRecordScenario();
    const tampered = clone(s.input);
    tampered.intermediatePlans = {};
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("intermediate_plan_missing"))).toBe(true);
  });

  it("U-RECHAIN-018e [m4]: どの record からも参照されない余分な key と blob は intermediate_plan_unexpected で fail する", () => {
    const s = buildTwoRecordScenario();
    const tampered = clone(s.input);
    tampered.intermediatePlans[`sha256:${"e".repeat(64)}`] = "余分な blob";
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("intermediate_plan_unexpected"))).toBe(true);
  });

  it("U-RECHAIN-018f [m4]: 最後の record の content_digest を key に R の PLAN blob を足すと intermediate_plan_unexpected で fail する", () => {
    const s = buildTwoRecordScenario();
    const tampered = clone(s.input);
    tampered.intermediatePlans[s.r2.record.binding.contentDigest] = s.r2.content;
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("intermediate_plan_unexpected"))).toBe(true);
  });

  it("U-RECHAIN-018g: 2 件以上の asset が無いとき intermediatePlans は空でなければならない", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    tampered.intermediatePlans = { [`sha256:${"d".repeat(64)}`]: "余分" };
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok)
      expect(verdict.reasons.some((r) => r.startsWith("intermediate_plan_unexpected"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U-RECHAIN-019: legacy bootstrap 除外 (PLAN-L6-711 §2.3-6、receipt revision 6)
// ---------------------------------------------------------------------------

const LEGACY_ASSET = `plan:legacy:${"a".repeat(64)}`;
const HEX32_ASSET = `plan:${"0123456789abcdef".repeat(2)}`;
const LEGACY_COMMAND_IDS = [
  "plan-revise:issue-1:legacy-x:r2:000000000000",
  "pr154-legacy-x-r2",
] as const;

/**
 * 同 asset の record を priorCount 件 (revision 1..priorCount) 持つ base から、H が
 * revision priorCount+1 を 1 件 append した re-chain。`concurrent` のときは待機中に M が同 asset を
 * revision priorCount+1 で admit しており、R は revision priorCount+2 で再発行する。
 * R の digest は common 経路 (`AppendPlanRevisionInput`) で正しく導く。
 */
function buildChainScenario(opts: {
  assetId: string;
  priorCount: number;
  concurrent?: boolean;
  hCommandId?: string;
  /** H の追加 record の revision。省略時は priorCount+1 (legacy bootstrap 型は M に record 無しで 2)。 */
  hRevision?: number;
}): RechainInput {
  const { blobs, put } = makeBlobStore();
  const baseFm = baseFrontmatterOther();
  const bind = (revision: number) => ({
    path: PLAN_PATH,
    planId: PLAN_ID,
    assetId: opts.assetId,
    revision,
  });
  const priors: { content: string; record: TrackedReceiptRecord }[] = [];
  for (let rev = 1; rev <= opts.priorCount; rev++) {
    const previous = priors.at(-1);
    priors.push(
      makeRevision({
        frontmatterOther: baseFm,
        generates: BASE_GENERATES,
        items: BASE_ITEMS,
        admission: admissionFor(rev),
        binding: bind(rev),
        commandId: `plan-revise:issue-998:prior:plan:r${rev}`,
        admittedAt: "2026-09-27T00:00:00.000Z",
        priorRecords: priors.map((p) => p.record),
        basePayloadDigest: previous ? payloadDigestOf(previous.content) : GENESIS_PAYLOAD_DIGEST,
        actor: AUTHOR_ACTOR,
        sourceCommit: COMMITS.base,
      }),
    );
  }
  const priorRecords = priors.map((p) => p.record);
  const baseContent =
    priors.at(-1)?.content ??
    `---\n${stringify({ ...baseFm, generates: BASE_GENERATES })}---\n${bodyFor(BASE_ITEMS)}`;
  const n = opts.priorCount;
  const basePayload = n > 0 ? payloadDigestOf(baseContent) : GENESIS_PAYLOAD_DIGEST;

  const hGenerates = [
    ...BASE_GENERATES,
    { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
  ];
  const hItems = [...BASE_ITEMS, "rev (S2): 検証器を実装した。"];
  const hRevision = opts.hRevision ?? n + 1;
  const admissionH = admissionFor(hRevision);
  const h = makeRevision({
    frontmatterOther: baseFm,
    generates: hGenerates,
    items: hItems,
    admission: admissionH,
    binding: bind(hRevision),
    commandId: opts.hCommandId ?? "plan-revise:issue-999:s2:plan:r1:h1",
    admittedAt: H_ADMITTED_AT,
    priorRecords,
    basePayloadDigest: basePayload,
    actor: AUTHOR_ACTOR,
    sourceCommit: COMMITS.base,
  });

  let mContent = baseContent;
  let mRecords = priorRecords;
  let mGenerates: readonly unknown[] = BASE_GENERATES;
  let mItems: readonly string[] = BASE_ITEMS;
  if (opts.concurrent) {
    mGenerates = [
      ...BASE_GENERATES,
      { artifact_path: "docs/plans/PLAN-L6-999-concurrent-note.md", artifact_type: "markdown_doc" },
    ];
    mItems = [...BASE_ITEMS, "rev (concurrent): 別 PR が先に merge した。"];
    const m = makeRevision({
      frontmatterOther: baseFm,
      generates: mGenerates,
      items: mItems,
      admission: admissionFor(n + 1),
      binding: bind(n + 1),
      commandId: "plan-revise:issue-777:concurrent:plan:r1:c1",
      admittedAt: "2026-09-28T00:30:00.000Z",
      priorRecords,
      basePayloadDigest: basePayload,
      actor: AUTHOR_ACTOR,
      sourceCommit: COMMITS.base,
    });
    mContent = m.content;
    mRecords = [...priorRecords, m.record];
  }

  const lastM = mRecords.at(-1);
  const rRevision = lastM ? lastM.binding.revision + 1 : hRevision;
  if (!admissionH.reentry) throw new Error("fixture-admission-missing-reentry");
  const r = makeRevision({
    frontmatterOther: baseFm,
    generates: [...mGenerates, hGenerates[hGenerates.length - 1]],
    items: [...mItems, hItems[hItems.length - 1]],
    admission: { ...admissionH, reentry: { ...admissionH.reentry, targetRevision: rRevision } },
    binding: bind(rRevision),
    commandId: `${h.record.commandId}:rechain-1`,
    admittedAt: R_ADMITTED_AT,
    priorRecords: mRecords,
    basePayloadDigest: mRecords.length > 0 ? payloadDigestOf(mContent) : GENESIS_PAYLOAD_DIGEST,
  });

  const baseTree: TreeMap = {
    [PLAN_PATH]: put(baseContent),
    [RECEIPT_PATH]: put(receiptFile(priorRecords)),
  };
  const mTree: TreeMap = {
    [PLAN_PATH]: put(mContent),
    [RECEIPT_PATH]: put(receiptFile(mRecords)),
  };
  return {
    commits: { ...commitObjs(), M: COMMITS.M, base: COMMITS.base },
    trees: {
      base: baseTree,
      H: {
        [PLAN_PATH]: put(h.content),
        [RECEIPT_PATH]: put(receiptFile([...priorRecords, h.record])),
      },
      M: mTree,
      X: { ...mTree },
      R: {
        [PLAN_PATH]: put(r.content),
        [RECEIPT_PATH]: put(receiptFile([...mRecords, r.record])),
      },
    },
    blobs,
    admission: { [h.record.recordDigest]: admissionH },
    intermediatePlans: {},
  };
}

describe("verifyRechainDelta legacy bootstrap 除外 (U-RECHAIN-019)", () => {
  for (const commandId of LEGACY_COMMAND_IDS) {
    it(`U-RECHAIN-019a1 [m4]: M に同 legacy asset の revision 1 があり H / R が revision 2 → reasons はちょうど [legacy_bootstrap_unsupported] (command_id=${commandId})`, () => {
      const input = buildChainScenario({
        assetId: LEGACY_ASSET,
        priorCount: 1,
        hCommandId: commandId,
      });
      const verdict = verifyRechainDelta(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reasons).toEqual([LEGACY_BOOTSTRAP_UNSUPPORTED]);
    });

    it(`U-RECHAIN-019a2 [m4/m5]: M に同 asset の record が無く H が revision 2 → reasons に legacy_bootstrap_unsupported を含む (command_id=${commandId})`, () => {
      const input = buildChainScenario({
        assetId: LEGACY_ASSET,
        priorCount: 0,
        hRevision: 2,
        hCommandId: commandId,
      });
      const verdict = verifyRechainDelta(input);
      expect(verdict.ok).toBe(false);
      // 理由の集約 (§2.3-6): legacy 理由と源の欠落の理由が併存する (legacy で短絡しない)。
      if (!verdict.ok)
        expect(verdict.reasons).toEqual([
          LEGACY_BOOTSTRAP_UNSUPPORTED,
          `receipt_digest_source_unavailable:${PLAN_PATH}`,
        ]);
    });
  }

  it("U-RECHAIN-019b [m1]: H が legacy revision 2、待機中に M が同 asset を revision 2 で admit し R が revision 3 → fail", () => {
    const input = buildChainScenario({ assetId: LEGACY_ASSET, priorCount: 1, concurrent: true });
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toContain(LEGACY_BOOTSTRAP_UNSUPPORTED);
  });

  it("U-RECHAIN-019b0: (対照) 019b と同形で非 legacy asset なら pass する (019b の fail は legacy 判定だけに由来する)", () => {
    const input = buildChainScenario({ assetId: ASSET_ID, priorCount: 1, concurrent: true });
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("U-RECHAIN-019c [m2]: (正系) M に同 legacy asset の最新 revision 2 があり H / R が revision 3 → pass (record 単位の除外)", () => {
    const input = buildChainScenario({ assetId: LEGACY_ASSET, priorCount: 2 });
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("U-RECHAIN-019d [m3]: (正系) plan:<32 hex> asset で M の最新 revision 1、H / R が revision 2 → pass", () => {
    const input = buildChainScenario({ assetId: HEX32_ASSET, priorCount: 1 });
    const verdict = verifyRechainDelta(input);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR #839 Sol r1 FLAG の回帰 (中間 blob の bind 前 digest、strip(R) の byte 一致)
// ---------------------------------------------------------------------------

describe("verifyRechainDelta PR #839 r1 FLAG 回帰", () => {
  it("U-RECHAIN-003c: R の frontmatter の key 順だけを変え (title を先頭へ)、digest と receipt を正規に再導出しても strip(R) の byte 不一致で fail する", () => {
    const b = buildBaseline();
    const { title, ...rest } = baseFrontmatterOther();
    const reordered = { title, ...rest };
    const hGenerates = [
      ...BASE_GENERATES,
      { artifact_path: "src/plan-admission/rechain-verifier.ts", artifact_type: "source_module" },
    ];
    const { content, record } = makeRevision(
      rParams(b, { frontmatterOther: reordered, generates: hGenerates }),
    );
    expect(content.startsWith("---\ntitle:")).toBe(true);
    const tampered = clone(b.input);
    installR(tampered, content, [b.priorRecord, record]);
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toEqual([`plan-strip-mismatch:bytes:${PLAN_PATH}`]);
  });
  it("U-RECHAIN-018h: 中間 blob の status を draft→confirmed に変えると、bind 後の digest が key と一致しても fail する", () => {
    const s = buildTwoRecordScenario();
    const tampered = clone(s.input);
    const key = s.r1.record.binding.contentDigest;
    const original = tampered.intermediatePlans[key];
    expect(original.includes("status: draft")).toBe(true);
    tampered.intermediatePlans[key] = original.split("status: draft").join("status: confirmed");
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toContain(`intermediate_plan_digest_mismatch:${key}`);
  });

  it("U-RECHAIN-003b: R の frontmatter に YAML コメントを 1 行足す (意味は不変) と strip(R) の byte 不一致で fail する", () => {
    const { input } = buildBaseline();
    const tampered = clone(input);
    const rContent = tampered.blobs[tampered.trees.R[PLAN_PATH]];
    const injected = rContent
      .split("\nadmission_receipt:")
      .join("\n# injected unreviewed comment\nadmission_receipt:");
    expect(injected).not.toBe(rContent);
    const oid = sha(injected).slice(0, 40);
    tampered.blobs[oid] = injected;
    tampered.trees.R[PLAN_PATH] = oid;
    const verdict = verifyRechainDelta(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons).toEqual([`plan-strip-mismatch:bytes:${PLAN_PATH}`]);
  });
});
