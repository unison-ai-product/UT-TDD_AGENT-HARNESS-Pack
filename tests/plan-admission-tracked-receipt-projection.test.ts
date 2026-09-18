import { describe, expect, it } from "vitest";
import {
  parseTrackedReceiptProjection,
  trackedReceiptRecordDigest,
} from "../src/plan-admission/tracked-receipt-projection.ts";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

function record(sequence: number, previousRecordDigest: string | null, suffix: string) {
  const unsigned = {
    sequence,
    previousRecordDigest,
    commandId: `cmd-${suffix}`,
    receiptId: `receipt-${suffix}`,
    receiptDigest: sha("a"),
    decisionDigest: sha("b"),
    binding: {
      path: `docs/plans/PLAN-L7-${suffix}-fixture.md`,
      planId: `PLAN-L7-${suffix}-fixture`,
      assetId: `plan:l7:${suffix}`,
      revision: sequence,
      contentDigest: sha("c"),
    },
  };
  return { ...unsigned, recordDigest: trackedReceiptRecordDigest(unsigned) };
}

function json(records: ReturnType<typeof record>[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: "ut-tdd.plan-admission-receipts/v1",
    records: records.map((item) => ({
      sequence: item.sequence,
      previous_record_digest: item.previousRecordDigest,
      record_digest: item.recordDigest,
      command_id: item.commandId,
      receipt_id: item.receiptId,
      receipt_digest: item.receiptDigest,
      decision_digest: item.decisionDigest,
      binding: {
        path: item.binding.path,
        plan_id: item.binding.planId,
        asset_id: item.binding.assetId,
        revision: item.binding.revision,
        content_digest: item.binding.contentDigest,
      },
    })),
    ...extra,
  });
}

describe("tracked admission receipt projection", () => {
  it("U-PADM-014: strict projectionを検証しcommand lookupを提供する", () => {
    const first = record(1, null, "91");
    const second = record(2, first.recordDigest, "92");
    // sealed lineage 移行後の successor asset は同一 path の revision 番号を 1 から
    // 再開する (issue #143 / PLAN-RECOVERY-16 §2)。一意性は (path, asset, revision) で
    // 判定し、別 asset の同 path・同 revision を重複扱いしない。
    const successorBase = record(3, second.recordDigest, "91");
    const successorUnsigned = {
      ...successorBase,
      commandId: "cmd-91-successor",
      receiptId: "receipt-91-successor",
      binding: {
        ...successorBase.binding,
        assetId: "plan:rebase:91-successor",
        revision: 1,
      },
    };
    const { recordDigest: _unsignedDigest, ...successorInput } = successorUnsigned;
    const successor = {
      ...successorUnsigned,
      recordDigest: trackedReceiptRecordDigest(successorInput),
    };
    const result = parseTrackedReceiptProjection(json([first, second, successor]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lookup("cmd-92")?.binding.revision).toBe(2);
    expect(result.value.lookup("cmd-91-successor")?.binding.assetId).toBe(
      "plan:rebase:91-successor",
    );
    expect(result.value).toMatchObject({
      integrity: "hash_chain_verified",
      issuerAuthenticity: "not_verified",
    });
  });

  it("U-PADM-015: chain改ざん、非canonical順序、重複bindingをfail-closeする", () => {
    const first = record(1, null, "91");
    const duplicateBase = record(2, sha("d"), "91");
    const duplicateUnsigned = {
      ...duplicateBase,
      binding: { ...duplicateBase.binding, revision: 1 },
    };
    const { recordDigest: _discarded, ...digestInput } = duplicateUnsigned;
    const duplicate = {
      ...duplicateUnsigned,
      recordDigest: trackedReceiptRecordDigest(digestInput),
    };
    const result = parseTrackedReceiptProjection(json([first, duplicate]));
    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "record[1]:previous-record-digest-mismatch",
        "record[1]:path-revision-duplicate",
      ]),
    });
    const outOfOrder = record(3, first.recordDigest, "93");
    expect(parseTrackedReceiptProjection(json([first, outOfOrder]))).toEqual({
      ok: false,
      errors: expect.arrayContaining(["record[1]:sequence-not-canonical"]),
    });
  });

  it("U-PADM-016: short hash、PLAN外path、unknown fieldを拒否する", () => {
    const first = record(1, null, "91");
    const raw = JSON.parse(json([first])) as { records: Array<Record<string, unknown>> };
    raw.records[0].receipt_digest = "sha256:abcd";
    expect(parseTrackedReceiptProjection(JSON.stringify(raw))).toEqual({
      ok: false,
      errors: expect.arrayContaining(["record[0]:field-invalid"]),
    });
    expect(parseTrackedReceiptProjection(json([first], { unexpected: true }))).toEqual({
      ok: false,
      errors: ["projection-root-shape-invalid"],
    });
  });
});
