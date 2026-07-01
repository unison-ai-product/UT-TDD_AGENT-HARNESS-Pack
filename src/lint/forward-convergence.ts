/**
 * forward-convergence lint — PLAN-DISCOVERY-08 (Step5 = fail-close)。
 *
 * 不変条件 (PO 2026-06-26): Forward (L0-L14 spine) = きれいな最終正本。別フローの最終実態は必ず
 * Forward へ集約 (backprop_decision 経由の合流 / Reverse back-fill) される。未集約の別フローが宙に浮いた
 * まま「Forward freeze = 最終正本成立」と主張してはならない (docs/process/modes/README.md §1/§5/§6.8.8)。
 *
 * SSoT 非重複 (AC-5): 集約義務の既存統制は以下が担う —
 *  - poc (Discovery/Scrum) confirmed   → scrum-reverse.ts (IMP-064)
 *  - add-impl / refactor / retrofit / troubleshoot → backfill-pairing.ts (KIND_BACKFILL)
 * 本 analyzer はそのどちらも見ていない**残ギャップ = kind=impl の spine-外 landed 未集約**のみを担う。
 *
 * fail-close (Step5): doctor.ok を gate する (NEW unconverged-landed=0)。baseline 既存債務は
 * FORWARD_CONVERGENCE_LEGACY_DEBT で grandfather し、allowlist↔audit doc 一致を別 hard check で担保。
 * version_target (PLAN-DISCOVERY-09 version-up) 付き draft は将来版へ保全 = deferred(version-up) 種別。
 *
 * 純関数 (analyzeForwardConvergence) + I/O loader (loadConvergenceDocs) を分離 (lint 共通様式)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequires } from "./backfill-pairing";
import { loadRoadmaps } from "./roadmap-registry";
import { parseLinks } from "./scrum-reverse";
import { fmValue } from "./shared";

/** 本 analyzer が収束義務を判定する kind。poc/add-impl 等は別 SSoT が担うため対象外 (二重計上防止)。 */
export const CONVERGENCE_SCOPE_KINDS = new Set<string>(["impl"]);

/** landed = 実装が着地した最終実態 (status 終端のうち実装側)。 */
const LANDED_STATUSES = new Set<string>(["confirmed", "completed"]);

/** backprop_decision のうち「Forward 集約不要」を明示的に成立させる disposition (§6.8.8)。 */
const LOCAL_IMPL_ONLY_DECISIONS = new Set<string>(["local_impl_only", "not_required"]);

/**
 * version-up parked の許可 target ledger (PLAN-DISCOVERY-09)。`version_target` は任意文字列でなく
 * この台帳に照合する (Codex Critical: 曖昧 label で集約逃れを作らない)。S4 で requirements 側へ正本化する。
 */
export const VERSION_UP_ALLOWED_TARGETS = new Set<string>(["future", "v2"]);

/**
 * fail-close 前から存在する未集約 landed impl の audited 債務 (PLAN-DISCOVERY-08 Step5、baseline 2026-06-26)。
 * gate は NEW 違反のみ fail-close し、ここに列挙した既存債務は grandfather する (backfill-pairing の
 * LEGACY_CONDITIONAL_BACKFILL_DEBT_PLAN_IDS と同型)。allowlist ↔ audit doc の双方向一致は別 hard check で担保。
 *
 * IMP-146 で baseline 2 件を解消済 (= allowlist 空、Codex cross-review AGREE、2026-06-26):
 *  - PLAN-L7-62-runtime-portability-guard  → L1 nfr.md (NFR-04/NFR-01) への descent link で spine-internal 化 (trace correction)。
 *  - PLAN-L7-147-refactor-candidate-detector → PLAN-REVERSE-141 が L6 function-spec / L7 test-design へ detector 仕様を
 *    back-fill し当該 PLAN を参照 = converged (Forward 集約)。
 * 解消履歴は `docs/governance/forward-convergence-legacy-debt-audit.md` §解消済 を SSoT とする。
 * 新規 legacy 債務を grandfather する場合のみここへ追加し、audit doc 表行と双方向一致させること。
 * grandfather 機構自体は legacyDebt 引数注入でテスト被覆する (空 allowlist と機構テストを分離)。
 */
export const FORWARD_CONVERGENCE_LEGACY_DEBT = new Set<string>([]);

export type ConvergenceBucket =
  | "spine-internal"
  | "draft-deferred"
  | "version-up-parked"
  | "local-impl-only"
  | "converged"
  | "unconverged-landed";

export interface ConvergencePlan {
  plan_id: string;
  kind: string;
  status: string;
  parentDesign: string | null;
  requires: string[];
  backpropDecision: string;
  backpropDecisionReason: string;
  /** version-up parked マーカー (将来版へ保全)。null = 通常。 */
  versionTarget: string | null;
}

export interface ConvergenceClassification {
  plan_id: string;
  bucket: ConvergenceBucket;
  reason: string;
}

export interface ForwardConvergenceResult {
  classifications: ConvergenceClassification[];
  /** landed × spine-外 × 未集約 = Forward 未集約の全件 (legacy + new)。 */
  unconvergedLanded: string[];
  /** unconvergedLanded のうち audited legacy debt (grandfather、ok を落とさない)。 */
  legacyDebt: string[];
  /** unconvergedLanded のうち新規違反 (= fail-close 対象、ok を落とす)。 */
  newViolations: string[];
  /** spine-外で未 landing かつ version_target なし = 通常の将来作業 (active draft、outstanding)。 */
  draftDeferred: string[];
  /** spine-外で未 landing かつ version_target 付き = 将来版へ保全 (version-up、PLAN-DISCOVERY-09)。 */
  versionUpParked: string[];
  /** 明示理由付きで Forward 集約不要と判定された landed (§6.8.8 local_impl_only)。 */
  localImplOnly: string[];
  /** Reverse 合流で Forward へ集約済の landed。 */
  converged: string[];
  /** spine に接続済 (= 既に Forward 降下済) で集約義務なし。 */
  spineInternal: string[];
  /** fail-close: ok = 新規違反 (legacy 除く) が 0。doctor.ok と連動する (PLAN-DISCOVERY-08 Step5)。 */
  ok: boolean;
}

/**
 * version-up parked として有効か (Codex Critical guards):
 *  ① version_target が ledger に存在 ② status=draft (landed には付与不可、landing-time 除外禁止)。
 * landed (confirmed/completed) で version_target が付いていても version-up とは認めない (= 通常の集約判定へ)。
 */
export function isValidVersionUp(plan: ConvergencePlan): boolean {
  if (!plan.versionTarget) return false;
  if (plan.status !== "draft") return false;
  return VERSION_UP_ALLOWED_TARGETS.has(plan.versionTarget);
}

/** parent_design / requires / roadmap span のいずれかで Forward に接続しているか。 */
export function isSpineConnected(plan: ConvergencePlan, roadmapSpanIds: Set<string>): boolean {
  if (roadmapSpanIds.has(plan.plan_id)) return true;
  const pd = plan.parentDesign;
  if (pd && pd !== "null" && pd.includes("docs/design/")) return true;
  // requires が上流設計 PLAN (L1-L6) / design doc を指せば降下接続とみなす。
  return plan.requires.some((r) => /PLAN-L[1-6]-/.test(r) || r.includes("docs/design/"));
}

export function isLanded(plan: ConvergencePlan): boolean {
  return LANDED_STATUSES.has(plan.status);
}

/** 明示 disposition (local_impl_only / 理由付き not_required) で集約不要が成立しているか。 */
export function hasLocalImplOnlyDisposition(plan: ConvergencePlan): boolean {
  if (!LOCAL_IMPL_ONLY_DECISIONS.has(plan.backpropDecision)) return false;
  // not_required は理由必須 (prose 空での免除を許さない、§6.8.8 audit)。
  if (plan.backpropDecision === "not_required") {
    return plan.backpropDecisionReason.trim().length >= 10;
  }
  return true;
}

/**
 * unconverged-landed を audited legacy debt (grandfather) と NEW 違反 (fail-close 対象) に分割する純関数。
 * grandfather 機構を allowlist 注入でテスト可能にしつつ analyzeForwardConvergence の引数増 (max-source-params)
 * を避けるため独立関数に切り出す。default = 実 allowlist (IMP-146 後は空)。
 */
export function partitionConvergenceDebt(
  unconvergedLanded: string[],
  legacyDebt: ReadonlySet<string> = FORWARD_CONVERGENCE_LEGACY_DEBT,
): { legacyDebt: string[]; newViolations: string[] } {
  return {
    legacyDebt: unconvergedLanded.filter((id) => legacyDebt.has(id)),
    newViolations: unconvergedLanded.filter((id) => !legacyDebt.has(id)),
  };
}

/**
 * spine-外 impl の Forward 集約状態を分類 (純関数、I/O なし)。
 * @param plans 全 active PLAN
 * @param roadmapSpanIds 登録工程表の span plan_id 集合 (spine 接続判定)
 * @param reverseReferencedIds reverse PLAN が requires/references で指す plan_id 集合 (Reverse 合流判定)
 */
export function analyzeForwardConvergence(
  plans: ConvergencePlan[],
  roadmapSpanIds: Set<string>,
  reverseReferencedIds: Set<string>,
): ForwardConvergenceResult {
  const classifications: ConvergenceClassification[] = [];

  for (const p of plans) {
    if (!CONVERGENCE_SCOPE_KINDS.has(p.kind)) continue;
    if (isSpineConnected(p, roadmapSpanIds)) {
      classifications.push({
        plan_id: p.plan_id,
        bucket: "spine-internal",
        reason: "parent_design / requires / roadmap span で Forward に接続済",
      });
      continue;
    }
    if (!isLanded(p)) {
      // 未 landing: version-up parked (将来版へ保全) か通常の active draft か。
      if (isValidVersionUp(p)) {
        classifications.push({
          plan_id: p.plan_id,
          bucket: "version-up-parked",
          reason: `version_target=${p.versionTarget} で将来版へ保全 (PLAN-DISCOVERY-09)`,
        });
      } else {
        classifications.push({
          plan_id: p.plan_id,
          bucket: "draft-deferred",
          reason: `spine-外だが未 landing (status=${p.status})。将来作業 = active draft`,
        });
      }
      continue;
    }
    // landed: version_target が付いていても version-up とは認めない (Codex Critical: landing-time 除外禁止)。
    if (hasLocalImplOnlyDisposition(p)) {
      classifications.push({
        plan_id: p.plan_id,
        bucket: "local-impl-only",
        reason: `backprop_decision=${p.backpropDecision} で Forward 集約不要を明示`,
      });
      continue;
    }
    if (reverseReferencedIds.has(p.plan_id)) {
      classifications.push({
        plan_id: p.plan_id,
        bucket: "converged",
        reason: "Reverse PLAN が requires/references で参照 = Forward 合流済",
      });
      continue;
    }
    classifications.push({
      plan_id: p.plan_id,
      bucket: "unconverged-landed",
      reason: "landed × spine-外 × backprop_decision/Reverse 合流なし = Forward 未集約",
    });
  }

  const pick = (b: ConvergenceBucket): string[] =>
    classifications.filter((c) => c.bucket === b).map((c) => c.plan_id);
  const unconvergedLanded = pick("unconverged-landed");
  // legacy (audited grandfather) と new (fail-close 対象) に分割 (ok は new のみで決める)。
  // 分割は partitionConvergenceDebt 純関数へ委譲し、grandfather 機構を allowlist 注入でテスト可能にしつつ
  // analyzeForwardConvergence の引数増 (max-source-params) を避ける。
  const { legacyDebt: legacyDebtIds, newViolations } = partitionConvergenceDebt(unconvergedLanded);
  return {
    classifications,
    unconvergedLanded,
    legacyDebt: legacyDebtIds,
    newViolations,
    draftDeferred: pick("draft-deferred"),
    versionUpParked: pick("version-up-parked"),
    localImplOnly: pick("local-impl-only"),
    converged: pick("converged"),
    spineInternal: pick("spine-internal"),
    ok: newViolations.length === 0,
  };
}

export interface ConvergenceDocs {
  plans: ConvergencePlan[];
  roadmapSpanIds: Set<string>;
  reverseReferencedIds: Set<string>;
}

/** PLAN を ConvergencePlan へ parse (SSoT: requires は backfill-pairing.parseRequires を再利用)。 */
export function parseConvergencePlan(file: string, content: string): ConvergencePlan {
  return {
    plan_id: fmValue(content, "plan_id") ?? file.replace(/\.md$/, ""),
    kind: fmValue(content, "kind") ?? "unknown",
    status: fmValue(content, "status") ?? "unknown",
    parentDesign: fmValue(content, "parent_design") ?? null,
    requires: parseRequires(content),
    backpropDecision: fmValue(content, "backprop_decision") ?? "",
    backpropDecisionReason: fmValue(content, "backprop_decision_reason") ?? "",
    versionTarget: fmValue(content, "version_target") ?? null,
  };
}

/** 末尾 `/id.md` / `id.md` / `id` を plan_id へ正規化。 */
function normalizeRef(ref: string): string {
  const base = ref.replaceAll("\\", "/").split("/").at(-1) ?? ref;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

export function loadConvergenceDocs(repoRoot: string = process.cwd()): ConvergenceDocs {
  const plansDir = join(repoRoot, "docs", "plans");
  const plans: ConvergencePlan[] = [];
  const reverseReferencedIds = new Set<string>();
  for (const f of readdirSync(plansDir)) {
    if (!f.endsWith(".md")) continue;
    const content = readFileSync(join(plansDir, f), "utf8");
    const plan = parseConvergencePlan(f, content);
    if (plan.status === "archived") continue;
    plans.push(plan);
    // reverse PLAN が requires/references で指す plan_id を集約 (SSoT: scrum-reverse.parseLinks)。
    if (plan.kind === "reverse") {
      for (const link of parseLinks(content)) reverseReferencedIds.add(normalizeRef(link));
    }
  }
  const roadmapSpanIds = new Set<string>();
  for (const rec of loadRoadmaps(repoRoot)) {
    for (const span of rec.roadmap.spans) roadmapSpanIds.add(span.plan_id);
  }
  return { plans, roadmapSpanIds, reverseReferencedIds };
}

/** doctor / CLI 向け surface (fail-close: NEW 違反で ok=false。legacy debt は grandfather だが常時 surface)。 */
export function forwardConvergenceMessages(result: ForwardConvergenceResult): string[] {
  const tail =
    `spine-internal ${result.spineInternal.length} / converged ${result.converged.length} / ` +
    `local-impl-only ${result.localImplOnly.length} / version-up ${result.versionUpParked.length} / ` +
    `draft-deferred ${result.draftDeferred.length}`;
  const legacy =
    result.legacyDebt.length > 0
      ? ` / legacy debt ${result.legacyDebt.length} (grandfather: ${result.legacyDebt.join(", ")})`
      : "";
  if (result.ok) {
    return [`forward-convergence — OK (NEW 未集約 landed impl 0; ${tail}${legacy})`];
  }
  return [
    `forward-convergence — violation: NEW 未集約 landed impl ${result.newViolations.length} 件 ` +
      `(${result.newViolations.join(", ")}): spine-外で Forward 集約 (backprop_decision / Reverse 合流 / version-up parked) 未。` +
      `${tail}${legacy}`,
  ];
}

/** legacy debt allowlist ↔ audit doc の双方向一致 (Codex Critical B: allowlist/audit drift は別 hard check)。 */
export interface LegacyAuditDriftResult {
  /** allowlist にあるが audit doc 未記載。 */
  missingInAudit: string[];
  /** audit doc にあるが allowlist 未登録。 */
  missingInAllowlist: string[];
  ok: boolean;
}

export function analyzeLegacyAuditDrift(
  auditedPlanIds: Set<string>,
  allowlist: ReadonlySet<string> = FORWARD_CONVERGENCE_LEGACY_DEBT,
): LegacyAuditDriftResult {
  const missingInAudit = [...allowlist].filter((id) => !auditedPlanIds.has(id));
  const missingInAllowlist = [...auditedPlanIds].filter((id) => !allowlist.has(id));
  return {
    missingInAudit,
    missingInAllowlist,
    ok: missingInAudit.length === 0 && missingInAllowlist.length === 0,
  };
}

/** audit doc (markdown table) から `PLAN-...` 行頭セルを抽出 (backfill-pairing と同方式)。 */
export function parseLegacyAuditPlanIds(content: string): Set<string> {
  return new Set([...content.matchAll(/^\|\s*(PLAN-[A-Za-z0-9-]+)\s*\|/gm)].map((m) => m[1]));
}

export function loadLegacyAuditDrift(repoRoot: string = process.cwd()): LegacyAuditDriftResult {
  let audited = new Set<string>();
  try {
    const content = readFileSync(
      join(repoRoot, "docs", "governance", "forward-convergence-legacy-debt-audit.md"),
      "utf8",
    );
    audited = parseLegacyAuditPlanIds(content);
  } catch {
    // audit doc 不在 = allowlist 全件 missing として drift surface (無音 OK にしない)。
  }
  return analyzeLegacyAuditDrift(audited);
}

export function legacyAuditDriftMessages(result: LegacyAuditDriftResult): string[] {
  if (result.ok) {
    return [
      `forward-convergence-audit — OK (legacy debt allowlist ↔ audit doc 双方向一致, ${FORWARD_CONVERGENCE_LEGACY_DEBT.size} 件)`,
    ];
  }
  const parts: string[] = [];
  if (result.missingInAudit.length > 0)
    parts.push(
      `audit doc 未記載 ${result.missingInAudit.length} (${result.missingInAudit.join(", ")})`,
    );
  if (result.missingInAllowlist.length > 0)
    parts.push(
      `allowlist 未登録 ${result.missingInAllowlist.length} (${result.missingInAllowlist.join(", ")})`,
    );
  return [`forward-convergence-audit — violation: ${parts.join("; ")}`];
}
