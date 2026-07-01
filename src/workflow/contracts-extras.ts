import type { ContractResult, Finding } from "./contracts-types";

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

function stableId(prefix: string, value: string): string {
  return `${prefix}:${value || "unknown"}`.replace(/[^A-Za-z0-9._:-]+/g, "-");
}
export function suggestSkillInjection(input: {
  task: string;
  layer: string;
  drive: string;
  catalog: { skill_id: string; triggers?: string[]; layers?: string[]; drives?: string[] }[];
}): ContractResult & { candidates: { skill_id: string; score: number; reason: string }[] } {
  const task = input.task.toLowerCase();
  const candidates = input.catalog
    .map((skill) => {
      let score = 0;
      if (skill.layers?.includes(input.layer)) score += 0.35;
      if (skill.drives?.includes(input.drive)) score += 0.35;
      if (skill.triggers?.some((trigger) => task.includes(trigger.toLowerCase()))) score += 0.3;
      return {
        skill_id: skill.skill_id,
        score: Number(score.toFixed(2)),
        reason: `layer=${input.layer}; drive=${input.drive}`,
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.skill_id.localeCompare(b.skill_id));
  const findings =
    input.catalog.length === 0
      ? [finding("missing-catalog", "skill catalog is empty", { severity: "warn" })]
      : [];
  return { ...result(findings), candidates };
}

export function validateFolderRules(input: {
  path: string;
  artifact_kind: string;
  registry: Record<string, string[]>;
}): ContractResult & { violations: string[] } {
  const allowed = input.registry[input.artifact_kind] ?? [];
  const valid = allowed.some((prefix) => input.path.replaceAll("\\", "/").startsWith(prefix));
  const violations = valid ? [] : [`${input.artifact_kind}:${input.path}`];
  return { ...result(valid ? [] : [finding("folder-rule-violation", violations[0])]), violations };
}

export function catalogExistingAssets(input: {
  roots: { path: string; type: string; content?: string }[];
}): ContractResult & { assets: { asset_id: string; path: string; type: string }[] } {
  const assets = input.roots.map((root) => ({
    asset_id: stableId(root.type, root.path),
    path: root.path,
    type: root.type,
  }));
  const findings =
    assets.length === 0 ? [finding("empty-assets", "no assets found", { severity: "warn" })] : [];
  return { ...result(findings), assets };
}

export function prioritizeCapabilityGaps(input: {
  assets: { asset_id: string }[];
  workflow_impact: Record<string, number>;
  missing_routes: string[];
}): { priorities: { gap: string; score: number }[] } {
  const assetCount = Math.max(1, input.assets.length);
  return {
    priorities: input.missing_routes
      .map((gap) => ({
        gap,
        score: Number(((input.workflow_impact[gap] ?? 1) / assetCount).toFixed(2)),
      }))
      .sort((a, b) => b.score - a.score || a.gap.localeCompare(b.gap)),
  };
}

export function renderFoundationReadiness(input: {
  categories: { name: string; implemented?: boolean; designed?: boolean }[];
}): ContractResult & { implemented: string[]; designed: string[]; missing: string[] } {
  const implemented = input.categories.filter((c) => c.implemented).map((c) => c.name);
  const designed = input.categories.filter((c) => !c.implemented && c.designed).map((c) => c.name);
  const missing = input.categories.filter((c) => !c.implemented && !c.designed).map((c) => c.name);
  return {
    ...result(
      missing.map((name) =>
        finding("foundation-missing", `${name} is missing`, { severity: "warn" }),
      ),
    ),
    implemented,
    designed,
    missing,
  };
}

export function recommendModelEffort(input: {
  task: string;
  drive: string;
  layer: string;
  size: "S" | "M" | "L";
  uncertainty: number;
}): { model_family: string; reasoning_effort: "low" | "medium" | "high"; evidence_path: string } {
  const high = input.size === "L" || input.uncertainty >= 0.7;
  const medium = input.size === "M" || input.uncertainty >= 0.35;
  return {
    model_family: high ? "frontier" : medium ? "codex" : "fast",
    reasoning_effort: high ? "high" : medium ? "medium" : "low",
    evidence_path: `${input.layer}:${input.drive}:${stableId("task", input.task)}`,
  };
}

export function scoreTaskComplexity(input: {
  size: number;
  dependencies: number;
  uncertainty?: number;
  affected_artifacts: number;
}): { score: number; class: "S" | "M" | "L"; findings: Finding[] } {
  const findings =
    input.uncertainty === undefined
      ? [finding("unknown-uncertainty", "uncertainty is unknown", { severity: "warn" })]
      : [];
  const score =
    input.size +
    input.dependencies * 2 +
    input.affected_artifacts +
    (input.uncertainty ?? 0.5) * 10;
  return {
    score: Number(score.toFixed(2)),
    class: score >= 18 ? "L" : score >= 9 ? "M" : "S",
    findings,
  };
}

export function resolveDriveStatePartition(input: {
  drive: string;
  mode: string;
  kind: string;
  layer: string;
  plan_id?: string;
  session_id?: string;
}): { partition_path: string; skip_sub_doc: string[] } {
  const id = input.plan_id ?? input.session_id ?? "unscoped";
  return {
    partition_path: `.ut-tdd/drive/${input.drive}/${input.mode}/${id}`,
    skip_sub_doc: input.kind === "poc" ? ["L8", "L9"] : [],
  };
}

export function validateDriveStatePartitions(input: {
  partitions: { drive: string; partition_path: string; artifact_ids: string[] }[];
  allowed_cross_drive_artifacts?: string[];
}): ContractResult & { duplicate_artifact_ids: string[] } {
  const allowed = new Set(input.allowed_cross_drive_artifacts ?? []);
  const byArtifact = new Map<string, Set<string>>();
  for (const partition of input.partitions) {
    if (
      !partition.partition_path
        .replaceAll("\\", "/")
        .startsWith(`.ut-tdd/drive/${partition.drive}/`)
    ) {
      return {
        ...result([
          finding("drive-partition-path-mismatch", "partition path does not match drive", {
            evidencePath: partition.partition_path,
          }),
        ]),
        duplicate_artifact_ids: [],
      };
    }
    for (const artifactId of partition.artifact_ids) {
      if (!byArtifact.has(artifactId)) byArtifact.set(artifactId, new Set());
      byArtifact.get(artifactId)?.add(partition.drive);
    }
  }
  const duplicateArtifactIds = [...byArtifact.entries()]
    .filter(([artifactId, drives]) => drives.size > 1 && !allowed.has(artifactId))
    .map(([artifactId]) => artifactId)
    .sort();
  return {
    ...result(
      duplicateArtifactIds.map((artifactId) =>
        finding("cross-drive-artifact-contamination", `${artifactId} appears in multiple drives`),
      ),
    ),
    duplicate_artifact_ids: duplicateArtifactIds,
  };
}

export function classifyDrive(input: {
  plan: string;
  code_delta?: string[];
  dependency_delta?: string[];
}): { drive: string; confidence: number; findings: Finding[] } {
  const text =
    `${input.plan} ${(input.code_delta ?? []).join(" ")} ${(input.dependency_delta ?? []).join(" ")}`.toLowerCase();
  const drive = text.includes("db")
    ? "db"
    : text.includes("frontend") || text.includes("ui")
      ? "frontend"
      : text.includes("agent")
        ? "agent"
        : "fullstack";
  const confidence = drive === "fullstack" ? 0.6 : 0.85;
  return {
    drive,
    confidence,
    findings:
      confidence < 0.7
        ? [
            finding("low-drive-confidence", "drive classification has low confidence", {
              severity: "warn",
            }),
          ]
        : [],
  };
}

export function catalogSkills(input: {
  skill_docs: { path: string; name?: string; triggers?: string[] }[];
}): ContractResult & { skills: { skill_id: string; path: string; triggers: string[] }[] } {
  const skills = input.skill_docs.map((doc) => ({
    skill_id: stableId("skill", doc.name ?? doc.path),
    path: doc.path,
    triggers: doc.triggers ?? [],
  }));
  return {
    ...result(
      skills.length === 0
        ? [finding("empty-skill-catalog", "skill catalog is empty", { severity: "warn" })]
        : [],
    ),
    skills,
  };
}

export function recommendSkills(input: {
  task: string;
  layer: string;
  drive: string;
  catalog: { skill_id: string; triggers?: string[]; layers?: string[]; drives?: string[] }[];
}) {
  const recommendation = suggestSkillInjection(input);
  return { recommendations: recommendation.candidates, findings: recommendation.findings };
}

export function buildCommandCatalog(input: {
  command_docs: { path: string; command: string; description?: string }[];
  cli_surface: string[];
}): ContractResult & { commands: { command_id: string; command: string; path: string }[] } {
  const surface = new Set(input.cli_surface);
  const commands = input.command_docs.map((doc) => ({
    command_id: stableId("command", doc.command),
    command: doc.command,
    path: doc.path,
  }));
  const findings = commands
    .filter((cmd) => !surface.has(cmd.command))
    .map((cmd) =>
      finding("command-not-on-cli-surface", `${cmd.command} is not on CLI surface`, {
        evidencePath: cmd.path,
        severity: "warn",
      }),
    );
  return { ...result(findings), commands };
}
