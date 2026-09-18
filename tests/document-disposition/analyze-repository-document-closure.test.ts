import { describe, expect, it } from "vitest";
import { analyzeRepositoryDocumentClosure } from "../../src/document-disposition/domain/analyze-repository-document-closure.ts";
import type { DocumentDispositionInput } from "../../src/document-disposition/domain/document-disposition.ts";
import {
  createDocumentDeltaDecision,
  createDocumentDeltaEvent,
  type DocumentDelta,
  documentDeltaChainDigest,
} from "../../src/document-disposition/domain/replay-document-deltas.ts";

function snapshot(snapshotDigest: string, paths: readonly string[]) {
  return {
    snapshotDigest,
    members: paths.map((path) => ({
      path,
      blobOid: `oid:${path}`,
      contentDigest: `sha:${path}`,
    })),
  };
}

function record(baselinePath: string) {
  return {
    baselinePath,
    disposition: "retain" as const,
    reason: "現行設計と一致",
    targets: [],
    planIds: [],
    applicationStatus: "verified" as const,
    applicability: { kind: "applicable" as const },
  };
}

function ledger(records: DocumentDispositionInput[], deltas: DocumentDelta[] = []) {
  const ledgerId = "ledger";
  const decisions = deltas.map((delta) => {
    const path = delta.kind === "delete" ? delta.before.path : delta.after.path;
    return createDocumentDeltaDecision({
      deltaId: delta.deltaId,
      ledgerId,
      fromSnapshotDigest: delta.fromSnapshotDigest,
      toSnapshotDigest: delta.toSnapshotDigest,
      operationKind: delta.kind,
      before: delta.kind === "add" ? undefined : delta.before,
      after: delta.kind === "delete" ? undefined : delta.after,
      affectedPath: path,
      record: record(path),
    });
  });
  return {
    ledgerId,
    records,
    deltas,
    decisions,
    deltaChainDigest: documentDeltaChainDigest({
      ledgerId,
      baselineSnapshotDigest: "baseline",
      policyRevision: "document-closure-v1",
      deltas,
    }),
  };
}

describe("analyzeRepositoryDocumentClosure U-DOCLEDGER-003", () => {
  it("exactly-once ledgerはclosed/exit 0を返す", () => {
    const result = analyzeRepositoryDocumentClosure({
      baselineSnapshot: snapshot("baseline", ["docs/a.md", "docs/b.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md", "docs/b.md"]),
      ledger: ledger([record("docs/a.md"), record("docs/b.md")]),
      policyRevision: "document-closure-v1",
    });

    expect(result).toEqual({
      finalSnapshotDigest: "final",
      deltaChainDigest: expect.any(String),
      effective: snapshot("final", ["docs/a.md", "docs/b.md"]).members,
      reductionDigest: expect.any(String),
      findings: [],
      routeRequirements: [],
      closure: "closed",
      exitCode: 0,
    });
  });

  it("missing recordをstable findingとして全件返し、入力を変更しない", () => {
    const input = {
      baselineSnapshot: snapshot("baseline", ["docs/a.md", "docs/b.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md", "docs/b.md"]),
      ledger: ledger([record("docs/a.md")]),
      policyRevision: "document-closure-v1",
    } as const;
    const before = structuredClone(input);

    const first = analyzeRepositoryDocumentClosure(input);
    const second = analyzeRepositoryDocumentClosure(input);

    expect(first).toEqual({
      finalSnapshotDigest: "final",
      deltaChainDigest: expect.any(String),
      findings: [
        expect.objectContaining({
          ruleId: "doc-disposition-missing",
          subjectIdentity: "docs/b.md",
          exitCode: 1,
        }),
      ],
      routeRequirements: [],
      closure: "blocked",
      exitCode: 1,
    });
    expect(second.findings.map(({ findingId }) => findingId)).toEqual(
      first.findings.map(({ findingId }) => findingId),
    );
    expect(input).toEqual(before);
  });

  it("snapshotに存在しないunique ledger recordをphantomとして返す", () => {
    const result = analyzeRepositoryDocumentClosure({
      baselineSnapshot: snapshot("baseline", ["docs/a.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md"]),
      ledger: ledger([record("docs/a.md"), record("docs/z.md")]),
      policyRevision: "document-closure-v1",
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: "doc-disposition-phantom",
        subjectIdentity: "docs/z.md",
      }),
    ]);
  });

  it("exact duplicateを1件のduplicate findingへ正規化し、二次missingを出さない", () => {
    const result = analyzeRepositoryDocumentClosure({
      baselineSnapshot: snapshot("baseline", ["docs/a.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md"]),
      ledger: ledger([record("docs/a.md"), record("docs/a.md")]),
      policyRevision: "document-closure-v1",
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: "doc-disposition-duplicate",
        subjectIdentity: "docs/a.md",
      }),
    ]);
  });

  it("case-fold collisionをOS非依存で検出し、finding順を固定する", () => {
    const result = analyzeRepositoryDocumentClosure({
      baselineSnapshot: snapshot("baseline", ["docs/A.md", "docs/a.md"]),
      finalSnapshot: snapshot("final", ["docs/A.md", "docs/a.md"]),
      ledger: ledger([record("docs/A.md"), record("docs/a.md")]),
      policyRevision: "document-closure-v1",
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "doc-disposition-duplicate",
          subjectIdentity: "docs/A.md|docs/a.md",
        }),
        expect.objectContaining({
          reasonCode: "final-casefold-collision",
          subjectIdentity: "docs/A.md|docs/a.md",
        }),
      ]),
    );
  });

  it("missing/phantom/duplicateを同時に隠さずstable順で返す", () => {
    const input = {
      baselineSnapshot: snapshot("baseline", ["docs/a.md", "docs/b.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md", "docs/b.md", "docs/c.md"]),
      ledger: ledger([record("docs/a.md"), record("docs/a.md"), record("docs/z.md")]),
      policyRevision: "document-closure-v1",
    } as const;

    const result = analyzeRepositoryDocumentClosure(input);

    expect(result.findings.map(({ ruleId, subjectIdentity }) => [ruleId, subjectIdentity])).toEqual(
      [
        ["doc-delta-unregistered", "docs/c.md"],
        ["doc-disposition-duplicate", "docs/a.md"],
        ["doc-disposition-missing", "docs/b.md"],
        ["doc-disposition-phantom", "docs/z.md"],
      ],
    );
    expect(analyzeRepositoryDocumentClosure(input)).toEqual(result);
  });

  it("finalで追加されたpathはbaseline disposition missingとして扱わない", () => {
    const result = analyzeRepositoryDocumentClosure({
      baselineSnapshot: snapshot("baseline", ["docs/a.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md", "docs/new.md"]),
      ledger: ledger([record("docs/a.md")]),
      policyRevision: "document-closure-v1",
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: "doc-delta-unregistered",
        subjectIdentity: "docs/new.md",
      }),
    ]);
    expect(result.findings.some(({ ruleId }) => ruleId === "doc-disposition-missing")).toBe(false);
  });

  it("登録済みaddをreplayしてclosure Greenにする", () => {
    const after = snapshot("final", ["docs/a.md", "docs/new.md"]).members[1];
    const decision = createDocumentDeltaDecision({
      deltaId: "d1",
      ledgerId: "ledger",
      fromSnapshotDigest: "baseline",
      toSnapshotDigest: "final",
      operationKind: "add",
      after,
      affectedPath: after.path,
      record: record(after.path),
    });
    const delta = createDocumentDeltaEvent({
      deltaId: "d1",
      ledgerId: "ledger",
      fromSnapshotDigest: "baseline",
      toSnapshotDigest: "final",
      sequence: 1,
      kind: "add",
      after,
      decisionDigest: decision.decisionDigest,
      previousEventDigest: null,
    });
    const result = analyzeRepositoryDocumentClosure({
      baselineSnapshot: snapshot("baseline", ["docs/a.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md", "docs/new.md"]),
      ledger: ledger([record("docs/a.md")], [delta]),
      policyRevision: "document-closure-v1",
    });

    expect(result.findings).toEqual([]);
    expect(result.closure).toBe("closed");
  });

  it("不完全なdispositionをstable findingとしてclosureで拒否する", () => {
    const incomplete = {
      ...record("docs/a.md"),
      disposition: "update",
      targets: [],
      planIds: [],
      applicability: {
        kind: "conditional",
        reason: "",
        observedCondition: "flag=on",
        reevaluationTrigger: "",
      },
    } as const;
    const input = {
      baselineSnapshot: snapshot("baseline", ["docs/a.md"]),
      finalSnapshot: snapshot("final", ["docs/a.md"]),
      ledger: ledger([incomplete]),
      policyRevision: "document-closure-v1",
    } as const;

    const result = analyzeRepositoryDocumentClosure(input);

    expect(result).toEqual({
      finalSnapshotDigest: "final",
      deltaChainDigest: expect.any(String),
      findings: [
        expect.objectContaining({
          ruleId: "doc-disposition-incomplete",
          subjectIdentity: "docs/a.md",
          exitCode: 1,
        }),
      ],
      routeRequirements: [],
      closure: "blocked",
      exitCode: 1,
    });
    expect(analyzeRepositoryDocumentClosure(input)).toEqual(result);
  });
});
