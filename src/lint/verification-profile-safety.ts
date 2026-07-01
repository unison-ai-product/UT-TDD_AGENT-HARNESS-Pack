import { normalizePath } from "./shared";
import { PROFILES } from "./verification-profile-catalog";
import type {
  ExternalProfileActivationInput,
  ExternalProfileActivationPlan,
  ExternalProfileActivationStep,
  GeneratedMcpConfigInput,
  GeneratedMcpConfigResult,
  VerificationProfile,
  VerificationProfileFinding,
  VerificationProfileFindingCode,
  VerificationProfileSafetyInput,
  VerificationProfileSafetyResult,
} from "./verification-profile-types";

function getVerificationProfile(id: string): VerificationProfile | null {
  if (!Object.hasOwn(PROFILES, id)) return null;
  return PROFILES[id as keyof typeof PROFILES];
}

function profileFinding(input: {
  code: VerificationProfileFindingCode;
  message: string;
  severity?: "error" | "warn" | "info";
  profileId?: string;
}): VerificationProfileFinding {
  return {
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    profileId: input.profileId,
  };
}

function isWorkspaceMount(repoRoot: string, mount: string): boolean {
  const repo = normalizePath(repoRoot).replace(/\/$/, "");
  const candidate = normalizePath(mount).replace(/\/$/, "");
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

function looksInlineSecret(value: string): boolean {
  if (value.startsWith("env:")) return false;
  return /^(ghp_|github_pat_|sk-|xox[baprs]-|glpat-|eyJ)/.test(value) || value.length >= 32;
}

function envReference(value: string): string {
  return value.startsWith("env:") ? `\${${value.slice(4)}}` : "<redacted>";
}

/**
 * Split a profile command string into an argv array (executable + arguments).
 * Whitespace-delimited; empty tokens dropped. Profile commands are plain
 * whitespace-separated words (no shell quoting), so this is sufficient for the
 * generated MCP launcher `{command, args}` contract (PLAN-L7-79).
 */
function tokenizeCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export function renderGeneratedMcpConfig(input: GeneratedMcpConfigInput): GeneratedMcpConfigResult {
  const findings: VerificationProfileFinding[] = [];
  const targetPath = input.targetPath ?? ".ut-tdd/local/mcp.generated.json";
  const writesCommittedConfig =
    normalizePath(targetPath) === ".vscode/mcp.json" ||
    normalizePath(targetPath).startsWith(".vscode/");
  if (writesCommittedConfig) {
    findings.push(
      profileFinding({
        code: "global-mount",
        message:
          "generated MCP config must remain a local suggestion and not write committed editor config",
      }),
    );
  }

  const mounts = input.mounts ?? [input.repoRoot];
  for (const mount of mounts) {
    if (!isWorkspaceMount(input.repoRoot, mount)) {
      findings.push(
        profileFinding({
          code: "global-mount",
          message: `mount ${mount} is outside workspace root`,
          severity: "error",
        }),
      );
    }
  }

  const servers: Record<string, unknown> = {};
  for (const id of input.selectedProfileIds) {
    const profile = getVerificationProfile(id);
    if (!profile) {
      findings.push(profileFinding({ code: "unknown-profile", message: `unknown profile ${id}` }));
      continue;
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.env ?? {})) {
      if (looksInlineSecret(value)) {
        findings.push(
          profileFinding({
            code: "credential-inline",
            message: `inline credential-like value for ${name} is not allowed`,
            severity: "error",
            profileId: profile.id,
          }),
        );
      } else {
        env[name] = envReference(value);
      }
    }
    // PLAN-L7-79: the generated MCP config feeds an external launcher whose
    // contract is `{command, args}` where args is a tokenized argv array, not a
    // single display string. Tokenize `profile.command` so the executable is not
    // re-included in args (e.g. command="bun", args=["run","test"] instead of
    // command="bun", args=["bun run test"]). `executable` is only a PATH-probe
    // hint (it can differ from the command head, e.g. wrapper commands) so it is
    // a defensive fallback for the command word, never the args.
    const [launchCommand, ...launchArgs] = tokenizeCommand(profile.command);
    servers[profile.id] = {
      command: launchCommand ?? profile.executable ?? profile.command,
      args: launchArgs,
      env,
      mounts,
      disabled: !profile.defaultEnabled,
    };
  }

  return {
    targetPath,
    content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    findings,
    writesCommittedConfig,
    ok: findings.every((finding) => finding.severity !== "error") && !writesCommittedConfig,
  };
}

function officialHost(profile: VerificationProfile): string | null {
  if (profile.id === "playwright-mcp") return "github.com/microsoft/playwright-mcp";
  if (profile.id === "mcp-inspector-smoke") return "github.com/modelcontextprotocol/inspector";
  if (profile.id === "github-mcp-readonly") return "github.com/github/github-mcp-server";
  if (profile.id === "docker-mcp-toolkit")
    return "docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit";
  if (profile.id === "vitest-browser-playwright") return "vitest.dev/guide/browser";
  if (profile.id === "testcontainers") return "node.testcontainers.org";
  if (profile.id === "msw") return "mswjs.io";
  return null;
}

export function analyzeVerificationProfileSafety(
  input: VerificationProfileSafetyInput,
): VerificationProfileSafetyResult {
  const profile = input.profile;
  const findings: VerificationProfileFinding[] = [];
  const actions: string[] = [];
  const sourceUrl = profile.sourceUrl ?? "";
  const expectedSource = officialHost(profile);
  if (expectedSource && !sourceUrl.includes(expectedSource)) {
    findings.push(
      profileFinding({
        code: "untrusted-source",
        message: `profile source ${sourceUrl || "<missing>"} does not match ${expectedSource}`,
        severity: "error",
        profileId: profile.id,
      }),
    );
  }
  if (profile.packageName) {
    const expected = input.expectedPackage ?? profile.packageName;
    if (profile.packageName !== expected) {
      findings.push(
        profileFinding({
          code: "package-mismatch",
          message: `profile package ${profile.packageName} does not match ${expected}`,
          severity: "warn",
          profileId: profile.id,
        }),
      );
    }
    if (!(input.declaredPackages ?? []).includes(profile.packageName)) {
      findings.push(
        profileFinding({
          code: "package-missing",
          message: `${profile.packageName} is not declared; do not install implicitly`,
          severity: "warn",
          profileId: profile.id,
        }),
      );
    }
  }
  const allowedTools = input.allowedTools ?? profile.allowedTools ?? [];
  if (profile.id === "github-mcp-readonly") {
    const writeTools = allowedTools.filter((tool) => /write|delete|admin|merge|create/i.test(tool));
    if (writeTools.length > 0 && !input.requiresHumanApproval) {
      findings.push(
        profileFinding({
          code: "github-write-tool",
          message: `GitHub MCP write tools require human approval: ${writeTools.join(", ")}`,
          severity: "error",
          profileId: profile.id,
        }),
      );
    }
    if (
      (allowedTools.includes("*") || allowedTools.includes("all")) &&
      !input.requiresHumanApproval
    ) {
      findings.push(
        profileFinding({
          code: "broad-toolset",
          message: "GitHub MCP broad toolsets require human approval",
          severity: "error",
          profileId: profile.id,
        }),
      );
    }
  }
  if (profile.requiresDocker) {
    if (!input.dockerAvailable) {
      findings.push(
        profileFinding({
          code: "docker-unavailable",
          message: "Docker is required but unavailable",
          severity: "error",
          profileId: profile.id,
        }),
      );
    }
    if (!input.dockerControlsDocumented) {
      findings.push(
        profileFinding({
          code: "docker-controls-missing",
          message: "Docker profile/resource controls are not documented",
          severity: "error",
          profileId: profile.id,
        }),
      );
    }
  }
  const trusted = !findings.some((finding) => finding.code === "untrusted-source");
  const ready = !findings.some(
    (finding) => finding.severity === "error" || finding.code === "package-missing",
  );
  return {
    profile,
    findings: findings.sort((a, b) => a.code.localeCompare(b.code)),
    actions,
    trusted,
    ready,
    ok: !findings.some((finding) => finding.severity === "error"),
  };
}

export function planExternalProfileActivation(
  input: ExternalProfileActivationInput,
): ExternalProfileActivationPlan {
  const steps: ExternalProfileActivationStep[] = [];
  const findings: VerificationProfileFinding[] = [];
  const sortedRecommendations = [...input.recommendations].sort((a, b) =>
    a.profile.id.localeCompare(b.profile.id),
  );
  for (const recommendation of sortedRecommendations) {
    const profile = recommendation.profile;
    if (profile.defaultEnabled) continue;
    steps.push({
      profileId: profile.id,
      action: "probe-profile",
      reason: `${profile.id} must pass readiness probe before activation`,
    });
    if (profile.sourceType === "mcp") {
      steps.push({
        profileId: profile.id,
        action: "mcp-inspector-smoke",
        reason: `${profile.id} requires MCP Inspector smoke before run`,
      });
    }
    steps.push({
      profileId: profile.id,
      action: "human-approval",
      reason: `${profile.id} is disabled by default`,
    });
    if (!input.allowExternal) {
      steps.push({
        profileId: profile.id,
        action: "refuse-run",
        reason: "external execution is not allowed for this workflow evidence",
      });
      findings.push(
        profileFinding({
          code: "external-approval-required",
          message: `${profile.id} requires allow_external and human-approved workflow evidence`,
          severity: "error",
          profileId: profile.id,
        }),
      );
    }
  }
  return {
    steps,
    findings,
    actionsTaken: [],
    ok: findings.length === 0,
  };
}
