/**
 * Right-arm gate planning lint.
 *
 * G8-G14 were intentionally left concept-only while the right-arm gate model was
 * being stabilized. Once that carry was observed as IMP-052, the unsafe state is
 * not "future implementation remains"; it is "future implementation remains
 * without a concrete PLAN route". This lint keeps that route machine-checked.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { loadCompiledRightArmRegistry } from "../vmodel-contract/adapters/yaml-contract-loader.ts";
import { parseBacklogEntries } from "./improvement-backlog.ts";
import { fmValue } from "./shared.ts";

export interface RightArmGatePlanningInput {
  gatesMd: string;
  backlogMd: string;
  concretePlanRefs?: string[];
  engineSwapPlanStatus?: string | null;
  engineSwapProgramExitStatus?: string | null;
  verifyPlans?: RightArmVerifyPlan[];
  expectedVerifyPlans?: RightArmVerificationObligation[];
  parentBacklinks?: string[];
}

export interface RightArmVerifyPlan {
  planId?: string;
  layer: string;
  status: string;
  engineSwapLinked: boolean;
  owningDesignLinked?: boolean;
  verificationGate?: string;
  parentDesign?: string;
  generatedArtifacts?: string[];
  governanceArtifactExists?: boolean;
  dependencyPlanIds?: string[];
}

export interface RightArmVerificationObligation {
  planId: string;
  layer: string;
  gate: string;
  governanceArtifact: string;
  evidenceManifest: string;
  requiredBacklinks?: string[];
}

export interface RightArmGatePlanningResult {
  ok: boolean;
  imp052Present: boolean;
  imp052Status: string | null;
  planRefs: string[];
  gatesStillUnplanned: boolean;
  engineSwapState: "not_registered" | "in_progress" | "complete";
  missingPlannedVerifyLayers: string[];
  missingCompletedVerifyLayers: string[];
  violations: string[];
}

const PLAN_REF = /PLAN-(?:L\d+|REVERSE)-[A-Za-z0-9._-]+/g;
const REQUIRED_PLAN_REFS = [
  "PLAN-L7-130-right-arm-gate-planning",
  "PLAN-REVERSE-130-right-arm-gate-planning",
] as const;
const ENGINE_SWAP_PLAN_IDS = new Set([
  "PLAN-L1-07-vmodel-engine-swap-requirements-delta",
  "PLAN-L4-24-declarative-vmodel-contract-right-arm",
]);
const EXPECTED_VERIFY_LAYERS = ["L8", "L9", "L10", "L11", "L12", "L13", "L14"];

function frontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? (YAML.parse(match[1]) as Record<string, unknown>) : null;
}

function dependencyIds(content: string): string[] {
  const raw = frontmatter(content)?.dependencies as
    | { parent?: unknown; requires?: unknown; references?: unknown }
    | undefined;
  if (!raw || typeof raw !== "object") return [];
  return [raw.parent, raw.requires, raw.references]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replaceAll("\\", "/").split("/").at(-1)?.replace(/\.md$/, "") ?? "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/[.,;:]+$/, "")))].sort();
}

export function engineSwapDependencyLink(content: string): boolean {
  return dependencyIds(content).some((value) => ENGINE_SWAP_PLAN_IDS.has(value));
}

export function loadRightArmGatePlanningInput(repoRoot = process.cwd()): RightArmGatePlanningInput {
  const concretePlanRefs = REQUIRED_PLAN_REFS.filter((planId) =>
    existsSync(resolve(repoRoot, "docs/plans", `${planId}.md`)),
  );
  const planDir = resolve(repoRoot, "docs/plans");
  const engineSwapPath = resolve(planDir, "PLAN-L4-24-declarative-vmodel-contract-right-arm.md");
  const engineSwapContent = existsSync(engineSwapPath)
    ? readFileSync(engineSwapPath, "utf8")
    : null;
  const engineSwapPlanStatus = engineSwapContent
    ? (fmValue(engineSwapContent, "status") ?? null)
    : null;
  const engineSwapProgramExitStatus = engineSwapContent
    ? (fmValue(engineSwapContent, "program_exit_status") ?? null)
    : null;
  const registry = loadCompiledRightArmRegistry(repoRoot);
  const expectedVerifyPlans = registry.obligations.map((entry) => ({
    planId: entry.planId,
    layer: entry.layer,
    gate: entry.gate,
    governanceArtifact: entry.governanceArtifact,
    evidenceManifest: entry.evidenceManifest,
    requiredBacklinks:
      registry.pairExceptions.find((exception) => exception.layer === entry.layer)
        ?.requiredBacklinks ?? [],
  }));
  const parentBacklinks = engineSwapContent ? dependencyIds(engineSwapContent) : [];
  const verifyPlans = existsSync(planDir)
    ? readdirSync(planDir)
        .filter((name) => name.endsWith(".md"))
        .flatMap((name) => {
          const content = readFileSync(resolve(planDir, name), "utf8");
          if (fmValue(content, "kind") !== "verify") return [];
          const raw = frontmatter(content) ?? {};
          const generates = Array.isArray(raw.generates) ? raw.generates : [];
          const generatedArtifacts = generates.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const path = (entry as { artifact_path?: unknown }).artifact_path;
            return typeof path === "string" ? [path.replaceAll("\\", "/")] : [];
          });
          const parentDesign = typeof raw.parent_design === "string" ? raw.parent_design : "";
          return [
            {
              planId: fmValue(content, "plan_id") ?? "",
              layer: fmValue(content, "layer") ?? "",
              status: fmValue(content, "status") ?? "draft",
              engineSwapLinked: engineSwapDependencyLink(content),
              owningDesignLinked: dependencyIds(content).includes(
                "PLAN-L4-24-declarative-vmodel-contract-right-arm",
              ),
              verificationGate: fmValue(content, "verification_gate") ?? "",
              parentDesign,
              generatedArtifacts,
              governanceArtifactExists: Boolean(
                parentDesign && existsSync(resolve(repoRoot, parentDesign)),
              ),
              dependencyPlanIds: dependencyIds(content),
            },
          ];
        })
    : [];
  return {
    gatesMd: readFileSync(resolve(repoRoot, "docs/process/gates.md"), "utf8"),
    backlogMd: readFileSync(resolve(repoRoot, "docs/improvement-backlog.md"), "utf8"),
    concretePlanRefs,
    engineSwapPlanStatus,
    engineSwapProgramExitStatus,
    verifyPlans,
    expectedVerifyPlans,
    parentBacklinks,
  };
}

function validExpectedVerifyPlans(
  input: RightArmGatePlanningInput,
  violations: string[],
): RightArmVerifyPlan[] {
  const obligations = input.expectedVerifyPlans ?? [];
  if (
    obligations.length !== EXPECTED_VERIFY_LAYERS.length ||
    EXPECTED_VERIFY_LAYERS.some(
      (layer) => obligations.filter((obligation) => obligation.layer === layer).length !== 1,
    )
  ) {
    violations.push("engine-swap verification obligations must define L8-L14 exactly once");
    return [];
  }
  const plans = input.verifyPlans ?? [];
  const parentBacklinks = new Set(input.parentBacklinks ?? []);
  return obligations.flatMap((obligation) => {
    const matches = plans.filter((plan) => plan.planId === obligation.planId);
    if (matches.length !== 1) {
      violations.push(
        matches.length === 0
          ? `engine-swap expected verify PLAN is missing: ${obligation.planId}`
          : `engine-swap verify PLAN identity is duplicated: ${obligation.planId}`,
      );
      return [];
    }
    const plan = matches[0];
    const mismatches: string[] = [];
    if (plan.layer !== obligation.layer) mismatches.push(`layer=${plan.layer}`);
    if (plan.verificationGate !== obligation.gate) {
      mismatches.push(`verification_gate=${plan.verificationGate ?? "missing"}`);
    }
    if (!plan.engineSwapLinked) mismatches.push("engine-swap-link=missing");
    if (!plan.owningDesignLinked) mismatches.push("owning-design-link=missing");
    if (!parentBacklinks.has(obligation.planId)) mismatches.push("parent-backlink=missing");
    if (plan.parentDesign !== obligation.governanceArtifact) {
      mismatches.push(`parent_design=${plan.parentDesign ?? "missing"}`);
    }
    if (!plan.governanceArtifactExists) mismatches.push("governance-artifact=missing");
    if (!(plan.generatedArtifacts ?? []).includes(obligation.governanceArtifact)) {
      mismatches.push("governance-artifact-generate=missing");
    }
    if (!(plan.generatedArtifacts ?? []).includes(obligation.evidenceManifest)) {
      mismatches.push("evidence-manifest-generate=missing");
    }
    for (const backlink of obligation.requiredBacklinks ?? []) {
      if (!(plan.dependencyPlanIds ?? []).includes(backlink)) {
        mismatches.push(`required-backlink=${backlink}`);
      }
    }
    if (!new Set(["draft", "confirmed", "completed", "archived"]).has(plan.status)) {
      mismatches.push(`status=${plan.status}`);
    }
    if (mismatches.length > 0) {
      violations.push(
        `engine-swap verify PLAN contract mismatch: ${obligation.planId} (${mismatches.join(",")})`,
      );
      return [];
    }
    return [plan];
  });
}

export function analyzeRightArmGatePlanning(
  input: RightArmGatePlanningInput,
): RightArmGatePlanningResult {
  const entries = parseBacklogEntries(input.backlogMd);
  const imp052 = entries.find((entry) => entry.id === "IMP-052");
  const imp052Text = imp052 ? `${imp052.issue}\n${imp052.link}` : "";
  const g8g14Text = input.gatesMd.match(/G8-G14[\s\S]{0,700}/)?.[0] ?? "";
  const planRefs = unique([
    ...(g8g14Text.match(PLAN_REF) ?? []),
    ...(imp052Text.match(PLAN_REF) ?? []),
    ...(input.concretePlanRefs ?? []),
  ]);
  const gatesStillUnplanned = /G8-G14[\s\S]{0,300}未起票/.test(input.gatesMd);
  const violations: string[] = [];
  const expectedVerifyLayers = EXPECTED_VERIFY_LAYERS;
  const validVerifyPlans = validExpectedVerifyPlans(input, violations);
  const plannedVerifyLayers = new Set(
    validVerifyPlans
      .filter((plan) => plan.engineSwapLinked && plan.status !== "archived")
      .map((plan) => plan.layer),
  );
  const completedVerifyLayers = new Set(
    validVerifyPlans
      .filter(
        (plan) =>
          plan.engineSwapLinked && (plan.status === "confirmed" || plan.status === "completed"),
      )
      .map((plan) => plan.layer),
  );
  const missingPlannedVerifyLayers = expectedVerifyLayers.filter(
    (layer) => !plannedVerifyLayers.has(layer),
  );
  const missingCompletedVerifyLayers = expectedVerifyLayers.filter(
    (layer) => !completedVerifyLayers.has(layer),
  );
  const designFrozen =
    input.engineSwapPlanStatus === "confirmed" || input.engineSwapPlanStatus === "completed";
  const programAccepted = input.engineSwapProgramExitStatus === "accepted";
  const engineSwapState = !input.engineSwapPlanStatus
    ? "not_registered"
    : designFrozen && programAccepted && missingCompletedVerifyLayers.length === 0
      ? "complete"
      : "in_progress";

  if (!imp052) {
    violations.push("IMP-052 is missing from docs/improvement-backlog.md");
  }
  if (imp052?.status === "observed" && planRefs.length === 0) {
    violations.push("IMP-052 is still observed instead of routed to a concrete PLAN");
  }
  if (planRefs.length === 0) {
    violations.push("G8-G14 mechanization carry has no PLAN reference");
  }
  if (gatesStillUnplanned && planRefs.length === 0) {
    violations.push("docs/process/gates.md still marks G8-G14 mechanization as unplanned");
  }
  if (!input.engineSwapPlanStatus) {
    violations.push("engine-swap right-arm PLAN is missing");
  } else if (
    input.engineSwapPlanStatus !== "draft" &&
    input.engineSwapPlanStatus !== "confirmed" &&
    input.engineSwapPlanStatus !== "completed"
  ) {
    violations.push(`engine-swap right-arm PLAN has invalid status=${input.engineSwapPlanStatus}`);
  }
  if (
    input.engineSwapProgramExitStatus !== "in_progress" &&
    input.engineSwapProgramExitStatus !== "accepted"
  ) {
    violations.push(
      `engine-swap program_exit_status is invalid=${input.engineSwapProgramExitStatus ?? "missing"}`,
    );
  }
  if (programAccepted && !designFrozen) {
    violations.push("engine-swap program cannot be accepted before the right-arm design freeze");
  }
  if (designFrozen && missingPlannedVerifyLayers.length > 0) {
    violations.push(
      `engine-swap right-arm design is frozen but linked verify PLAN layers are not planned: ${missingPlannedVerifyLayers.join(",")}`,
    );
  }
  if (programAccepted && missingCompletedVerifyLayers.length > 0) {
    violations.push(
      `engine-swap program is accepted but verify PLAN layers are incomplete: ${missingCompletedVerifyLayers.join(",")}`,
    );
  }

  return {
    ok: violations.length === 0,
    imp052Present: Boolean(imp052),
    imp052Status: imp052?.status ?? null,
    planRefs,
    gatesStillUnplanned,
    engineSwapState,
    missingPlannedVerifyLayers,
    missingCompletedVerifyLayers,
    violations,
  };
}

export function rightArmGatePlanningMessages(result: RightArmGatePlanningResult): string[] {
  if (result.engineSwapState === "in_progress" && result.violations.length === 0) {
    return [
      `right-arm-gate-planning - IN-PROGRESS (planned missing=${result.missingPlannedVerifyLayers.join(",") || "none"}; completed missing=${result.missingCompletedVerifyLayers.join(",") || "none"}; legacy plans=${result.planRefs.join(", ")})`,
    ];
  }
  if (result.ok) {
    return [
      `right-arm-gate-planning - OK (IMP-052=${result.imp052Status}, plans=${result.planRefs.join(", ")})`,
    ];
  }
  return [`right-arm-gate-planning - violation: ${result.violations.join("; ")}`];
}
