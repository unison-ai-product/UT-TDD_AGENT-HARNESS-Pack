/**
 * design-bottomup 駆動モデル (画面後付け駆動) の ① elicitation engine + Discovery 合成。
 *
 * 入口条件: backend が主軸で確立済の system に、後から画面/UI を足したくなったとき。
 * Forward (design-first / greenfield) とも Add-feature 経路B (汎用機能の L3 要件 back-fill) とも
 * 入口が異なる第3の向き = 確立した backend を "下" として、L4 data (= FE 設計の backend 対応物) /
 * harness.db projection / CLI capability から FE 要件を洗い出す (derive) → 画面 mock で具体化 →
 * Forward で L3/L5/L6 を降下 → 実装。
 *
 * 本 engine が新規 (①)。② mock 具体化 = screen-design (L2 wireframe) / Discovery (design_uncertain)、
 * ③ Forward 降下 = Forward 本線 + Discovery 合流点、は既存機構を合成する (再発明しない)。
 * 合成は contracts.ts の routeSignalToMode (既存 Discovery routing) を再利用して担保する。
 */
import { type ContractResult, type Finding, routeSignalToMode } from "./contracts";

export interface BackendCapability {
  /** backend 側の供給源の種別。FE 要件はこれらから derive される。 */
  kind: "data_entity" | "cli_command" | "projection";
  /** entity 名 / command 名 / projection table 名。 */
  id: string;
  /** 供給面の短い説明 (画面が render に要するもの)。 */
  surface: string;
}

export interface ScreenRef {
  screen_id: string;
  name: string;
  /** PM (Project Management) / HM (Harness Management) / GD (Guide & Docs)。 */
  category: string;
  url: string;
  l1_ref: string;
}

export interface ScreenTraceRef {
  screen_id: string;
  requirement_id: string;
  requirement_kind: string;
}

/** FE 設計鎖の slot。L2 (画面棚卸し) / L4 (ui-standard) は別経路で確定済のため本 engine の対象外。 */
export type FeDesignSlot = "L3:screen-functional" | "L5:ui-detail" | "L6:screen-spec";

export interface FeRequirementCandidate {
  candidate_id: string;
  screen_id: string;
  design_slot: FeDesignSlot;
  /** derive 元の backend capability id (grounding。prose でなく実体で substantiate)。 */
  derived_from: string;
  requirement: string;
}

export interface FeDesignSlotState {
  slot: FeDesignSlot;
  /** doc body が substance を持つか (slot 登録だけの coverage は has_body=false)。 */
  has_body: boolean;
  doc_path: string;
}

export interface FeDesignGap {
  slot: FeDesignSlot;
  /** routeSignalToMode / DriveTddFit と整合する Red signal 種別。 */
  signal_type: string;
  screen_ids: string[];
  candidate_count: number;
}

export interface DesignBottomupDiscovery {
  mode: "design-bottomup";
  /** 既存 Discovery routing に確実に乗るエントリ signal (mode 再発明しない)。 */
  entry_signal: string;
  hypothesis: string;
  stages: string[];
  /** Discovery の設計確証時の合流点 (concept §2.5)。 */
  forward_merge: string;
  route_candidates: string[];
}

const ALL_SLOTS: FeDesignSlot[] = ["L3:screen-functional", "L5:ui-detail", "L6:screen-spec"];

const SLOT_SIGNAL: Record<FeDesignSlot, string> = {
  "L3:screen-functional": "screen_requirement_gap",
  "L5:ui-detail": "ui_detail_gap",
  "L6:screen-spec": "screen_spec_gap",
};

const SLOT_SHORT: Record<FeDesignSlot, string> = {
  "L3:screen-functional": "l3",
  "L5:ui-detail": "l5",
  "L6:screen-spec": "l6",
};

/** category ごとに、FE 要件の derive 元として優先する capability 種別。 */
const CATEGORY_CAP_KINDS: Record<string, BackendCapability["kind"][]> = {
  HM: ["projection", "cli_command", "data_entity"],
  PM: ["data_entity", "projection", "cli_command"],
  GD: ["data_entity"],
};

function finding(
  code: string,
  message: string,
  options: { evidencePath?: string; severity?: Finding["severity"] } = {},
): Finding {
  return {
    code,
    severity: options.severity ?? "error",
    evidence_path: options.evidencePath ?? "",
    message,
  };
}

function result(findings: Finding[], evidence_paths: string[] = []): ContractResult {
  return { ok: findings.every((f) => f.severity !== "error"), findings, evidence_paths };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * その画面の screen-specific な backend grounding を決める。
 * primary = その画面の screen_trace (どの FR/BR を surface するか = 画面固有の backend 依存)。
 * secondary = category が render に要する backend capability (data_entity / projection / CLI)。
 * 画面固有 trace を優先することで、全画面が同一 generic capability に潰れる grounding 劣化を防ぐ。
 */
function groundingFor(
  screen: ScreenRef,
  capabilities: BackendCapability[],
  trace: ScreenTraceRef[],
): string {
  const traced = trace.find((t) => t.screen_id === screen.screen_id);
  const screenRef = traced ? `${traced.requirement_kind}:${traced.requirement_id}` : "";
  const kinds = CATEGORY_CAP_KINDS[screen.category] ?? ["data_entity"];
  let capRef = "";
  for (const kind of kinds) {
    const cap = capabilities.find((c) => c.kind === kind);
    if (cap) {
      capRef = `${cap.kind}:${cap.id}`;
      break;
    }
  }
  if (screenRef && capRef) return `${screenRef} via ${capRef}`;
  return screenRef || capRef;
}

function requirementText(slot: FeDesignSlot, screen: ScreenRef, derivedFrom: string): string {
  switch (slot) {
    case "L3:screen-functional":
      return `${screen.screen_id} (${screen.name}): read-only 画面機能要件 — ${derivedFrom} を surface (S5=b, ${screen.url})`;
    case "L5:ui-detail":
      return `${screen.screen_id}: FE 内部設計 — ${derivedFrom} 由来の component 分割 / state / routing (${screen.url})`;
    case "L6:screen-spec":
      return `${screen.screen_id}: per-screen 機能設計 — ${derivedFrom} 由来の項目 / event / validation`;
  }
}

/**
 * ① backend reality から FE 要件候補を洗い出す。
 * 各画面について FE 設計鎖 (L3/L5/L6) の候補を、backend capability に grounding して derive する。
 * grounding 不能 (capability も trace も無い) 画面は warn で可視化する (absence-blindness 対策)。
 */
export function elicitFeRequirements(input: {
  screens: ScreenRef[];
  capabilities: BackendCapability[];
  screen_trace: ScreenTraceRef[];
}): ContractResult & { candidates: FeRequirementCandidate[] } {
  const screens = [...input.screens].sort((a, b) => a.screen_id.localeCompare(b.screen_id));
  const candidates: FeRequirementCandidate[] = [];
  const findings: Finding[] = [];

  for (const screen of screens) {
    const derivedFrom = groundingFor(screen, input.capabilities, input.screen_trace);
    if (!derivedFrom) {
      findings.push(
        finding(
          "fe-requirement-ungrounded",
          `${screen.screen_id} は backend capability / trace から FE 要件を derive できない (backend 未供給)`,
          { severity: "warn" },
        ),
      );
      continue;
    }
    for (const slot of ALL_SLOTS) {
      candidates.push({
        candidate_id: `fe-cand:${screen.screen_id}:${SLOT_SHORT[slot]}`,
        screen_id: screen.screen_id,
        design_slot: slot,
        derived_from: derivedFrom,
        requirement: requirementText(slot, screen, derivedFrom),
      });
    }
  }

  if (candidates.length === 0 && input.screens.length > 0) {
    findings.push(
      finding("fe-requirement-empty", "どの画面も backend から FE 要件を derive できなかった", {
        severity: "warn",
      }),
    );
  }

  return { ...result(findings), candidates };
}

/**
 * ② 候補が存在するのに FE 設計 slot の body が不在な箇所を gap として検出し、
 * routeSignalToMode / DriveTddFit と整合する Red signal で発火する。
 * has_body=true (substance あり) の slot は gap にしない (coverage≠substance: 実体のみ green)。
 */
export function detectFeDesignGaps(input: {
  candidates: FeRequirementCandidate[];
  slots: FeDesignSlotState[];
}): ContractResult & { gaps: FeDesignGap[] } {
  const bySlot = new Map<FeDesignSlot, FeRequirementCandidate[]>();
  for (const c of input.candidates) {
    const list = bySlot.get(c.design_slot) ?? [];
    list.push(c);
    bySlot.set(c.design_slot, list);
  }

  const gaps: FeDesignGap[] = [];
  const findings: Finding[] = [];

  for (const slot of ALL_SLOTS) {
    const slotCandidates = bySlot.get(slot) ?? [];
    if (slotCandidates.length === 0) continue;
    const state = input.slots.find((s) => s.slot === slot);
    if (state?.has_body) continue;
    const screenIds = uniqueSorted(slotCandidates.map((c) => c.screen_id));
    gaps.push({
      slot,
      signal_type: SLOT_SIGNAL[slot],
      screen_ids: screenIds,
      candidate_count: slotCandidates.length,
    });
    findings.push(
      finding(
        SLOT_SIGNAL[slot],
        `${slot}: ${screenIds.length} 画面の FE 要件候補があるが設計 body が不在 (${state?.doc_path ?? "(slot 未定義)"})`,
        { severity: "warn", evidencePath: state?.doc_path ?? "" },
      ),
    );
  }

  return { ...result(findings), gaps };
}

/**
 * ③ gap を Discovery (design_uncertain) エントリへ合成する。
 * 新 mode を作らず既存 Discovery の mock 具体化 → 検証 → Forward 合流 (L3-L6) を再利用する。
 * entry_signal が既存 routeSignalToMode で discovery へ確実に乗ることを route_candidates で示す。
 */
export function composeDesignBottomupDiscovery(input: {
  gaps: FeDesignGap[];
  hypothesis?: string;
}): ContractResult & { discovery: DesignBottomupDiscovery | null } {
  if (input.gaps.length === 0) {
    return { ...result([]), discovery: null };
  }
  const entrySignal = "design_uncertain";
  const routeCandidates = routeSignalToMode({ signal: entrySignal }).candidates;
  const slotList = input.gaps.map((g) => g.slot).join(" / ");
  const discovery: DesignBottomupDiscovery = {
    mode: "design-bottomup",
    entry_signal: entrySignal,
    hypothesis:
      input.hypothesis ??
      `backend から derive した ${input.gaps.length} slot (${slotList}) の FE 設計を mock で具体化し confirm する`,
    stages: [
      "elicit: backend (L4 data / projection / CLI) → FE 要件 洗い出し",
      "concretize: L2 wireframe mock で具体化 (screen-design 再利用)",
      "descend: Forward で L3 screen-functional / L5 ui-detail / L6 screen-spec を降下",
      "decide: Discovery S4 (decideDiscoveryS4) で設計確証 → Forward 合流",
    ],
    forward_merge: "L3-L6",
    route_candidates: routeCandidates,
  };
  return { ...result([]), discovery };
}

/**
 * design-bottomup 駆動の end-to-end 実行: elicit → detectGaps → composeDiscovery を連鎖する。
 */
export function runDesignBottomup(input: {
  screens: ScreenRef[];
  capabilities: BackendCapability[];
  screen_trace: ScreenTraceRef[];
  slots: FeDesignSlotState[];
  hypothesis?: string;
}): ContractResult & {
  candidates: FeRequirementCandidate[];
  gaps: FeDesignGap[];
  discovery: DesignBottomupDiscovery | null;
} {
  const elicited = elicitFeRequirements({
    screens: input.screens,
    capabilities: input.capabilities,
    screen_trace: input.screen_trace,
  });
  const detected = detectFeDesignGaps({ candidates: elicited.candidates, slots: input.slots });
  const composed = composeDesignBottomupDiscovery({
    gaps: detected.gaps,
    hypothesis: input.hypothesis,
  });
  const findings = [...elicited.findings, ...detected.findings, ...composed.findings];
  return {
    ...result(findings),
    candidates: elicited.candidates,
    gaps: detected.gaps,
    discovery: composed.discovery,
  };
}
