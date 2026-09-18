export interface SkillScoringContext {
  reference: string;
  layer: string;
  drive: string;
  kind: string;
  workflowMode: string;
}

export interface SkillLearningSignals {
  skillRating?: number;
  adoptionCount?: number;
  successCount?: number;
  unusedFlag?: number;
}

export interface SkillScoreDetails {
  score: number;
  matchedTokens: string[];
  learningAdjustment: number;
  excluded: boolean;
  exclusionReason?: string;
}

const SITUATION_CATEGORIES = new Set<string>(["domain", "project"]);
const ALL_LAYER_TOKENS = new Set([
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "L12",
  "L13",
  "L14",
]);
const BROAD_DRIVE_MODEL_COUNT = 9;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function commaList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function metadataOverlap(
  ctx: SkillScoringContext,
  asset: Record<string, unknown>,
): { score: number; matchedTokens: string[] } {
  const assetTokens = new Set(
    tokenize(
      [
        asset.asset_id,
        asset.path,
        asset.trigger,
        asset.capability,
        asset.skill_type,
        asset.role,
        asset.category,
      ]
        .map((value) => String(value ?? ""))
        .join(" "),
    ),
  );
  const ctxTokens = new Set(
    tokenize([ctx.drive, ctx.kind, ctx.workflowMode, ctx.reference].join(" ")),
  );
  const matchedTokens: string[] = [];
  for (const token of ctxTokens) {
    if (assetTokens.has(token)) matchedTokens.push(token);
  }
  matchedTokens.sort();
  return { score: Math.min(0.2, matchedTokens.length * 0.05), matchedTokens };
}

export function isWildcardChecklistAsset(asset: Record<string, unknown>): boolean {
  const layers = new Set(commaList(asset.applies_layers));
  const driveModels = commaList(asset.applies_drive_models);
  if (!Array.from(ALL_LAYER_TOKENS).every((layer) => layers.has(layer))) return false;
  if (driveModels.length < BROAD_DRIVE_MODEL_COUNT) return false;
  const identity = [asset.asset_id, asset.path, asset.skill_type]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  return /review-checklist|quality-gate-review/.test(identity);
}

export function shouldScoreSkillAsset(asset: Record<string, unknown>): boolean {
  if (String(asset.skill_type ?? "").startsWith("skill-map")) return false;
  return !isWildcardChecklistAsset(asset);
}

function learningAdjustment(signals?: SkillLearningSignals): number {
  if (!signals) return 0;
  const adoptionCount = Math.max(0, Number(signals.adoptionCount ?? 0));
  const skillRating = clamp(Number(signals.skillRating ?? 0), 0, 1);
  let adjustment = 0;
  if (adoptionCount > 0) {
    adjustment += Math.min(0.06, Math.log2(adoptionCount + 1) * 0.015);
    adjustment += skillRating * 0.04;
  }
  if (Number(signals.unusedFlag ?? 0) === 1) adjustment -= 0.12;
  return round2(adjustment);
}

export function scoreSkillDetailed(
  ctx: SkillScoringContext,
  asset: Record<string, unknown>,
  options: { learning?: SkillLearningSignals } = {},
): SkillScoreDetails {
  if (!shouldScoreSkillAsset(asset)) {
    return {
      score: 0,
      matchedTokens: [],
      learningAdjustment: 0,
      excluded: true,
      exclusionReason: "non-workflow-scoring-asset",
    };
  }
  const appliesLayers = commaList(asset.applies_layers);
  const appliesDriveModels = commaList(asset.applies_drive_models);
  const category = String(asset.category ?? "").trim();
  const reviewText = [asset.skill_type, asset.trigger, asset.capability, asset.role]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  const overlap = metadataOverlap(ctx, asset);
  const learning = learningAdjustment(options.learning);
  let score = 0.15;
  if (ctx.layer && appliesLayers.includes(ctx.layer)) score += 0.3;
  if (appliesDriveModels.includes(ctx.workflowMode)) score += 0.3;
  score += overlap.score;
  if (/review|checklist|quality|test|lint/.test(reviewText)) score += 0.05;
  if (SITUATION_CATEGORIES.has(category) && overlap.score > 0) score += 0.1;
  score += learning;
  return {
    score: round2(clamp(score, 0, 1)),
    matchedTokens: overlap.matchedTokens,
    learningAdjustment: learning,
    excluded: false,
  };
}

export function scoreSkill(
  ctx: SkillScoringContext,
  asset: Record<string, unknown>,
  options: { learning?: SkillLearningSignals } = {},
): number {
  return scoreSkillDetailed(ctx, asset, options).score;
}

export function skillScoreReason(
  ctx: SkillScoringContext,
  asset: Record<string, unknown>,
  details: SkillScoreDetails,
): string {
  const skillId = String(asset.asset_id ?? "");
  const matched = details.matchedTokens.length > 0 ? details.matchedTokens.join("|") : "none";
  const learning =
    details.learningAdjustment === 0 ? "neutral" : details.learningAdjustment.toFixed(2);
  return `layer=${ctx.layer}; technical_drive=${ctx.drive}; drive_model=${ctx.workflowMode}; kind=${ctx.kind}; skill=${skillId}; matched=${matched}; learning=${learning}`;
}
