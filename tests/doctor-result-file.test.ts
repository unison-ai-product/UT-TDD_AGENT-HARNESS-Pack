/**
 * PLAN-L7-461 スコープ1: doctor 二重実行の解消。
 *
 * envelope の採用条件は「同一 HEAD かつ full scope」では不足する。doctor の出力は実行環境に
 * 依存し (memory-sync は origin ref、merged-plan-status は default branch SHA、CI step は
 * strict flag 付き)、弱い条件で採用すると **別条件で測った結果を fence の assertion に流し込む**。
 * advisor (gpt-5.6-sol、敵対検証 2026-07-29) がこの弱条件を refuted としたため、
 * 宣言済み portable surface (producer root / ref map / options / check ID 集合) と
 * producer command/version の完全一致を要求する。checkout と detached snapshot の
 * gitignored state や process 環境が同値だとは主張しない。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFullDoctorCheckDefinitions } from "../src/doctor/check-definitions.ts";
import { runDoctorMeasured } from "../src/doctor/index.ts";
import {
  buildDoctorResultEnvelope,
  canonicalRepoRoot,
  DOCTOR_RESULT_ENVELOPE_SCHEMA_VERSION,
  doctorResultEnvelopeUsability,
  doctorResultPayloadDigest,
  doctorResultProducerIdentity,
  parseDoctorResultEnvelope,
  writeDoctorResultEnvelopeFile,
} from "../src/doctor/result-file.ts";
import { nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import { defaultBranchRefMap, headSha } from "../src/git/default-branch.ts";
import { consumeDoctorResultEnvelopeWithReason } from "./support/doctor-envelope.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const RESULT = { ok: true, messages: ["doctor: rule-drift — OK"] };
const REF_MAP = { "refs/remotes/origin/main": "b155171cf23d619751c01f11a2630334adb74f9c" };
const OPTIONS = {
  strict_green_command_digest: true,
  strict_telemetry_provenance: false,
  timing: false,
};
const CHECK_IDS = ["memory-sync", "merged-plan-status", "rule-drift"];
const PRODUCER = { command: "ut-tdd doctor", version: "0.1.0" };

const envelope = (overrides: Record<string, unknown> = {}) => ({
  ...buildDoctorResultEnvelope({
    headSha: "a".repeat(40),
    scope: "full",
    profile: null,
    producerRoot: "/tmp/ut-tdd-head-snapshot",
    refMap: REF_MAP,
    options: OPTIONS,
    checkIds: CHECK_IDS,
    producer: PRODUCER,
    result: RESULT,
  }),
  ...overrides,
});

const usability = (overrides: Record<string, unknown> = {}) =>
  doctorResultEnvelopeUsability({
    envelope: envelope(),
    expectedHeadSha: "a".repeat(40),
    expectedProducerRoot: "/tmp/ut-tdd-head-snapshot",
    expectedRefMap: REF_MAP,
    expectedOptions: OPTIONS,
    expectedCheckIds: CHECK_IDS,
    expectedProducer: PRODUCER,
    ci: true,
    ...overrides,
  });

describe("doctor result envelope (PLAN-L7-461)", () => {
  it("U-DOCTORENV-001: accepts only an envelope with the same declared surface and producer", () => {
    expect(usability()).toEqual({
      usable: true,
      reason: "same-declared-surface-producer-measurement",
    });
  });

  it("U-DOCTORENV-002: refuses to treat a local artifact as authoritative", () => {
    // ローカルでは環境変数が指すファイルを権威にしない (CI 内信頼境界の外)。
    expect(usability({ ci: false })).toEqual({ usable: false, reason: "not-ci-context" });
  });

  it("U-DOCTORENV-003: fails closed when the observation surface differs", () => {
    expect(usability({ expectedHeadSha: "b".repeat(40) }).usable).toBe(false);
    expect(usability({ expectedProducerRoot: "/tmp/other-root" })).toEqual({
      usable: false,
      reason: "producer-root-mismatch:/tmp/ut-tdd-head-snapshot",
    });
    expect(usability({ expectedRefMap: {} })).toEqual({
      usable: false,
      reason: "ref-map-mismatch",
    });
    expect(usability({ expectedRefMap: { "refs/remotes/origin/main": "c".repeat(40) } })).toEqual({
      usable: false,
      reason: "ref-map-mismatch",
    });
    expect(
      usability({
        expectedOptions: {
          strict_green_command_digest: false,
          strict_telemetry_provenance: false,
          timing: false,
        },
      }),
    ).toEqual({ usable: false, reason: "options-mismatch" });
    expect(usability({ expectedCheckIds: ["rule-drift"] })).toEqual({
      usable: false,
      reason: "check-id-set-mismatch",
    });
    expect(usability({ expectedProducer: { command: "ut-tdd doctor", version: "0.2.0" } })).toEqual(
      { usable: false, reason: "producer-mismatch" },
    );
  });

  it("U-DOCTORENV-004: fails closed for a narrowed check set even at the same head", () => {
    expect(usability({ envelope: envelope({ scope: "toolchain" }) })).toEqual({
      usable: false,
      reason: "scope-not-full:toolchain",
    });
    expect(usability({ envelope: envelope({ profile: "consumer-toolchain" }) })).toEqual({
      usable: false,
      reason: "profile-set:consumer-toolchain",
    });
  });

  it("U-DOCTORENV-005: detects a corrupted payload through the digest", () => {
    const tampered = envelope({ result: { ok: true, messages: ["doctor: fabricated — OK"] } });
    expect(usability({ envelope: tampered })).toEqual({
      usable: false,
      reason: "payload-digest-mismatch",
    });
    // digest は破損検出であって真正性の証明ではない (再計算すれば通る)。契約として固定する。
    const recomputed = envelope({
      result: { ok: true, messages: ["doctor: fabricated — OK"] },
      payload_digest: doctorResultPayloadDigest({
        ok: true,
        messages: ["doctor: fabricated — OK"],
      }),
    });
    expect(usability({ envelope: recomputed }).usable).toBe(true);
  });

  it("U-DOCTORENV-006: rejects an envelope that is missing any required field", () => {
    const full = JSON.stringify(envelope());
    expect(parseDoctorResultEnvelope(full)).not.toBeNull();
    expect(parseDoctorResultEnvelope("{")).toBeNull();
    for (const key of [
      "head_sha",
      "scope",
      "producer_root",
      "ref_map",
      "options",
      "check_ids",
      "producer",
      "payload_digest",
      "result",
    ]) {
      const partial = JSON.parse(full) as Record<string, unknown>;
      delete partial[key];
      expect(parseDoctorResultEnvelope(JSON.stringify(partial)), `missing ${key}`).toBeNull();
    }
    // 省略された option を「偽」と推測しない。
    const partialOptions = JSON.parse(full) as Record<string, unknown>;
    partialOptions.options = { timing: false };
    expect(parseDoctorResultEnvelope(JSON.stringify(partialOptions))).toBeNull();
  });

  it("U-DOCTORENV-006a: rejects unknown fields at every closed schema boundary", () => {
    for (const mutate of [
      (candidate: Record<string, unknown>) => {
        candidate.unknown = true;
      },
      (candidate: Record<string, unknown>) => {
        (candidate.options as Record<string, unknown>).unknown = true;
      },
      (candidate: Record<string, unknown>) => {
        (candidate.producer as Record<string, unknown>).unknown = true;
      },
      (candidate: Record<string, unknown>) => {
        (candidate.result as Record<string, unknown>).unknown = true;
      },
    ]) {
      const candidate = JSON.parse(JSON.stringify(envelope())) as Record<string, unknown>;
      mutate(candidate);
      expect(parseDoctorResultEnvelope(JSON.stringify(candidate))).toBeNull();
    }
  });

  it("U-DOCTORENV-006b: validates timing shape and binds timings into the digest", () => {
    const timedResult = {
      ok: true,
      messages: ["doctor: timed — OK"],
      timings: [{ id: "rule-drift", duration_ms: 1.25, ok: true, message_count: 1 }],
    };
    const timed = envelope({
      options: {
        strict_green_command_digest: true,
        strict_telemetry_provenance: false,
        timing: true,
      },
      result: timedResult,
      payload_digest: doctorResultPayloadDigest(timedResult),
    });
    expect(parseDoctorResultEnvelope(JSON.stringify(timed))).not.toBeNull();
    const malformed = {
      ...timed,
      result: { ...timedResult, timings: [{ ...timedResult.timings[0], extra: true }] },
    };
    expect(parseDoctorResultEnvelope(JSON.stringify(malformed))).toBeNull();
    const tampered = {
      ...timed,
      result: {
        ...timedResult,
        timings: [{ ...timedResult.timings[0], duration_ms: 99 }],
      },
    };
    expect(
      usability({
        envelope: parseDoctorResultEnvelope(JSON.stringify(tampered)),
        expectedOptions: {
          strict_green_command_digest: true,
          strict_telemetry_provenance: false,
          timing: true,
        },
      }),
    ).toEqual({ usable: false, reason: "payload-digest-mismatch" });
  });

  it("U-DOCTORENV-007: rejects a stale schema version", () => {
    expect(DOCTOR_RESULT_ENVELOPE_SCHEMA_VERSION).toBe("v4");
    expect(usability({ envelope: envelope({ schema_version: "v2" }) })).toEqual({
      usable: false,
      reason: "schema-version-mismatch:v2",
    });
    expect(usability({ envelope: null })).toEqual({
      usable: false,
      reason: "envelope-missing-or-unreadable",
    });
  });
});

/**
 * consumer 側の回帰 (PLAN-L7-461)。CI で観測面が一致したときだけ採用し、
 * 宣言不足・読めない・非 CI・面の不一致では null を返して呼び出し側を自走させる。
 */
describe("doctor envelope consumption (PLAN-L7-461)", () => {
  const snapshotRoot = headSnapshotRoot();
  // 実ファイルは書かない (head snapshot 由来の値を書き込む経路を作らないため、
  // test-repository-isolation の forbidden-live-root-source を構造的に避ける)。
  const envelopeJson = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ...buildDoctorResultEnvelope({
        headSha: headSha(snapshotRoot) ?? "",
        scope: "full",
        profile: null,
        producerRoot: canonicalRepoRoot(snapshotRoot),
        refMap: defaultBranchRefMap(snapshotRoot),
        options: OPTIONS,
        checkIds: buildFullDoctorCheckDefinitions(nodeDoctorDeps(snapshotRoot)).map((d) => d.id),
        producer: doctorResultProducerIdentity(snapshotRoot),
        result: { ok: true, messages: ["doctor: consumed-envelope OK"] },
      }),
      ...overrides,
    });
  const reader = (json: string) => ({ readFile: () => json });
  const missingReader = {
    readFile: () => {
      throw new Error("ENOENT");
    },
  };
  const env = (overrides: Record<string, string> = {}) => ({
    CI: "true",
    UT_TDD_DOCTOR_RESULT_FILE: "/tmp/ut-tdd-doctor-result.json",
    UT_TDD_DOCTOR_RESULT_ROOT: snapshotRoot,
    UT_TDD_DOCTOR_RESULT_STRICT: "1",
    ...overrides,
  });

  it("U-DOCTORENV-008: consumes the envelope when the declared surface matches", () => {
    const consumed = consumeDoctorResultEnvelopeWithReason(env(), reader(envelopeJson()));
    expect(consumed.reason).toBe("accepted");
    expect(consumed.result?.messages).toEqual(["doctor: consumed-envelope OK"]);
  });

  it("U-DOCTORENV-009: falls back to a self-run instead of trusting a partial declaration", () => {
    const json = envelopeJson();
    expect(consumeDoctorResultEnvelopeWithReason({ CI: "true" }, reader(json))).toEqual({
      result: null,
      reason: "envelope-not-declared",
    });
    expect(consumeDoctorResultEnvelopeWithReason(env(), missingReader).reason).toBe(
      "envelope-unreadable",
    );
    expect(consumeDoctorResultEnvelopeWithReason(env({ CI: "false" }), reader(json)).reason).toBe(
      "not-ci-context",
    );
    expect(
      consumeDoctorResultEnvelopeWithReason(env({ UT_TDD_DOCTOR_RESULT_STRICT: "0" }), reader(json))
        .reason,
    ).toBe("options-mismatch");
    expect(
      consumeDoctorResultEnvelopeWithReason(
        env({ UT_TDD_DOCTOR_RESULT_ROOT: "/tmp/other-root" }),
        reader(json),
      ).reason,
    ).toBe(`producer-root-mismatch:${canonicalRepoRoot(snapshotRoot)}`);
  });

  it("U-DOCTORENV-010: refuses an envelope measured at another head", () => {
    const json = envelopeJson({ head_sha: "f".repeat(40) });
    expect(consumeDoctorResultEnvelopeWithReason(env(), reader(json)).reason).toBe(
      `head-sha-mismatch:${"f".repeat(40)}`,
    );
  });
});

describe("doctor check set equivalence across the single-run switch (PLAN-L7-461 AC-2)", () => {
  it("U-DOCTORENV-011: never accepts a measurement whose check set is narrower than the fence expects", () => {
    const snapshotRoot = headSnapshotRoot();
    const fullIds = buildFullDoctorCheckDefinitions(nodeDoctorDeps(snapshotRoot)).map((d) => d.id);
    expect(fullIds.length).toBeGreaterThan(50);
    expect(new Set(fullIds).size).toBe(fullIds.length);

    const narrowed = fullIds.slice(0, fullIds.length - 1);
    const measured = buildDoctorResultEnvelope({
      headSha: "a".repeat(40),
      scope: "full",
      profile: null,
      producerRoot: "/tmp/root",
      refMap: {},
      options: OPTIONS,
      checkIds: narrowed,
      producer: { command: "ut-tdd doctor", version: "test" },
      result: { ok: true, messages: [] },
    });

    expect(
      doctorResultEnvelopeUsability({
        envelope: measured,
        expectedHeadSha: "a".repeat(40),
        expectedProducerRoot: "/tmp/root",
        expectedRefMap: {},
        expectedOptions: OPTIONS,
        expectedCheckIds: fullIds,
        expectedProducer: { command: "ut-tdd doctor", version: "test" },
        ci: true,
      }),
    ).toEqual({ usable: false, reason: "check-id-set-mismatch" });
  });
});

describe("doctor result envelope measured surface (PLAN-L7-484)", () => {
  it("U-DOCTORENV-012: reports the resolved setup-smoke profile and only its executed check", () => {
    const measured = runDoctorMeasured(nodeDoctorDeps(headSnapshotRoot()), { setupSmoke: true });
    expect(measured.profile.id).toBe("consumer-setup-smoke");
    expect(measured.checkIds).toEqual(["setup-smoke"]);
  });

  it("U-DOCTORENV-013: writes supplied measured check IDs without rebuilding the full registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-envelope-"));
    const file = join(dir, "result.json");
    try {
      writeDoctorResultEnvelopeFile(file, headSnapshotRoot(), {
        scope: "setup-smoke",
        profile: "consumer-setup-smoke",
        options: OPTIONS,
        checkIds: ["setup-smoke"],
        result: RESULT,
      });
      const written = parseDoctorResultEnvelope(readFileSync(file, "utf8"));
      expect(written?.check_ids).toEqual(["setup-smoke"]);
      expect(written?.scope).toBe("setup-smoke");
      expect(written?.profile).toBe("consumer-setup-smoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("U-DOCTORENV-014: rejects a strict telemetry option mismatch", () => {
    expect(
      usability({
        expectedOptions: { ...OPTIONS, strict_telemetry_provenance: true },
      }),
    ).toEqual({ usable: false, reason: "options-mismatch" });
  });

  it("U-DOCTORENV-015: a setup-smoke measurement cannot be consumed as full", () => {
    expect(
      usability({
        envelope: envelope({
          scope: "setup-smoke",
          profile: "consumer-setup-smoke",
          check_ids: ["setup-smoke"],
        }),
      }),
    ).toEqual({ usable: false, reason: "scope-not-full:setup-smoke" });
  });
});
