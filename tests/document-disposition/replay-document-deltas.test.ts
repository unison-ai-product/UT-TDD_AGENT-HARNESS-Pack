import { describe, expect, it } from "vitest";
import {
  createDocumentDeltaDecision,
  createDocumentDeltaEvent,
  type DocumentDelta,
  type DocumentDeltaDecisionDraft,
  type DocumentDeltaPayload,
  documentDeltaChainDigest,
  type ReplayDocumentDeltasInput,
  replayDocumentDeltas,
} from "../../src/document-disposition/domain/replay-document-deltas.ts";

const member = (path: string, blobOid = `oid:${path}`, contentDigest = `sha:${path}`) => ({
  path,
  blobOid,
  contentDigest,
});

const decisionRecord = (path: string) => ({
  baselinePath: path,
  disposition: "retain",
  reason: "明示delta判断",
  targets: [] as const,
  planIds: [] as const,
  applicationStatus: "verified",
  applicability: { kind: "applicable" },
});

const buildInput = (
  baseline: ReturnType<typeof member>[],
  final: ReturnType<typeof member>[],
  deltas: DocumentDelta[] = [],
): ReplayDocumentDeltasInput => {
  const ledgerId = "ledger";
  const decisions = deltas.map((delta) => {
    const path = delta.kind === "delete" ? delta.before.path : delta.after.path;
    return createDocumentDeltaDecision({
      deltaId: delta.deltaId,
      ledgerId,
      fromSnapshotDigest: "baseline",
      toSnapshotDigest: "final",
      operationKind: delta.kind,
      before: delta.kind === "add" ? undefined : delta.before,
      after: delta.kind === "delete" ? undefined : delta.after,
      affectedPath: path,
      record: decisionRecord(path),
    });
  });
  return {
    baseline,
    final,
    deltas,
    decisions,
    ledgerId,
    baselineSnapshotDigest: "baseline",
    finalSnapshotDigest: "final",
    expectedDeltaChainDigest: documentDeltaChainDigest({
      ledgerId,
      baselineSnapshotDigest: "baseline",
      policyRevision: "document-closure-v1",
      deltas,
    }),
    policyRevision: "document-closure-v1",
  };
};

const replay = (
  baseline: ReturnType<typeof member>[],
  final: ReturnType<typeof member>[],
  deltas: DocumentDelta[] = [],
) => replayDocumentDeltas(buildInput(baseline, final, deltas));

const event = (delta: DocumentDeltaPayload, previousEventDigest: string | null): DocumentDelta => {
  const path = delta.kind === "delete" ? delta.before.path : delta.after.path;
  const decision = createDocumentDeltaDecision({
    deltaId: delta.deltaId,
    ledgerId: "ledger",
    fromSnapshotDigest: "baseline",
    toSnapshotDigest: "final",
    operationKind: delta.kind,
    before: delta.kind === "add" ? undefined : delta.before,
    after: delta.kind === "delete" ? undefined : delta.after,
    affectedPath: path,
    record: decisionRecord(path),
  });
  return createDocumentDeltaEvent({
    ...delta,
    ledgerId: "ledger",
    fromSnapshotDigest: "baseline",
    toSnapshotDigest: "final",
    decisionDigest: decision.decisionDigest,
    previousEventDigest,
  });
};

describe("replayDocumentDeltas U-DOCLEDGER-005", () => {
  it("unchanged snapshotはclosed", () => {
    expect(replay([member("docs/a.md")], [member("docs/a.md")])).toMatchObject({
      findings: [],
      ok: true,
    });
  });

  it.each([
    ["add", [], [member("docs/a.md")]],
    ["delete", [member("docs/a.md")], []],
    ["modify", [member("docs/a.md", "old")], [member("docs/a.md", "new")]],
  ] as const)("未登録%sを差分identityで返す", (kind, baseline, final) => {
    const result = replay([...baseline], [...final]);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind, ruleId: "doc-delta-unregistered" }),
    ]);
  });

  it("明示add/modify/deleteをsequence順にreplayする", () => {
    const added = member("docs/a.md", "v1");
    const modified = member("docs/a.md", "v2");
    const first = event({ deltaId: "d1", sequence: 1, kind: "add", after: added }, null);
    const second = event(
      { deltaId: "d2", sequence: 2, kind: "modify", before: added, after: modified },
      first.eventDigest,
    );
    const third = event(
      { deltaId: "d3", sequence: 3, kind: "delete", before: modified },
      second.eventDigest,
    );
    const deltas = [first, second, third];
    expect(replay([], [], deltas)).toMatchObject({ findings: [], ok: true });
  });

  it("明示renameだけがdelete+addを消費する", () => {
    const before = member("docs/a.md", "same");
    const after = member("docs/b.md", "same");
    const registered = [event({ deltaId: "d1", sequence: 1, kind: "rename", before, after }, null)];

    expect(replay([before], [after], registered)).toMatchObject({ findings: [], ok: true });
    expect(replay([before], [after]).findings.map(({ kind }) => kind)).toEqual(["add", "delete"]);
  });

  it.each([
    [
      "stale-before",
      [member("docs/a.md", "v1")],
      [member("docs/a.md", "v2")],
      event(
        {
          deltaId: "d1",
          sequence: 1,
          kind: "modify",
          before: member("docs/a.md", "wrong"),
          after: member("docs/a.md", "v2"),
        },
        null,
      ),
      "stale-before",
    ],
    [
      "existing-add",
      [member("docs/a.md")],
      [member("docs/a.md")],
      event({ deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") }, null),
      "path-already-exists",
    ],
  ] as const)("%sをfail-closeする", (_name, baseline, final, delta, reasonCode) => {
    const result = replay([...baseline], [...final], [delta] as DocumentDelta[]);
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatchObject({ reasonCode });
  });

  it("delete後のmodifyをsource-missingで拒否する", () => {
    const original = member("docs/a.md");
    const deleted = event({ deltaId: "d1", sequence: 1, kind: "delete", before: original }, null);
    const modified = event(
      {
        deltaId: "d2",
        sequence: 2,
        kind: "modify",
        before: original,
        after: member("docs/a.md", "v2"),
      },
      deleted.eventDigest,
    );
    const result = replay([original], [], [deleted, modified]);
    expect(result.findings.map(({ reasonCode }) => reasonCode)).toEqual(["source-missing"]);
  });

  it("finding順とidentityをstableにし、入力を変更しない", () => {
    const inputBaseline = [member("docs/z.md"), member("docs/a.md", "old")];
    const inputFinal = [member("docs/b.md"), member("docs/a.md", "new")];
    const before = structuredClone({ inputBaseline, inputFinal });

    const first = replay(inputBaseline, inputFinal);
    const second = replay(inputBaseline, inputFinal);

    expect(first.findings.map(({ kind, subjectIdentity }) => [kind, subjectIdentity])).toEqual([
      ["add", "docs/b.md"],
      ["delete", "docs/z.md"],
      ["modify", "docs/a.md"],
    ]);
    expect(second).toEqual(first);
    expect({ inputBaseline, inputFinal }).toEqual(before);
  });

  it("空delta列でもchain seed改竄を拒否する", () => {
    const input = buildInput([member("docs/a.md")], [member("docs/a.md")]);
    const result = replayDocumentDeltas({ ...input, expectedDeltaChainDigest: "tampered" });
    expect(result).toMatchObject({
      ok: false,
      findings: [{ kind: "chain", reasonCode: "chain-digest-invalid", sequence: 0 }],
    });
  });

  it("deltaId又はsnapshot identity改竄をevent digest不一致として拒否する", () => {
    const original = event(
      { deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") },
      null,
    );
    for (const mutated of [
      { ...original, deltaId: "mutated" },
      { ...original, fromSnapshotDigest: "other" },
    ]) {
      const result = replay([], [member("docs/a.md")], [mutated]);
      expect(result.ok).toBe(false);
      expect(result.findings[0].reasonCode).toMatch(/event-digest-invalid|snapshot-mismatch/);
    }
  });

  it("decision欠落と不完全decisionを拒否する", () => {
    const delta = event(
      { deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") },
      null,
    );
    const input = buildInput([], [member("docs/a.md")], [delta]);
    const missing = replayDocumentDeltas({ ...input, decisions: [] });
    expect(missing.findings[0]).toMatchObject({ reasonCode: "decision-cardinality-invalid" });

    const incomplete = replayDocumentDeltas({
      ...input,
      decisions: [
        {
          ...input.decisions[0],
          record: { ...input.decisions[0].record, reason: "" },
        },
      ],
    });
    expect(incomplete.findings[0]).toMatchObject({ reasonCode: "decision-mismatch" });
  });

  it("duplicate sequenceは入力順に依存せず両eventを拒否する", () => {
    const first = event(
      { deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") },
      null,
    );
    const second = event(
      { deltaId: "d2", sequence: 1, kind: "add", after: member("docs/b.md") },
      first.eventDigest,
    );
    const left = replayDocumentDeltas(buildInput([], [], [first, second]));
    const right = replayDocumentDeltas(buildInput([], [], [second, first]));
    expect(left).toEqual(right);
    expect(left.findings.map(({ reasonCode }) => reasonCode)).toEqual([
      "sequence-invalid",
      "sequence-invalid",
    ]);
  });

  it("chain破断後は後続eventをstateへ適用しない", () => {
    const invalid = event(
      { deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") },
      "tampered",
    );
    const child = event(
      { deltaId: "d2", sequence: 2, kind: "add", after: member("docs/b.md") },
      invalid.eventDigest,
    );
    const result = replay([], [member("docs/b.md")], [invalid, child]);
    expect(result.findings.map(({ reasonCode }) => reasonCode)).toEqual([
      "chain-link-invalid",
      "prior-invalid",
    ]);
  });

  it("同一deltaIdを複数eventで共有できない", () => {
    const added = member("docs/a.md", "v1");
    const modified = member("docs/a.md", "v2");
    const first = event({ deltaId: "same", sequence: 1, kind: "add", after: added }, null);
    const secondDraft = event(
      { deltaId: "same", sequence: 2, kind: "modify", before: added, after: modified },
      first.eventDigest,
    );
    const second = createDocumentDeltaEvent({
      ...secondDraft,
      decisionDigest: first.decisionDigest,
    });
    const result = replayDocumentDeltas({
      ...buildInput([], [modified], [first, second]),
      decisions: buildInput([], [modified], [first]).decisions,
    });

    expect(result.findings.map(({ reasonCode }) => reasonCode)).toEqual([
      "delta-id-duplicate",
      "delta-id-duplicate",
    ]);
  });

  it("baseline/final重複pathをMapで上書きしない", () => {
    const duplicate = [member("docs/a.md", "v1"), member("docs/a.md", "v2")];
    expect(
      replay(duplicate, duplicate)
        .findings.map(({ reasonCode }) => reasonCode)
        .sort(),
    ).toEqual(["baseline-duplicate", "final-duplicate"]);
  });

  it("final case-fold collisionをfail-closeする", () => {
    const result = replay([], [member("docs/A.md"), member("docs/a.md")]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        reasonCode: "final-casefold-collision",
        subjectIdentity: "docs/A.md|docs/a.md",
      }),
    ]);
  });

  it("delta factoryはinvalid sequence/path/identityを生成しない", () => {
    expect(() =>
      event({ deltaId: "d1", sequence: 0, kind: "add", after: member("docs/a.md") }, null),
    ).toThrow("document-delta-identity-invalid");
    expect(() =>
      createDocumentDeltaEvent({
        deltaId: "d1",
        ledgerId: "ledger",
        fromSnapshotDigest: "baseline",
        toSnapshotDigest: "final",
        sequence: 1,
        kind: "add",
        after: member("../a.md"),
        decisionDigest: "decision",
        previousEventDigest: null,
      }),
    ).toThrow("document-delta-member-invalid");
    expect(() =>
      createDocumentDeltaEvent({
        deltaId: "",
        ledgerId: "ledger",
        fromSnapshotDigest: "baseline",
        toSnapshotDigest: "final",
        sequence: 1,
        kind: "add",
        after: member("docs/a.md"),
        decisionDigest: "decision",
        previousEventDigest: null,
      }),
    ).toThrow("document-delta-identity-invalid");
  });

  it("decision factoryは不完全recordを生成せず、具体event provenanceを束縛する", () => {
    const delta = event(
      { deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") },
      null,
    );
    const input = buildInput([], [member("docs/a.md")], [delta]);
    expect(() =>
      createDocumentDeltaDecision({
        ...input.decisions[0],
        record: { ...input.decisions[0].record, reason: "" },
      }),
    ).toThrow("document-delta-decision-invalid");

    const foreign = createDocumentDeltaDecision({
      ...input.decisions[0],
      ledgerId: "other-ledger",
    });
    const result = replayDocumentDeltas({ ...input, decisions: [foreign] });
    expect(result.findings[0]).toMatchObject({ reasonCode: "decision-mismatch" });
  });

  it.each([
    {
      name: "addにbeforeがある",
      mutate: (draft: DocumentDeltaDecisionDraft) => ({
        ...draft,
        before: member("docs/old.md"),
      }),
    },
    {
      name: "deleteにafterがある",
      mutate: (draft: DocumentDeltaDecisionDraft) => ({
        ...draft,
        operationKind: "delete",
        before: member("docs/a.md"),
        after: member("docs/a.md"),
      }),
    },
    {
      name: "modifyにbeforeがない",
      mutate: (draft: DocumentDeltaDecisionDraft) => ({
        ...draft,
        operationKind: "modify",
        before: undefined,
      }),
    },
    {
      name: "未知のoperation kind",
      mutate: (draft: DocumentDeltaDecisionDraft) => ({
        ...draft,
        operationKind: "copy",
      }),
    },
    {
      name: "member pathがrepo-relativeでない",
      mutate: (draft: DocumentDeltaDecisionDraft) => ({
        ...draft,
        after: member("../a.md"),
        affectedPath: "../a.md",
        record: { ...draft.record, baselinePath: "../a.md" },
      }),
    },
    {
      name: "member identityが空",
      mutate: (draft: DocumentDeltaDecisionDraft) => ({
        ...draft,
        after: { ...member("docs/a.md"), blobOid: "" },
      }),
    },
  ])("decision factoryはinvalid stateを拒否する: $name", ({ mutate }) => {
    const delta = event(
      { deltaId: "d1", sequence: 1, kind: "add", after: member("docs/a.md") },
      null,
    );
    const decision = buildInput([], [member("docs/a.md")], [delta]).decisions[0];
    expect(() =>
      createDocumentDeltaDecision(mutate(decision) as unknown as DocumentDeltaDecisionDraft),
    ).toThrow("document-delta-decision-invalid");
  });
});
