import { ROUTE_SIGNAL_MAP, routeSignalCandidates } from "./route-map.ts";

export interface RouteFilingFinding {
  code: string;
  severity: "error" | "warn" | "info";
  evidence_path: string;
  message: string;
}

export interface RouteFilingContractResult {
  ok: boolean;
  findings: RouteFilingFinding[];
  evidence_paths: string[];
}

export interface FilingTarget {
  mode: string;
  allowed_kinds: string[];
  layer_band: string[];
  sub_doc_hint: string;
  pairing_obligation: string;
  forward_insufficient_reason: string;
  origin: { signal: string; plan_id: string };
  requires_human_approval: boolean;
}

export interface RouteFilingResult extends RouteFilingContractResult {
  signal: string;
  target: FilingTarget;
}

const ROUTE_CONTRACT_EVIDENCE_PATH = "src/schema/route-filing.ts";

export const FILING_TARGET_BY_MODE: Record<
  string,
  Omit<FilingTarget, "mode" | "forward_insufficient_reason" | "origin" | "requires_human_approval">
> = {
  forward: {
    allowed_kinds: ["design", "impl"],
    layer_band: ["L1-L6", "L7"],
    sub_doc_hint: "layer-specific VALID_SUB_DOCS",
    pairing_obligation: "normal V-pair pair-freeze",
  },
  discovery: {
    allowed_kinds: ["poc"],
    layer_band: ["cross"],
    sub_doc_hint: "workflow_phase S0-S4",
    pairing_obligation: "confirmed PoC requires Reverse promotion before Forward merge",
  },
  scrum: {
    allowed_kinds: ["poc"],
    layer_band: ["cross"],
    sub_doc_hint: "workflow_phase S0-S4",
    pairing_obligation: "S4 acceptance plus Reverse fullback before exit",
  },
  reverse: {
    allowed_kinds: ["reverse"],
    layer_band: ["cross"],
    sub_doc_hint: "workflow_phase R0-R4",
    pairing_obligation: "R4 forward_routing plus re-entry pair-freeze gate",
  },
  redesign: {
    allowed_kinds: ["design", "add-design"],
    layer_band: ["L1-L6"],
    sub_doc_hint: "差替え対象の設計sub_doc、起点証拠、supersede対象を指定",
    pairing_obligation:
      "旧設計のsupersede、再降下pair-freezeと再検証。Reverse証拠は存在時のみ参照する",
  },
  recovery: {
    allowed_kinds: ["recovery"],
    layer_band: ["cross"],
    sub_doc_hint: "",
    pairing_obligation: "prevention evidence plus TL/PO signoff",
  },
  incident: {
    allowed_kinds: ["troubleshoot", "recovery"],
    layer_band: ["L7", "cross"],
    sub_doc_hint: "",
    pairing_obligation: "troubleshoot requires recovery PLAN and permanent fix routing",
  },
  refactor: {
    allowed_kinds: ["refactor"],
    layer_band: ["L7"],
    sub_doc_hint: "",
    pairing_obligation: "behavior invariant plus regression fence and linked test id",
  },
  retrofit: {
    allowed_kinds: ["retrofit"],
    layer_band: ["L7"],
    sub_doc_hint: "",
    pairing_obligation:
      "L8 regression plus preflight; design backfill on architecture or DB impact",
  },
  "add-feature": {
    allowed_kinds: ["add-design", "add-impl"],
    layer_band: ["L3-L6", "L7"],
    sub_doc_hint: "target design sub_doc, usually L6 function-spec",
    pairing_obligation: "add-impl requires Reverse pairing and design ancestor",
  },
  research: {
    allowed_kinds: ["research"],
    layer_band: ["L1-L4"],
    sub_doc_hint: "",
    pairing_obligation: "ADR record plus Forward connection target",
  },
  "design-bottomup": {
    allowed_kinds: ["add-design", "add-impl"],
    layer_band: ["L2-L6", "L7"],
    sub_doc_hint: "screen/UI sub_doc",
    pairing_obligation: "same as add-feature with Reverse backfill",
  },
  "version-up": {
    allowed_kinds: ["impl"],
    layer_band: ["L7"],
    sub_doc_hint: "",
    pairing_obligation:
      "parked draft requires version_target; activation removes parking and joins add-feature",
  },
  verify: {
    allowed_kinds: ["verify"],
    layer_band: ["L8-L14"],
    sub_doc_hint: "",
    pairing_obligation: "verification evidence plus defect routing",
  },
};

function finding(code: string, message: string): RouteFilingFinding {
  return { code, severity: "warn", evidence_path: "", message };
}

export function routeFiling(input: {
  signal: string;
  current_plan?: string;
  drive?: string;
}): RouteFilingResult {
  const signal = input.signal.trim();
  const mode = routeSignalCandidates(signal)[0] ?? "forward";
  const template = FILING_TARGET_BY_MODE[mode] ?? FILING_TARGET_BY_MODE.forward;
  const routeEntry = ROUTE_SIGNAL_MAP.find((entry) => entry.mode === mode);
  const findings =
    mode === "forward" && routeSignalCandidates(signal).length === 0
      ? [finding("route-filing-unknown-signal", "unknown signal falls back to forward")]
      : [];
  return {
    ok: true,
    findings,
    evidence_paths: [ROUTE_CONTRACT_EVIDENCE_PATH],
    signal,
    target: {
      mode,
      allowed_kinds: [...template.allowed_kinds],
      layer_band: [...template.layer_band],
      sub_doc_hint: template.sub_doc_hint,
      pairing_obligation: template.pairing_obligation,
      forward_insufficient_reason:
        mode === "forward" ? "" : `route signal ${signal} selected ${mode}`,
      origin:
        mode === "forward"
          ? { signal: "", plan_id: "" }
          : { signal, plan_id: input.current_plan ?? "" },
      requires_human_approval: routeEntry?.requiresApproval ?? false,
    },
  };
}
