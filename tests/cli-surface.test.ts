import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { utTddCliProbe } from "../src/cli/distribution.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  buildConsumerNodeRuntimeBundle,
  buildConsumerNodeRuntimePayloads,
  digestConsumerRuntimeBytes,
} from "../src/setup/consumer-node-runtime.ts";
import { derivePackPublicationAssets } from "../src/setup/pack-publication-assets.ts";
import { buildPackPublicationStagingPlan } from "../src/setup/pack-publication-staging.ts";
import { digestMaterializedReleaseEntries } from "../src/setup/release-materializer.ts";
import { defaultHarnessDbPath, openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { MODEL_IDS } from "../src/team/model-policy.ts";
import { headPlanDocCount } from "./plan-asset/head-plan-doc-count.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const legacyEnvPrefix = ["HE", "LIX"].join("");

function runCli(args: string[]) {
  return runCliIn(repoRoot, args);
}

function runCliIn(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  // PLAN-L7-462 step 2: CLI 実発火 oracle は node 直 spawn (cmd.exe/bun 経由なし)。
  return spawnSync("node", [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
    windowsHide: true,
    // maxBuffer は既定 1 MiB では足りない。plan migration-dry-run --json は HEAD の全 PLAN を
    // 出すので PLAN が増えるほど伸び、2026-08-21 時点で 1,043,627 byte = 既定の 99.5% に達して
    // いた。超えると child が殺され status=null / stdout 切り捨てになり、失敗が
    // 「expected null to be +0」としか見えない。PLAN を 1 本足しただけの merge が読めない理由で
    // main を赤化させたので余裕を持たせる。ENOBUFS 自体は parseCliJson が明示的に検出する。
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseCliJson(run: ReturnType<typeof runCliIn>) {
  // maxBuffer 超過は status=null + error=ENOBUFS で現れる。status だけを見ると
  // 「expected null to be +0」になり原因が読めないので、先に error を突く。
  expect(run.error?.message ?? "", "spawn error").toBe("");
  expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);
  expect(run.stdout.trim(), `stderr:\n${run.stderr}`).not.toBe("");
  return JSON.parse(run.stdout);
}

function seedScopePreviewDb(root: string): void {
  mkdirSync(join(root, ".ut-tdd"), { recursive: true });
  const db = openHarnessDb(defaultHarnessDbPath(root), { repoRoot: root });
  try {
    migrate(db);
    upsertRow(db, {
      table: "document_scale_profile_reviews",
      primaryKey: "document_scale_profile_review_id",
      row: {
        document_scale_profile_review_id: "standard:DOC-L4-REPORT",
        profile_id: "standard",
        doc_type_id: "DOC-L4-REPORT",
        document_scale_profile_entry_id: "entry:standard:DOC-L4-REPORT",
        document_catalog_entry_id: "catalog:DOC-L4-REPORT",
        decision: "conditional",
        detail_override: "standard",
        status_override: "profile_controlled",
        reason: "report capability flag controls adoption",
        required_plan_id: "",
        catalog_layer: "L4",
        catalog_sub_doc: "report",
        requirement_class: "product-select",
        catalog_default_status: "skipped",
        catalog_profile_controlled: 1,
        catalog_skip_reason_required: 1,
        source_path: "docs/governance/vmodel-document-scale-profiles.md",
        indexed_at: "2026-07-09T00:00:00.000Z",
      },
    });
  } finally {
    db.close();
  }
}

function writeFakeProvider(binDir: string, name: "codex" | "claude"): string {
  const rawEnv = [legacyEnvPrefix, "ALLOW", "RAW", name.toUpperCase()].join("_");
  const reasonEnv = [legacyEnvPrefix, "RAW", name.toUpperCase(), "REASON"].join("_");
  if (process.platform === "win32") {
    const path = join(binDir, `${name}.cmd`);
    writeFileSync(
      path,
      [
        "@echo off",
        `echo noisy-${name}`,
        'set "OUTPUT_DIR=%CD%"',
        'if defined UT_TDD_TEST_PROVIDER_OUTPUT_DIR set "OUTPUT_DIR=%UT_TDD_TEST_PROVIDER_OUTPUT_DIR%"',
        `echo raw=%${rawEnv}% > "%OUTPUT_DIR%\\${name}-env.txt"`,
        `echo reason=%${reasonEnv}% >> "%OUTPUT_DIR%\\${name}-env.txt"`,
        `echo effort=%CLAUDE_CODE_EFFORT_LEVEL% >> "%OUTPUT_DIR%\\${name}-env.txt"`,
        `echo args=%* >> "%OUTPUT_DIR%\\${name}-env.txt"`,
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
    return path;
  }
  const path = join(binDir, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo noisy-${name}`,
      ['output_dir="$', '{UT_TDD_TEST_PROVIDER_OUTPUT_DIR:-$PWD}"'].join(""),
      `printf "raw=%s\\nreason=%s\\neffort=%s\\nargs=%s\\n" "$${rawEnv}" "$${reasonEnv}" "$CLAUDE_CODE_EFFORT_LEVEL" "$*" > "$output_dir/${name}-env.txt"`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function writeFakeUtTdd(binDir: string): string {
  if (process.platform === "win32") {
    const path = join(binDir, "ut-tdd.cmd");
    writeFileSync(path, "@echo off\r\necho ut-tdd 0.0.0\r\nexit /b 0\r\n", "utf8");
    return path;
  }
  const path = join(binDir, "ut-tdd");
  writeFileSync(path, "#!/bin/sh\necho ut-tdd 0.0.0\nexit 0\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  chmodSync(path, 0o755);
  return path;
}

function withFakeProviderEnv(provider: "codex" | "claude") {
  const binDir = mkdtempSync(join(tmpdir(), `ut-tdd-cli-${provider}-bin-`));
  writeFakeProvider(binDir, provider);
  return {
    binDir,
    env: {
      ...process.env,
      UT_TDD_TEST_PROVIDER_OUTPUT_DIR: binDir,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

describe("utTddCliProbe (PLAN-L7-462 step 2 .cmd shim probe)", () => {
  it("U-DIST-CLI-PROBE: resolves a PATH-provided ut-tdd shim (win32 は ComSpec 経由 — bare node spawn だと ENOENT)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ut-tdd-cli-probe-"));
    try {
      writeFakeUtTdd(tmp);
      const probe = utTddCliProbe({ ...process.env, PATH: tmp }, process.platform);
      expect(probe.status).toBe(0);
      expect(probe.stdout).toContain("ut-tdd 0.0.0");
    } finally {
      removeTestTree(tmp);
    }
  });
});

describe("L7 CLI surface closure", () => {
  it("U-GATE-007 persists gate run evidence without changing gate verdict semantics", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-gate-run-"));
    try {
      const run = runCliIn(root, [
        "gate",
        "G0.5",
        "--mode",
        "standalone",
        "--review-kind",
        "human",
        "--human-approved",
        "--plan",
        "PLAN-L7-363-routine-gate-run-projection",
        "--session",
        "session-gate-test",
        "--json",
      ]);
      expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);
      const payload = JSON.parse(run.stdout);
      expect(payload.passed).toBe(true);
      expect(payload.gate_run_evidence.path).toMatch(/^\.ut-tdd\/gate_runs\/G0\.5-/);
      const files = readdirSync(join(root, ".ut-tdd", "gate_runs"));
      expect(files).toHaveLength(1);
      const evidence = JSON.parse(
        readFileSync(join(root, ".ut-tdd", "gate_runs", files[0]), "utf8"),
      );
      expect(evidence).toMatchObject({
        gate_id: "G0.5",
        plan_id: "PLAN-L7-363-routine-gate-run-projection",
        status: "passed",
        session_id: "session-gate-test",
        source: "ut-tdd gate",
      });
    } finally {
      removeTestTree(root);
    }
  }, 15_000);

  it("U-GATE-008 keeps the gate verdict when evidence persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-gate-run-fail-"));
    try {
      writeFileSync(join(root, ".ut-tdd"), "not a directory", "utf8");
      const run = runCliIn(root, [
        "gate",
        "G0.5",
        "--mode",
        "standalone",
        "--review-kind",
        "human",
        "--human-approved",
        "--plan",
        "PLAN-L7-363-routine-gate-run-projection",
        "--json",
      ]);
      expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);
      const payload = JSON.parse(run.stdout);
      expect(payload.passed).toBe(true);
      expect(payload.gate_run_evidence).toBeNull();
      expect(payload.gate_run_evidence_warning).toContain("gate run evidence write failed");
    } finally {
      removeTestTree(root);
    }
  }, 15_000);

  it("exposes plan complete as the completed handover lifecycle entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-plan-complete-"));
    try {
      const use = runCliIn(root, ["plan", "use", "PLAN-L7-04-handover-mechanism"]);
      expect(use.status).toBe(0);

      const complete = runCliIn(root, ["plan", "complete", "--dry-run"]);
      expect(complete.status).toBe(0);
      expect(complete.stdout).toContain("plan complete:");
      expect(complete.stdout).toContain("status=completed");
      expect(complete.stdout).toContain("(dry-run)");
    } finally {
      removeTestTree(root);
    }
  }, 15_000);

  it("exposes green command digest migration as a non-destructive plan dry-run surface", () => {
    const run = runCli(["plan", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("digest-migrate");
  }, 15_000);

  it("exposes green command digest migration execute as an explicit opt-in surface", () => {
    const run = runCli(["plan", "digest-migrate", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--execute");
    expect(run.stdout).toContain("--json");
  }, 15_000);

  it("U-PA-042: exposes the complete HEAD migration inventory as a machine-readable dry-run", () => {
    const run = runCli(["plan", "migration-dry-run", "--json"]);
    const payload = parseCliJson(run) as {
      ok: boolean;
      total: number;
      emitted: number;
      decisionCounts: Record<string, number>;
      findings: unknown[];
    };

    const planCount = headPlanDocCount(process.cwd());
    expect(payload).toMatchObject({
      ok: true,
      total: planCount,
      emitted: planCount,
      decisionCounts: { migrated: planCount - 53, rekeyed: 53, rejected: 0, pending: 0 },
      findings: [],
    });
  }, 15_000);

  it("exposes skill suggest as a JSON command surface", () => {
    const run = runCli(["skill", "suggest", "--plan", "PLAN-NO-SUCH", "--json"]);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([]);
  }, 15_000);

  it("exposes strict telemetry provenance as a doctor verification flag", () => {
    const run = runCli(["doctor", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--json");
    expect(run.stdout).toContain("--setup-smoke");
    expect(run.stdout).toContain("--profile");
    expect(run.stdout).toContain("--profiles");
    expect(run.stdout).toContain("--scope");
    expect(run.stdout).toContain("--timing");
    expect(run.stdout).toContain("--strict-telemetry-provenance");
    expect(run.stdout).toContain("--strict-green-command-digest");
  }, 15_000);

  it("lists doctor profiles as a machine-readable public surface", () => {
    const run = runCli(["doctor", "--profiles", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload.map((profile: { id: string }) => profile.id)).toEqual([
      "source-full",
      "source-doc-lane",
      "source-toolchain",
      "consumer-toolchain",
      "consumer-setup-smoke",
    ]);
    expect(payload).toContainEqual(
      expect.objectContaining({
        id: "consumer-toolchain",
        audience: "consumer",
        invocation: "registry",
        sourceOnly: false,
      }),
    );
    expect(payload).toContainEqual(
      expect.objectContaining({
        id: "consumer-setup-smoke",
        audience: "consumer",
        invocation: "setup-smoke",
        sourceOnly: false,
      }),
    );
    expect(payload).toContainEqual(
      expect.objectContaining({
        id: "source-full",
        sourceOnly: true,
      }),
    );
  }, 15_000);

  it("runs a named consumer-safe doctor profile without relying on setup-smoke alias", () => {
    const run = runCli(["doctor", "--profile", "consumer-toolchain", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("doctor: toolchain-pin - OK")]),
    );
    expect(payload.messages.join("\n")).not.toContain("plan-governance");
  }, 20_000);

  it("fail-closes unsupported doctor profile as machine-readable JSON", () => {
    const run = runCli(["doctor", "--profile", "bogus", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.messages).toEqual([
      'doctor: invalid --profile "bogus" (expected: source-full, source-doc-lane, source-toolchain, consumer-toolchain, consumer-setup-smoke)',
    ]);
  }, 15_000);

  it("fail-closes unsupported doctor scope as machine-readable JSON", () => {
    const run = runCli(["doctor", "--scope", "bogus", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.messages).toEqual([
      'doctor: invalid --scope "bogus" (expected: full, toolchain)',
    ]);
  }, 15_000);

  it("emits machine-readable doctor JSON while preserving failing exit codes", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-doctor-json-fail-"));
    try {
      const run = runCliIn(root, ["doctor", "--setup-smoke", "--json"]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.messages).toEqual(
        expect.arrayContaining([expect.stringContaining("doctor:")]),
      );
      expect(run.stdout).not.toContain("undefined");
    } finally {
      removeTestTree(root);
    }
  }, 15_000);

  it("U-DOCTORENV-016: binds a real setup-smoke CLI result file to the executed surface", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-cli-doctor-envelope-"));
    const resultFile = join(dir, "doctor-result.json");
    try {
      const run = runCli(["doctor", "--setup-smoke", "--result-file", resultFile, "--json"]);

      // setup-smoke は環境依存の検査結果を返すため、検査本体の 0/1 は許容する。
      // lock blocked (2) は envelope を生成しないため、ここでは受け付けない。
      expect(run.status).toBeLessThan(2);
      const envelope = JSON.parse(readFileSync(resultFile, "utf8")) as {
        schema_version: string;
        scope: string;
        profile: string | null;
        options: Record<string, unknown>;
        check_ids: string[];
      };

      expect(envelope).toMatchObject({
        schema_version: "v4",
        scope: "setup-smoke",
        profile: "consumer-setup-smoke",
      });
      expect(envelope.check_ids).toEqual(["setup-smoke"]);
      expect(Object.keys(envelope.options).sort()).toEqual([
        "strict_green_command_digest",
        "strict_telemetry_provenance",
        "timing",
      ]);
    } finally {
      removeTestTree(dir);
    }
  }, 30_000);

  it("U-DOCLOCK-009: blocks a competing doctor CLI before it starts verification", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-doctor-lock-"));
    try {
      const stateDir = join(root, ".ut-tdd", "state", "doctor-lock", "claims");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "fixture-lock.json"),
        `${JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString(), lock_id: "fixture-lock" })}\n`,
        "utf8",
      );
      const run = runCliIn(root, ["doctor", "--setup-smoke", "--json"]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(2);
      expect(payload).toMatchObject({ ok: false });
      expect(payload.messages.join("\n")).toContain("already running");
    } finally {
      removeTestTree(root);
    }
  }, 15_000);

  it.each([
    ["U-DOCLOCK-012", "--staged"],
    ["U-DOCLOCK-013", "--uncommitted"],
  ])(
    "%s: blocks a competing review %s before its internal doctor starts",
    (_id, mode) => {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-review-lock-"));
      try {
        const gitInit = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
        expect(gitInit.status).toBe(0);
        const claimsDir = join(root, ".ut-tdd", "state", "doctor-lock", "claims");
        mkdirSync(claimsDir, { recursive: true });
        writeFileSync(
          join(claimsDir, "fixture-lock.json"),
          `${JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString(), lock_id: "fixture-lock" })}\n`,
          "utf8",
        );
        const run = runCliIn(root, ["review", mode, "--json"]);
        const payload = JSON.parse(run.stdout);

        expect(run.status).toBe(2);
        expect(payload).toMatchObject({ ok: false });
        expect(payload.doctorMessages.join("\n")).toContain("already running");
      } finally {
        removeTestTree(root);
      }
    },
    15_000,
  );

  it("documents guard blocked exit code in hook and manual preflight help", () => {
    const agentGuard = runCli(["hook", "agent-guard", "--help"]);
    const workGuard = runCli(["hook", "work-guard", "--help"]);
    const preflight = runCli(["guard", "preflight", "--help"]);
    const exitContract = "exits: 0=pass, 1=error, 2=blocked";

    expect(agentGuard.status).toBe(0);
    expect(workGuard.status).toBe(0);
    expect(preflight.status).toBe(0);
    expect(agentGuard.stdout).toContain(exitContract);
    expect(workGuard.stdout).toContain(exitContract);
    expect(preflight.stdout).toContain(exitContract);
  }, 15_000);

  it("exposes Pack sync commands as first-class distribution surfaces", () => {
    const run = runCli(["distribution", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sync-plan");
    expect(run.stdout).toContain("sync-stage");
    expect(run.stdout).toContain("sync-pack");
    expect(run.stdout).toContain("release-plan");
  }, 15_000);

  it("exposes ID-based trace impact traversal as a CLI surface", () => {
    const run = runCli(["trace", "impact", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--id <id>");
    expect(run.stdout).toContain("--json");
  }, 15_000);

  it("exposes typed spec closure RAG as a CLI surface", () => {
    const run = runCli(["trace", "rag", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--id <id>");
    expect(run.stdout).toContain("--json");
  }, 15_000);

  it("exposes DB scope-preview as a CLI surface", () => {
    const run = runCli(["db", "scope-preview", "--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--profile <profile>");
    expect(run.stdout).toContain("--activation-profile <profile>");
    expect(run.stdout).toContain("--capability <flag...>");
    expect(run.stdout).toContain("--json");
  }, 15_000);

  it("renders DB scope-preview JSON without mutating profile sources", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-scope-preview-cli-"));
    try {
      seedScopePreviewDb(root);
      const run = runCliIn(root, [
        "db",
        "scope-preview",
        "--profile",
        "standard",
        "--capability",
        "report",
        "--json",
      ]);
      const payload = parseCliJson(run);

      expect(payload).toMatchObject({
        ok: true,
        profile_id: "standard",
        summary: {
          documents_total: 1,
          documents_in_scope: 1,
        },
      });
      expect(payload.documents[0]).toMatchObject({
        doc_type_id: "DOC-L4-REPORT",
        resolved_scope_status: "in_scope",
        gate_id: "G4",
      });
    } finally {
      removeTestTree(root);
    }
  }, 15_000);

  it("exposes feedback commands through the extracted registrar", () => {
    const help = runCli(["feedback", "--help"]);
    const classify = runCli(["feedback", "classify", "--text", "please review this regression"]);
    const payload = JSON.parse(classify.stdout);

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("list");
    expect(help.stdout).toContain("classify");
    expect(help.stdout).toContain("pending");
    expect(classify.status).toBe(0);
    expect(payload).toMatchObject({
      role: "pmo-haiku",
      text: "please review this regression",
    });
    expect(payload.output_schema.category).toContain("feedback");
  }, 15_000);

  it("exposes skill injection as a provider-neutral JSON manifest", () => {
    const run = runCli([
      "skill",
      "suggest",
      "--text",
      "refactor regression test",
      "--inject",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      plan_id: "text:refactor-regression-test",
      missing_skill_ids: [],
    });
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.every((entry: { skill_path: string }) => entry.skill_path)).toBe(true);
    expect(payload.required_paths.length).toBeGreaterThan(0);
  }, 20_000);

  it("injects per-call model/effort overrides into adapter plans (PLAN-L7-255)", () => {
    const fake = withFakeProviderEnv("codex");
    try {
      const run = runCliIn(
        repoRoot,
        [
          "codex",
          "--role",
          "reviewer",
          "--task",
          "mechanical ledger check",
          "--model",
          "gpt-5.3-codex-spark",
        ],
        fake.env,
      );
      const payload = parseCliJson(run);
      expect(payload.dry_run).toBe(true);
      expect(payload.model).toBe("gpt-5.3-codex-spark");
      // PLAN-L7-255: effort 未指定でも routing が ladder 既定 (spark=high) を解決して注入する
      expect(payload.args).toEqual([
        "exec",
        "-m",
        "gpt-5.3-codex-spark",
        "-c",
        "model_reasoning_effort=high",
        "-",
      ]);
    } finally {
      removeTestTree(fake.binDir);
    }
  }, 20_000);

  it("keeps claude runtime command dry-run registered through delegation helper", () => {
    const fake = withFakeProviderEnv("claude");
    try {
      const run = runCliIn(
        repoRoot,
        [
          "claude",
          "--role",
          "reviewer",
          "--task",
          "mechanical ledger check",
          "--model",
          "claude-opus-5",
          "--effort",
          "xhigh",
        ],
        fake.env,
      );
      const payload = parseCliJson(run);
      expect(payload).toMatchObject({
        provider: "claude",
        dry_run: true,
        model: "claude-opus-5",
        effort: "high",
      });
      expect(payload.args).toEqual([
        "--print",
        "--input-format",
        "text",
        "--model",
        "claude-opus-5",
        "--effort",
        "high",
      ]);
    } finally {
      removeTestTree(fake.binDir);
    }
  }, 20_000);

  it("passes plan skill injection through task route adapter plans", () => {
    const sourcePlan = join(
      repoRoot,
      "docs",
      "plans",
      "PLAN-L7-135-dynamic-skill-injection-materialization.md",
    );
    if (!existsSync(sourcePlan)) return;

    const run = runCli([
      "task",
      "route",
      "--role",
      "se",
      "--plan",
      sourcePlan,
      "--mode",
      "codex-only",
      "--execute",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload.adapterPlan.context_injection.required_paths.length).toBeGreaterThan(0);
    expect(payload.adapterPlan.stdin).toContain("UT-TDD context injection:");
  }, 20_000);

  it("keeps proposal advisory lanes aligned with executable task routing", () => {
    const classify = runCli([
      "task",
      "classify",
      "--design-docs",
      "--json",
      "--text",
      "Rename a local docs helper and update README wording.",
    ]);
    const route = runCli([
      "task",
      "route",
      "--role",
      "se",
      "--primary",
      "codex",
      "--mode",
      "codex-only",
      "--json",
      "--text",
      "rename a field",
    ]);
    const classifyPayload = JSON.parse(classify.stdout);
    const routePayload = JSON.parse(route.stdout);

    expect(classify.status).toBe(0);
    expect(route.status).toBe(0);
    expect(classifyPayload.document_coverage.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "T2-mini",
          model: "gpt-5.4-mini",
          parallel_slots: 4,
          closing_authority: false,
          ownership: expect.stringContaining("disjoint"),
        }),
        expect.objectContaining({
          tier: "T2-spark",
          model: "gpt-5.3-codex-spark",
          parallel_slots: 3,
          closing_authority: false,
          ownership: expect.stringContaining("disjoint"),
        }),
      ]),
    );
    expect(routePayload.decision).toMatchObject({
      role: "se",
      tier: "T2",
      model: "gpt-5.3-codex-spark",
      status: "ready",
    });
    expect(routePayload.decision.model).not.toBe("gpt-5.4-mini");
  }, 20_000);

  it("exposes upper-model advisor dry-runs for lower orchestrator models", () => {
    const run = runCli([
      "advisor",
      "--task",
      "review whether the release gate is safe to close",
      "--current-model",
      "claude-sonnet-4-6",
      "--mode",
      "hybrid",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    // 設計判断 (review intent → design) は Fable 一次 + Sol fallback (PO ルーティング 2026-07-29)。
    expect(payload).toMatchObject({
      provider: "claude",
      model: MODEL_IDS.claude.fable,
      effort: "low",
      consultation_mode: "consult",
      decision_kind: "design",
      current_model_lower_than_advisor: true,
      adapterPlan: {
        provider: "claude",
        model: MODEL_IDS.claude.fable,
        dry_run: true,
      },
      fallback: {
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        consultation_mode: "consult",
      },
    });
    expect(payload.adapterPlan.stdin).toContain("upper-model advisor");
  }, 20_000);

  it("executes advisor through the selected upper Codex adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-advisor-exec-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const fakeCodex = writeFakeProvider(binDir, "codex");
      const currentPath = process.env.PATH ?? process.env.Path ?? "";
      const testPath = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
      const run = runCliIn(
        root,
        [
          "advisor",
          "--task",
          "advise on uncertain implementation close",
          "--provider",
          "codex",
          "--mode",
          "codex-only",
          "--execute",
          "--json",
        ],
        {
          ...process.env,
          PATH: testPath,
          Path: testPath,
          UT_TDD_CODEX_BIN: fakeCodex,
        },
      );
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("noisy-codex");
      expect(payload).toMatchObject({
        provider: "codex",
        model: MODEL_IDS.codex.frontier,
        effort: "low",
        adapterPlan: {
          provider: "codex",
          model: MODEL_IDS.codex.frontier,
          dry_run: false,
          executed: true,
          exit_code: 0,
        },
      });
      const codexEnv = readFileSync(join(root, "codex-env.txt"), "utf8");
      expect(codexEnv).toContain(MODEL_IDS.codex.frontier);
      expect(codexEnv).toContain("args=");
    } finally {
      removeTestTree(root);
    }
  }, 20_000);

  it("exposes builder catalog as a JSON command surface", () => {
    const run = runCli(["builder", "catalog", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.commands.map((row: { command: string }) => row.command)).toContain(
      "ut-tdd builder catalog",
    );
  });

  it("fails review command closed unless the current uncommitted scope is explicit", () => {
    const run = runCli(["review", "--json"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("review requires --uncommitted");
  });

  it("emits a non-destructive cutover dry-run plan", () => {
    const run = runCli(["cutover", "--to", "staging", "--dry-run", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      mode: "dry-run",
      to: "staging",
      humanApprovalRequired: true,
    });
    expect(payload.checks).toContain("node src\\cli.ts doctor");
  });

  it("refuses cutover apply without a human-approved runbook", () => {
    const run = runCli(["cutover", "--to", "staging", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      mode: "requires-human-approval",
      humanApprovalRequired: true,
    });
    expect(run.stderr).toContain("explicit human-approved runbook");
  });

  it("exposes clean distribution planning with preflight, rollback, and contract metadata", () => {
    const binDir = mkdtempSync(join(tmpdir(), "ut-tdd-cli-dist-"));
    const runtimeRoot = join(repoRoot, ".ut-tdd", "runtime");
    try {
      const compiled = Buffer.from("export default 0;\n", "utf8");
      const identity = {
        product_id: "distribution-fixture",
        consumer_root: repoRoot,
        runtime_root: runtimeRoot,
        operation_id: "distribution-fixture-readiness",
        attempt: 0,
        generation_id: "distribution-fixture-generation",
        subject_revision: "a".repeat(40),
        artifact_digest: `sha256:${"b".repeat(64)}`,
        node_executable_identity: `node-${process.version}|sha256:${"c".repeat(64)}`,
        package_lock_digest: `sha256:${"d".repeat(64)}`,
        source_graph_digest: `sha256:${"e".repeat(64)}`,
        compiled_esm_digest: digestConsumerRuntimeBytes(compiled),
        release_id: `rel-sha256:${"f".repeat(64)}`,
        materializer_version: "fixture",
        artifact_set_digest: `sha256:${"1".repeat(64)}`,
        control_manifest_digest: `sha256:${"2".repeat(64)}`,
        sealed_policy: "compiled-esm-only" as const,
      };
      const payloads = buildConsumerNodeRuntimePayloads({
        identity,
        compiled_esm: compiled,
        node_bootstrap_receipt: Buffer.from("{}\n", "utf8"),
      });
      const bundle = buildConsumerNodeRuntimeBundle({ identity, ...payloads });
      mkdirSync(bundle.bundle_path, { recursive: true });
      writeFileSync(
        join(bundle.bundle_path, "bundle-manifest.json"),
        `${JSON.stringify(bundle)}\n`,
        "utf8",
      );
      mkdirSync(join(runtimeRoot, "activation"), { recursive: true });
      writeFileSync(
        join(runtimeRoot, "activation", "active.json"),
        JSON.stringify({
          bundle_path: bundle.bundle_path,
          bundle_digest: bundle.bundle_digest,
        }),
        "utf8",
      );
      const fakeCodex = writeFakeProvider(binDir, "codex");
      writeFakeUtTdd(binDir);
      const run = runCliIn(repoRoot, ["distribution", "plan", "--tag", "v0.1.0", "--json"], {
        ...process.env,
        UT_TDD_CODEX_BIN: fakeCodex,
        UT_TDD_TEST_PROVIDER_OUTPUT_DIR: binDir,
        PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      });
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        actualCutRequiresPoApproval: true,
        export: {
          ok: true,
          channel: "clean-repo-plus-tarball",
          sourceTag: "v0.1.0",
          cleanRepo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
        },
        readiness: {
          ok: true,
        },
      });
      expect(payload.export.artifactPaths).toContain("LICENSE");
      expect(payload.export.artifactPaths).not.toContain(
        "docs/plans/PLAN-L7-157-distribution-clean-pull.md",
      );
      expect(payload.readiness.rollback.managedPaths).toContain("AGENTS.md");
      expect(payload.readiness.contracts.tagPin).toBe(
        "github:unison-ai-product/UT-TDD_AGENT-HARNESS-Pack#v0.1.0",
      );
      expect(payload.readiness.contracts.tagPin).toContain("#v0.1.0");
      expect(payload.readiness.ci.forkPullRequestSecrets).toBe("not-required");
      expect(readFileSync(join(binDir, "codex-env.txt"), "utf8")).toContain("args=");
    } finally {
      removeTestTree(binDir);
      removeTestTree(runtimeRoot);
    }
  }, 20_000);

  it("creates a local clean distribution tarball and checksum without publishing", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-package-out-"));
    try {
      const run = runCliIn(repoRoot, [
        "distribution",
        "package",
        "--tag",
        "v0.1.0",
        "--out",
        outDir,
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        actualPublishRequiresPoApproval: true,
        export: {
          ok: true,
          sourceTag: "v0.1.0",
        },
      });
      // PLAN-L7-413 D-4c: unsigned tarball 契約へ整合 — signature 系 field は payload から
      // 撤去済み (宣言と実装の一致)。tarball + checksum + manifest のみが成果物。
      expect(payload.artifacts.signature).toBeUndefined();
      expect(existsSync(payload.artifacts.tarball)).toBe(true);
      expect(existsSync(payload.artifacts.checksum)).toBe(true);
      expect(existsSync(payload.artifacts.manifest)).toBe(true);
      expect(readFileSync(payload.artifacts.checksum, "utf8")).toContain("v0.1.0.tar.gz");
      const manifest = JSON.parse(readFileSync(payload.artifacts.manifest, "utf8"));
      expect(manifest.artifactCount).toBeGreaterThan(100);
    } finally {
      removeTestTree(outDir);
    }
  }, 30_000);

  it("exposes a non-destructive Pack repository sync plan", () => {
    const run = runCliIn(repoRoot, [
      "distribution",
      "sync-plan",
      "--tag",
      "v0.1.0",
      "--staging-dir",
      "tmp-pack-stage",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      actualRemoteMutationRequiresPoApproval: true,
      sync: {
        mode: "non-destructive-sync-plan",
        cleanRepo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
        sourceTag: "v0.1.0",
        branch: "main",
        publishRequiresPoApproval: true,
        destructiveRemoteMutation: false,
      },
    });
    expect(payload.sync.copyPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactPath: "skills/SKILL_MAP.md",
        }),
      ]),
    );
    expect(
      payload.sync.copyPlan.map((entry: { artifactPath: string }) => entry.artifactPath),
    ).not.toContain("docs/plans/PLAN-L7-157-distribution-clean-pull.md");
    expect(payload.sync.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "git clone https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack.git",
        ),
        expect.stringContaining("git -C "),
        expect.stringContaining("push origin main --follow-tags"),
      ]),
    );
  });

  it("U-DOCSECRET-006: materializes clean Pack artifacts into a local staging directory without publishing", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ut-tdd-pack-stage-"));
    try {
      const run = runCliIn(repoRoot, [
        "distribution",
        "sync-stage",
        "--tag",
        "v0.1.0",
        "--out",
        outDir,
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        stage: {
          outDir,
          destructiveRemoteMutation: false,
          actualRemoteMutationRequiresPoApproval: true,
          unmanagedExistingPaths: [],
          copyError: null,
        },
      });
      expect(existsSync(join(outDir, "skills", "SKILL_MAP.md"))).toBe(true);
      expect(existsSync(join(outDir, "docs", "templates", "adapter", "AGENTS.md"))).toBe(true);
      expect(existsSync(join(outDir, "docs", "templates", "adapter", ".codex", "hooks.json"))).toBe(
        true,
      );
      expect(
        existsSync(join(outDir, "docs", "plans", "PLAN-L7-157-distribution-clean-pull.md")),
      ).toBe(false);
      expect(existsSync(join(outDir, ".ut-tdd", "harness.db"))).toBe(false);
      expect(existsSync(payload.stage.manifest)).toBe(true);
      const manifest = JSON.parse(readFileSync(payload.stage.manifest, "utf8"));
      expect(manifest.stage.copiedArtifacts).toBeGreaterThan(100);
    } finally {
      removeTestTree(outDir);
    }
  }, 30_000);

  it("U-DOCSECRET-006: updates a local Pack checkout and prunes non-Pack files only when requested", () => {
    const packDir = mkdtempSync(join(tmpdir(), "ut-tdd-pack-repo-"));
    let manifest: string | null = null;
    try {
      const stalePlan = join(packDir, "docs", "plans", "PLAN-L7-157-distribution-clean-pull.md");
      mkdirSync(join(packDir, "docs", "plans"), { recursive: true });
      writeFileSync(stalePlan, "dogfood plan should not ship\n", "utf8");

      const blocked = runCliIn(repoRoot, [
        "distribution",
        "sync-pack",
        "--tag",
        "v0.1.0",
        "--repo-dir",
        packDir,
        "--json",
      ]);
      const blockedPayload = JSON.parse(blocked.stdout);
      manifest = blockedPayload.pack.manifest;

      expect(blocked.status, blocked.stderr || blocked.stdout).toBe(1);
      expect(blockedPayload).toMatchObject({
        ok: false,
        secretScan: {
          ok: true,
        },
        pack: {
          repoDir: packDir,
          repoExists: true,
          pruneLocal: false,
          unmanagedExistingPaths: ["docs/plans/PLAN-L7-157-distribution-clean-pull.md"],
          localGitMutationExecuted: false,
          destructiveRemoteMutation: false,
          actualRemoteMutationRequiresPoApproval: true,
        },
      });
      expect(existsSync(stalePlan)).toBe(true);

      const pruned = runCliIn(repoRoot, [
        "distribution",
        "sync-pack",
        "--tag",
        "v0.1.0",
        "--repo-dir",
        packDir,
        "--prune-local",
        "--json",
      ]);
      const prunedPayload = JSON.parse(pruned.stdout);
      manifest = prunedPayload.pack.manifest;

      expect(pruned.status, pruned.stderr || pruned.stdout).toBe(0);
      expect(prunedPayload).toMatchObject({
        ok: true,
        secretScan: {
          ok: true,
        },
        pack: {
          repoDir: packDir,
          repoExists: true,
          pruneLocal: true,
          prunedPaths: ["docs/plans/PLAN-L7-157-distribution-clean-pull.md"],
          unmanagedExistingPaths: [],
          localGitMutationExecuted: false,
          destructiveRemoteMutation: false,
          actualRemoteMutationRequiresPoApproval: true,
        },
      });
      expect(existsSync(join(packDir, "skills", "SKILL_MAP.md"))).toBe(true);
      expect(existsSync(stalePlan)).toBe(false);
      expect(prunedPayload.pack.nextCommands).toEqual(
        expect.arrayContaining([
          expect.stringContaining("git -C "),
          expect.stringContaining(" add -- "),
          expect.stringContaining('"src/cli.ts"'),
          expect.stringContaining('commit -m "chore: sync clean pack v0.1.0"'),
          expect.stringContaining("push origin main"),
        ]),
      );
      expect(prunedPayload.pack.nextCommands.join("\n")).not.toContain("git add --all");
      expect(prunedPayload.pack.nextCommands.join("\n")).not.toContain(" add --all");
    } finally {
      removeTestTree(packDir);
      if (manifest) rmSync(manifest, { force: true });
    }
  }, 40_000);

  it("exposes non-destructive release publication planning", () => {
    const run = runCliIn(repoRoot, [
      "distribution",
      "release-plan",
      "--tag",
      "v0.1.0",
      "--repo",
      "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      tag: "v0.1.0",
      repo: "unison-ai-product/UT-TDD_AGENT-HARNESS-Pack",
      externalPublishRequiresApproval: true,
    });
    expect(payload.commands).toContain("node src/cli.ts distribution package --tag v0.1.0");
    expect(payload.commands.join("\n")).not.toContain("bun ");
    expect(payload.commands.join("\n")).not.toContain(".sig");
    expect(payload.commands).toContain(
      "gh release create v0.1.0 .ut-tdd/release/v0.1.0.tar.gz .ut-tdd/release/v0.1.0.tar.gz.sha256 .ut-tdd/release/v0.1.0.manifest.json --repo unison-ai-product/UT-TDD_AGENT-HARNESS-Pack --verify-tag --notes-file .ut-tdd/release/v0.1.0.manifest.json",
    );
    expect(payload.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("git tag -a v0.1.0"),
        expect.stringContaining("gh release create v0.1.0"),
      ]),
    );
  });

  it("exposes GitHub branch-type guard as a JSON command surface", () => {
    const body = join(tmpdir(), `ut-tdd-pr-body-${Date.now()}.md`);
    const commits = join(tmpdir(), `ut-tdd-commits-${Date.now()}.txt`);
    writeFileSync(body, "## Summary\nPatch only.\n", "utf8");
    writeFileSync(commits, "fix: patch production regression\n", "utf8");
    try {
      const run = runCliIn(repoRoot, [
        "github",
        "guard",
        "--head-ref",
        "hotfix/prod-regression",
        "--base-ref",
        "main",
        "--pr-title",
        "fix: patch production regression",
        "--pr-body-file",
        body,
        "--commit-file",
        commits,
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(1);
      expect(payload.ok).toBe(false);
      expect(payload.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "hotfix-postmortem-missing" })]),
      );
    } finally {
      rmSync(body, { force: true });
      rmSync(commits, { force: true });
    }
  });

  it("rejects team setup when CODEOWNERS team slugs are omitted", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-tdd-setup-no-teams-"));
    try {
      const run = runCliIn(repo, ["setup", "--team", "--dry-run"]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("--tl-team / --qa-team / --po-team");
    } finally {
      removeTestTree(repo);
    }
  });

  it("requires setup ingress to carry an aggregate admission envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-setup-aggregate-envelope-"));
    const input = join(root, "consumer-runtime-input.json");
    try {
      writeFileSync(
        input,
        JSON.stringify({
          identity: {},
          admission_input: { plan: { entries: [] }, control_manifest_base64: "" },
          compiled_esm_base64: "",
          node_bootstrap_receipt_base64: "",
        }),
      );
      const run = runCliIn(root, ["setup", "--consumer-runtime-input", input]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("aggregate_input/final_tree/attestation");
      expect(readdirSync(root)).toEqual(["consumer-runtime-input.json"]);
    } finally {
      removeTestTree(root);
    }
  });

  it("accepts a production aggregate envelope through CLI setup admission", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-setup-aggregate-positive-"));
    const inputPath = join(root, "consumer-runtime-input.json");
    try {
      const content = Buffer.from("export default 0;\n", "utf8");
      const entry = { path: "src/entry.ts", mode: "100644" as const, content };
      const artifactSetDigest = digestMaterializedReleaseEntries([entry]);
      const sourceRevision = "a".repeat(40);
      const releaseId = deriveReleaseId("1", sourceRevision, artifactSetDigest);
      const publicationArtifacts = [
        {
          sourcePath: "releases/stable/entry.ts",
          destinationPath: entry.path,
          mode: entry.mode,
          size: content.length,
          contentDigest: digestConsumerRuntimeBytes(content),
        },
      ];
      const provisionalRelease = {
        materializerVersion: "1",
        artifactSourceCommit: sourceRevision,
        artifactSetDigest,
        artifactInventoryDigest: deriveArtifactInventoryDigest(publicationArtifacts),
        releaseAssetInventoryDigest: `sha256:${"0".repeat(64)}`,
        releaseRecordDigest: `sha256:${"0".repeat(64)}`,
        artifacts: publicationArtifacts,
      };
      const assets = derivePackPublicationAssets({
        release: { releaseId, ...provisionalRelease },
        entries: [
          {
            sourcePath: "releases/stable/entry.ts",
            destinationPath: entry.path,
            mode: entry.mode,
            size: content.length,
            contentDigest: digestConsumerRuntimeBytes(content),
            content,
          },
        ],
      });
      if (!assets.ok) throw new Error(assets.error);
      const release = {
        ...provisionalRelease,
        releaseAssetInventoryDigest: assets.value.releaseAssetInventoryDigest,
      };
      const manifest = {
        schema_version: "v2" as const,
        releases: {
          [releaseId]: { ...release, releaseRecordDigest: deriveReleaseRecordDigest(release) },
        },
        channels: { canary: releaseId, stable: releaseId },
        channelOrder: ["canary", "stable"],
      };
      const controlManifestBytes = Buffer.from(stringify(manifest), "utf8");
      const staging = buildPackPublicationStagingPlan({
        manifestInput: manifest,
        releaseId,
        controlManifestBytes,
        entries: [
          {
            sourcePath: "releases/stable/entry.ts",
            destinationPath: entry.path,
            mode: entry.mode,
            size: content.length,
            contentDigest: digestConsumerRuntimeBytes(content),
            content,
          },
        ],
      });
      if (!staging.ok) throw new Error(staging.error);
      const aggregateInput = {
        repository: "fixture-repository",
        channel: "stable",
        final_tree: {
          manifestEntries: [{ path: "release/manifest.yaml", value: manifest }],
          sourcePaths: ["releases/stable/entry.ts"],
          cleanPackAllowlist: ["release/manifest.yaml", entry.path],
          channelMappings: [
            {
              channel: "stable",
              releaseId,
              sourceRevision,
              sourcePath: "releases/stable/entry.ts",
              destinationPath: entry.path,
            },
          ],
        },
        attestation: {
          status: "attested",
          releaseId,
          artifactSourceCommit: sourceRevision,
          expectedDigest: artifactSetDigest,
          actualDigest: artifactSetDigest,
          entries: [
            { path: entry.path, mode: entry.mode, content_base64: content.toString("base64") },
          ],
        },
      };
      writeFileSync(
        inputPath,
        JSON.stringify({
          identity: { accepted: true },
          admission_input: {
            productId: "ut-tdd",
            consumerRoot: root,
            runtimeRoot: join(root, ".ut-tdd", "runtime"),
            manifest: {
              materializerVersion: "1",
              releaseId,
              sourceRevision,
              artifactSetDigest,
            },
            receipt: {
              materializerVersion: "1",
              releaseId,
              sourceRevision,
              artifactSetDigest,
              productId: "ut-tdd",
              consumerRoot: root,
              runtimeRoot: join(root, ".ut-tdd", "runtime"),
            },
            aggregate_input: aggregateInput,
            control_manifest_base64: controlManifestBytes.toString("base64"),
          },
          compiled_esm_base64: content.toString("base64"),
          node_bootstrap_receipt_base64: Buffer.from("{}\n", "utf8").toString("base64"),
        }),
      );
      const run = runCliIn(root, [
        "setup",
        "--solo",
        "--dry-run",
        "--consumer-runtime-input",
        inputPath,
      ]);
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stderr).not.toContain("consumer_runtime_aggregate_");
    } finally {
      removeTestTree(root);
    }
  });

  it("exposes telemetry scan as a JSON command surface without provider CLI execution", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-telemetry-"));
    try {
      const run = runCliIn(root, [
        "telemetry",
        "scan",
        "--claude-dir",
        join(root, "missing-claude"),
        "--codex-dir",
        join(root, "missing-codex"),
        "--json",
      ]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(payload).toMatchObject({
        totalRuns: 0,
        claudeRuns: 0,
        codexRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(payload.claudeDir).toBe(join(root, "missing-claude"));
      expect(payload.codexDir).toBe(join(root, "missing-codex"));
      expect(run.stderr).not.toContain("claude");
      expect(run.stderr).not.toContain("codex");
    } finally {
      removeTestTree(root);
    }
  });

  it("exposes quality audit as a JSON command surface", () => {
    const run = runCli(["audit", "quality", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toHaveProperty("byBucket");
    expect(payload.byBucket).toHaveProperty("gate");
    expect(payload).toHaveProperty("byCode");
  }, 20_000);

  it("exposes route eval --json as an alias for --format json", () => {
    const legacy = runCli(["route", "eval", "--signal", "reverse", "--format", "json"]);
    const alias = runCli(["route", "eval", "--signal", "reverse", "--json"]);

    expect(legacy.status).toBe(0);
    expect(alias.status).toBe(0);
    expect(JSON.parse(alias.stdout)).toEqual(JSON.parse(legacy.stdout));
  }, 20_000);

  it("exposes roster list and check as JSON command surfaces", () => {
    const list = runCli(["roster", "list", "--json"]);
    const listed = JSON.parse(list.stdout);
    const check = runCli(["roster", "check", "--json"]);
    const checked = JSON.parse(check.stdout);

    expect(list.status).toBe(0);
    expect(listed.ok).toBe(true);
    expect(listed.count).toBeGreaterThanOrEqual(14);
    expect(listed.entries.map((entry: { id: string }) => entry.id)).toContain("pmo-sonnet");

    expect(check.status).toBe(0);
    expect(checked.ok).toBe(true);
    expect(checked.missingFromRoster).toEqual([]);
    expect(checked.nameMismatches).toEqual([]);
    expect(checked.allowlistedPresent).toBe(20);
    expect(checked.nonAllowlisted).toEqual([]);
  }, 20_000);

  it("exposes branch audit as a read-only JSON command surface", () => {
    const run = runCli(["branch", "audit", "--json"]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toHaveProperty("byStatus");
    expect(payload.byStatus).toHaveProperty("delete-candidate");
    expect(Array.isArray(payload.rows)).toBe(true);
  }, 20_000);

  it("exposes team run as a shared Claude/Codex dry-run launch plan", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-team-"));
    try {
      const teamPath = join(root, "team.yaml");
      writeFileSync(
        teamPath,
        [
          "name: speed-team",
          "strategy: parallel",
          "max_parallel: 2",
          "members:",
          "  - role: se",
          "    engine: codex-se",
          "    task: implement slice A",
          "  - role: tl",
          "    engine: pmo-sonnet",
          "    task: review slice A",
          "",
        ].join("\n"),
      );

      const run = runCli(["team", "run", "--definition", teamPath, "--mode", "hybrid", "--json"]);
      const payload = JSON.parse(run.stdout);

      expect(run.status).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        team: "speed-team",
        strategy: "parallel",
        dry_run: true,
      });
      expect(payload.members.map((member: { provider: string }) => member.provider)).toEqual([
        "codex",
        "claude",
      ]);
      expect(
        payload.members.map((member: { adapter: { command: string } }) => member.adapter.command),
      ).toEqual(["codex", "claude"]);
    } finally {
      removeTestTree(root);
    }
  });

  it("exposes team suggest as a deterministic launch policy surface", () => {
    const run = runCli([
      "team",
      "suggest",
      "--task",
      "production security schema migration",
      "--mode",
      "hybrid",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      should_launch: true,
      mode: "hybrid",
      difficulty: "critical",
      trigger: "risk",
    });
    expect(
      payload.definition.members.map((member: { provider?: string; role: string }) => member.role),
    ).toEqual(["se", "tl", "qa"]);
  });

  it("exposes proposal document coverage lanes as a parallel team suggestion", () => {
    const run = runCli([
      "team",
      "suggest",
      "--task",
      "Rename a local docs helper and update README wording.",
      "--mode",
      "hybrid",
      "--design-docs",
      "--json",
    ]);
    const payload = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(payload).toMatchObject({
      should_launch: true,
      mode: "hybrid",
      trigger: "difficulty",
    });
    expect(payload.document_coverage.recommended_subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "T2-mini", parallel_slots: 4 }),
        expect.objectContaining({ tier: "T2-spark", parallel_slots: 3 }),
      ]),
    );
    expect(payload.definition).toMatchObject({
      name: "proposal-coverage-team",
      strategy: "parallel",
      max_parallel: 7,
    });
    expect(
      payload.definition.members.filter(
        (member: { model?: string }) => member.model === "gpt-5.4-mini",
      ),
    ).toHaveLength(4);
    expect(
      payload.definition.members.filter(
        (member: { model?: string }) => member.model === "gpt-5.3-codex-spark",
      ),
    ).toHaveLength(3);
    expect(
      payload.definition.members.some((member: { model?: string }) => member.model === "gpt-5.5"),
    ).toBe(false);
    expect(
      payload.definition.members.every((member: { ownership?: string }) => member.ownership),
    ).toBe(true);
  }, 20_000);

  it("executes team run through fake Claude/Codex adapters while keeping JSON machine-readable", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-team-exec-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const fakeCodex = writeFakeProvider(binDir, "codex");
      const fakeClaude = writeFakeProvider(binDir, "claude");
      const teamPath = join(root, "team.yaml");
      writeFileSync(
        teamPath,
        [
          "name: speed-team",
          "strategy: parallel",
          "max_parallel: 2",
          "members:",
          "  - role: se",
          "    engine: codex-se",
          "    task: implement slice A",
          "  - role: tl",
          "    engine: pmo-sonnet",
          "    task: review slice A",
          "",
        ].join("\n"),
      );

      const currentPath = process.env.PATH ?? process.env.Path ?? "";
      const testPath = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
      const env = {
        ...process.env,
        PATH: testPath,
        Path: testPath,
        UT_TDD_CODEX_BIN: fakeCodex,
        UT_TDD_CLAUDE_BIN: fakeClaude,
      };
      const run = runCliIn(
        root,
        ["team", "run", "--definition", teamPath, "--mode", "hybrid", "--execute", "--json"],
        env,
      );
      // parseCliJson は status/stdout の assert に stderr を添える — JSON が空のときも
      // 失敗原因 (CLI の stderr) が CI ログへ出る。
      const payload = parseCliJson(run);

      expect(run.stdout).not.toContain("noisy-codex");
      expect(run.stdout).not.toContain("noisy-claude");
      expect(payload).toMatchObject({
        ok: true,
        team: "speed-team",
        strategy: "parallel",
        dry_run: false,
      });
      expect(payload.executions.map((row: { status: string }) => row.status)).toEqual([
        "completed",
        "completed",
      ]);
      const slots = JSON.parse(
        readFileSync(join(root, ".ut-tdd", "state", "agent-slots.json"), "utf8"),
      );
      expect(slots).toHaveLength(2);
      expect(
        slots.every((slot: { slot_source: string }) => slot.slot_source === "team_runner"),
      ).toBe(true);
      expect(slots.every((slot: { released_at: string | null }) => slot.released_at !== null)).toBe(
        true,
      );
      expect(readFileSync(join(root, "codex-env.txt"), "utf8")).not.toContain("raw=1");
      expect(readFileSync(join(root, "codex-env.txt"), "utf8")).not.toContain(
        "reason=ut-tdd-runtime-adapter-wrapper",
      );
      expect(readFileSync(join(root, "claude-env.txt"), "utf8")).not.toContain("raw=1");
      // repo語彙 Opus/middle は Claude CLI 正式値 medium へ正規化される。
      expect(readFileSync(join(root, "claude-env.txt"), "utf8")).toContain("effort=medium");
    } finally {
      removeTestTree(root);
    }
  }, 20_000);

  it("executes codex adapter under --execute --json and reports dry_run:false honestly", () => {
    // 回帰: 旧実装は --execute --json で provider を起動せず dry_run:false の plan JSON だけ
    // 返していた (実行していないのに実行済みに見える機械判定の罠)。実行 + 正直な JSON を要求する。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-cli-adapter-exec-"));
    try {
      const binDir = join(root, "bin");
      mkdirSync(binDir);
      const fakeCodex = writeFakeProvider(binDir, "codex");
      const fakeClaude = writeFakeProvider(binDir, "claude");
      const currentPath = process.env.PATH ?? process.env.Path ?? "";
      const testPath = `${binDir}${process.platform === "win32" ? ";" : ":"}${currentPath}`;
      const env = {
        ...process.env,
        PATH: testPath,
        Path: testPath,
        UT_TDD_CODEX_BIN: fakeCodex,
        UT_TDD_CLAUDE_BIN: fakeClaude,
      };
      const run = runCliIn(
        root,
        ["codex", "--role", "se", "--task", "implement slice A", "--execute", "--json"],
        env,
      );

      // provider の stdout (noisy-codex) は fd2(stderr) へ逃がし、stdout は実行結果 JSON 専用に保つ。
      expect(run.stdout).not.toContain("noisy-codex");
      const payload = JSON.parse(run.stdout);
      expect(payload).toMatchObject({
        provider: "codex",
        executed: true,
        dry_run: false,
        exit_code: 0,
        // 正常終了は signal=null (signal 終了時のみ exit_code=null + signal 名が入る)。
        signal: null,
      });
      // provider が実際に起動した証跡 (env dump)。「実行せず JSON だけ」だと生成されない。
      expect(readFileSync(join(root, "codex-env.txt"), "utf8")).toContain("args=");
    } finally {
      removeTestTree(root);
    }
  }, 20_000);
});
