import { describe, expect, it } from "vitest";
import {
  analyzeVerificationProfileGate,
  catalogVerificationProfiles,
  getVerificationProfile,
  inspectMcpProfile,
  listVerificationProfiles,
  probeVerificationProfile,
  recommendVerificationProfiles,
  runVerificationProfile,
  saveVerificationEvidence,
  VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  type VerificationProbeDeps,
  verificationProfileGateMessages,
  verificationRecommendationMermaid,
  verificationRecommendationMessages,
} from "../src/lint/verification-profile";
import { PROFILES } from "../src/lint/verification-profile-catalog";
import {
  analyzeVerificationProfileSafety,
  planExternalProfileActivation,
  renderGeneratedMcpConfig,
} from "../src/lint/verification-profile-safety";
import type { VerificationProfileRunResult as SidecarVerificationProfileRunResult } from "../src/lint/verification-profile-types";

function deps(over: Partial<VerificationProbeDeps> = {}): VerificationProbeDeps {
  return {
    repoRoot: "/repo",
    env: {},
    now: () => "2026-06-09T12:34:56.000Z",
    commandOk: () => true,
    runCommand: () => ({ status: 0 }),
    readText: (path) =>
      path.endsWith("package.json")
        ? JSON.stringify({ devDependencies: { vitest: "^2.1.9" } })
        : null,
    writeText: () => undefined,
    ...over,
  };
}

function mustProfile(id: string) {
  const profile = getVerificationProfile(id);
  if (!profile) throw new Error(`missing test profile: ${id}`);
  return profile;
}

describe("verification profile recommendation", () => {
  it("loads profile definitions from the externalized catalog module", () => {
    expect(Object.keys(PROFILES)).toEqual(
      expect.arrayContaining(["bun-unit", "doctor", "mcp-inspector-smoke"]),
    );
  });

  it("recommends DB and browser profiles from changed files", () => {
    const result = recommendVerificationProfiles([
      "docs/design/harness/L5-detailed-design/physical-data.md",
      "src/web/app.tsx",
    ]);

    expect(result.recommendations.map((r) => r.profile.id)).toEqual([
      "bun-unit",
      "doctor",
      "playwright-mcp",
      "testcontainers",
      "vitest-browser-playwright",
    ]);
    expect(result.missingProfiles).toEqual([
      "playwright-mcp",
      "testcontainers",
      "vitest-browser-playwright",
    ]);
  });

  it("maps MCP profile changes to Inspector smoke and GitHub workflow changes to readonly context", () => {
    const result = recommendVerificationProfiles([".vscode/mcp.json", ".github/workflows/ci.yml"]);

    expect(result.recommendations.map((r) => r.profile.id)).toContain("mcp-inspector-smoke");
    expect(result.recommendations.map((r) => r.profile.id)).toContain("github-mcp-readonly");
    expect(result.recommendations.map((r) => r.profile.id)).toContain("doctor");
  });

  it("emits a Mermaid impact graph suitable for docs or audit evidence", () => {
    const result = recommendVerificationProfiles(["src/web/app.tsx"]);
    const graph = verificationRecommendationMermaid(result);

    expect(graph).toContain("flowchart LR");
    expect(graph).toContain("src/web/app.tsx");
    expect(graph).toContain("vitest-browser-playwright");
  });

  it("surfaces recommendation counts for doctor", () => {
    const result = recommendVerificationProfiles(["src/cli.ts"]);

    expect(verificationRecommendationMessages(result)[0]).toContain("profiles recommended");
  });

  it("hard-gates default runnable profiles while routing external profiles to approval/refusal", () => {
    const gate = analyzeVerificationProfileGate(recommendVerificationProfiles(["src/web/app.tsx"]));

    expect(gate.ok).toBe(true);
    expect(gate.defaultRunnableProfiles).toEqual(["bun-unit", "doctor"]);
    expect(gate.externalProfiles).toEqual(["playwright-mcp", "vitest-browser-playwright"]);
    expect(gate.activationPlan.steps.map((step) => step.action)).toContain("human-approval");
    expect(gate.activationPlan.steps.map((step) => step.action)).toContain("refuse-run");
    expect(verificationProfileGateMessages(gate)[0]).toContain("default_runnable=2");
  });

  it("lists MCP and external test foundation profiles as disabled by default", () => {
    const external = listVerificationProfiles().filter(
      (profile) => profile.sourceType !== "builtin",
    );

    // every() は空配列で vacuous pass するため、catalog が空になる退行を件数で先に弾く (A-128 F-6)。
    expect(external.length).toBeGreaterThanOrEqual(6);
    expect(external.map((profile) => profile.id)).toContain("playwright-mcp");
    expect(external.every((profile) => profile.defaultEnabled === false)).toBe(true);
  });

  it("probes package and Docker prerequisites without installing anything", () => {
    const result = probeVerificationProfile(
      "testcontainers",
      deps({ commandOk: (command) => command !== "docker" }),
    );

    expect(result?.ready).toBe(false);
    expect(result?.checks.map((check) => check.name)).toContain("package");
    expect(result?.checks.map((check) => check.name)).toContain("executable");
    expect(
      result?.checks.some((check) => check.message.includes("bun add -D testcontainers")),
    ).toBe(true);
  });

  it("refuses disabled external profile execution unless explicitly allowed", () => {
    const result: SidecarVerificationProfileRunResult | null = runVerificationProfile(
      "vitest-browser-playwright",
      {},
      deps({
        readText: (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({ devDependencies: { "@vitest/browser-playwright": "^4.0.0" } })
            : null,
      }),
    );

    expect(result?.status).toBe("refused");
    // status だけでなく拒否理由 (allow-list review 未通過) を oracle にする (A-128 F-6)。
    expect(result?.messages.join(" ")).toContain("--allow-external");
    expect(result?.exitCode).toBeNull();
  });

  it("returns null for unknown profile ids across probe/run/inspect entry points", () => {
    expect(getVerificationProfile("not-a-profile")).toBeNull();
    expect(probeVerificationProfile("not-a-profile", deps())).toBeNull();
    expect(runVerificationProfile("not-a-profile", {}, deps())).toBeNull();
    expect(inspectMcpProfile("not-a-profile", {}, deps())).toBeNull();
    // prototype 汚染系のキーも実在キー扱いしない (Object.hasOwn 境界、A-128 F-4)。
    expect(getVerificationProfile("toString")).toBeNull();
    expect(getVerificationProfile("__proto__")).toBeNull();
    expect(getVerificationProfile("constructor")).toBeNull();
  });

  it("fails (not throws) when package.json is unreadable for a package-backed profile", () => {
    const result = runVerificationProfile(
      "vitest-browser-playwright",
      { allowExternal: true },
      deps({ readText: () => null }),
    );

    expect(result?.status).toBe("failed");
    expect(result?.exitCode).toBeNull();
    expect(result?.messages.join(" ")).toContain("@vitest/browser-playwright");
  });

  it("propagates non-zero runner exit codes as failed", () => {
    const result = runVerificationProfile(
      "bun-unit",
      {},
      deps({ runCommand: () => ({ status: 7 }) }),
    );

    expect(result?.status).toBe("failed");
    expect(result?.exitCode).toBe(7);
  });

  it("supports dry-run for builtin profile runners", () => {
    const result = runVerificationProfile("bun-unit", { dryRun: true }, deps());

    expect(result?.status).toBe("dry-run");
    expect(result?.command).toBe("bun run test");
  });

  it("saves normalized evidence records for later DB collection", () => {
    const writes: Array<{ path: string; content: string }> = [];
    const written = saveVerificationEvidence(
      { kind: "verify-run", id: "bun-unit", payload: { status: "dry-run" } },
      deps({ writeText: (path, content) => writes.push({ path, content }) }),
    );

    expect(written.path).toBe(
      ".ut-tdd/evidence/verification-profiles/20260609123456-verify-run-bun-unit.json",
    );
    expect(writes).toHaveLength(1);
    // 文字列リテラル重複でなく src 側定数を oracle にする (単一正本化、A-128 F-6)。
    expect(JSON.parse(writes[0].content).schema_version).toBe(VERIFICATION_EVIDENCE_SCHEMA_VERSION);
  });

  it("refuses MCP Inspector smoke by default and reports readiness checks", () => {
    const result = inspectMcpProfile("playwright-mcp", {}, deps());

    expect(result?.status).toBe("refused");
    expect(result?.method).toBe("tools/list");
    expect(result?.checks.some((check) => check.name.startsWith("inspector:"))).toBe(true);
    // 拒否理由 (デフォルト無効 + allow-list review 必要) を oracle にする (A-128 F-6)。
    expect(result?.messages.join(" ")).toContain("disabled by default");
    expect(result?.messages.join(" ")).toContain("--allow-external");
  });

  it("U-MCPPROFILE-014: marks profiles not ready when the generated launcher command is unavailable", () => {
    const result = probeVerificationProfile(
      "mcp-inspector-smoke",
      deps({ commandOk: (command) => command !== "ut-tdd" }),
    );

    expect(result?.ready).toBe(false);
    expect(result?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "executable", ok: true, message: "bun --version" }),
        expect.objectContaining({ name: "launcher", ok: false, message: "ut-tdd --help" }),
      ]),
    );
  });
});

describe("MCP profile config and safety (U-MCPPROFILE-001..014)", () => {
  it("U-MCPPROFILE-001: catalog contains complete researched candidates with source URLs and trigger signals", () => {
    const catalog = catalogVerificationProfiles();
    const ids = catalog.profiles.map((profile) => profile.id);

    expect(ids).toEqual([
      "bun-unit",
      "docker-mcp-toolkit",
      "doctor",
      "github-mcp-readonly",
      "mcp-inspector-smoke",
      "msw",
      "playwright-mcp",
      "testcontainers",
      "vitest-browser-playwright",
    ]);
    for (const id of [
      "mcp-inspector-smoke",
      "playwright-mcp",
      "github-mcp-readonly",
      "docker-mcp-toolkit",
      "vitest-browser-playwright",
      "testcontainers",
      "msw",
    ]) {
      const profile = catalog.profiles.find((candidate) => candidate.id === id);
      expect(profile?.sourceUrl).toMatch(/^https:\/\//);
      expect(profile?.triggerSignals?.length).toBeGreaterThan(0);
    }
  });

  it("U-MCPPROFILE-002: external and MCP profiles are disabled by default while built-ins stay enabled", () => {
    const catalog = catalogVerificationProfiles();
    const external = catalog.profiles.filter((profile) => profile.sourceType !== "builtin");
    const builtins = catalog.profiles.filter((profile) => profile.sourceType === "builtin");

    expect(external.every((profile) => profile.defaultEnabled === false)).toBe(true);
    expect(builtins.map((profile) => [profile.id, profile.defaultEnabled])).toEqual([
      ["bun-unit", true],
      ["doctor", true],
    ]);
  });

  it("U-MCPPROFILE-003: Docker MCP Toolkit is optional, isolated, Docker-backed, and has no runner", () => {
    const profile = catalogVerificationProfiles().profiles.find(
      (candidate) => candidate.id === "docker-mcp-toolkit",
    );

    expect(profile).toMatchObject({
      optional: true,
      requiresDocker: true,
      profileIsolation: "docker-desktop-mcp-toolkit",
      defaultEnabled: false,
    });
    expect(
      runVerificationProfile("docker-mcp-toolkit", { allowExternal: true }, deps())?.status,
    ).toBe("failed");
  });

  it("U-MCPPROFILE-004: generated MCP config is a local suggestion and never writes .vscode/mcp.json", () => {
    const result = renderGeneratedMcpConfig({
      repoRoot: "/repo",
      selectedProfileIds: ["playwright-mcp"],
      env: { PLAYWRIGHT_MCP_TOKEN: "env:PLAYWRIGHT_MCP_TOKEN" },
    });

    expect(result.ok).toBe(true);
    expect(result.targetPath).toBe(".ut-tdd/local/mcp.generated.json");
    expect(result.targetPath).not.toBe(".vscode/mcp.json");
    expect(result.content).toContain("playwright-mcp");
    expect(result.writesCommittedConfig).toBe(false);
  });

  it("U-MCPPROFILE-005: home-directory or global mounts become global-mount findings", () => {
    const result = renderGeneratedMcpConfig({
      repoRoot: "/repo",
      selectedProfileIds: ["playwright-mcp"],
      mounts: ["/repo", "/Users/example"],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "global-mount", severity: "error" }),
    ]);
  });

  it("U-MCPPROFILE-006: inline token-like values are rejected while env var references are allowed", () => {
    const rejected = renderGeneratedMcpConfig({
      repoRoot: "/repo",
      selectedProfileIds: ["github-mcp-readonly"],
      env: { GITHUB_TOKEN: "ghp_inline_secret" },
    });
    const allowed = renderGeneratedMcpConfig({
      repoRoot: "/repo",
      selectedProfileIds: ["github-mcp-readonly"],
      env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.content).not.toContain("ghp_inline_secret");
    expect(rejected.findings.map((finding) => finding.code)).toContain("credential-inline");
    expect(allowed.ok).toBe(true);
    expect(allowed.content).toContain("$" + "{GITHUB_TOKEN}");
  });

  it("U-MCPPROFILE-013: generated server command/args is a tokenized argv, not a single display string", () => {
    const result = renderGeneratedMcpConfig({
      repoRoot: "/repo",
      selectedProfileIds: ["bun-unit", "mcp-inspector-smoke"],
    });
    const config = JSON.parse(result.content) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    // command is the head token; args carry the remaining argv (no re-inclusion
    // of the executable, no whole-command-string-as-one-arg).
    expect(config.mcpServers["bun-unit"].command).toBe("bun");
    expect(config.mcpServers["bun-unit"].args).toEqual(["run", "test"]);

    // Wrapper command whose first token ("ut-tdd") differs from the probe-hint
    // executable ("bun"): the launch command is the command head, not the hint.
    expect(config.mcpServers["mcp-inspector-smoke"].command).toBe("ut-tdd");
    expect(config.mcpServers["mcp-inspector-smoke"].args[0]).toBe("mcp");

    // Regression for the pre-fix bug: args must never be the whole command line.
    for (const server of Object.values(config.mcpServers)) {
      expect(server.args).not.toContain("bun run test");
      expect(server.args[0]).not.toBe(server.command);
    }
  });

  it("U-MCPPROFILE-007: catalog presence alone cannot mark a profile trusted", () => {
    const result = analyzeVerificationProfileSafety({
      profile: {
        ...mustProfile("playwright-mcp"),
        sourceUrl: "https://example.com/not-official",
      },
      declaredPackages: ["@playwright/mcp"],
    });

    expect(result.trusted).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("untrusted-source");
  });

  it("U-MCPPROFILE-008: GitHub MCP write tools or broad toolsets require human approval", () => {
    const result = analyzeVerificationProfileSafety({
      profile: mustProfile("github-mcp-readonly"),
      allowedTools: ["issues:write", "pull_requests:write"],
      requiresHumanApproval: false,
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("github-write-tool");
  });

  it("U-MCPPROFILE-009: missing package declaration is readiness finding, not implicit install", () => {
    const result = analyzeVerificationProfileSafety({
      profile: mustProfile("playwright-mcp"),
      declaredPackages: [],
    });

    expect(result.ready).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "package-missing", severity: "warn" }),
    ]);
    expect(result.actions).not.toContain("install-package");
  });

  it("U-MCPPROFILE-010: Docker MCP Toolkit without Docker controls is not ready", () => {
    const result = analyzeVerificationProfileSafety({
      profile: mustProfile("docker-mcp-toolkit"),
      declaredPackages: ["docker-mcp-toolkit"],
      dockerAvailable: false,
      dockerControlsDocumented: false,
    });

    expect(result.ready).toBe(false);
    expect(result.findings.map((finding) => finding.code).sort()).toEqual([
      "docker-controls-missing",
      "docker-unavailable",
    ]);
  });

  it("U-MCPPROFILE-011: activation plan routes trigger signals to probe, smoke, and approval steps", () => {
    const plan = planExternalProfileActivation({
      triggerSignals: ["ui_flow", "external_issue", "db_integration"],
      recommendations: recommendVerificationProfiles([
        "src/web/app.tsx",
        ".github/workflows/ci.yml",
        "docs/design/harness/L5-detailed-design/physical-data.md",
      ]).recommendations,
      allowExternal: true,
    });

    expect(plan.steps.map((step) => step.action)).toEqual([
      "probe-profile",
      "mcp-inspector-smoke",
      "human-approval",
      "probe-profile",
      "mcp-inspector-smoke",
      "human-approval",
      "probe-profile",
      "human-approval",
      "probe-profile",
      "human-approval",
    ]);
    expect(plan.steps.map((step) => step.profileId)).toContain("github-mcp-readonly");
  });

  it("U-MCPPROFILE-012: recommendation does not install, enable, or run external tools implicitly", () => {
    const plan = planExternalProfileActivation({
      triggerSignals: ["mcp_profile_changed"],
      recommendations: recommendVerificationProfiles([".vscode/mcp.json"]).recommendations,
      allowExternal: false,
    });

    expect(plan.ok).toBe(false);
    expect(plan.actionsTaken).toEqual([]);
    expect(plan.steps.map((step) => step.action)).toContain("refuse-run");
    expect(plan.findings).toEqual([
      expect.objectContaining({ code: "external-approval-required" }),
    ]);
  });
});
