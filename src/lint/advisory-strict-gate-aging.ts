/**
 * advisory-strict-gate-aging (PLAN-L7-420 Step 3) — doctor 自身の「strict 化待ち advisory gate 放置」検出。
 *
 * green-command-digest (PLAN-L7-132) は「hard 化は fake digest 是正後」と宣言したが、CI が
 * `--strict-green-command-digest` 無しで doctor を回し続けた結果、この advisory 状態が導入から
 * 2週間以上放置され、不一致が 30 件→44 件→49 件と再蓄積した (PLAN-L7-420 G-1)。「段階導入」という
 * advisory 状態は、期限も検出機構も無いまま恒久化しうる — fail-open の看板替え。
 *
 * 本検査は「opt-in strict フラグを持つ advisory gate」の既知レジストリを保持し、CI (harness-check.yml)
 * がその strict フラグを常時投入していない gate について、導入日からの経過日数が閾値を超えていないかを
 * 可視化する (`ut-tdd doctor` に常時表示される advisory note、非 blocking)。CI へ strict 投入済みの
 * gate (`promotedInCi: true`) は fail-open リスクが閉じているため対象から外れる。
 *
 * ## promotedInCi 自己検証 (blind review Finding 4, 2026-07-21 是正)
 *
 * `promotedInCi` は元々レジストリの手動 boolean のみで、workflow から strict flag が削除されても
 * 検出できなかった (「レジストリが promoted と言っている」ことと「実際に CI が strict flag を渡している」
 * ことが乖離しうる = 二度目の fail-open 看板替え)。これを防ぐため、`promotedInCi: true` の gate は
 * `.github/workflows/harness-check.yml` の実内容に `strictFlag` 文字列が存在するかを検証し、無ければ
 * その gate を「CI 未昇格扱い」へ実質降格してから aging 判定へ回す (`verifyPromotedGatesAgainstWorkflow`)。
 * workflow を読めない場合は fail-open (従来どおり登録値をそのまま信頼) し、その旨を note で明示する。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** CI workflow ファイルの既定相対パス (repoRoot からの相対)。 */
export const HARNESS_CHECK_WORKFLOW_RELATIVE_PATH = join(
  ".github",
  "workflows",
  "harness-check.yml",
);

/**
 * `.github/workflows/harness-check.yml` の内容を読む。読めない場合 (未 checkout / パス不整合等) は
 * fail-open のため `null` を返す (呼び出し側は「検証できなかった」ことを note として可視化する)。
 */
export function readHarnessCheckWorkflowContent(
  repoRoot: string,
  relativePath: string = HARNESS_CHECK_WORKFLOW_RELATIVE_PATH,
): string | null {
  try {
    return readFileSync(join(repoRoot, relativePath), "utf8");
  } catch {
    return null;
  }
}

export interface AdvisoryStrictGate {
  /** doctor check id (対応する強化対象 check の見出しに揃える)。 */
  id: string;
  /** advisory として (strict 化への opt-in スイッチ付きで) 導入された日 (ISO date, YYYY-MM-DD)。 */
  introducedOn: string;
  /** advisory を hard 化する opt-in CLI フラグ。 */
  strictFlag: string;
  /** CI (harness-check.yml) がこの strict フラグを常時投入しているか。 */
  promotedInCi: boolean;
  /** 由来 PLAN (人間可読の追跡用)。 */
  planRef: string;
  description: string;
}

/**
 * 既知の advisory→strict opt-in gate レジストリ。
 * - green-command-digest: PLAN-L7-420 Step 1/2 で不一致 49 件を是正し CI へ strict 投入済
 *   (promotedInCi=true、fail-open リスク解消)。
 * - db-telemetry-provenance: PLAN-L7-192 で opt-in switch を実装したが runtime capture gap が
 *   残るため CI 投入は期限付き deferral (PLAN-L7-420 §telemetry-provenance strict deferral 参照)。
 */
export const ADVISORY_STRICT_GATES: readonly AdvisoryStrictGate[] = [
  {
    id: "green-command-digest",
    introducedOn: "2026-06-25",
    strictFlag: "--strict-green-command-digest",
    promotedInCi: true,
    planRef: "PLAN-L7-132 / PLAN-L7-194 / PLAN-L7-303 / PLAN-L7-420",
    description:
      "green_command の output_digest が evidence_path の実 hash と一致するかの hard gate",
  },
  {
    id: "db-telemetry-provenance",
    introducedOn: "2026-06-29",
    strictFlag: "--strict-telemetry-provenance",
    promotedInCi: false,
    planRef: "PLAN-L7-192 / PLAN-L7-420",
    description: "populated telemetry table が runtime provenance を持つかの hard gate",
  },
];

export interface AdvisoryGateAgingFinding {
  id: string;
  ageDays: number;
  thresholdDays: number;
  strictFlag: string;
  planRef: string;
}

/** advisory gate が CI 未昇格のまま放置されてよい最大日数 (超えたら warn)。 */
export const ADVISORY_GATE_AGING_THRESHOLD_DAYS = 60;

/**
 * CI 未昇格 (`promotedInCi: false`) の advisory gate のうち、導入日からの経過日数が閾値を超えるものを
 * 返す純関数 (時刻は options.now 注入、既定は現在時刻)。
 */
export function analyzeAdvisoryGateAging(
  gates: readonly AdvisoryStrictGate[] = ADVISORY_STRICT_GATES,
  options: { now?: Date; thresholdDays?: number } = {},
): AdvisoryGateAgingFinding[] {
  const now = options.now ?? new Date();
  const thresholdDays = options.thresholdDays ?? ADVISORY_GATE_AGING_THRESHOLD_DAYS;
  const findings: AdvisoryGateAgingFinding[] = [];
  for (const gate of gates) {
    if (gate.promotedInCi) continue;
    const introduced = new Date(`${gate.introducedOn}T00:00:00Z`);
    if (Number.isNaN(introduced.getTime())) continue;
    const ageDays = Math.floor((now.getTime() - introduced.getTime()) / 86_400_000);
    if (ageDays > thresholdDays) {
      findings.push({
        id: gate.id,
        ageDays,
        thresholdDays,
        strictFlag: gate.strictFlag,
        planRef: gate.planRef,
      });
    }
  }
  return findings.sort((a, b) => b.ageDays - a.ageDays);
}

/** doctor 向け advisory メッセージ (非 blocking)。放置が無ければ OK 行、有れば warn 行。 */
export function advisoryGateAgingMessages(findings: AdvisoryGateAgingFinding[]): string[] {
  if (findings.length === 0) {
    return ["advisory-strict-gate-aging — OK (CI 未昇格の advisory gate はいずれも閾値内)"];
  }
  const detail = findings
    .map(
      (f) =>
        `${f.id} (${f.ageDays}d > ${f.thresholdDays}d、${f.strictFlag} 未 CI 投入、${f.planRef})`,
    )
    .join(", ");
  return [
    `advisory-strict-gate-aging — warn: ${findings.length} 件の advisory gate が閾値日数を超えて` +
      ` CI strict 未昇格のまま放置: ${detail}`,
  ];
}

export interface PromotedGateWorkflowDrift {
  id: string;
  strictFlag: string;
  planRef: string;
}

export interface PromotedGateWorkflowVerification {
  /** 実質降格 (promotedInCi=true だが workflow に flag が見つからなかった) 後の gate 一覧。 */
  adjustedGates: AdvisoryStrictGate[];
  /** レジストリと workflow 実内容が乖離していた gate (registry says promoted but flag missing)。 */
  driftFindings: PromotedGateWorkflowDrift[];
}

/**
 * workflow YAML からコメント部分を除去した実効内容を返す。flag の実在検証がコメント
 * (`# promoted with --strict-...` のような注記) に誤マッチしないようにする (blind review
 * 反例: run 行から flag を消してもコメントに flag 名が残ると昇格扱いのままになる)。
 * `#` 以降を行単位で落とす素朴な実装で足りる — strict flag は常に `run:` コマンド行に
 * 現れ、quoted string 内に `#` を含む run 行は harness-check.yml に存在しない
 * (real fixture test で担保)。
 */
export function stripYamlComments(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

/**
 * `promotedInCi: true` の gate について、`strictFlag` 文字列が `workflowContent` の
 * **コメントを除いた実効内容** に実在するかを検証する純関数。`workflowContent` が `null`
 * (未検証/読めない) の場合は fail-open — レジストリの値をそのまま信頼し、降格もドリフト報告も
 * しない (呼び出し側で「検証できなかった」ことを別途 note する)。
 */
export function verifyPromotedGatesAgainstWorkflow(
  gates: readonly AdvisoryStrictGate[],
  workflowContent: string | null,
): PromotedGateWorkflowVerification {
  if (workflowContent === null) {
    return { adjustedGates: [...gates], driftFindings: [] };
  }
  const effectiveContent = stripYamlComments(workflowContent);
  const adjustedGates: AdvisoryStrictGate[] = [];
  const driftFindings: PromotedGateWorkflowDrift[] = [];
  for (const gate of gates) {
    if (gate.promotedInCi && !effectiveContent.includes(gate.strictFlag)) {
      adjustedGates.push({ ...gate, promotedInCi: false });
      driftFindings.push({ id: gate.id, strictFlag: gate.strictFlag, planRef: gate.planRef });
      continue;
    }
    adjustedGates.push(gate);
  }
  return { adjustedGates, driftFindings };
}

/** workflow ドリフト (registry says promoted but flag missing) 向け doctor note。 */
export function promotedGateWorkflowDriftMessages(
  driftFindings: readonly PromotedGateWorkflowDrift[],
): string[] {
  return driftFindings.map(
    (d) =>
      `advisory-strict-gate-aging — warn: ${d.id} registry says promoted but flag missing from ` +
      `workflow (${d.strictFlag} not found in ${HARNESS_CHECK_WORKFLOW_RELATIVE_PATH}, ${d.planRef})`,
  );
}

/**
 * doctor 向けラッパ。常に non-blocking (ok=true) — 放置の可視化が目的であり、これ自体で doctor を
 * fail させない (閾値超過は個別 gate の PO/TL 判断に委ねる)。
 *
 * `repoRoot` (または直接注入する `workflowContent`) を渡すと、`promotedInCi: true` の gate を
 * `.github/workflows/harness-check.yml` の実内容と突き合わせ、strict flag が消えていれば「CI 未昇格」
 * 扱いへ降格して aging 判定へ回す (blind review Finding 4 是正)。どちらも省略した場合は従来どおり
 * レジストリの `promotedInCi` を無検証で信頼する (呼び出しごとに fs アクセスを強制しない)。
 */
export function checkAdvisoryGateAging(options?: {
  now?: Date;
  thresholdDays?: number;
  gates?: readonly AdvisoryStrictGate[];
  repoRoot?: string;
  /** テスト注入用。`undefined` なら repoRoot から読む。`null` を明示すれば「読めなかった」を模擬できる。 */
  workflowContent?: string | null;
}): { messages: string[]; ok: boolean } {
  const gates = options?.gates ?? ADVISORY_STRICT_GATES;
  const verificationRequested =
    options?.workflowContent !== undefined || options?.repoRoot !== undefined;

  if (!verificationRequested) {
    const findings = analyzeAdvisoryGateAging(gates, options);
    return { messages: advisoryGateAgingMessages(findings), ok: true };
  }

  const workflowContent =
    options?.workflowContent !== undefined
      ? options.workflowContent
      : readHarnessCheckWorkflowContent(options?.repoRoot as string);

  const { adjustedGates, driftFindings } = verifyPromotedGatesAgainstWorkflow(
    gates,
    workflowContent,
  );
  const findings = analyzeAdvisoryGateAging(adjustedGates, options);
  const messages = [
    ...advisoryGateAgingMessages(findings),
    ...promotedGateWorkflowDriftMessages(driftFindings),
  ];

  if (workflowContent === null) {
    messages.push(
      "advisory-strict-gate-aging — note: workflow content could not be read; " +
        "promotedInCi values were trusted as-is (fail-open, unverified)",
    );
  }

  return { messages, ok: true };
}
