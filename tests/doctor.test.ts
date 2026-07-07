import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildFullDoctorCheckDefinitions,
  collectDoctorCheckRun,
  consumerSafeDoctorRunProfiles,
  DOCTOR_RUN_PROFILE_IDS,
  DOCTOR_RUN_PROFILES,
  doctorOutputIdsForScope,
  doctorRunProfilesForAudience,
  FULL_DOCTOR_OUTPUT_IDS,
  isConsumerSafeDoctorRunProfile,
  resolveDoctorRunProfile,
  selectDoctorCheckDefinitions,
} from "../src/doctor/check-registry";
import {
  checkDependencyDrift as checkDependencyDriftAdapter,
  checkRegressionExpansion as checkRegressionExpansionAdapter,
} from "../src/doctor/dependency-regression";
import {
  checkAgentSlots,
  checkAssetDrift,
  checkBackfillResult,
  checkBranchKind,
  checkChangeImpact,
  checkChangeSetIntegrity,
  checkCodexWrapperParity,
  checkCodingRules,
  checkCycleP4Verification,
  checkDbCurrency,
  checkDbProjectionCoverage,
  checkDbProjectionIngestion,
  checkDddTddRules,
  checkDependencyDrift,
  checkDescentObligation,
  checkDriveDbRegistration,
  checkDriveModelPassage,
  checkForwardConvergence,
  checkForwardConvergenceAudit,
  checkFrRoadmapCoverage,
  checkGateConfirm,
  checkGuardrailInvariants,
  checkHandover,
  checkHandoverDisciplineMessages,
  checkImplPlanTrace,
  checkL6Completion,
  checkL6FrCoverage,
  checkL7Completion,
  checkMergedPlanStatus,
  checkModuleDrift,
  checkOracleTestTrace,
  checkPairFreeze,
  checkPlaceholderDeps,
  checkPlanDod,
  checkPlanGovernance,
  checkPlanReferenceFreshnessAdvisory,
  checkPlanSchedule,
  checkPlanTraceGate,
  checkProjectHooks,
  checkPropagation,
  checkReadability,
  checkRegressionExpansion,
  checkReviewEvidence,
  checkRoadmap,
  checkRuleAutomationClosure,
  checkRuleDrift,
  checkRuntimePortability,
  checkRuntimeReadability,
  checkScrumReverse,
  checkSkillAssignment,
  checkTelemetryClosure,
  checkTrackedCanonical,
  checkVerificationGroupsResult,
  checkVerificationProfile,
  type DoctorDeps,
  nodeDoctorDeps,
  runDoctor,
} from "../src/doctor/index";
import { buildDoctorResult } from "../src/doctor/result";
import type { AgentSlotsDeps, Slot } from "../src/runtime/agent-slots";

const NOW = "2026-06-04T00:00:00.000Z";
const pointerPath = join("/repo", ".ut-tdd", "handover", "CURRENT.json");
const slotStatePath = join("/repo", ".ut-tdd", "state", "agent-slots.json");
const currentPlanPath = join("/repo", ".ut-tdd", "state", "current-plan");
const digestDir = join("/repo", ".ut-tdd", "logs", "plan");

describe("buildDoctorResult", () => {
  it("preserves leading messages, prefixes check messages, and fails closed on any failed check", () => {
    const result = buildDoctorResult({
      leadingMessages: ["doctor: mode=standalone"],
      checks: [
        { ok: true, messages: ["alpha - OK"] },
        { ok: false, messages: ["beta - violation"] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      "doctor: mode=standalone",
      "doctor: alpha - OK",
      "doctor: beta - violation",
    ]);
  });

  it("preserves optional timing diagnostics without changing ok/messages", () => {
    const result = buildDoctorResult({
      leadingMessages: ["doctor: mode=standalone"],
      checks: [{ ok: true, messages: ["alpha - OK"] }],
      timings: [{ id: "alpha", duration_ms: 1.25, ok: true, message_count: 1 }],
    });

    expect(result).toMatchObject({
      ok: true,
      messages: ["doctor: mode=standalone", "doctor: alpha - OK"],
      timings: [{ id: "alpha", duration_ms: 1.25, ok: true, message_count: 1 }],
    });
  });
});

function codexWrapperParityFiles(root: string, overrides: Record<string, string> = {}) {
  const file = (relativePath: string) => join(root, ...relativePath.split("/"));
  return new Map<string, string>(
    Object.entries({
      ".claude/settings.json": [
        "{",
        '  "hooks": {',
        '    "SessionStart": [{ "hooks": [{ "command": "bun \\"$CLAUDE_PROJECT_DIR/src/cli.ts\\" session start" }] }],',
        '    "PostToolUse": [{ "hooks": [{ "command": "bun \\"$CLAUDE_PROJECT_DIR/src/cli.ts\\" hook post-tool-use" }] }],',
        '    "Stop": [{ "hooks": [{ "command": "bun \\"$CLAUDE_PROJECT_DIR/src/cli.ts\\" session summary" }] }]',
        "  }",
        "}",
      ].join("\n"),
      "src/runtime/adapter.ts": [
        'const args = isCodex ? ["exec", "-"] : ["--print", "--input-format", "text"];',
        "return { stdin: intent.task, plan_id: intent.planId };",
      ].join("\n"),
      "src/runtime/adapter-policy.ts": 'export const CODEX_STDIN_ARGS = ["exec", "-"] as const;',
      "tests/runtime-hook-entrypoints.test.ts": [
        "ut-tdd codex --execute records the same session lifecycle through the adapter wrapper",
        "ut-tdd codex --task-file feeds file content through the same adapter wrapper",
        "ut-tdd codex --plan records wrapper lifecycle without forwarding plan flags to Codex",
      ].join("\n"),
      "tests/runtime-adapter.test.ts": "U-ADAPTER-007\nU-ADAPTER-008",
      "docs/test-design/harness/L7-unit-test-design.md": "U-ADAPTER-009",
      ...overrides,
    }).map(([relativePath, text]) => [file(relativePath), text]),
  );
}

function deps(over: Partial<DoctorDeps> & { files?: Map<string, string> } = {}): DoctorDeps {
  const files = over.files ?? new Map<string, string>();
  return {
    repoRoot: "/repo",
    now: NOW,
    readText: (p) => files.get(p) ?? null,
    listDir: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`) || k.startsWith(`${dir}\\`))
        .map((k) => k.slice(dir.length + 1)),
    ...over,
  };
}

describe("checkHandover (doctor handover staleness surface)", () => {
  it("missing CURRENT.json prompts generation without failing", () => {
    expect(checkHandover(deps())).toContain("CURRENT.json");
  });

  it("fresh pointer returns OK and includes active plan", () => {
    const files = new Map([
      [
        pointerPath,
        JSON.stringify({
          active_plan: "PLAN-X",
          status: "in_progress",
          latest_doc: null,
          digest_summary: null,
          updated_at: "2026-06-03T18:00:00.000Z",
        }),
      ],
    ]);
    const msg = checkHandover(deps({ files }));
    expect(msg).toContain("OK");
    expect(msg).toContain("PLAN-X");
  });

  it("older than 24h returns stale warning", () => {
    const files = new Map([
      [pointerPath, JSON.stringify({ updated_at: "2026-06-01T00:00:00.000Z" })],
    ]);
    expect(checkHandover(deps({ files }))).toContain("stale");
  });

  it("broken JSON prompts regeneration without throwing", () => {
    const files = new Map([[pointerPath, "{not json"]]);
    expect(() => checkHandover(deps({ files }))).not.toThrow();
    expect(checkHandover(deps({ files }))).toContain("CURRENT.json");
  });
});

describe("checkHandoverDisciplineMessages", () => {
  it("fresh CURRENT still surfaces drift when active_plan differs from current plan", () => {
    const files = new Map([
      [currentPlanPath, "PLAN-L5-08-harness-db-feedback\n2026-06-03T23:50:00.000Z"],
      [
        join(digestDir, "PLAN-L5-08-harness-db-feedback.digest.json"),
        JSON.stringify({
          plan_id: "PLAN-L5-08-harness-db-feedback",
          sessions: ["s1"],
          commits: [],
          files_touched: ["docs/plans/PLAN-L5-08-harness-db-feedback.md"],
          failures: [],
          updated_at: "2026-06-03T23:55:00.000Z",
        }),
      ],
      [
        pointerPath,
        JSON.stringify({
          active_plan: "PLAN-L5-00-master",
          status: "completed",
          latest_doc: null,
          digest_summary: { commits: 0, files: 0, failures: 0 },
          updated_at: "2026-06-03T23:59:00.000Z",
          generated_by: "ut-tdd-handover",
          doc_entry_count: 0,
        }),
      ],
    ]);
    const messages = checkHandoverDisciplineMessages(deps({ files }));
    expect(messages.some((m) => m.includes("drift"))).toBe(true);
  });

  it("runDoctor surfaces handover discipline as warning-only", () => {
    const files = new Map([
      [currentPlanPath, "PLAN-L5-08-harness-db-feedback\n2026-06-03T23:50:00.000Z"],
      [
        join(digestDir, "PLAN-L5-08-harness-db-feedback.digest.json"),
        JSON.stringify({
          plan_id: "PLAN-L5-08-harness-db-feedback",
          sessions: ["s1"],
          commits: [],
          files_touched: ["docs/plans/PLAN-L5-08-harness-db-feedback.md"],
          failures: [],
          updated_at: "2026-06-03T23:55:00.000Z",
        }),
      ],
    ]);
    const r = runDoctor(deps({ files }));
    expect(r.ok).toBe(false);
    expect(r.messages.some((m) => m.includes("handover-discipline"))).toBe(true);
    expect(r.messages.some((m) => m.includes("verification group lint could not run"))).toBe(true);
  });
});

describe("checkAgentSlots (doctor agent-slots surface, IMP-050)", () => {
  function slotDeps(slots: Slot[] | null, now = "2026-06-04T00:10:00.000Z"): AgentSlotsDeps {
    const files = new Map<string, string>();
    if (slots !== null) files.set(slotStatePath, JSON.stringify(slots));
    return {
      repoRoot: "/repo",
      now: () => now,
      readText: (p) => files.get(p) ?? null,
      writeText: () => {
        throw new Error("doctor slotDeps writeText must stay read-only");
      },
      newId: () => "x",
    };
  }
  function slot(over: Partial<Slot>): Slot {
    return {
      slot_id: "s",
      agent_kind: "pmo-sonnet",
      role: null,
      slot_source: "agent_guard",
      fired_at: "2026-06-04T00:00:00.000Z",
      released_at: null,
      status: "running",
      exit_code: null,
      ...over,
    };
  }

  it("returns a no-record message when slot state is missing", () => {
    expect(checkAgentSlots(slotDeps(null))).toContain("agent-slots");
  });

  it("reports stale slots older than the release threshold", () => {
    const msg = checkAgentSlots(slotDeps([slot({ slot_id: "old" })])); // fired 00:00, now 00:10
    expect(msg).toContain("stale");
    expect(msg).toContain("old");
  });

  it("reports OK and peak for released slots without writing state", () => {
    const msg = checkAgentSlots(
      slotDeps([slot({ status: "completed", released_at: "2026-06-04T00:02:00.000Z" })]),
    );
    expect(msg).toContain("OK");
    expect(msg).toContain("peak_parallel");
  });
});

describe("runDoctor", () => {
  let realRepoDoctor: ReturnType<typeof runDoctor>;

  beforeAll(() => {
    realRepoDoctor = runDoctor();
  }, 240_000);

  it("ok=true includes handover and agent-slots surfaces as warnings", () => {
    const r = runDoctor(deps());
    expect(r.ok).toBe(false);
    expect(r.messages.some((m) => m.includes("handover"))).toBe(true);
    expect(r.messages.some((m) => m.includes("agent-slots"))).toBe(true);
    expect(r.messages.some((m) => m.includes("verification group lint could not run"))).toBe(true);
    // Keep warning-only surfaces from masking hard-fail lint coverage.
    expect(r.messages.some((m) => m.includes("scrum-reverse"))).toBe(true);
    expect(r.messages.some((m) => m.includes("propagation"))).toBe(true);
    expect(r.messages.some((m) => m.includes("coding-rules"))).toBe(true);
  });

  it("U-SETUP-014: supports a fresh-consumer setup smoke without requiring dogfood PLAN/design docs", () => {
    const hookJson = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs hook agent-guard" }] },
          { hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs hook work-guard" }] },
        ],
        SessionStart: [{ hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs session start" }] }],
        PostToolUse: [{ hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs hook post-tool-use" }] }],
        Stop: [
          { hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs session summary" }] },
          { hooks: [{ command: "bun .ut-tdd/bin/ut-tdd.mjs hook subagent-stop" }] },
        ],
      },
    });
    const file = (path: string) => join("/repo", ...path.split("/"));
    const files = new Map<string, string>([
      [file(".ut-tdd/bin/ut-tdd.mjs"), "const localBin = '.ut-tdd/bin/ut-tdd.mjs';"],
      [file("AGENTS.md"), "UT-TDD adapter"],
      [file("CLAUDE.md"), "UT-TDD adapter"],
      [file(".claude/CLAUDE.md"), "UT-TDD adapter"],
      [file(".claude/settings.json"), hookJson],
      [file(".codex/config.toml"), "hooks = true"],
      [file(".codex/hooks.json"), hookJson],
    ]);

    const r = runDoctor(deps({ files }), { setupSmoke: true });

    expect(DOCTOR_RUN_PROFILE_IDS).toEqual([
      "source-full",
      "source-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(new Set(DOCTOR_RUN_PROFILE_IDS).size).toBe(DOCTOR_RUN_PROFILE_IDS.length);
    expect(Object.keys(DOCTOR_RUN_PROFILES).sort()).toEqual([...DOCTOR_RUN_PROFILE_IDS].sort());
    expect(doctorRunProfilesForAudience("consumer")).toEqual([
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    ]);
    expect(doctorRunProfilesForAudience("consumer").every(isConsumerSafeDoctorRunProfile)).toBe(
      true,
    );
    expect(consumerSafeDoctorRunProfiles().map((profile) => profile.id)).toEqual([
      "source-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(consumerSafeDoctorRunProfiles().every(isConsumerSafeDoctorRunProfile)).toBe(true);
    expect(consumerSafeDoctorRunProfiles().some((profile) => profile.sourceOnly)).toBe(false);
    expect(consumerSafeDoctorRunProfiles()).not.toContainEqual(
      expect.objectContaining({ sourceOnly: true }),
    );
    expect(
      consumerSafeDoctorRunProfiles().filter((profile) => profile.audience === "consumer"),
    ).toEqual([DOCTOR_RUN_PROFILES["consumer-setup-smoke"]]);
    expect(resolveDoctorRunProfile({ setupSmoke: true })).toEqual(
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    );
    expect(resolveDoctorRunProfile({ setupSmoke: true })).toMatchObject({
      id: "consumer-setup-smoke",
      audience: "consumer",
      invocation: "setup-smoke",
      setupSmoke: true,
      outputIds: [],
      sourceOnly: false,
    });
    expect(resolveDoctorRunProfile({ setupSmoke: true, scope: "toolchain" })).toMatchObject({
      id: "consumer-setup-smoke",
      invocation: "setup-smoke",
      setupSmoke: true,
      sourceOnly: false,
    });
    expect(resolveDoctorRunProfile({ profile: "consumer-setup-smoke" })).toEqual(
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    );
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual(["doctor: setup-smoke - OK (checked=22, failed=0)"]);
  });

  it("runs only the toolchain gate when doctor scope is toolchain", () => {
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(process.cwd()));
    const selected = selectDoctorCheckDefinitions(definitions, "toolchain");
    const run = collectDoctorCheckRun(nodeDoctorDeps(process.cwd()), {
      scope: "toolchain",
      timing: true,
    });

    expect(resolveDoctorRunProfile()).toEqual(DOCTOR_RUN_PROFILES["source-full"]);
    expect(doctorRunProfilesForAudience("source").map((profile) => profile.id)).toEqual([
      "source-full",
      "source-toolchain",
    ]);
    expect(doctorRunProfilesForAudience("source").filter((profile) => profile.sourceOnly)).toEqual([
      DOCTOR_RUN_PROFILES["source-full"],
    ]);
    expect(isConsumerSafeDoctorRunProfile(DOCTOR_RUN_PROFILES["source-full"])).toBe(false);
    expect(isConsumerSafeDoctorRunProfile(DOCTOR_RUN_PROFILES["source-toolchain"])).toBe(true);
    expect(resolveDoctorRunProfile()).toMatchObject({
      id: "source-full",
      audience: "source",
      invocation: "registry",
      scope: "full",
      setupSmoke: false,
      outputIds: FULL_DOCTOR_OUTPUT_IDS,
      sourceOnly: true,
    });
    expect(resolveDoctorRunProfile({ scope: "toolchain" })).toEqual(
      DOCTOR_RUN_PROFILES["source-toolchain"],
    );
    expect(resolveDoctorRunProfile({ scope: "toolchain" })).toMatchObject({
      id: "source-toolchain",
      audience: "source",
      invocation: "registry",
      scope: "toolchain",
      setupSmoke: false,
      outputIds: ["toolchain-pin"],
      sourceOnly: false,
    });
    expect(resolveDoctorRunProfile({ profile: "source-full", setupSmoke: true })).toEqual(
      DOCTOR_RUN_PROFILES["source-full"],
    );
    expect(resolveDoctorRunProfile({ profile: "source-toolchain" })).toEqual(
      DOCTOR_RUN_PROFILES["source-toolchain"],
    );
    expect(DOCTOR_RUN_PROFILES["source-full"].outputIds).toEqual(doctorOutputIdsForScope("full"));
    expect(DOCTOR_RUN_PROFILES["source-toolchain"].outputIds).toEqual(
      doctorOutputIdsForScope("toolchain"),
    );
    expect(doctorOutputIdsForScope("toolchain")).toEqual(["toolchain-pin"]);
    expect(selected.map((definition) => definition.id)).toEqual(["toolchain-pin"]);
    expect(run.checks).toHaveLength(1);
    expect(run.checks[0]?.messages[0]).toContain("toolchain-pin");
    expect(run.timings).toEqual([
      expect.objectContaining({ id: "toolchain-pin", ok: run.checks[0]?.ok, message_count: 1 }),
    ]);
  });

  it("includes asset-drift hard gate in doctor output", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: asset-drift") && m.includes("OK"))).toBe(
      true,
    );
  });

  it("includes skill-assignment hard gate in doctor output", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: skill-assignment - OK"))).toBe(true);
  });

  // PLAN-L7-95: the 4 previously-inert lint audits + the lint-wiring meta-gate must be
  // invoked by runDoctor (invocation fence — guards against re-introducing the absence-blindness
  // where a lint module is reachable/tested but its audit never runs in a runtime path).
  it("invokes the 4 newly-wired lint audits + lint-wiring meta-gate in doctor output", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    for (const gate of [
      "doctor: doc-consistency — OK",
      "doctor: entity-coverage — OK",
      "doctor: fr-registry-audit — OK",
      "doctor: improvement-backlog — OK",
      "doctor: lint-wiring — OK",
    ]) {
      expect(r.messages.some((m) => m.includes(gate))).toBe(true);
    }
  });

  it("includes branch-kind-check in doctor output", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: branch-kind-check - OK"))).toBe(true);
  });

  it("includes GitHub CI policy hard gate in doctor output", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: github-ci-policy - OK"))).toBe(true);
  });

  it("includes G1/G3 trace gates in doctor output", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: g1-trace - OK"))).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: g3-trace - OK"))).toBe(true);
  });

  it("hard-gates PLAN governance once repo frontmatter debt is closed", () => {
    const governance = checkPlanGovernance(process.cwd());
    const r = realRepoDoctor;

    expect(governance.ok).toBe(true);
    expect(governance.messages[0]).toContain("plan-governance - OK");
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: plan-schedule") && m.includes("OK"))).toBe(
      true,
    );
    expect(r.messages.some((m) => m.includes("doctor: plan-governance - OK"))).toBe(true);
  });

  it("keeps doctor plan gate re-exports stable after extraction", () => {
    expect(checkPlanSchedule).toBeTypeOf("function");
    expect(checkPlanGovernance).toBeTypeOf("function");
    expect(checkPlanReferenceFreshnessAdvisory).toBeTypeOf("function");
    expect(checkForwardConvergence).toBeTypeOf("function");
    expect(checkForwardConvergenceAudit).toBeTypeOf("function");
  });

  it("keeps doctor lint gate re-exports stable after extraction", () => {
    expect(checkModuleDrift).toBeTypeOf("function");
    expect(checkAssetDrift).toBeTypeOf("function");
    expect(checkSkillAssignment).toBeTypeOf("function");
    expect(checkDescentObligation).toBeTypeOf("function");
    expect(checkChangeImpact).toBeTypeOf("function");
    expect(checkChangeSetIntegrity).toBeTypeOf("function");
    expect(checkVerificationProfile).toBeTypeOf("function");
    expect(checkBranchKind).toBeTypeOf("function");
  });

  it("keeps doctor runtime-state re-exports stable after extraction", () => {
    expect(checkHandover).toBeTypeOf("function");
    expect(checkHandoverDisciplineMessages).toBeTypeOf("function");
    expect(checkAgentSlots).toBeTypeOf("function");
    expect(nodeDoctorDeps).toBeTypeOf("function");
  });

  it("surfaces draft code-line reference freshness as a leading advisory", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-ref-fresh-"));
    try {
      mkdirSync(join(root, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(root, "docs", "plans", "PLAN-L7-900-ref-fresh.md"),
        [
          "---",
          "plan_id: PLAN-L7-900-ref-fresh",
          'title: "PLAN-L7-900 ref fresh fixture"',
          "kind: refactor",
          "layer: L7",
          "drive: be",
          "status: draft",
          "created: 2026-06-20",
          "updated: 2026-06-20",
          "agent_slots:",
          "  - role: tl",
          '    slot_label: "TL - fixture"',
          "generates: []",
          "dependencies:",
          "  parent: null",
          "  requires: []",
          "  blocks: []",
          "  references: []",
          "---",
          "",
          "See src/missing.ts:1 before implementation.",
          "",
        ].join("\n"),
        "utf8",
      );

      const messages = checkPlanReferenceFreshnessAdvisory(root);

      expect(
        messages.some((message) => message.includes("plan-reference-freshness - advisory")),
      ).toBe(true);
      expect(messages.every((message) => message.startsWith("doctor: "))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces dependency-drift and regression expansion instead of scaffold stub", () => {
    const r = realRepoDoctor;
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: dependency-drift"))).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: regression-expansion"))).toBe(true);
    expect(r.messages.some((m) => m.includes("scaffold stub"))).toBe(false);
  });

  it("surfaces roadmap-rollup as a hard gate summary line", () => {
    const r = realRepoDoctor;
    const rollupLines = r.messages.filter((m) => m.startsWith("doctor: roadmap-rollup"));

    expect(r.ok).toBe(true);
    expect(rollupLines).toHaveLength(1);
    expect(rollupLines[0]).toContain("bands ");
    expect(rollupLines[0]).toContain("gates ");
    expect(rollupLines[0]).toContain("spans ");
    expect(rollupLines[0]).toContain("frontier:");
  });

  it("surfaces Cycle P4 closure audit as a hard gate", () => {
    const r = realRepoDoctor;

    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: cycle-p4-verification - OK"))).toBe(true);
  });

  it("fails descent-obligation when a trace chain has no required downstream landing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-descent-"));
    try {
      const docDir = join(root, "docs", "design", "harness", "L6-function-design");
      mkdirSync(docDir, { recursive: true });
      writeFileSync(
        join(docDir, "bad.md"),
        "---\nlayer: L6\nstatus: confirmed\n---\nFR-L1-99\n",
        "utf8",
      );

      const result = checkDescentObligation(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("descent-obligation - unmet");
      expect(result.messages.join("\n")).toContain("FR-L1-99");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Guardrail invariant helper for review evidence fixtures.
  function planWithReview(
    planId: string,
    reviewKind: string,
    reviewer: string,
    worker: string,
  ): string {
    return [
      "---",
      `plan_id: ${planId}`,
      "status: confirmed",
      "kind: impl",
      "review_evidence:",
      "  - reviewer: code-reviewer",
      `    review_kind: ${reviewKind}`,
      `    worker_model: ${worker}`,
      `    reviewer_model: ${reviewer}`,
      '    tests_green_at: "2026-06-15"',
      '    reviewed_at: "2026-06-15"',
      "    verdict: pass",
      "---",
      "",
      "## body",
      "",
    ].join("\n");
  }

  it("passes guardrail-invariants when cross_agent review uses distinct models", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-guardrail-ok-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-TEST-01-crossmodel.md"),
        planWithReview("PLAN-TEST-01-crossmodel", "cross_agent", "gpt-5.4", "claude-opus-4-8"),
        "utf8",
      );

      const result = checkGuardrailInvariants(root);

      expect(result.ok).toBe(true);
      expect(result.messages.join("\n")).toContain("guardrail-invariants");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails guardrail-invariants on cross_agent same-model self-review (reviewer == worker)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-guardrail-same-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-TEST-02-selfreview.md"),
        planWithReview(
          "PLAN-TEST-02-selfreview",
          "cross_agent",
          "claude-opus-4-8",
          "claude-opus-4-8",
        ),
        "utf8",
      );

      const result = checkGuardrailInvariants(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("guardrail-invariants - violation");
      expect(result.messages.join("\n")).toContain("same-model-self-review");
      expect(result.messages.join("\n")).toContain("PLAN-TEST-02-selfreview");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("permits intra_runtime_subagent same-model review in single-runtime fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-guardrail-intra-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-TEST-04-intra.md"),
        planWithReview("PLAN-TEST-04-intra", "intra_runtime_subagent", "gpt-5.4", "gpt-5.4"),
        "utf8",
      );

      const result = checkGuardrailInvariants(root);

      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not false-positive guardrail-invariants when one model is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-guardrail-partial-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      // Missing worker_model should not trigger a same-model violation.
      writeFileSync(
        join(planDir, "PLAN-TEST-03-partial.md"),
        [
          "---",
          "plan_id: PLAN-TEST-03-partial",
          "status: confirmed",
          "kind: impl",
          "review_evidence:",
          "  - reviewer: code-reviewer",
          "    review_kind: intra_runtime_subagent",
          "    reviewer_model: claude-sonnet-4-6",
          '    tests_green_at: "2026-06-15"',
          '    reviewed_at: "2026-06-15"',
          "    verdict: pass",
          "---",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = checkGuardrailInvariants(root);

      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when guardrail-invariants repo root cannot be read", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-guardrail-missing-${NOW}-nope`);
    const result = checkGuardrailInvariants(missingRoot);
    expect(result.ok).toBe(false);
  });

  it("fails confirmed L7 PLANs with unchecked DoD items", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-plan-dod-"));
    try {
      const planDir = join(root, "docs", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, "PLAN-L7-99-unchecked.md"),
        [
          "---",
          "plan_id: PLAN-L7-99-unchecked",
          "status: confirmed",
          "kind: impl",
          "---",
          "",
          "## L4 DoD",
          "",
          "- [ ] verification evidence is not closed",
          "",
          "## L5 Notes",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = checkPlanDod(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("plan-dod - violation");
      expect(result.messages.join("\n")).toContain("PLAN-L7-99-unchecked:9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails active design/test-design docs with unresolved L7 placeholder_deps", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-placeholder-deps-"));
    try {
      const docDir = join(root, "docs", "design", "harness", "L5-detailed-design");
      mkdirSync(docDir, { recursive: true });
      writeFileSync(
        join(docDir, "physical-data.md"),
        [
          "---",
          "layer: L5",
          "status: confirmed",
          "---",
          "",
          "- placeholder_deps: {waiting_layer:L7, waiting_spec: stale implementation bridge}",
          "- Current status: dedicated `placeholder_deps` doctor rule is not implemented yet.",
        ].join("\n"),
        "utf8",
      );

      const result = checkPlaceholderDeps(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("placeholder-deps - violation");
      expect(result.messages.join("\n")).toContain("physical-data.md:6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails active L4-L6 design docs with stale L7 completion blockers", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-l7-completion-"));
    try {
      const docDir = join(root, "docs", "design", "harness", "L4-basic-design");
      mkdirSync(docDir, { recursive: true });
      writeFileSync(
        join(docDir, "function.md"),
        [
          "---",
          "layer: L4",
          "status: confirmed",
          "---",
          "",
          "> Current implementation only covers C2; remaining items are L7 carry.",
          "| `ut-tdd review --uncommitted` | FR-45 | pending | doc-reviewer |",
        ].join("\n"),
        "utf8",
      );

      const result = checkL7Completion(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("l7-completion - violation");
      expect(result.messages.join("\n")).toContain("function.md:6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-009: surfaces Claude hook / Codex wrapper parity as a doctor hard gate", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-codex-parity-"));
    try {
      const result = checkCodexWrapperParity(
        deps({ repoRoot: root, files: codexWrapperParityFiles(root) }),
      );

      expect(result.ok).toBe(true);
      expect(result.messages.join("\n")).toContain("codex-wrapper-parity - OK");
      expect(result.messages.join("\n")).toContain("codex=ut-tdd-wrapper-lifecycle");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-ADAPTER-009: fails closed when Codex wrapper lifecycle evidence is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-codex-parity-missing-"));
    try {
      const result = checkCodexWrapperParity(
        deps({
          repoRoot: root,
          files: codexWrapperParityFiles(root, {
            "tests/runtime-hook-entrypoints.test.ts": "Claude settings only",
          }),
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("Codex wrapper lifecycle test missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when hard-gate checker inputs cannot be read", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-missing-${Date.now()}-nope`);
    const checks = [
      ["backfill", checkBackfillResult(missingRoot)],
      ["scrum-reverse", checkScrumReverse(missingRoot)],
      ["propagation", checkPropagation(missingRoot)],
      ["pair-freeze", checkPairFreeze(missingRoot)],
      ["module-drift", checkModuleDrift(missingRoot)],
      ["merged-plan-status", checkMergedPlanStatus(missingRoot)],
      ["review-evidence", checkReviewEvidence(missingRoot)],
      ["guardrail-invariants", checkGuardrailInvariants(missingRoot)],
      ["asset-drift", checkAssetDrift(missingRoot)],
      ["skill-assignment", checkSkillAssignment(missingRoot)],
      ["descent-obligation", checkDescentObligation(missingRoot)],
      ["change-impact", checkChangeImpact(missingRoot)],
      ["change-set-integrity", checkChangeSetIntegrity(missingRoot)],
      ["verification-profile", checkVerificationProfile(missingRoot)],
      ["branch-kind", checkBranchKind(missingRoot)],
      ["coding-rules", checkCodingRules(missingRoot)],
      ["ddd-tdd-rules", checkDddTddRules(missingRoot)],
      ["runtime-portability", checkRuntimePortability(missingRoot)],
      ["db-projection-coverage", checkDbProjectionCoverage(missingRoot)],
      ["db-projection-ingestion", checkDbProjectionIngestion(missingRoot)],
      ["rule-drift", checkRuleDrift(missingRoot)],
      ["gate-confirm", checkGateConfirm(missingRoot)],
      ["plan-dod", checkPlanDod(missingRoot)],
      ["placeholder-deps", checkPlaceholderDeps(missingRoot)],
      ["g1-trace", checkPlanTraceGate(missingRoot, "G1-trace")],
      ["g3-trace", checkPlanTraceGate(missingRoot, "G3-trace")],
      ["rule-automation-closure", checkRuleAutomationClosure(missingRoot)],
      ["drive-model-passage", checkDriveModelPassage(missingRoot)],
      ["drive-db-registration", checkDriveDbRegistration(missingRoot)],
      ["db-currency", checkDbCurrency(missingRoot)],
      ["fr-roadmap-coverage", checkFrRoadmapCoverage(missingRoot)],
      ["telemetry-closure", checkTelemetryClosure(missingRoot)],
      ["cycle-p4-verification", checkCycleP4Verification(missingRoot)],
      ["l6-fr-coverage", checkL6FrCoverage(missingRoot)],
      ["readability", checkReadability(missingRoot)],
      ["runtime-readability", checkRuntimeReadability(missingRoot)],
      ["project-hook", checkProjectHooks(missingRoot)],
      ["codex-wrapper-parity", checkCodexWrapperParity(deps({ repoRoot: missingRoot }))],
      ["l6-completion", checkL6Completion(missingRoot)],
      ["l7-completion", checkL7Completion(missingRoot)],
      ["verification-groups", checkVerificationGroupsResult(missingRoot)],
      ["roadmap", checkRoadmap(missingRoot)],
      ["impl-plan-trace", checkImplPlanTrace(missingRoot)],
      ["oracle-test-trace", checkOracleTestTrace(missingRoot)],
      ["tracked-canonical", checkTrackedCanonical(missingRoot)],
      ["dependency-drift", checkDependencyDrift(missingRoot)],
      ["regression-expansion", checkRegressionExpansion(missingRoot, null)],
    ] as const;

    expect(checks.filter(([, result]) => result.ok).map(([name]) => name)).toEqual([]);
    for (const [, result] of checks) {
      expect(result.messages.join("\n")).toMatch(/violation/i);
    }
  });

  it("keeps extracted dependency/regression doctor adapters fail-closed", () => {
    const missingRoot = join(tmpdir(), `ut-tdd-doctor-dependency-missing-${Date.now()}-nope`);

    expect(checkDependencyDriftAdapter(missingRoot)).toMatchObject({
      ok: false,
      result: null,
      messages: ["dependency-drift - violation: repo root could not be read"],
    });
    expect(checkRegressionExpansionAdapter(missingRoot, null)).toMatchObject({
      ok: false,
      messages: ["regression-expansion - violation: repo root could not be read"],
    });
  });

  it("skips change-impact / change-set-integrity in a non-git directory instead of failing closed", () => {
    // ZIP 展開のみ (非 git) の利用環境: git status が引けないだけで doctor を落とさない。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-nongit-"));
    try {
      const impact = checkChangeImpact(root);
      const integrity = checkChangeSetIntegrity(root);
      expect(impact.ok).toBe(true);
      expect(impact.messages.join("\n")).toMatch(/skipped \(not a git repository\)/);
      expect(integrity.ok).toBe(true);
      expect(integrity.messages.join("\n")).toMatch(/skipped \(not a git repository\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps all hard gates wired into runDoctor hard-gate aggregation", () => {
    const indexSource = readFileSync(join(process.cwd(), "src", "doctor", "index.ts"), "utf8");
    const registrySource = readFileSync(
      join(process.cwd(), "src", "doctor", "check-registry.ts"),
      "utf8",
    );
    const definitionsSource = readFileSync(
      join(process.cwd(), "src", "doctor", "check-definitions.ts"),
      "utf8",
    );
    const profileSource = readFileSync(join(process.cwd(), "src", "doctor", "profiles.ts"), "utf8");
    const runnerSource = readFileSync(join(process.cwd(), "src", "doctor", "runner.ts"), "utf8");
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(process.cwd()));
    const checkIds = definitions.map((definition) => definition.id);
    const outputIds = [...FULL_DOCTOR_OUTPUT_IDS];
    expect(indexSource).toContain("resolveDoctorRunProfile");
    expect(indexSource).toContain("const profile = resolveDoctorRunProfile(options)");
    expect(indexSource).toContain('if (profile.invocation === "setup-smoke")');
    expect(indexSource).toContain(
      "const { checks, timings } = collectDoctorCheckRun(deps, options)",
    );
    expect(registrySource).toContain('} from "./runner"');
    expect(registrySource).toContain('} from "./check-definitions"');
    expect(runnerSource).toContain("export function collectDoctorCheckRun");
    expect(runnerSource).toContain("export function collectDoctorChecks");
    expect(definitionsSource).toContain("export function buildFullDoctorCheckDefinitions");
    expect(runnerSource).toContain("buildFullDoctorCheckDefinitions(deps, options)");
    expect(definitionsSource).not.toContain("checkPlanReferenceFreshnessAdvisory");
    expect(registrySource).toContain('} from "./profiles"');
    expect(profileSource).toContain("export const DOCTOR_RUN_PROFILES");
    expect(profileSource).toContain("export const DOCTOR_RUN_PROFILE_IDS");
    expect(profileSource).toContain("export function resolveDoctorRunProfile");
    expect(profileSource).toContain("export function doctorRunProfilesForAudience");
    expect(profileSource).toContain("export function consumerSafeDoctorRunProfiles");
    expect(profileSource).toContain("export function isConsumerSafeDoctorRunProfile");
    expect(profileSource).toContain('consumerSafeDoctorRunProfile("consumer-setup-smoke")');
    expect(profileSource).toContain('consumerSafeDoctorRunProfile("source-toolchain")');
    expect(runnerSource).toContain("export function selectDoctorCheckDefinitions");
    expect(profileSource).toContain('export type DoctorScope = "full" | "toolchain"');
    const expectedHardGates = [
      "backfill",
      "scrum-reverse",
      "propagation",
      "pair-freeze",
      "module-drift",
      "merged-plan-status",
      "review-evidence",
      "guardrail-invariants",
      "asset-drift",
      "skill-assignment",
      "descent-obligation",
      "change-impact",
      "change-set-integrity",
      "verification-profile",
      "branch-kind-check",
      "coding-rules",
      "design-language",
      "ddd-tdd-rules",
      "runtime-portability",
      "db-projection-coverage",
      "db-projection-ingestion",
      "rule-drift",
      "gate-confirm",
      "plan-schedule",
      "plan-governance",
      "plan-dod",
      "placeholder-deps",
      "g1-trace",
      "g3-trace",
      "rule-automation-closure",
      "drive-model-passage",
      "drive-db-registration",
      "db-currency",
      "fr-roadmap-coverage",
      "telemetry-closure",
      "cycle-p4-verification",
      "l6-fr-coverage",
      "readability",
      "runtime-readability",
      "project-hook",
      "codex-wrapper-parity",
      "toolchain-pin",
      "l6-completion",
      "l7-completion",
      "verification-groups",
      "roadmap",
      "impl-plan-trace",
      "oracle-test-trace",
      "tracked-canonical",
      "dependency-drift",
      "regression-expansion",
      "green-command-digest",
    ];

    expect(new Set(checkIds).size).toBe(checkIds.length);
    expect(new Set(outputIds).size).toBe(outputIds.length);
    expect(checkIds).toEqual(expect.arrayContaining(outputIds));
    expect(
      selectDoctorCheckDefinitions(definitions, "full").map((definition) => definition.id),
    ).toEqual(checkIds);
    expect(doctorOutputIdsForScope("full")).toEqual(outputIds);
    expect(outputIds).toEqual(expect.arrayContaining(expectedHardGates));
    expect(checkIds).not.toContain("plan-reference-freshness");
    expect(outputIds).not.toContain("plan-reference-freshness");
    expect(registrySource).not.toContain("checkPlanReferenceFreshnessAdvisory");
    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const definition of definitions) {
      for (const requiredId of definition.requires ?? []) {
        const required = definitionsById.get(requiredId);
        expect(required).toBeDefined();
        expect(checkIds.indexOf(requiredId)).toBeLessThan(checkIds.indexOf(definition.id));
        expect(required?.profiles).toEqual(expect.arrayContaining([...definition.profiles]));
      }
    }
    expect(checkIds.indexOf("review-evidence")).toBeLessThan(checkIds.indexOf("pair-freeze"));
    expect(outputIds.indexOf("l7-completion")).toBeLessThan(outputIds.indexOf("review-evidence"));
    expect(checkIds.indexOf("guardrail-invariants")).toBeGreaterThan(
      checkIds.indexOf("regression-expansion"),
    );
    expect(outputIds.indexOf("guardrail-invariants")).toBeLessThan(
      outputIds.indexOf("verification-groups"),
    );
    expect(
      definitions.find((definition) => definition.id === "regression-expansion"),
    ).toMatchObject({
      requires: ["dependency-drift"],
    });
  });
});
