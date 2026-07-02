import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface GithubWorkflowDoc {
  file: string;
  content: string;
  profile: "source" | "pack";
}

export interface GithubCiPolicyViolation {
  file: string;
  profile: "source" | "pack";
  reason:
    | "missing_workflow"
    | "malformed_yaml"
    | "missing_job"
    | "missing_trigger"
    | "missing_permission"
    | "missing_concurrency"
    | "missing_step"
    | "forbidden_full_doctor"
    | "forbidden_raw_vitest"
    | "forbidden_source_full_tests";
  detail: string;
}

export interface GithubCiPolicyResult {
  checked: number;
  violations: GithubCiPolicyViolation[];
  ok: boolean;
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowYaml {
  name?: string;
  on?: unknown;
  permissions?: Record<string, unknown> | string;
  concurrency?: unknown;
  jobs?: Record<string, WorkflowJob>;
}

interface RequiredStepSpec {
  label: string;
  any: readonly string[];
}

interface ForbiddenStepSpec {
  reason: Extract<
    GithubCiPolicyViolation["reason"],
    "forbidden_full_doctor" | "forbidden_raw_vitest" | "forbidden_source_full_tests"
  >;
  detail: string;
  matches: (step: WorkflowStep) => boolean;
}

interface GithubCiProfileSpec {
  requiredSteps: readonly RequiredStepSpec[];
  forbiddenSteps: readonly ForbiddenStepSpec[];
}

const SOURCE_REQUIRED_STEPS = [
  { label: "checkout@v5", any: ["actions/checkout@v5"] },
  { label: "setup-bun@v2", any: ["oven-sh/setup-bun@v2"] },
  { label: "frozen install", any: ["bun install --frozen-lockfile"] },
  { label: "github guard", any: ["github guard"] },
  { label: "typecheck", any: ["bun run typecheck"] },
  { label: "db rebuild", any: ["db rebuild"] },
  { label: "full tests", any: ["bun run test"] },
  { label: "lint", any: ["bun run lint"] },
  { label: "audit quality", any: ["audit quality"] },
  { label: "full doctor", any: ["src/cli.ts doctor"] },
] as const;

const PACK_REQUIRED_STEPS = [
  { label: "checkout@v5", any: ["actions/checkout@v5"] },
  { label: "setup-bun@v2", any: ["oven-sh/setup-bun@v2"] },
  { label: "frozen install", any: ["bun install --frozen-lockfile"] },
  { label: "typecheck", any: ["bun run typecheck"] },
  { label: "pack tests", any: ["bun run test:pack"] },
  { label: "lint", any: ["bun run lint"] },
  { label: "setup projection", any: ["src/cli.ts setup --solo"] },
  { label: "setup smoke doctor", any: ["doctor --setup-smoke"] },
] as const;

const GITHUB_CI_PROFILE_SPECS: Record<GithubWorkflowDoc["profile"], GithubCiProfileSpec> = {
  source: {
    requiredSteps: SOURCE_REQUIRED_STEPS,
    forbiddenSteps: [],
  },
  pack: {
    requiredSteps: PACK_REQUIRED_STEPS,
    forbiddenSteps: [
      {
        reason: "forbidden_full_doctor",
        detail:
          "Pack CI must use doctor --setup-smoke because Pack excludes source-only governance docs",
        matches: (step) => {
          const run = step.run ?? "";
          return run.includes(" doctor") && !run.includes("--setup-smoke");
        },
      },
      {
        reason: "forbidden_raw_vitest",
        detail: "Pack CI must use bun run test:pack instead of raw vitest run",
        matches: (step) => /\bvitest\s+run\b/.test(step.run ?? ""),
      },
      {
        reason: "forbidden_source_full_tests",
        detail: "Pack CI must use bun run test:pack instead of source full bun run test",
        matches: (step) => /\bbun\s+run\s+test\b(?!:)/.test(step.run ?? ""),
      },
    ],
  },
};

function inferGithubCiProfile(file: string, content: string): GithubWorkflowDoc["profile"] {
  if (file.endsWith(join("common", "pack-harness-check.yml"))) return "pack";
  if (file.endsWith(join("common", "harness-check.yml"))) return "source";
  if (
    content.includes("bun run test:pack") ||
    content.includes("setup --solo") ||
    content.includes("doctor --setup-smoke")
  ) {
    return "pack";
  }
  return "source";
}

function valuesContain(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => valuesContain(entry, needle));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      valuesContain(entry, needle),
    );
  }
  return false;
}

function stepText(step: WorkflowStep): string {
  return [step.name, step.uses, step.run].filter(Boolean).join("\n");
}

function hasStep(steps: WorkflowStep[], needles: readonly string[]): boolean {
  return steps.some((step) => {
    const text = stepText(step);
    return needles.every((needle) => text.includes(needle));
  });
}

function pushViolation(input: {
  violations: GithubCiPolicyViolation[];
  doc: GithubWorkflowDoc;
  reason: GithubCiPolicyViolation["reason"];
  detail: string;
}): void {
  input.violations.push({
    file: input.doc.file,
    profile: input.doc.profile,
    reason: input.reason,
    detail: input.detail,
  });
}

export function analyzeGithubCiPolicy(docs: GithubWorkflowDoc[]): GithubCiPolicyResult {
  const violations: GithubCiPolicyViolation[] = [];
  for (const doc of docs) {
    let workflow: WorkflowYaml;
    try {
      workflow = parseYaml(doc.content) as WorkflowYaml;
    } catch {
      pushViolation({
        violations,
        doc,
        reason: "malformed_yaml",
        detail: "workflow YAML does not parse",
      });
      continue;
    }
    const job = workflow.jobs?.["harness-check"];
    if (!job) {
      pushViolation({ violations, doc, reason: "missing_job", detail: "jobs.harness-check" });
      continue;
    }
    if (!valuesContain(workflow.on, "main")) {
      pushViolation({
        violations,
        doc,
        reason: "missing_trigger",
        detail: "push/pull_request main",
      });
    }
    if (!valuesContain(workflow.permissions, "read")) {
      pushViolation({ violations, doc, reason: "missing_permission", detail: "contents: read" });
    }
    if (!workflow.concurrency) {
      pushViolation({
        violations,
        doc,
        reason: "missing_concurrency",
        detail: "concurrency group",
      });
    }

    const steps = job.steps ?? [];
    const profileSpec = GITHUB_CI_PROFILE_SPECS[doc.profile];
    for (const spec of profileSpec.requiredSteps) {
      if (!hasStep(steps, spec.any)) {
        pushViolation({ violations, doc, reason: "missing_step", detail: spec.label });
      }
    }

    for (const spec of profileSpec.forbiddenSteps) {
      if (steps.some(spec.matches)) {
        pushViolation({
          violations,
          doc,
          reason: spec.reason,
          detail: spec.detail,
        });
      }
    }
  }

  for (const profile of ["source", "pack"] as const) {
    if (!docs.some((doc) => doc.profile === profile)) {
      pushViolation({
        violations,
        doc: {
          file:
            profile === "source"
              ? join(".github", "workflows", "harness-check.yml")
              : join("docs", "templates", "github", "common", "pack-harness-check.yml"),
          profile,
          content: "",
        },
        reason: "missing_workflow",
        detail: `${profile} harness-check workflow`,
      });
    }
  }

  return { checked: docs.length, violations, ok: violations.length === 0 };
}

export function loadGithubCiPolicyDocs(repoRoot: string = process.cwd()): GithubWorkflowDoc[] {
  const candidates: GithubWorkflowDoc[] = [];
  const addCandidate = (relativeFile: string) => {
    const absoluteFile = join(repoRoot, relativeFile);
    if (!existsSync(absoluteFile)) return;
    const content = readFileSync(absoluteFile, "utf8");
    const profile = inferGithubCiProfile(relativeFile, content);
    if (candidates.some((candidate) => candidate.profile === profile)) return;
    candidates.push({
      file: relativeFile,
      content,
      profile,
    });
  };
  addCandidate(join(".github", "workflows", "harness-check.yml"));
  addCandidate(join("docs", "templates", "github", "common", "harness-check.yml"));
  addCandidate(join("docs", "templates", "github", "common", "pack-harness-check.yml"));
  return candidates;
}

export function githubCiPolicyMessages(result: GithubCiPolicyResult): string[] {
  if (result.ok) {
    return [`github-ci-policy - OK (checked=${result.checked}, source+pack harness-check gates)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.file}:${v.reason}:${v.detail}`)
    .join(", ");
  return [`github-ci-policy - violation ${result.violations.length} (${sample})`];
}
