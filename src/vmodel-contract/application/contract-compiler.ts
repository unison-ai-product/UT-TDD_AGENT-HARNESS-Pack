import { createHash } from "node:crypto";

export const RIGHT_ARM_LAYERS = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"] as const;
export const VMODEL_LAYERS = [
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  ...RIGHT_ARM_LAYERS,
] as const;

const PAIR_EXCEPTION_BACKLINKS: Record<string, string[]> = {
  L11: [
    "PLAN-L1-07-vmodel-engine-swap-requirements-delta",
    "PLAN-L4-24-declarative-vmodel-contract-right-arm",
  ],
  L13: [
    "PLAN-L12-01-engine-swap-acceptance-deploy",
    "PLAN-L4-24-declarative-vmodel-contract-right-arm",
  ],
};

export interface CompiledVerificationObligation {
  ruleId: string;
  planId: string;
  layer: string;
  gate: string;
  governanceArtifact: string;
  caseIdPrefix: string;
  evidenceManifest: string;
}

export interface CompiledRightArmRegistry {
  contractRevision: string;
  sourceHash: string;
  generatedHash: string;
  obligations: CompiledVerificationObligation[];
  pairExceptions: CompiledPairException[];
}

export interface CompiledPairException {
  layer: string;
  reason: string;
  allowedPairLayers: string[];
  requiredBacklinks: string[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function requiredString(source: UnknownRecord, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stringArray(source: UnknownRecord, key: string, label: string): string[] {
  const value = source[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry)
  ) {
    throw new Error(`${label}.${key} must be a non-empty string array`);
  }
  return [...value];
}

function assertRepoPath(value: string, label: string, prefix: "docs/" | ".ut-tdd/evidence/"): void {
  const normalized = value.replaceAll("\\", "/");
  if (normalized !== value || !normalized.startsWith(prefix) || normalized.includes("..")) {
    throw new Error(`${label} must be a normalized repository path under ${prefix}`);
  }
}

function compileLayer(value: unknown): CompiledVerificationObligation {
  const layer = record(value, "contract layer");
  const layerId = requiredString(layer, "layer", "contract layer");
  if (!RIGHT_ARM_LAYERS.includes(layerId as (typeof RIGHT_ARM_LAYERS)[number])) {
    throw new Error(`unsupported right-arm layer=${layerId}`);
  }
  const expectedGate = `G${layerId.slice(1)}`;
  const gate = requiredString(layer, "gate", layerId);
  if (gate !== expectedGate)
    throw new Error(`${layerId}.gate expected=${expectedGate} actual=${gate}`);
  const planId = requiredString(layer, "verification_plan_id", layerId);
  if (!planId.startsWith(`PLAN-${layerId}-`)) {
    throw new Error(`${layerId}.verification_plan_id must start with PLAN-${layerId}-`);
  }
  const governanceArtifact = requiredString(layer, "governance_artifact", layerId);
  const evidenceManifest = requiredString(layer, "evidence_manifest", layerId);
  const caseIdPrefix = requiredString(layer, "case_id_prefix", layerId);
  assertRepoPath(governanceArtifact, `${layerId}.governance_artifact`, "docs/");
  assertRepoPath(evidenceManifest, `${layerId}.evidence_manifest`, ".ut-tdd/evidence/");
  if (!/^[A-Z]+-$/.test(caseIdPrefix)) {
    throw new Error(`${layerId}.case_id_prefix must match ^[A-Z]+-$`);
  }
  return {
    ruleId: `right-arm:${layerId}:${gate}`,
    planId,
    layer: layerId,
    gate,
    governanceArtifact,
    caseIdPrefix,
    evidenceManifest,
  };
}

export function compileRightArmContract(raw: unknown): CompiledRightArmRegistry {
  const contract = record(raw, "V-model contract");
  const layers = contract.layers;
  if (!Array.isArray(layers)) throw new Error("V-model contract.layers must be an array");
  const declaredLayers = layers.map((value) =>
    requiredString(record(value, "contract layer"), "layer", "contract layer"),
  );
  if (
    declaredLayers.length !== VMODEL_LAYERS.length ||
    VMODEL_LAYERS.some((layer) => declaredLayers.filter((value) => value === layer).length !== 1)
  ) {
    throw new Error(`V-model layers must define L0-L14 exactly once: ${declaredLayers.join(",")}`);
  }
  for (const layerId of VMODEL_LAYERS) {
    const layer = record(
      layers.find((value) => record(value, "contract layer").layer === layerId),
      layerId,
    );
    const expectedGate = layerId === "L0" ? "G0.5" : `G${layerId.slice(1)}`;
    const gate = requiredString(layer, "gate", layerId);
    if (gate !== expectedGate) {
      throw new Error(`${layerId}.gate expected=${expectedGate} actual=${gate}`);
    }
  }
  const rightArm = layers
    .filter((value) => {
      const candidate = record(value, "contract layer");
      return RIGHT_ARM_LAYERS.includes(
        String(candidate.layer ?? "") as (typeof RIGHT_ARM_LAYERS)[number],
      );
    })
    .map(compileLayer);
  const actualLayers = rightArm.map((entry) => entry.layer);
  if (
    actualLayers.length !== RIGHT_ARM_LAYERS.length ||
    RIGHT_ARM_LAYERS.some((layer) => actualLayers.filter((value) => value === layer).length !== 1)
  ) {
    throw new Error(`right-arm layers must be exactly once: ${actualLayers.join(",")}`);
  }
  for (const key of ["planId", "governanceArtifact", "evidenceManifest"] as const) {
    const values = rightArm.map((entry) => entry[key]);
    if (new Set(values).size !== values.length) throw new Error(`duplicate right-arm ${key}`);
  }
  const obligations = RIGHT_ARM_LAYERS.map(
    (layer) => rightArm.find((entry) => entry.layer === layer) as CompiledVerificationObligation,
  );
  const workflow = record(contract.forward_workflow, "V-model contract.forward_workflow");
  const exceptionValues = workflow.pair_reciprocity_exception_contracts;
  if (!Array.isArray(exceptionValues)) {
    throw new Error("pair_reciprocity_exception_contracts must be an array");
  }
  const pairExceptions = exceptionValues.map((value) => {
    const exception = record(value, "pair exception");
    const layer = requiredString(exception, "layer", "pair exception");
    const reason = requiredString(exception, "reason", `pair exception ${layer}`);
    const allowedPairLayers = stringArray(
      exception,
      "allowed_pair_layers",
      `pair exception ${layer}`,
    );
    const requiredBacklinks = stringArray(
      exception,
      "required_backlinks",
      `pair exception ${layer}`,
    );
    const layerSource = layers.find(
      (candidate) => record(candidate, "contract layer").layer === layer,
    );
    if (!layerSource) throw new Error(`pair exception references unknown layer=${layer}`);
    const declaredPairs = stringArray(record(layerSource, layer), "pair_layers", layer);
    if (JSON.stringify(allowedPairLayers) !== JSON.stringify(declaredPairs)) {
      throw new Error(`pair exception ${layer} allowed_pair_layers drift`);
    }
    const expectedBacklinks = PAIR_EXCEPTION_BACKLINKS[layer];
    if (
      !expectedBacklinks ||
      requiredBacklinks.length !== expectedBacklinks.length ||
      expectedBacklinks.some((backlink) => !requiredBacklinks.includes(backlink))
    ) {
      throw new Error(`pair exception ${layer} required_backlinks drift`);
    }
    return { layer, reason, allowedPairLayers, requiredBacklinks };
  });
  if (
    pairExceptions.length !== 2 ||
    ["L11", "L13"].some(
      (layer) => pairExceptions.filter((exception) => exception.layer === layer).length !== 1,
    )
  ) {
    throw new Error("pair exception contracts must define L11 and L13 exactly once");
  }
  const contractRevision = requiredString(contract, "schema_version", "V-model contract");
  const sourcePayload = JSON.stringify(contract);
  const generatedPayload = JSON.stringify({ contractRevision, obligations, pairExceptions });
  return {
    contractRevision,
    sourceHash: sha256(sourcePayload),
    generatedHash: sha256(generatedPayload),
    obligations,
    pairExceptions,
  };
}
