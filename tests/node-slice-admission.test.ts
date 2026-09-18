import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitNodeSlice,
  assertAncestorClosure,
  backfillLegacySliceAdmissions,
  NodeSliceAdmissionError,
} from "../src/runtime/node-slice-admission.ts";
import { sliceAdmissionPreimage } from "../src/schema/node-slice-admission.ts";

const subject = "git-sha1:0123456789abcdef0123456789abcdef01234567" as const;
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const priorHead = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
const receiptDigest = (
  slice: string,
  predecessorValue: string | null,
  revision: string,
  inputs: string[],
  decision: string,
  producer: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "node-slice-admission.v1",
        slice,
        predecessorValue,
        revision,
        inputs,
        decision,
        producer,
      ]),
    )
    .digest("hex");
const predecessor = receiptDigest("f0a", null, subject, [], "approved", "f0a-toolchain-owner");

describe("F0b slice admission kernel", () => {
  it("approves only the registered producer and exact F0b input", () => {
    const result = admitNodeSlice({
      slice_id: "f0b",
      subject_revision: subject,
      predecessor_receipt_digest: predecessor,
      required_input_receipt_digests: ["b".repeat(64)],
      requiredInputs: [
        {
          digest: "b".repeat(64),
          kind: "f0b.sealed-generation",
          producer: "f0b-sealed-build-owner",
          subject_revision: subject,
          decision: "approved",
        },
      ],
      producer: "f0b-sealed-build-owner",
      history: [
        {
          schema_version: "node-slice-admission.v1",
          slice_id: "f0a",
          predecessor_receipt_digest: null,
          subject_revision: subject,
          required_input_receipt_digests: [],
          decision: "approved",
          producer: "f0a-toolchain-owner",
          receipt_digest: receiptDigest(
            "f0a",
            null,
            subject,
            [],
            "approved",
            "f0a-toolchain-owner",
          ),
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.receipt.schema_version).toBe("node-slice-admission.v1");
    expect(sliceAdmissionPreimage(result.receipt).startsWith("[")).toBe(true);
  });

  it("rejects wrong producer, replay, rejected input and duplicate input", () => {
    const base = {
      slice_id: "f0b" as const,
      subject_revision: subject,
      predecessor_receipt_digest: predecessor,
      required_input_receipt_digests: ["b".repeat(64)],
      producer: "f0b-sealed-build-owner" as const,
    };
    expect(admitNodeSlice({ ...base, producer: "f0a-toolchain-owner" }).reason).toBe(
      "wrong-producer",
    );
    const prior = {
      schema_version: "node-slice-admission.v1" as const,
      slice_id: "f0a" as const,
      predecessor_receipt_digest: null,
      subject_revision: subject,
      required_input_receipt_digests: [],
      decision: "approved" as const,
      producer: "f0a-toolchain-owner" as const,
      receipt_digest: receiptDigest("f0a", null, subject, [], "approved", "f0a-toolchain-owner"),
    };
    const approved = admitNodeSlice({
      ...base,
      history: [
        {
          schema_version: "node-slice-admission.v1",
          slice_id: "f0b",
          predecessor_receipt_digest: predecessor,
          subject_revision: subject,
          required_input_receipt_digests: ["b".repeat(64)],
          decision: "approved",
          producer: "f0b-sealed-build-owner",
          receipt_digest: receiptDigest(
            "f0b",
            predecessor,
            subject,
            ["b".repeat(64)],
            "approved",
            "f0b-sealed-build-owner",
          ),
        },
        prior,
      ],
      requiredInputs: [
        {
          digest: "b".repeat(64),
          kind: "f0b.sealed-generation",
          producer: "f0b-sealed-build-owner",
          subject_revision: subject,
          decision: "approved",
        },
      ],
    });
    expect(approved.reason).toBe("replay");
    expect(
      admitNodeSlice({
        ...base,
        history: [prior],
        required_input_receipt_digests: ["b".repeat(64), "b".repeat(64)],
      }).reason,
    ).toBe("required-input-set-mismatch");
    expect(
      admitNodeSlice({
        ...base,
        history: [prior],
        requiredInputs: [
          {
            digest: "b".repeat(64),
            kind: "f0b.sealed-generation",
            producer: "f0b-sealed-build-owner",
            subject_revision: subject,
            decision: "rejected",
          },
        ],
      }).reason,
    ).toBe("rejected-prerequisite");
  });

  it("fails closed for raw revisions", () => {
    expect(() =>
      admitNodeSlice({
        slice_id: "f0b",
        subject_revision: "0123456789abcdef0123456789abcdef01234567",
        predecessor_receipt_digest: predecessor,
        required_input_receipt_digests: ["b".repeat(64)],
        producer: "f0b-sealed-build-owner",
      }),
    ).toThrow(NodeSliceAdmissionError);
  });

  it("CAND-NODEBOOT-018 reconstructs the exact legacy D0/F0a pair atomically", () => {
    const repoRoot = process.cwd();
    rmSync(resolve(repoRoot, ".ut-tdd", "ledger", "cutover-ledger.db"), { force: true });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = backfillLegacySliceAdmissions({
      repoRoot,
      candidateRevision: candidate,
      commandAuthority: "#484",
    });
    expect(result.exactly_once).toBe(true);
    expect(result.state.d0?.records).toHaveLength(4);
    expect(result.state.f0a?.git_rows).toHaveLength(8);
    expect(result.state.d0?.family_status).toBe("unverified_family");
    expect(result.state.f0a?.review_authority).toBe("none");
    expect(() =>
      backfillLegacySliceAdmissions({
        repoRoot,
        candidateRevision: candidate,
        commandAuthority: "#484",
      }),
    ).toThrow("legacy-backfill-replay");
  });

  it("CAND-NODEBOOT-018 rejects wrong authority and incomplete typed evidence", () => {
    expect(() =>
      backfillLegacySliceAdmissions({
        repoRoot: process.cwd(),
        candidateRevision: head,
        commandAuthority: "opus",
      }),
    ).toThrow("wrong-command-authority");
    expect(
      admitNodeSlice({
        slice_id: "f0b",
        subject_revision: subject,
        predecessor_receipt_digest: predecessor,
        required_input_receipt_digests: ["b".repeat(64)],
        producer: "f0b-sealed-build-owner",
        requiredInputs: [],
        history: [
          {
            schema_version: "node-slice-admission.v1",
            slice_id: "f0a",
            predecessor_receipt_digest: null,
            subject_revision: subject,
            required_input_receipt_digests: [],
            decision: "approved",
            producer: "f0a-toolchain-owner",
            receipt_digest: predecessor,
          },
        ],
      }).reason,
    ).toBe("required-input-evidence-mismatch");
  });

  it("CAND-NODEBOOT-018 rejects a complete-history non-ancestor", () => {
    // The immediate parent is guaranteed to exist in the CI checkout while
    // remaining a valid complete-history non-ancestor of the current HEAD.
    expect(() => assertAncestorClosure(process.cwd(), [head], priorHead)).toThrow("not_ancestor");
  });

  it("CAND-NODEBOOT-019 rejects missing, failed, and cross-revision F0b evidence for F0c", () => {
    const f0cEvidence = {
      digest: "c".repeat(64),
      kind: "f0c.os-jobs",
      producer: "f0c-ci-owner",
      subject_revision: subject,
      decision: "approved" as const,
    };
    const f0bReceipt = receiptDigest(
      "f0b",
      predecessor,
      subject,
      ["c".repeat(64)],
      "approved",
      "f0b-sealed-build-owner",
    );
    const base = {
      slice_id: "f0c" as const,
      subject_revision: subject,
      predecessor_receipt_digest: f0bReceipt,
      required_input_receipt_digests: ["c".repeat(64)],
      producer: "f0c-ci-owner" as const,
      history: [
        {
          schema_version: "node-slice-admission.v1" as const,
          slice_id: "f0b" as const,
          predecessor_receipt_digest: predecessor,
          subject_revision: subject,
          required_input_receipt_digests: ["c".repeat(64)],
          decision: "approved" as const,
          producer: "f0b-sealed-build-owner" as const,
          receipt_digest: f0bReceipt,
        },
      ],
    };
    expect(admitNodeSlice(base).reason).toBe("required-input-evidence-mismatch");
    expect(
      admitNodeSlice({
        ...base,
        requiredInputs: [f0cEvidence],
        history: [
          {
            ...base.history[0],
            decision: "rejected" as const,
            receipt_digest: receiptDigest(
              "f0b",
              predecessor,
              subject,
              ["c".repeat(64)],
              "rejected",
              "f0b-sealed-build-owner",
            ),
          },
        ],
        predecessor_receipt_digest: receiptDigest(
          "f0b",
          predecessor,
          subject,
          ["c".repeat(64)],
          "rejected",
          "f0b-sealed-build-owner",
        ),
      }).reason,
    ).toBe("rejected-prerequisite");
    const crossSubject = "git-sha1:fedcba9876543210fedcba9876543210fedcba98";
    const crossRevisionReceipt = receiptDigest(
      "f0b",
      predecessor,
      crossSubject,
      ["c".repeat(64)],
      "approved",
      "f0b-sealed-build-owner",
    );
    expect(
      admitNodeSlice({
        ...base,
        predecessor_receipt_digest: crossRevisionReceipt,
        requiredInputs: [f0cEvidence],
        history: [
          {
            ...base.history[0],
            subject_revision: crossSubject,
            receipt_digest: crossRevisionReceipt,
          },
        ],
      }).reason,
    ).toBe("predecessor-subject-mismatch");
  });
});
