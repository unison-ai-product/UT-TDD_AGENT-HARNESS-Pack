import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoctorCheckDefinitionGroups } from "../src/doctor/check-definition-groups.ts";
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
} from "../src/doctor/check-registry.ts";
import {
  checkDependencyDrift as checkDependencyDriftAdapter,
  checkRegressionExpansion as checkRegressionExpansionAdapter,
} from "../src/doctor/dependency-regression.ts";
import {
  checkAgentContractDetection,
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
  checkDeliverablePlanTrace,
  checkDependencyDrift,
  checkDescentObligation,
  checkDesignDocCrossIntegrity,
  checkDriveDbRegistration,
  checkDriveModelPassage,
  checkForwardConvergence,
  checkForwardConvergenceAudit,
  checkFrRoadmapCoverage,
  checkGateConfirm,
  checkGateIdFormat,
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
  checkTypedSpecLedgerBodySync,
  checkTypedSpecOwnedArtifactDispersal,
  checkTypedSpecPhaseLayerAlignment,
  checkTypedSpecTraceClosure,
  checkVerificationGroupsResult,
  checkVerificationProfile,
  type DoctorDeps,
  nodeDoctorDeps,
  runDoctor,
} from "../src/doctor/index.ts";
import { buildDoctorResult } from "../src/doctor/result.ts";
import { analyzeGateRunCoverage, gateRunCoverageMessages } from "../src/lint/gate-run-coverage.ts";
import type { AgentSlotsDeps, Slot } from "../src/runtime/agent-slots.ts";
import {
  analyzeDesignDetectionStats,
  DESIGN_QUALITY_CHECK_IDS,
  type DesignDetectionStats,
  designDetectionMessages,
} from "../src/state-db/design-detection.ts";
import { consumeDoctorResultEnvelope } from "./support/doctor-envelope.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

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

describe("design-detection doctor aggregate", () => {
  const cleanStats = (): DesignDetectionStats => ({
    coverageRows: DESIGN_QUALITY_CHECK_IDS.map((subject_id) => ({
      subject_id,
      metric: "violation_count",
      value: 0,
      threshold: 0,
      status: "passed",
    })),
    missingCoverage: [],
    blockedCoverage: [],
    pairOrphanFindings: [],
  });

  it("fails on missing coverage rows without replaying file-driven lint details", () => {
    const stats = cleanStats();
    stats.coverageRows = stats.coverageRows.filter((row) => row.subject_id !== "module-drift");
    stats.missingCoverage = ["module-drift"];

    const result = analyzeDesignDetectionStats(stats);

    expect(result.ok).toBe(false);
    expect(designDetectionMessages(result).join("\n")).toContain("missing_coverage=1");
    expect(designDetectionMessages(result).join("\n")).not.toContain("module-drift —");
  });

  it("fails on blocked coverage and open pair orphan findings", () => {
    const stats = cleanStats();
    stats.blockedCoverage = [
      {
        subject_id: "l6-fr-coverage",
        metric: "violation_count",
        value: 2,
        threshold: 0,
        status: "blocked",
      },
    ];
    stats.pairOrphanFindings = [
      {
        finding_id: "finding:design-pair-orphan:pair-missing:doc",
        kind: "design-pair-orphan:pair-missing",
        severity: "error",
        subject_id: "docs/design/harness/L1-requirements/functional.md",
        source: "vmodel-pair-freeze",
        status: "open",
        evidence_path: "docs/design/harness/L1-requirements/functional.md",
      },
    ];

    const result = analyzeDesignDetectionStats(stats);
    const messages = designDetectionMessages(result).join("\n");

    expect(result.ok).toBe(false);
    expect(messages).toContain("blocked_coverage=1");
    expect(messages).toContain("pair_orphans=1");
    expect(messages).toContain("design-pair-orphan:pair-missing");
  });
});

describe("gate-run-coverage doctor aggregate", () => {
  it("U-DOCTOR-GATE-01 fails closed on workflow rows without gate evidence and orphan gate runs", () => {
    const result = analyzeGateRunCoverage({
      gateRuns: 1,
      workflowRuns: 2,
      workflowPlansWithoutGateRun: 1,
      orphanGateRuns: 1,
      blankPlanGateRuns: 0,
      invalidEvidenceFindings: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toEqual([
      "workflow_without_gate_run",
      "orphan_gate_run",
    ]);
    expect(gateRunCoverageMessages(result).join("\n")).toContain("gate-run-coverage - violation");
  });

  it("passes when gate and workflow projections are joined", () => {
    const result = analyzeGateRunCoverage({
      gateRuns: 2,
      workflowRuns: 2,
      workflowPlansWithoutGateRun: 0,
      orphanGateRuns: 0,
      blankPlanGateRuns: 0,
      invalidEvidenceFindings: 0,
    });

    expect(result.ok).toBe(true);
    expect(gateRunCoverageMessages(result).join("\n")).toContain("gate-run-coverage - OK");
  });
});

function codexWrapperParityFiles(root: string, overrides: Record<string, string> = {}) {
  const file = (relativePath: string) => join(root, ...relativePath.split("/"));
  return new Map<string, string>(
    Object.entries({
      ".claude/settings.json": JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Agent|Task",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-guard.ts`],
                  blockOnFailure: true,
                },
              ],
            },
            {
              matcher: "Edit|Write|MultiEdit",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/work-guard.ts`],
                  blockOnFailure: true,
                },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "session", "start"],
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit|Bash|PowerShell",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "post-tool-use"],
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "session", "summary"],
                },
              ],
            },
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "claude-memory-wake"],
                  asyncRewake: true,
                },
              ],
            },
          ],
          SubagentStop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`\${CLAUDE_PROJECT_DIR}/src/cli.ts`, "hook", "subagent-stop"],
                },
              ],
            },
          ],
        },
      }),
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
  let cachedRealRepoDoctor: ReturnType<typeof runDoctor> | null = null;
  /**
   * PLAN-L7-461: real-repo fence の生産者。CI では同一 job の doctor step が書いた envelope を
   * 消費して doctor の二重実行を避ける。採用は **観測面 (HEAD / root / ref map / options /
   * check ID 集合) が完全一致したときだけ**で、ローカル実行を含むそれ以外は従来どおり自走する
   * (fence の assertion 対象は「real repo に対する doctor 実行の messages」のまま不変)。
   */
  const realRepoDoctor = () => {
    if (cachedRealRepoDoctor) return cachedRealRepoDoctor;
    cachedRealRepoDoctor =
      consumeDoctorResultEnvelope() ?? runDoctor(nodeDoctorDeps(headSnapshotRoot()));
    return cachedRealRepoDoctor;
  };

  it("U-TESTHYGIENE-028: accepts the resolved aggregate doctor baseline", () => {
    const r = realRepoDoctor();
    const blockers = r.messages.filter(
      (message) => message.includes(" - violation") || message.includes(" — violation"),
    );

    expect(r.ok, `non-OK doctor checks:\n${blockers.join("\n")}`).toBe(true);
    expect(blockers).toHaveLength(0);
  });

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
    const codexHook = (...args: string[]) => ({
      type: "command",
      command: "node",
      args: [".ut-tdd/bin/ut-tdd.mjs", ...args],
    });
    const codexHookJson = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [codexHook("hook", "agent-guard")],
          },
          {
            hooks: [codexHook("hook", "work-guard")],
          },
        ],
        SessionStart: [{ hooks: [codexHook("session", "start")] }],
        PostToolUse: [
          {
            hooks: [codexHook("hook", "post-tool-use")],
          },
        ],
        Stop: [
          {
            hooks: [codexHook("session", "summary")],
          },
        ],
      },
    });
    const claudeHook = (...args: string[]) => ({
      type: "command",
      command: "node",
      args: [".ut-tdd/bin/ut-tdd.mjs", ...args],
    });
    const claudeHookJson = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [claudeHook("hook", "agent-guard")] },
          { hooks: [claudeHook("hook", "work-guard")] },
        ],
        SessionStart: [{ hooks: [claudeHook("session", "start")] }],
        PostToolUse: [{ hooks: [claudeHook("hook", "post-tool-use")] }],
        Stop: [{ hooks: [claudeHook("session", "summary")] }],
        SubagentStop: [{ hooks: [claudeHook("hook", "subagent-stop")] }],
      },
    });
    const file = (path: string) => join("/repo", ...path.split("/"));
    const files = new Map<string, string>([
      [
        file(".ut-tdd/bin/ut-tdd.mjs"),
        "const localBin = '.ut-tdd/bin/ut-tdd.mjs';\nspawnSync(process.execPath, args);\n",
      ],
      [file("AGENTS.md"), "UT-TDD adapter"],
      [file("CLAUDE.md"), "UT-TDD adapter"],
      [file(".claude/CLAUDE.md"), "UT-TDD adapter"],
      [file(".claude/settings.json"), claudeHookJson],
      [file(".codex/config.toml"), "hooks = true"],
      [file(".codex/hooks.json"), codexHookJson],
    ]);

    const r = runDoctor(deps({ files }), { setupSmoke: true });

    expect(DOCTOR_RUN_PROFILE_IDS).toEqual([
      "source-full",
      "source-doc-lane",
      "source-toolchain",
      "consumer-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(new Set(DOCTOR_RUN_PROFILE_IDS).size).toBe(DOCTOR_RUN_PROFILE_IDS.length);
    expect(Object.keys(DOCTOR_RUN_PROFILES).sort()).toEqual([...DOCTOR_RUN_PROFILE_IDS].sort());
    expect(doctorRunProfilesForAudience("consumer")).toEqual([
      DOCTOR_RUN_PROFILES["consumer-toolchain"],
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    ]);
    expect(doctorRunProfilesForAudience("consumer").every(isConsumerSafeDoctorRunProfile)).toBe(
      true,
    );
    expect(consumerSafeDoctorRunProfiles().map((profile) => profile.id)).toEqual([
      "source-toolchain",
      "consumer-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(consumerSafeDoctorRunProfiles().every(isConsumerSafeDoctorRunProfile)).toBe(true);
    expect(consumerSafeDoctorRunProfiles().some((profile) => profile.sourceOnly)).toBe(false);
    expect(consumerSafeDoctorRunProfiles()).not.toContainEqual(
      expect.objectContaining({ sourceOnly: true }),
    );
    expect(
      consumerSafeDoctorRunProfiles().filter((profile) => profile.audience === "consumer"),
    ).toEqual([
      DOCTOR_RUN_PROFILES["consumer-toolchain"],
      DOCTOR_RUN_PROFILES["consumer-setup-smoke"],
    ]);
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
    expect(resolveDoctorRunProfile({ profile: "consumer-toolchain" })).toEqual(
      DOCTOR_RUN_PROFILES["consumer-toolchain"],
    );
    expect(r.messages).toEqual(["doctor: setup-smoke - OK (checked=23, failed=0)"]);
  });

  it("runs only the toolchain gate when doctor scope is toolchain", () => {
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const selected = selectDoctorCheckDefinitions(definitions, "toolchain");
    const run = collectDoctorCheckRun(nodeDoctorDeps(headSnapshotRoot()), {
      scope: "toolchain",
      timing: true,
    });
    expect(run.checkIds).toEqual(selected.map((definition) => definition.id));

    expect(resolveDoctorRunProfile()).toEqual(DOCTOR_RUN_PROFILES["source-full"]);
    expect(doctorRunProfilesForAudience("source").map((profile) => profile.id)).toEqual([
      "source-full",
      "source-doc-lane",
      "source-toolchain",
    ]);
    expect(doctorRunProfilesForAudience("source").filter((profile) => profile.sourceOnly)).toEqual([
      DOCTOR_RUN_PROFILES["source-full"],
      DOCTOR_RUN_PROFILES["source-doc-lane"],
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
    expect(resolveDoctorRunProfile({ profile: "consumer-toolchain" })).toMatchObject({
      id: "consumer-toolchain",
      audience: "consumer",
      invocation: "registry",
      scope: "toolchain",
      setupSmoke: false,
      outputIds: ["toolchain-pin"],
      sourceOnly: false,
    });
    expect(DOCTOR_RUN_PROFILES["source-full"].outputIds).toEqual(doctorOutputIdsForScope("full"));
    expect(DOCTOR_RUN_PROFILES["source-toolchain"].outputIds).toEqual(
      doctorOutputIdsForScope("toolchain"),
    );
    expect(DOCTOR_RUN_PROFILES["consumer-toolchain"].outputIds).toEqual(
      doctorOutputIdsForScope("toolchain"),
    );
    expect(doctorOutputIdsForScope("toolchain")).toEqual(["toolchain-pin"]);
    expect(selected.map((definition) => definition.id)).toEqual(["toolchain-pin"]);
    expect(run.checks).toHaveLength(1);
    expect(run.checks[0]?.messages[0]).toContain("toolchain-pin");
    expect(run.timings).toEqual([
      expect.objectContaining({
        id: "toolchain-pin",
        ok: run.checks[0]?.ok,
        message_count: 1,
      }),
    ]);
  });

  it("U-CIPOL-027: runs exactly the checks declared by the source doc lane profile", () => {
    const profile = DOCTOR_RUN_PROFILES["source-doc-lane"];
    const profileOutputIds = new Set<string>(profile.outputIds);
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const selected = selectDoctorCheckDefinitions(definitions, profile.scope, profile.outputIds);
    const run = collectDoctorCheckRun(nodeDoctorDeps(headSnapshotRoot()), {
      profile: "source-doc-lane",
      timing: true,
    });

    expect(selected.map((definition) => definition.id)).toEqual([...profile.outputIds]);
    expect(run.checkIds).toEqual([...profile.outputIds]);
    expect(run.checks).toHaveLength(profile.outputIds.length);
    expect(run.timings.map((timing) => timing.id)).toEqual(
      definitions
        .filter(
          (definition) =>
            definition.profiles.includes(profile.scope) && profileOutputIds.has(definition.id),
        )
        .map((definition) => definition.id),
    );
  });

  it("includes asset-drift hard gate in doctor output", () => {
    const r = realRepoDoctor();
    // This test verifies gate wiring; unrelated active repo gates may legitimately be non-terminal.
    expect(r.messages.some((m) => m.includes("doctor: asset-drift") && m.includes("OK"))).toBe(
      true,
    );
  });

  it("includes skill-assignment hard gate in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: skill-assignment - OK"))).toBe(true);
  });

  // PLAN-L7-95: the 4 previously-inert lint audits + the lint-wiring meta-gate must be
  // invoked by runDoctor (invocation fence — guards against re-introducing the absence-blindness
  // where a lint module is reachable/tested but its audit never runs in a runtime path).
  it("invokes the 4 newly-wired lint audits + lint-wiring meta-gate in doctor output", () => {
    const r = realRepoDoctor();
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
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: branch-kind-check - OK"))).toBe(true);
  });

  it("includes GitHub CI policy hard gate in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: github-ci-policy - OK"))).toBe(true);
  });

  it("includes G1/G3 trace gates in doctor output", () => {
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: g1-trace - OK"))).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: g3-trace - OK"))).toBe(true);
  });

  it("surfaces typed spec trace closure as a doctor hard gate", () => {
    const result = checkTypedSpecTraceClosure(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-trace-closure - OK");
    expect(r.messages.some((m) => m.includes("doctor: typed-spec-trace-closure - OK"))).toBe(true);
  });

  it("surfaces design doc cross integrity as a doctor hard gate", () => {
    const result = checkDesignDocCrossIntegrity(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("design-doc-cross-integrity - OK");
    expect(r.messages.some((m) => m.includes("doctor: design-doc-cross-integrity - OK"))).toBe(
      true,
    );
  });

  it("fails design doc cross integrity when a typed spec is defined by multiple docs", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-design-cross-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      mkdirSync(join(root, "docs", "design", "harness", "L4-basic-design"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-document-catalog.md"),
        [
          "# V-model document catalog",
          "",
          "| doc_type_id | layer | sub_doc | category | requirement_class | applicability | default_status | source_doc_family | authoring_source_path | projection_table | profile_controlled | skip_reason_required |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|",
          "| DOC-A | L4 | data | basic-design | core | in_scope | required | fixture | docs/design/harness/L4-basic-design/data.md | spec_defs | false | false |",
          "| DOC-B | L4 | function | basic-design | core | in_scope | required | fixture | docs/design/harness/L4-basic-design/function.md | spec_defs | false | false |",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "design", "harness", "L4-basic-design", "data.md"),
        [
          "# A",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-DUP",
          "      kind: contract",
          "```",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(root, "docs", "design", "harness", "L4-basic-design", "function.md"),
        [
          "# B",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-DUP",
          "      kind: contract",
          "```",
        ].join("\n"),
        "utf8",
      );

      const result = checkDesignDocCrossIntegrity(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("design-doc-duplicate-definition");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails typed spec trace closure when bidirectional trace or test backlink is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-closure-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "# Typed spec bad closure",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-301",
          "      kind: typed-source",
          "      traces_to: [VMS-302]",
          "      tests: [TVMS-301]",
          "    - id: VMS-302",
          "      kind: typed-projection",
          "    - id: TVMS-301",
          "      kind: unit-oracle",
          "```",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecTraceClosure(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-trace-reverse-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-test-backlink-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-test-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces typed spec ledger/body sync as a doctor hard gate", () => {
    const result = checkTypedSpecLedgerBodySync(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-ledger-body-sync - OK");
    expect(r.messages.some((m) => m.includes("doctor: typed-spec-ledger-body-sync - OK"))).toBe(
      true,
    );
  });

  it("fails typed spec ledger/body sync when body, ledger, or phase direction is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-ledger-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "# Typed spec bad ledger",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-401",
          "      kind: typed-source",
          "      traces_from: [VMS-402]",
          "      tests: [TVMS-401]",
          "    - id: VMS-402",
          "      kind: typed-projection",
          "      tests: [TVMS-402]",
          "    - id: TVMS-401",
          "      kind: unit-oracle",
          "      traces_from: [VMS-401]",
          "    - id: TVMS-402",
          "      kind: unit-oracle",
          "      traces_from: [VMS-402]",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-401 | docs/plans/PLAN-L6-401.md | L6 |",
          "| VMS-402 | docs/plans/PLAN-L7-402.md | L7 |",
          "| TVMS-401 | docs/test-design/harness/L7-unit-test-design.md | L7 |",
          "| TVMS-999 | docs/test-design/harness/L7-unit-test-design.md | L7 |",
          "",
          "VMS-401 has body substance.",
          "VMS-402 has body substance.",
          "TVMS-401 has body substance.",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecLedgerBodySync(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-ledger-row-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-body-missing");
      expect(result.messages.join("\n")).toContain("typed-spec-ledger-unknown-id");
      expect(result.messages.join("\n")).toContain("typed-spec-phase-direction-invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces typed spec owned artifact dispersal as a doctor hard gate", () => {
    const result = checkTypedSpecOwnedArtifactDispersal(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-owned-artifact-dispersal - OK");
    expect(
      r.messages.some((m) => m.includes("doctor: typed-spec-owned-artifact-dispersal - OK")),
    ).toBe(true);
  });

  it("fails typed spec owned artifact dispersal when declarations remain outside ledger sources", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-owned-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "# Typed spec ownership bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-601",
          "      kind: typed-source",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-601 | docs/plans/PLAN-L6-601.md | L6 |",
          "",
          "VMS-601 has body substance.",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecOwnedArtifactDispersal(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-owned-source-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces typed spec phase/layer alignment as a doctor hard gate", () => {
    const result = checkTypedSpecPhaseLayerAlignment(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("typed-spec-phase-layer-alignment - OK");
    expect(
      r.messages.some((m) => m.includes("doctor: typed-spec-phase-layer-alignment - OK")),
    ).toBe(true);
  });

  it("fails typed spec phase/layer alignment when owner frontmatter does not match v_phase", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-typed-spec-phase-layer-"));
    try {
      mkdirSync(join(root, "docs", "governance"), { recursive: true });
      writeFileSync(
        join(root, "docs", "governance", "vmodel-typed-spec-definitions.md"),
        [
          "---",
          "title: Typed spec phase layer bad fixture",
          "status: confirmed",
          "typed_spec_phase_owner: L5",
          "---",
          "",
          "# Typed spec phase/layer bad fixture",
          "",
          "```yaml",
          "spec:",
          "  defines:",
          "    - id: VMS-701",
          "      kind: typed-source",
          "```",
          "",
          "| spec_id | ledger_sources | v_phase |",
          "| --- | --- | --- |",
          "| VMS-701 | docs/governance/vmodel-typed-spec-definitions.md | L6 |",
          "",
          "VMS-701 has body substance.",
        ].join("\n"),
        "utf8",
      );

      const result = checkTypedSpecPhaseLayerAlignment(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("typed-spec-phase-layer-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces V-model agent contract detection as a doctor hard gate", () => {
    const result = checkAgentContractDetection(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("agent-contract-detection - OK");
    expect(r.messages.some((m) => m.includes("doctor: agent-contract-detection - OK"))).toBe(true);
  });

  it("fails V-model agent contract detection when done_when references an unknown doctor gate", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-doctor-agent-contract-"));
    try {
      const governanceDir = join(root, "docs", "governance");
      mkdirSync(governanceDir, { recursive: true });
      writeFileSync(join(governanceDir, "vmodel-upgrade-schedule.md"), "# Schedule\n", "utf8");
      writeFileSync(
        join(governanceDir, "vmodel-typed-spec-definitions.md"),
        "# Typed spec\n",
        "utf8",
      );
      writeFileSync(
        join(governanceDir, "vmodel-agent-contracts.md"),
        [
          "# Agent contracts",
          "",
          "```yaml",
          "agent_contracts:",
          "  - contract_id: VAGENT-301",
          "    target_path: docs/governance/vmodel-typed-spec-definitions.md",
          "    defines: [VMS-301]",
          "    read_first:",
          "      - docs/governance/vmodel-upgrade-schedule.md",
          "    done_when:",
          "      - doctor:no-such-gate",
          "```",
        ].join("\n"),
        "utf8",
      );

      const result = checkAgentContractDetection(root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("agent-contract-doctor-gate-unknown");
      expect(result.messages.join("\n")).toContain("VAGENT-301:no-such-gate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes PLAN governance after merged-plan debt is resolved", () => {
    const governance = checkPlanGovernance(headSnapshotRoot());
    const r = realRepoDoctor();

    expect(governance.ok).toBe(true);
    expect(governance.messages).toEqual(expect.arrayContaining([expect.stringContaining("OK")]));
    expect(r.messages.some((m) => m.includes("doctor: plan-schedule") && m.includes("OK"))).toBe(
      true,
    );
    expect(r.messages.some((m) => m.includes("doctor: plan-governance") && m.includes("OK"))).toBe(
      true,
    );
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
    const r = realRepoDoctor();
    expect(r.messages.some((m) => m.includes("doctor: dependency-drift"))).toBe(true);
    expect(r.messages.some((m) => m.includes("doctor: regression-expansion"))).toBe(true);
    expect(r.messages.some((m) => m.includes("scaffold stub"))).toBe(false);
  });

  it("surfaces roadmap-rollup as a hard gate summary line", () => {
    const r = realRepoDoctor();
    const rollupLines = r.messages.filter((m) => m.startsWith("doctor: roadmap-rollup"));

    expect(rollupLines).toHaveLength(1);
    expect(rollupLines[0]).toContain("bands ");
    expect(rollupLines[0]).toContain("gates ");
    expect(rollupLines[0]).toContain("spans ");
    expect(rollupLines[0]).toContain("frontier:");
  });

  it("surfaces Cycle P4 closure audit as a hard gate", () => {
    const r = realRepoDoctor();

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
      ["typed-spec-trace-closure", checkTypedSpecTraceClosure(missingRoot)],
      ["typed-spec-ledger-body-sync", checkTypedSpecLedgerBodySync(missingRoot)],
      ["typed-spec-owned-artifact-dispersal", checkTypedSpecOwnedArtifactDispersal(missingRoot)],
      ["typed-spec-phase-layer-alignment", checkTypedSpecPhaseLayerAlignment(missingRoot)],
      ["agent-contract-detection", checkAgentContractDetection(missingRoot)],
      ["rule-drift", checkRuleDrift(missingRoot)],
      ["gate-confirm", checkGateConfirm(missingRoot)],
      ["gate-id-format", checkGateIdFormat(missingRoot)],
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
      ["deliverable-plan-trace", checkDeliverablePlanTrace(missingRoot)],
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
    const indexSource = readFileSync(join(headSnapshotRoot(), "src", "doctor", "index.ts"), "utf8");
    const registrySource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "check-registry.ts"),
      "utf8",
    );
    const definitionsSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "check-definitions.ts"),
      "utf8",
    );
    const groupSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "check-definition-groups.ts"),
      "utf8",
    );
    const profileSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "profiles.ts"),
      "utf8",
    );
    const runnerSource = readFileSync(
      join(headSnapshotRoot(), "src", "doctor", "runner.ts"),
      "utf8",
    );
    const definitions = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headSnapshotRoot()));
    const definitionGroups = buildDoctorCheckDefinitionGroups(nodeDoctorDeps(headSnapshotRoot()));
    const flattenedGroupDefinitions = definitionGroups.flatMap((group) => group.definitions);
    const checkIds = definitions.map((definition) => definition.id);
    const groupCheckIds = flattenedGroupDefinitions.map((definition) => definition.id);
    const outputIds = [...FULL_DOCTOR_OUTPUT_IDS];
    expect(indexSource).toContain("resolveDoctorRunProfile");
    expect(indexSource).toContain("const profile = resolveDoctorRunProfile(options)");
    expect(indexSource).toContain('if (profile.invocation === "setup-smoke")');
    expect(indexSource).toContain(
      "const { checks, checkIds, timings } = collectDoctorCheckRun(deps, options)",
    );
    expect(registrySource).toContain('} from "./runner.ts"');
    expect(registrySource).toContain('} from "./check-definitions.ts"');
    expect(runnerSource).toContain("export function collectDoctorCheckRun");
    expect(runnerSource).toContain("export function collectDoctorChecks");
    expect(definitionsSource).toContain("export function buildFullDoctorCheckDefinitions");
    expect(definitionsSource).toContain("buildDoctorCheckDefinitionGroups(deps, options)");
    expect(groupSource).toContain("export function buildDoctorCheckDefinitionGroups");
    expect(runnerSource).toContain("buildFullDoctorCheckDefinitions(deps, options)");
    expect(definitionsSource).not.toContain("checkPlanReferenceFreshnessAdvisory");
    expect(registrySource).toContain('} from "./profiles.ts"');
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
    expect(definitionGroups.map((group) => group.id)).toEqual([
      "plan-governance",
      "rules-and-process",
      "runtime-surface",
      "completion-and-readability",
      "source-trace",
      "dependency-and-db",
      "workflow-and-final",
    ]);
    const expectedHardGates = [
      "backfill",
      "scrum-reverse",
      "propagation",
      "pair-freeze",
      "module-drift",
      "merged-plan-status",
      "memory-sync",
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
      "design-detection",
      "rule-drift",
      "model-id-doc-drift",
      "gate-confirm",
      "gate-id-format",
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
      "runtime-state-location",
      "test-repository-isolation",
      "project-hook",
      "codex-wrapper-parity",
      "toolchain-pin",
      "l6-completion",
      "l7-completion",
      "verification-groups",
      "roadmap",
      "deliverable-plan-trace",
      "impl-plan-trace",
      "oracle-test-trace",
      "tracked-canonical",
      "dependency-drift",
      "regression-expansion",
      "agent-contract-detection",
      "green-command-digest",
    ];

    expect(new Set(checkIds).size).toBe(checkIds.length);
    expect(groupCheckIds).toEqual(checkIds);
    expect(new Set(definitionGroups.map((group) => group.id)).size).toBe(definitionGroups.length);
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
    const dependencyGroupIds =
      definitionGroups
        .find((group) => group.id === "dependency-and-db")
        ?.definitions.map((definition) => definition.id) ?? [];
    expect(dependencyGroupIds).toEqual(
      expect.arrayContaining(["dependency-drift", "regression-expansion"]),
    );
    expect(dependencyGroupIds.indexOf("dependency-drift")).toBeLessThan(
      dependencyGroupIds.indexOf("regression-expansion"),
    );
  });
});
