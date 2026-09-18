import { type FilingTarget, routeFiling } from "../schema/route-filing.ts";

export interface DetectorRouteCandidateLike {
  route_candidate_id?: unknown;
  finding_kind?: unknown;
  filing_target_id?: unknown;
  target_layer?: unknown;
  target_sub_doc?: unknown;
  candidate_status?: unknown;
  reason?: unknown;
}

export interface DetectorRouteCandidateReview {
  route_signal: string;
  filing_target: FilingTarget;
  snapshot_mismatch: boolean;
  review_status: "ssot_evaluated" | "snapshot_mismatch";
  next_action: string;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

export function detectorRouteSignal(candidate: DetectorRouteCandidateLike): string {
  const filingTarget = text(candidate.filing_target_id);
  const filingSignal = filingTarget.startsWith("routeFiling:")
    ? filingTarget.slice("routeFiling:".length)
    : "";
  return filingSignal || text(candidate.finding_kind) || "detector_route_candidate";
}

function layerMatchesBand(layer: string, bands: string[]): boolean {
  if (!layer) return true;
  return bands.some((band) => {
    if (band === layer || band === "cross") return band === layer;
    const range = band.match(/^L(\d+)-L(\d+)$/);
    if (!range) return false;
    const value = Number(layer.replace(/^L/, ""));
    return value >= Number(range[1]) && value <= Number(range[2]);
  });
}

export function reviewDetectorRouteCandidate(
  candidate: DetectorRouteCandidateLike,
): DetectorRouteCandidateReview {
  const routeSignal = detectorRouteSignal(candidate);
  const filing = routeFiling({ signal: routeSignal });
  const snapshotMismatch = !layerMatchesBand(
    text(candidate.target_layer),
    filing.target.layer_band,
  );
  const reviewStatus = snapshotMismatch ? "snapshot_mismatch" : "ssot_evaluated";
  const candidateId = text(candidate.route_candidate_id);
  const target = `${text(candidate.target_layer)}/${text(candidate.target_sub_doc)}`;
  const nextAction =
    `review detector route candidate ${candidateId}; ` +
    `candidate_status=${text(candidate.candidate_status)}; ` +
    `routeFiling SSoT evaluated signal=${routeSignal}; ` +
    `route_eval_mode=${filing.target.mode}; ` +
    `allowed_kinds=${filing.target.allowed_kinds.join(",")}; ` +
    `layer_band=${filing.target.layer_band.join(",")}; ` +
    `pairing_obligation=${filing.target.pairing_obligation}; ` +
    `requires_human_approval=${filing.target.requires_human_approval}; ` +
    `review_status=${reviewStatus}; ` +
    `target=${target}; filing=${text(candidate.filing_target_id)}: ${text(candidate.reason)}`;
  return {
    route_signal: routeSignal,
    filing_target: filing.target,
    snapshot_mismatch: snapshotMismatch,
    review_status: reviewStatus,
    next_action: nextAction,
  };
}

export function detectorRouteCandidateAction(candidate: DetectorRouteCandidateLike): string {
  return reviewDetectorRouteCandidate(candidate).next_action;
}
