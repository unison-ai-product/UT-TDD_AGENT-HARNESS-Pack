/**
 * doctor 実測結果の受け渡し artifact (PLAN-L7-461 スコープ1: doctor 二重実行の解消)。
 *
 * CI の linux leg では同一 HEAD に対する governance doctor が 2 回走っている:
 * CI step `doctor (governance hard gates)` (実測 50s) と、vitest 内の
 * `runDoctor(nodeDoctorDeps(headSnapshotRoot()))` (実測 114s)。後者は PLAN-L7-95 の
 * invocation fence であり、assertion 対象は「real repo に対する doctor 実行の messages」
 * そのもの。成果物の生産者を in-process 実行から CI step の artifact へ替えれば、
 * assertion を変えずに重複実行だけを消せる。
 *
 * ただし **doctor の出力は実行環境に依存する**。実測 (2026-07-29):
 * - `memory-sync` は `git ls-tree origin/main` に依存する。
 * - `merged-plan-status` は default branch の ref/SHA を解決できないと throw する (issue #186)。
 * - CI step は `--strict-green-command-digest` 付き、vitest 側は無しで検査集合が異なる。
 *
 * したがって「同一 HEAD かつ full scope」だけでは消費可否を判定できない (advisor
 * `gpt-5.6-sol` の敵対検証 2026-07-29 でこの弱い条件は refuted)。envelope は
 * producer が再利用に必要な **宣言済みportable surface** を持ち、consumer 側の期待と
 * 完全一致したときだけ採用する。gitignored runtime stateやprocess環境まで同値とは主張しない。
 * envelopeは同一job内のproducer測定receiptであり、detached snapshotの再測定ではない。
 *
 * 信頼境界: 同一 CI job 内の信頼済み step 間の受け渡しなので暗号署名は置かない
 * (鍵も同じ job に置く署名は同 job のコードに対して実効性が無い)。代わりに
 * **CI 文脈でのみ採用**し、ローカルでは権威にしない。`payload_digest` は破損検出であり
 * 真正性の証明ではない。
 *
 * fail-close の原則: 欠落・不一致・不明フィールド・非 CI 文脈は **必ず自走 (full runDoctor)**
 * へ落ちる。「artifact があるから信じる」経路は作らない。
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultBranchRefMap, headSha } from "../git/default-branch.ts";
import { ensureDir } from "../shared/fs.ts";
import type { DoctorRunProfileId, DoctorScope } from "./profiles.ts";
import type { DoctorResult } from "./result.ts";

export const DOCTOR_RESULT_ENVELOPE_SCHEMA_VERSION = "v4";

/** artifact のパスを渡す環境変数 (CI の doctor step が書き、vitest が読む)。 */
export const DOCTOR_RESULT_FILE_ENV = "UT_TDD_DOCTOR_RESULT_FILE";

export type DoctorResultEnvelopeScope = DoctorScope | "setup-smoke";

/** producer が実際に適用した option 集合。既定値も明示的に持つ (省略を「偽」と推測しない)。 */
export interface DoctorRunOptions {
  strict_green_command_digest: boolean;
  strict_telemetry_provenance: boolean;
  timing: boolean;
}

export interface DoctorResultEnvelope {
  schema_version: string;
  /** 実行時の HEAD sha。 */
  head_sha: string;
  /** full 以外 (toolchain 等) は検査集合が縮むため消費してはならない。 */
  scope: string;
  /** named profile 付き実行は検査集合が異なるため消費してはならない。 */
  profile: string | null;
  /** doctor を回したproducer checkoutのcanonical path。snapshot同値性は表さない。 */
  producer_root: string;
  /** 観測時に解決できた ref→SHA (ref 依存 check の入力同一性)。 */
  ref_map: Record<string, string>;
  /** 実際に適用した option 集合。 */
  options: DoctorRunOptions;
  /** 実行した check ID の集合 (sorted)。consumer の期待集合と完全一致を要求する。 */
  check_ids: string[];
  /** producer の識別 (command 名と version)。 */
  producer: { command: string; version: string };
  /** result の canonical JSON に対する sha256 (破損検出)。 */
  payload_digest: string;
  result: DoctorResult;
}

export interface EnvelopeUsability {
  usable: boolean;
  /** 採用しなかった理由 (自走へ落ちた理由の説明に使う。空文字は返さない)。 */
  reason: string;
}

/** result の canonical 表現。key 順を固定して digest を安定させる。 */
export function doctorResultPayloadDigest(result: DoctorResult): string {
  const canonical = JSON.stringify({
    ok: result.ok,
    messages: result.messages,
    ...(result.timings ? { timings: result.timings } : {}),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function buildDoctorResultEnvelope(input: {
  headSha: string;
  scope: DoctorResultEnvelopeScope;
  profile?: DoctorRunProfileId | null;
  producerRoot: string;
  refMap: Record<string, string>;
  options: DoctorRunOptions;
  checkIds: readonly string[];
  producer: { command: string; version: string };
  result: DoctorResult;
}): DoctorResultEnvelope {
  return {
    schema_version: DOCTOR_RESULT_ENVELOPE_SCHEMA_VERSION,
    head_sha: input.headSha,
    scope: input.scope,
    profile: input.profile ?? null,
    producer_root: input.producerRoot,
    ref_map: { ...input.refMap },
    options: { ...input.options },
    check_ids: [...input.checkIds].sort(),
    producer: { ...input.producer },
    payload_digest: doctorResultPayloadDigest(input.result),
    result: input.result,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isDoctorTimings(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((timing) => {
    if (
      !hasExactKeys(timing, ["duration_ms", "id", "message_count", "ok", "substeps"]) &&
      !hasExactKeys(timing, ["duration_ms", "id", "message_count", "ok"])
    ) {
      return false;
    }
    if (
      typeof timing.id !== "string" ||
      typeof timing.duration_ms !== "number" ||
      typeof timing.ok !== "boolean" ||
      typeof timing.message_count !== "number"
    ) {
      return false;
    }
    if (!("substeps" in timing)) return true;
    return (
      Array.isArray(timing.substeps) &&
      timing.substeps.every(
        (substep) =>
          hasExactKeys(substep, ["duration_ms", "id"]) &&
          typeof substep.id === "string" &&
          typeof substep.duration_ms === "number",
      )
    );
  });
}

/** JSON 文字列を envelope として読む。1 つでも欠けていれば null (呼び出し側は自走へ落ちる)。 */
export function parseDoctorResultEnvelope(raw: string): DoctorResultEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !hasExactKeys(parsed, [
      "check_ids",
      "head_sha",
      "options",
      "payload_digest",
      "producer",
      "producer_root",
      "profile",
      "ref_map",
      "result",
      "schema_version",
      "scope",
    ])
  ) {
    return null;
  }
  const c = parsed as Record<string, unknown>;
  const result = c.result as Record<string, unknown> | undefined;
  const options = c.options as Record<string, unknown> | undefined;
  const producer = c.producer as Record<string, unknown> | undefined;
  if (typeof c.schema_version !== "string") return null;
  if (typeof c.head_sha !== "string" || c.head_sha.trim() === "") return null;
  if (typeof c.scope !== "string") return null;
  if (c.profile !== null && typeof c.profile !== "string") return null;
  if (typeof c.producer_root !== "string" || c.producer_root.trim() === "") return null;
  if (!isStringRecord(c.ref_map)) return null;
  if (
    !hasExactKeys(options, [
      "strict_green_command_digest",
      "strict_telemetry_provenance",
      "timing",
    ]) ||
    typeof options.strict_green_command_digest !== "boolean" ||
    typeof options.strict_telemetry_provenance !== "boolean"
  ) {
    return null;
  }
  if (typeof options.timing !== "boolean") return null;
  if (!Array.isArray(c.check_ids) || c.check_ids.some((id) => typeof id !== "string")) return null;
  if (
    !hasExactKeys(producer, ["command", "version"]) ||
    typeof producer.command !== "string" ||
    typeof producer.version !== "string"
  ) {
    return null;
  }
  if (typeof c.payload_digest !== "string") return null;
  if (
    (!hasExactKeys(result, ["messages", "ok"]) &&
      !hasExactKeys(result, ["messages", "ok", "timings"])) ||
    typeof result.ok !== "boolean" ||
    !Array.isArray(result.messages)
  ) {
    return null;
  }
  if (result.messages.some((message) => typeof message !== "string")) return null;
  if (options.timing !== "timings" in result) return null;
  if ("timings" in result && !isDoctorTimings(result.timings)) return null;
  return {
    schema_version: c.schema_version,
    head_sha: c.head_sha,
    scope: c.scope,
    profile: (c.profile as string | null) ?? null,
    producer_root: c.producer_root,
    ref_map: c.ref_map,
    options: {
      strict_green_command_digest: options.strict_green_command_digest,
      strict_telemetry_provenance: options.strict_telemetry_provenance,
      timing: options.timing,
    },
    check_ids: c.check_ids as string[],
    producer: { command: producer.command, version: producer.version },
    payload_digest: c.payload_digest,
    result: result as unknown as DoctorResult,
  };
}

function sameRefMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => bKeys[index] === key && a[key] === b[key]);
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, index) => id === sortedB[index]);
}

/**
 * envelope をこの検証対象に対して採用してよいか。
 * 採用条件を 1 つでも満たさなければ usable=false で、呼び出し側は full 自走へ落ちる。
 */
export function doctorResultEnvelopeUsability(input: {
  envelope: DoctorResultEnvelope | null;
  /** 消費側が検証したい HEAD (通常は detached HEAD snapshot の sha)。 */
  expectedHeadSha: string;
  /** 同一job内で測定を実行したproducer checkoutのcanonical path。 */
  expectedProducerRoot: string;
  /** 消費側で解決した ref→SHA。 */
  expectedRefMap: Record<string, string>;
  /** 消費側が期待する option 集合。 */
  expectedOptions: DoctorRunOptions;
  /** 消費側が期待する check ID 集合。 */
  expectedCheckIds: readonly string[];
  /** 消費を許可するproducer command/version。 */
  expectedProducer: { command: string; version: string };
  /** CI 文脈か (ローカルでは artifact を権威にしない)。 */
  ci: boolean;
}): EnvelopeUsability {
  const { envelope, expectedHeadSha } = input;
  if (!input.ci) return { usable: false, reason: "not-ci-context" };
  if (!envelope) return { usable: false, reason: "envelope-missing-or-unreadable" };
  if (envelope.schema_version !== DOCTOR_RESULT_ENVELOPE_SCHEMA_VERSION) {
    return { usable: false, reason: `schema-version-mismatch:${envelope.schema_version}` };
  }
  if (!expectedHeadSha.trim()) return { usable: false, reason: "expected-head-sha-unknown" };
  if (envelope.head_sha !== expectedHeadSha) {
    return { usable: false, reason: `head-sha-mismatch:${envelope.head_sha}` };
  }
  if (envelope.scope !== "full") {
    return { usable: false, reason: `scope-not-full:${envelope.scope}` };
  }
  if (envelope.profile !== null)
    return { usable: false, reason: `profile-set:${envelope.profile}` };
  if (envelope.producer_root !== input.expectedProducerRoot) {
    return { usable: false, reason: `producer-root-mismatch:${envelope.producer_root}` };
  }
  if (!sameRefMap(envelope.ref_map, input.expectedRefMap)) {
    return { usable: false, reason: "ref-map-mismatch" };
  }
  if (
    envelope.options.strict_green_command_digest !==
      input.expectedOptions.strict_green_command_digest ||
    envelope.options.strict_telemetry_provenance !==
      input.expectedOptions.strict_telemetry_provenance ||
    envelope.options.timing !== input.expectedOptions.timing
  ) {
    return { usable: false, reason: "options-mismatch" };
  }
  if (!sameIdSet(envelope.check_ids, input.expectedCheckIds)) {
    return { usable: false, reason: "check-id-set-mismatch" };
  }
  if (
    envelope.producer.command !== input.expectedProducer.command ||
    envelope.producer.version !== input.expectedProducer.version
  ) {
    return { usable: false, reason: "producer-mismatch" };
  }
  if (envelope.payload_digest !== doctorResultPayloadDigest(envelope.result)) {
    return { usable: false, reason: "payload-digest-mismatch" };
  }
  return { usable: true, reason: "same-declared-surface-producer-measurement" };
}

// ---------------------------------------------------------------------------
// producer (実測した面ごと書き出す)
// ---------------------------------------------------------------------------

/**
 * 実測結果を envelope として書き出す (PLAN-L7-461 producer 側)。
 *
 * 観測面 (HEAD / root / ref map / options / check ID 集合) を **測った側が申告する**。
 * consumer はこれを自分の期待と完全一致で照合し、1 つでも違えば自走へ落ちる。
 */
export function writeDoctorResultEnvelopeFile(
  filePath: string,
  repoRoot: string,
  input: {
    scope: DoctorResultEnvelopeScope;
    profile: DoctorRunProfileId | null;
    options: DoctorRunOptions;
    checkIds: readonly string[];
    result: DoctorResult;
  },
): void {
  const sha = headSha(repoRoot);
  if (!sha) throw new Error("doctor result envelope requires a resolvable HEAD");
  const envelope = buildDoctorResultEnvelope({
    headSha: sha,
    scope: input.scope,
    profile: input.profile,
    producerRoot: canonicalRepoRoot(repoRoot),
    refMap: defaultBranchRefMap(repoRoot),
    options: input.options,
    checkIds: input.checkIds,
    producer: doctorResultProducerIdentity(repoRoot),
    result: input.result,
  });
  ensureDir(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

/**
 * producer と consumer で同じ正規化を使う (Windows の大小・区切り差で不一致にしない)。
 * 実在しない path でも throw せず正規化だけ行う (存在しない宣言 root は「不一致」として
 * fail-close されるべきで、例外で判定経路ごと落とすべきではない)。
 */
export function canonicalRepoRoot(repoRoot: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(repoRoot);
  } catch {
    resolved = repoRoot;
  }
  const normalized = resolved.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function producerVersion(repoRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function doctorResultProducerIdentity(repoRoot: string): {
  command: string;
  version: string;
} {
  return { command: "ut-tdd doctor", version: producerVersion(repoRoot) };
}
