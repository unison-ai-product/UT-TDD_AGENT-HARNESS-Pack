/**
 * doctor envelope の消費側 (PLAN-L7-461)。
 *
 * CI では同一 job の `doctor (governance hard gates)` step が実測結果を envelope として書き、
 * real-repo fence はそれを消費して doctor の二重実行を避ける。採用条件は、envelope が宣言する
 * portable surface と producer receipt の一致である。gitignored state や process 環境まで同値とは
 * 主張せず、1 つでも違えば `null` を返して呼び出し側を自走させる (fail-close)。
 *
 * ローカルでは採用しない。環境変数が指すファイルを権威にすると、fence が「実測ではなく
 * 差し込まれた JSON」を検証する経路になるため (advisor `gpt-5.6-sol` 2026-07-29 の条件)。
 */

import { readFileSync } from "node:fs";
import { buildFullDoctorCheckDefinitions } from "../../src/doctor/check-definitions.ts";
import type { DoctorResult } from "../../src/doctor/result.ts";
import {
  canonicalRepoRoot,
  DOCTOR_RESULT_FILE_ENV,
  doctorResultEnvelopeUsability,
  doctorResultProducerIdentity,
  parseDoctorResultEnvelope,
} from "../../src/doctor/result-file.ts";
import { nodeDoctorDeps } from "../../src/doctor/runtime-state.ts";
import { defaultBranchRefMap, headSha } from "../../src/git/default-branch.ts";
import { headSnapshotRoot } from "./workspace-roots.ts";

/** producer が申告すべき root (CI の doctor step が回した面)。 */
export const DOCTOR_RESULT_ROOT_ENV = "UT_TDD_DOCTOR_RESULT_ROOT";
/** producer が strict green-command-digest 付きで回したか。 */
export const DOCTOR_RESULT_STRICT_ENV = "UT_TDD_DOCTOR_RESULT_STRICT";

export interface EnvelopeConsumption {
  result: DoctorResult | null;
  /** 採用しなかった理由 (診断用。採用時は "accepted")。 */
  reason: string;
}

export interface EnvelopeConsumerDeps {
  /** envelope の読み取り。テストは実ファイルを書かずにこの口へ差し込む。 */
  readFile: (path: string) => string;
}

const NODE_CONSUMER_DEPS: EnvelopeConsumerDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
};

export function consumeDoctorResultEnvelopeWithReason(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnvelopeConsumerDeps = NODE_CONSUMER_DEPS,
): EnvelopeConsumption {
  const filePath = env[DOCTOR_RESULT_FILE_ENV];
  const declaredRoot = env[DOCTOR_RESULT_ROOT_ENV];
  if (!filePath || !declaredRoot) return { result: null, reason: "envelope-not-declared" };
  let raw: string;
  try {
    raw = deps.readFile(filePath);
  } catch {
    return { result: null, reason: "envelope-unreadable" };
  }
  const snapshotRoot = headSnapshotRoot();
  const usability = doctorResultEnvelopeUsability({
    envelope: parseDoctorResultEnvelope(raw),
    // producer は checkout root、consumer は snapshot root だが、ref 注入により
    // ref 依存 check の入力は一致する。HEAD は snapshot が clone 元と同一 revision。
    expectedHeadSha: headSha(snapshotRoot) ?? "",
    expectedProducerRoot: canonicalRepoRoot(declaredRoot),
    expectedRefMap: defaultBranchRefMap(snapshotRoot),
    expectedOptions: {
      strict_green_command_digest: env[DOCTOR_RESULT_STRICT_ENV] === "1",
      strict_telemetry_provenance: false,
      timing: false,
    },
    expectedCheckIds: buildFullDoctorCheckDefinitions(nodeDoctorDeps(snapshotRoot)).map(
      (definition) => definition.id,
    ),
    expectedProducer: doctorResultProducerIdentity(snapshotRoot),
    ci: env.CI === "true",
  });
  if (!usability.usable) return { result: null, reason: usability.reason };
  const envelope = parseDoctorResultEnvelope(raw);
  return { result: envelope?.result ?? null, reason: "accepted" };
}

export function consumeDoctorResultEnvelope(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnvelopeConsumerDeps = NODE_CONSUMER_DEPS,
): DoctorResult | null {
  const consumption = consumeDoctorResultEnvelopeWithReason(env, deps);
  // 採用/自走のどちらに落ちたかを実測として残す (削減効果の証跡は「消費された」ことに依存し、
  // 黙って自走へ落ちると before/after の差分を誤読するため)。
  if (env[DOCTOR_RESULT_FILE_ENV]) {
    process.stderr.write(`doctor-envelope: ${consumption.reason}
`);
  }
  return consumption.result;
}
