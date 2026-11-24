/**
 * issue #1002 Red tests (登録 + Red) の正式 oracle ID 昇格段階。
 * 契約: docs/design/harness/L6-function-design/agent-guard-delegation-boundary.md
 * test-design: docs/test-design/harness/L7-agent-guard-delegation-boundary-test-design.md
 *
 * 実装 PR (L6 §11 の PR 2〜5) で `it.fails` を `it` に戻し、全件 Green。
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeReviewRequest,
  issueReviewRequest,
  projectReviewVerdict,
} from "../src/feedback/review-attestation.ts";
import {
  beginReviewAttempt,
  canonicalReviewRevision,
  hasTerminalReviewReceipt,
  type ReviewCustodyRequest,
} from "../src/feedback/review-verdict-custody.ts";
import { type AssetDriftInput, analyzeAssetDrift } from "../src/lint/asset-drift.ts";
import {
  analyzeHookParity,
  analyzeRuleDrift,
  loadClaudeHookSettings,
  loadRuleAdapterDocs,
} from "../src/lint/rule-drift.ts";
import { buildAdapterPlan } from "../src/runtime/adapter.ts";
import * as guard from "../src/runtime/agent-guard.ts";
import * as policy from "../src/runtime/agent-guard-policy.ts";
import {
  isReadOnlyDelegationRole,
  READ_ONLY_DELEGATION_ROLES,
} from "../src/runtime/review-guard.ts";
import { buildCleanDistributionPlan } from "../src/setup/distribution.ts";
import { planSetup } from "../src/setup/index.ts";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { classifyProposalDocumentCoverage } from "../src/task/classify.ts";
import {
  DELEGATION_ROLE_ALLOWLIST,
  REVIEW_GATE_ROLES,
  resolveDelegationRouting,
} from "../src/team/delegation-routing.ts";
import * as modelPolicy from "../src/team/model-policy.ts";
import { afterAll, beforeAll, describe, expect, heavyIt, it } from "./support/hook-bounds.ts";

// production 定数から独立させるため、旧ソース repo 名はテスト側で実行時に連結する (リテラル禁止)。
const legacySourceName = ["ai", "dev", "kit", "vscode"].join("-");

const root = process.cwd();

/** 目標契約でだけ存在する export を型検査に依存せず取り出す (未実装なら undefined)。 */
function exported(mod: object, name: string): unknown {
  return (mod as Record<string, unknown>)[name];
}

function genericTypes(): ReadonlySet<string> {
  const value = exported(policy, "GENERIC_SUBAGENT_TYPES");
  expect(value, "GENERIC_SUBAGENT_TYPES is exported from agent-guard-policy.ts").toBeInstanceOf(
    Set,
  );
  return value as ReadonlySet<string>;
}

const GENERIC = ["general-purpose", "Explore", "Plan", "claude"] as const;
const OLD_ALLOWLIST_20 = [
  "be-api",
  "be-logic",
  "db-schema",
  "devops-deploy",
  "pmo-sonnet",
  "pmo-haiku",
  "pmo-project-explorer",
  "pmo-project-scout",
  "pmo-tech-docs",
  "pmo-tech-fork",
  "pmo-tech-news",
  "refactor-scout",
  "pdm-tech-innovation",
  "pdm-marketing-innovation",
  "pdm-innovation-manager",
  "code-reviewer",
  "blind-reviewer",
  "security-audit",
  "qa-test",
  "ut-tdd-tl",
] as const;
const DROPPED_12 = [
  "pmo-sonnet",
  "pmo-haiku",
  "pmo-project-explorer",
  "pmo-project-scout",
  "pmo-tech-docs",
  "pmo-tech-fork",
  "pmo-tech-news",
  "pdm-tech-innovation",
  "pdm-marketing-innovation",
  "pdm-innovation-manager",
  "refactor-scout",
  "code-reviewer",
] as const;
const KEPT_8 = [
  "blind-reviewer",
  "ut-tdd-tl",
  "qa-test",
  "security-audit",
  "be-api",
  "be-logic",
  "db-schema",
  "devops-deploy",
] as const;
const GATE_ROLES = [
  "blind-reviewer",
  "reviewer",
  "ut-tdd-tl",
  "qa-test",
  "security-audit",
] as const;

/**
 * 目標契約の ctx は `{ allowRaw }` だけで、定義ファイルを読まない (§3.5)。現行実装は
 * `resolveAgentFamily` を要求するので、定義ファイルが「ある」ことを模す permissive な stub を渡す。
 * 目標実装は無視する (余分な property)。現行実装では旧 allowlist の型が素通りし、
 * 定義ファイルの存在が判定に漏れていることが assertion の失敗として現れる。
 */
function run(
  toolName: string | undefined,
  toolInput: Record<string, string> | undefined,
  allowRaw = false,
) {
  const input = {
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    tool_input: toolInput,
  };
  return guard.evaluateAgentGuard(
    input as never,
    { allowRaw, resolveAgentFamily: () => "sonnet" } as never,
  );
}

function sourceOf(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, suffix));
    else if (entry.name.endsWith(suffix)) out.push(abs);
  }
  return out;
}

function setEqual(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((x) => b.has(x));
}

describe("issue #1002 agent-guard と委譲の境界", () => {
  // ---- agent-guard (G3〜G6 / §3) ----

  it("U-AGBOUND-005: 旧 allowlist 20 名は閉じた許可集合の外として BLOCK される", () => {
    for (const type of OLD_ALLOWLIST_20) {
      const result = run("Agent", { subagent_type: type, model: "sonnet" });
      expect(result.code, type).toBe(2);
      for (const generic of GENERIC) expect(result.message, type).toContain(generic);
    }
  });

  it("U-AGBOUND-006: 型の比較は完全一致 (大小文字を畳まず、未知・実環境の型を通さず、trim だけする)", () => {
    for (const type of [
      "explore",
      "General-Purpose",
      "foo",
      "claude-code-guide",
      "statusline-setup",
    ]) {
      expect(run("Agent", { subagent_type: type, model: "sonnet" }).code, type).toBe(2);
    }
    expect(run("Agent", { subagent_type: " Plan ", model: "sonnet" }).code).toBe(0);
  });

  it("U-AGBOUND-009: Agent tool では型によらず fable を使えない", () => {
    for (const type of GENERIC) {
      for (const model of ["fable", "claude-fable-5-2"]) {
        const result = run("Agent", { subagent_type: type, model });
        expect(result.code, `${type}/${model}`).toBe(2);
        expect(result.message, `${type}/${model}`).toMatch(/Agent tool.*fable/);
      }
    }
    // 旧 quality-check の名前は G3 で止まり、fable を理由にする経路は残らない。
    const legacy = run("Agent", { subagent_type: "blind-reviewer", model: "fable" });
    expect(legacy.code).toBe(2);
    expect(legacy.message).toContain("general-purpose");
  });

  it("U-AGBOUND-011: 判定の根拠は G3→G4→G5→G6 の順で 1 つに決まる", () => {
    const unknownNoModel = run("Agent", { subagent_type: "foo" });
    expect(unknownNoModel.code).toBe(2);
    expect(unknownNoModel.message).toContain("general-purpose");
    expect(unknownNoModel.message).not.toMatch(/missing model/);

    const genericFable = run("Agent", { subagent_type: "general-purpose", model: "fable" });
    expect(genericFable.code).toBe(2);
    expect(genericFable.message).toMatch(/Agent tool.*fable/);

    const unknownFable = run("Agent", { subagent_type: "foo", model: "fable" });
    expect(unknownFable.code).toBe(2);
    expect(unknownFable.message).toContain("general-purpose");
    expect(unknownFable.message).not.toMatch(/fable を使えない/);
  });

  it("U-AGBOUND-012: bypass は G3〜G6 の全てに効き、通常の通過には印を付けない", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["(a) 未知の型", { subagent_type: "foo", model: "sonnet" }],
      ["(b) model 無し", { subagent_type: "general-purpose" }],
      ["(c) 正規化不能", { subagent_type: "general-purpose", model: "unknown-model" }],
      ["(d) fable", { subagent_type: "general-purpose", model: "fable" }],
    ];
    for (const [label, input] of cases) {
      const result = run("Agent", input, true);
      expect(result.code, label).toBe(0);
      expect(result.bypassed, label).toBe(true);
      expect(result.message, label).toMatch(/^\[ut-tdd-guard\] WARN/);
    }
    const normal = run("Agent", { subagent_type: "general-purpose", model: "sonnet" }, true);
    expect(normal.code).toBe(0);
    expect(normal.bypassed).toBeUndefined();
  });

  it("U-AGBOUND-013: agent-guard は定義ファイルを読まず floor の残骸も持たない", () => {
    const files = ["src/runtime/agent-guard.ts", ".claude/hooks/agent-guard.ts", "src/cli.ts"];
    const banned = [
      "resolveAgentFamily",
      "resolveAgentFamilyFromRepo",
      "ResolvedFamily",
      "FAMILY_RANK",
      "FABLE_QUALITY_CHECK_SUBAGENTS",
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = sourceOf(file);
      for (const word of banned) if (text.includes(word)) hits.push(`${file}:${word}`);
    }
    expect(hits).toEqual([]);
    expect(sourceOf("src/runtime/agent-guard.ts")).not.toMatch(/from\s+["']node:fs["']/);
  });

  it("U-AGBOUND-014: GENERIC_SUBAGENT_TYPES はちょうど汎用の型 4 種", () => {
    expect(setEqual(genericTypes(), GENERIC)).toBe(true);
  });

  it("U-AGBOUND-015: .claude/CLAUDE.md の型の一覧は GENERIC_SUBAGENT_TYPES と機械照合される", () => {
    const text = sourceOf(".claude/CLAUDE.md");
    const section = text.match(/^Allowlist:\n\n((?:- `[^`]+`\n)+)/m);
    expect(section, "Allowlist bullet section in .claude/CLAUDE.md").not.toBeNull();
    const documented = [...(section as RegExpMatchArray)[1].matchAll(/- `([^`]+)`/g)].map(
      (m) => m[1],
    );
    const generic = genericTypes();
    expect(setEqual(documented, generic)).toBe(true);
    // 負例: 項目を 1 つ足した版・1 つ減らした版は不一致になる。
    expect(setEqual([...documented, "extra-type"], generic)).toBe(false);
    expect(setEqual(documented.slice(1), generic)).toBe(false);
  });

  // ---- hook shim (§3.6) ----

  describe("hook shim は定義ファイルの有無に依存しない", () => {
    let repo = "";
    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "agbound-016-"));
      mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
      cpSync(
        join(root, ".claude", "hooks", "agent-guard.ts"),
        join(repo, ".claude", "hooks", "agent-guard.ts"),
      );
      cpSync(join(root, "src"), join(repo, "src"), { recursive: true });
      cpSync(join(root, "node_modules", "zod"), join(repo, "node_modules", "zod"), {
        recursive: true,
      });
      writeFileSync(join(repo, "package.json"), '{"type":"module"}\n', "utf8");
    });
    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });
    const shim = (stdin: string) =>
      spawnSync(process.execPath, [join(repo, ".claude", "hooks", "agent-guard.ts")], {
        input: stdin,
        encoding: "utf8",
        cwd: repo,
        env: { ...process.env, UT_TDD_ALLOW_RAW_AGENT: "" },
      });

    it("U-AGBOUND-016: 定義ファイルが無い repo でも汎用の型は通り、旧 allowlist の型は定義があっても BLOCK", () => {
      expect(
        shim(
          JSON.stringify({
            tool_name: "Agent",
            tool_input: { subagent_type: "general-purpose", model: "sonnet" },
          }),
        ).status,
      ).toBe(0);
      const old = {
        tool_name: "Agent",
        tool_input: { subagent_type: "pmo-sonnet", model: "sonnet" },
      };
      expect(shim(JSON.stringify(old)).status).toBe(2);
      // 定義ファイルを置いても判定は変わらない (定義の有無で結果が動かない)。
      mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
      writeFileSync(
        join(repo, ".claude", "agents", "pmo-sonnet.md"),
        "---\nmodel: sonnet\n---\n",
        "utf8",
      );
      try {
        expect(shim(JSON.stringify(old)).status).toBe(2);
      } finally {
        rmSync(join(repo, ".claude", "agents"), { recursive: true, force: true });
      }
      expect(shim("{ broken").status).toBe(2);
      expect(shim("").status).toBe(2);
    });
  });

  // ---- 委譲 role (§4〜§6) ----

  it("U-AGBOUND-018: DELEGATION_ROLE_ALLOWLIST は SUBAGENT_ALLOWLIST に依存しない和集合と等しい", () => {
    const expected = new Set<string>([
      ...READ_ONLY_DELEGATION_ROLES,
      "ut-tdd-tl",
      "qa-test",
      "security-audit",
      "se",
      "po",
      "pm",
      "docs",
      "advisor",
      "tl-advisor",
      ...policy.CODEX_WORKSPACE_WRITE_ROLES,
    ]);
    expect(setEqual(DELEGATION_ROLE_ALLOWLIST, expected)).toBe(true);
    for (const name of DROPPED_12) {
      expect(DELEGATION_ROLE_ALLOWLIST.has(name), name).toBe(false);
    }
  });

  it("U-AGBOUND-019: 外す 12 名は fail-close、残る 8 名は通る", () => {
    for (const role of DROPPED_12) {
      const result = resolveDelegationRouting({ provider: "claude", role, task: "t" });
      expect(result.ok, role).toBe(false);
      if (!result.ok) expect(result.message, role).toContain("Allowed:");
    }
    for (const role of KEPT_8) {
      expect(resolveDelegationRouting({ provider: "claude", role, task: "t" }).ok, role).toBe(true);
    }
  });

  it("U-AGBOUND-021: 層の語彙は混ざらず、許可集合は GENERIC_SUBAGENT_TYPES と交わらない", () => {
    // 集合の等価 (過不足の両方を検出): REVIEW_GATE_ROLES = READ_ONLY ∪ {ut-tdd-tl, qa-test, security-audit}
    expect(
      setEqual(REVIEW_GATE_ROLES, [
        ...READ_ONLY_DELEGATION_ROLES,
        "ut-tdd-tl",
        "qa-test",
        "security-audit",
      ]),
    ).toBe(true);
    const generic = genericTypes();
    const normalized = [...DELEGATION_ROLE_ALLOWLIST].map((r) => r.trim().toLowerCase());
    const genericNormalized = new Set([...generic].map((r) => r.trim().toLowerCase()));
    expect(normalized.filter((r) => genericNormalized.has(r))).toEqual([]);
    for (const role of REVIEW_GATE_ROLES)
      expect(DELEGATION_ROLE_ALLOWLIST.has(role), role).toBe(true);
    for (const role of policy.CODEX_WORKSPACE_WRITE_ROLES) {
      expect(DELEGATION_ROLE_ALLOWLIST.has(role), role).toBe(true);
    }
  });

  it("U-AGBOUND-022: 外した role は read-only 契約の対象に残らない", () => {
    expect(isReadOnlyDelegationRole("code-reviewer")).toBe(false);
    for (const role of ["code-review", "blind-reviewer", "reviewer"]) {
      expect(isReadOnlyDelegationRole(role), role).toBe(true);
    }
  });

  it("U-AGBOUND-023: sandbox 権限の role は 6 つに固定され、判断ゲートには与えない", () => {
    expect(
      setEqual(policy.CODEX_WORKSPACE_WRITE_ROLES, [
        "se",
        "docs",
        "be-api",
        "be-logic",
        "db-schema",
        "devops-deploy",
      ]),
    ).toBe(true);
    const argvOf = (role: string) =>
      buildAdapterPlan(
        { provider: "codex", role, task: "t", model: "gpt-6-luna", effort: "high" },
        "hybrid",
      ).args;
    expect(argvOf("be-api")).toContain("workspace-write");
    expect(argvOf("se")).toContain("workspace-write");
    expect(argvOf("qa-test")).not.toContain("workspace-write");
    // 撤廃した role は routing の段階で拒否される。
    expect(resolveDelegationRouting({ provider: "codex", role: "pmo-sonnet", task: "t" }).ok).toBe(
      false,
    );
  });

  it("U-AGBOUND-024: floor の正本は 1 か所で、allowlist への依存は残らない", () => {
    const routing = sourceOf("src/team/delegation-routing.ts");
    const agentGuard = sourceOf("src/runtime/agent-guard.ts");
    expect(routing).not.toContain("SUBAGENT_ALLOWLIST");
    expect(routing.match(/(?:const|let)\s+REVIEW_GATE_ROLES\b/g) ?? []).toHaveLength(1);
    expect(agentGuard).not.toContain("REVIEW_GATE_ROLES");
    expect(agentGuard).not.toMatch(/rank/i);
  });

  // ---- 周辺 (§8) ----

  it("U-AGBOUND-025: asset-drift は agent 定義を照合せず、残すべき検査は残る", () => {
    const skill = { path: "skills/a.md", type: "skill" as const, id: "a", text: "clean" };
    const base = { assets: [skill], skillRootExists: true, skillDocCount: 1, enrolledRootCount: 1 };
    const noAllowlist = (extra: AssetDriftInput["assets"] = []) =>
      ({ ...base, assets: [skill, ...extra] }) as unknown as AssetDriftInput;
    const kinds = (input: AssetDriftInput) =>
      analyzeAssetDrift(input).violations.map((v) => v.kind);

    expect(kinds(noAllowlist())).toEqual([]);
    const agent = { path: ".claude/agents/foo.md", type: "agent" as const, id: "foo", text: "x" };
    const inert = analyzeAssetDrift(noAllowlist([agent]));
    expect(inert.violations).toEqual([]);
    expect(inert.ok).toBe(true);
    const residue = analyzeAssetDrift(
      noAllowlist([
        { path: "skills/b.md", type: "skill", id: "b", text: `see ${legacySourceName}` },
      ]),
    );
    expect(residue.ok).toBe(false);
    expect(residue.violations.map((v) => v.kind)).toContain("legacy-source-path-residue");
  });

  heavyIt("U-AGBOUND-026: roster CLI と registry は撤廃される", ["db", 120_000], async () => {
    for (const sub of ["list", "check"]) {
      const result = spawnSync(process.execPath, [join(root, "src", "cli.ts"), "roster", sub], {
        encoding: "utf8",
        cwd: root,
      });
      expect(result.status, `roster ${sub}`).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`, `roster ${sub}`).toMatch(/unknown command/i);
    }
    const catalog = await import("../src/assets/catalog.ts");
    expect(exported(catalog, "listRosterRegistry")).toBeUndefined();
    expect(exported(catalog, "checkRosterConsistency")).toBeUndefined();
    expect(sourceOf("src/assets/catalog.ts")).not.toContain(".claude/agents");
  });

  it("U-AGBOUND-027: setup と同梱 template は agent 定義を生成せず、文言に allowlist を残さない", () => {
    const plan = planSetup("0-A", { dryRun: true });
    expect(
      plan.files
        .map((f) => f.path.replaceAll("\\", "/"))
        .filter((p) => p.startsWith(".claude/agents/")),
    ).toEqual([]);
    expect(
      Object.keys(BUILTIN_GITHUB_TEMPLATES).filter((k) => k.startsWith("adapter/.claude/agents/")),
    ).toEqual([]);
    expect(existsSync(join(root, "docs", "templates", "adapter", ".claude", "agents"))).toBe(false);
    for (const key of ["adapter/.claude/settings.json", "adapter/.codex/hooks.json"]) {
      const messages = [
        ...(BUILTIN_GITHUB_TEMPLATES[key] ?? "").matchAll(/"statusMessage": "(agent-guard[^"]*)"/g),
      ].map((m) => m[1]);
      expect(messages.length, key).toBeGreaterThan(0);
      for (const message of messages) expect(message, key).not.toContain("allowlist");
    }
  });

  it("U-AGBOUND-028: Pack 配布物にも開発 repo にも agent 定義が残らない", () => {
    const tracked = spawnSync("git", ["ls-files"], {
      encoding: "utf8",
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    const paths = tracked.stdout.split(/\r?\n/).filter(Boolean);
    const plan = buildCleanDistributionPlan({ paths, sourceTag: "v0.0.0-test" });
    expect(plan.artifactPaths.filter((p) => p.includes(".claude/agents/"))).toEqual([]);
    expect(paths.filter((p) => /^\.claude\/agents\/.+\.md$/.test(p))).toEqual([]);
  });

  it("U-AGBOUND-029: 分類の出力は recommended_lanes で、レーンの role は委譲 role の語彙", () => {
    // worker 判定はレーンの tier (T0-frontier 以外) で行い、role 名を決め打ちしない。
    // fixture: se(T1-worker) の経路と uiux(T2-mini) の経路。docs は常に T2-mini。
    // qa(T1-worker) は discovery が G5 (= risky) のため classify.ts の現行経路では到達できない。
    const texts = [
      "design a new schema and implement the feature",
      "screen ui layout for the settings page",
      "screen ui layout with password authentication",
    ];
    const seenWorkerTiers = new Set<string>();
    for (const text of texts) {
      const record = classifyProposalDocumentCoverage({ text }) as unknown as Record<
        string,
        unknown
      >;
      expect(record.recommended_subagents).toBeUndefined();
      const lanes = record.recommended_lanes as
        | Array<{ role: string; tier: string; closing_authority: boolean }>
        | undefined;
      expect(Array.isArray(lanes), text).toBe(true);
      for (const lane of lanes ?? []) {
        expect(DELEGATION_ROLE_ALLOWLIST.has(lane.role), lane.role).toBe(true);
        if (lane.tier !== "T0-frontier") {
          seenWorkerTiers.add(lane.tier);
          expect(lane.closing_authority, `${lane.role}/${lane.tier}`).toBe(false);
        }
      }
    }
    expect([...seenWorkerTiers].sort()).toEqual(["T1-worker", "T2-mini"]);
  });

  it("U-AGBOUND-030: skills は撤廃済みの role を --role で案内しない", () => {
    const names = new Set<string>();
    for (const file of listFiles(join(root, "skills"), ".md")) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /ut-tdd\s+(?:claude|codex)\s+--role\s+([A-Za-z0-9_-]+)/g,
      ))
        names.add(m[1]);
    }
    expect([...names].filter((n) => !DELEGATION_ROLE_ALLOWLIST.has(n))).toEqual([]);
    expect([...names].filter((n) => (DROPPED_12 as readonly string[]).includes(n))).toEqual([]);
  });

  it("U-AGBOUND-031: SUBAGENT_ALLOWLIST は src/ から消え、実 repo の asset-drift は通る", async () => {
    const hits = listFiles(join(root, "src"), ".ts").filter((f) =>
      readFileSync(f, "utf8").includes("SUBAGENT_ALLOWLIST"),
    );
    expect(hits).toEqual([]);
    const { checkAssetDrift } = await import("../src/doctor/lint-gates.ts");
    expect(checkAssetDrift(root).ok).toBe(true);
  });

  // ---- floor (§5.1) ----

  it("U-AGBOUND-034: isReviewFloorModel は下限未満と未知を通さない", () => {
    const fn = exported(modelPolicy, "isReviewFloorModel");
    expect(typeof fn, "isReviewFloorModel is exported from model-policy.ts").toBe("function");
    const check = fn as (provider: string, model: string) => boolean;
    expect(check("claude", "claude-haiku-5-5")).toBe(false);
    expect(check("claude", "claude-sonnet-5-5")).toBe(false);
    expect(check("claude", "claude-opus-5-5")).toBe(true);
    expect(check("claude", "claude-fable-5-2")).toBe(true);
    expect(check("codex", "gpt-6-luna")).toBe(false);
    expect(check("codex", "gpt-6.1-sol")).toBe(true);
    expect(check("claude", "unknown-model")).toBe(false);
    expect(check("claude", "")).toBe(false);
  });

  it("U-AGBOUND-035: 判断ゲート role の明示 --model は下限未満なら fail-close", () => {
    const route = (provider: "claude" | "codex", role: string, model: string, effort?: string) =>
      resolveDelegationRouting({ provider, role, task: "t", model, ...(effort ? { effort } : {}) });
    for (const role of GATE_ROLES) {
      for (const [provider, model, effort] of [
        ["claude", "claude-sonnet-5-5", undefined],
        ["claude", "claude-haiku-5-5", undefined],
        ["codex", "gpt-6-luna", undefined],
        ["claude", "claude-sonnet-5-5", "high"],
      ] as const) {
        const result = route(provider, role, model, effort);
        expect(result.ok, `${role}/${provider}/${model}/${effort ?? "-"}`).toBe(false);
        if (!result.ok) {
          expect(result.message).toContain(role);
          expect(result.message).toContain(provider);
          expect(result.message).toContain(model);
          // 下限 model (L6 §5.1): claude は opus 級、codex は gpt-6.1-sol を示す。
          expect(result.message).toContain(
            provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
          );
        }
      }
      for (const [provider, model] of [
        ["claude", "claude-opus-5-5"],
        ["claude", "claude-fable-5-2"],
        ["codex", "gpt-6.1-sol"],
      ] as const) {
        const result = route(provider, role, model);
        expect(result.ok, `${role}/${model}`).toBe(true);
        if (result.ok) expect(result.model_source).toBe("explicit");
      }
    }
    expect(route("claude", "se", "claude-sonnet-5-5").ok).toBe(true);
  });

  describe("U-AGBOUND-036 review custody の入口", () => {
    const box = { dir: "" };
    beforeAll(() => {
      box.dir = mkdtempSync(join(tmpdir(), "agbound-036-"));
      execFileSync("git", ["init", "--quiet"], { cwd: box.dir, stdio: "ignore" });
    });
    afterAll(() => {
      if (box.dir) rmSync(box.dir, { recursive: true, force: true });
    });
    const requestFor = (authorFamily: "codex" | "claude", pr: number): ReviewCustodyRequest => {
      const base = { memoryId: `agbound-${pr}`, pr, exactHead: "a".repeat(40), authorFamily };
      return { ...base, reviewRevision: canonicalReviewRevision({ ...base, reviewRevision: "" }) };
    };

    it("U-AGBOUND-036: (e) agent-guard の返り値を verdict.txt に書いても projectReviewVerdict は verdict_identity_mismatch で拒否し、receipt を作らない", () => {
      const custodyRepo = mkdtempSync(join(tmpdir(), "agbound-036e-"));
      try {
        execFileSync("git", ["init", "--quiet"], { cwd: custodyRepo, stdio: "ignore" });
        const issued = issueReviewRequest({
          repoRoot: custodyRepo,
          request: canonicalizeReviewRequest({
            memoryId: "memory:agbound-036e",
            pr: 1002,
            exactHead: "a".repeat(40),
            reviewRevision: "legacy-revision",
            authorFamily: "codex",
            requestedAt: "2026-10-15T00:00:00.000Z",
          }),
          strict: true,
        });
        if (!issued.ok) throw new Error(issued.reason);
        const attempt = beginReviewAttempt({
          repoRoot: custodyRepo,
          request: issued.request,
          provider: "claude",
          model: "claude-opus-5-5",
        });
        if (!attempt.ok) throw new Error(attempt.reason);
        // agent-guard の実際の返り値 (verdict envelope を持たない guard 判定の形)。
        const decision = run("Agent", { subagent_type: "general-purpose", model: "sonnet" });
        writeFileSync(attempt.path, JSON.stringify(decision), "utf8");
        const result = projectReviewVerdict({
          repoRoot: custodyRepo,
          request: issued.request,
          attestation: {
            provider: "claude",
            role: "blind-reviewer",
            model: "claude-opus-5-5",
            pr: issued.request.pr,
            head: issued.request.exactHead,
            reviewRevision: issued.request.reviewRevision,
            startedAt: "2026-10-15T00:00:00.000Z",
            completedAt: "2026-10-15T00:01:00.000Z",
            exitCode: 0,
            attempt: attempt.attempt,
            invocationNonce: issued.request.invocationNonce,
          },
          verdictFile: attempt.path,
        });
        expect(result).toEqual({ ok: false, reason: "verdict_identity_mismatch" });
        expect(hasTerminalReviewReceipt(custodyRepo, issued.request)).toBe(false);
        expect(existsSync(join(custodyRepo, ".ut-tdd", "review", "receipts"))).toBe(false);
      } finally {
        rmSync(custodyRepo, { recursive: true, force: true });
      }
    });

    it("U-AGBOUND-036: 非著者 family でも下限未満の model は受理されず、receipt を作らない", () => {
      const attempt = (
        author: "codex" | "claude",
        provider: "codex" | "claude",
        model: string,
        pr: number,
      ) =>
        beginReviewAttempt({ repoRoot: box.dir, request: requestFor(author, pr), provider, model });
      expect(attempt("codex", "claude", "claude-opus-5-5", 1)).toMatchObject({ ok: true });
      expect(attempt("codex", "claude", "claude-sonnet-5-5", 2)).toEqual({
        ok: false,
        reason: "reviewer_model_below_floor",
      });
      expect(attempt("claude", "codex", "gpt-6-luna", 3)).toEqual({
        ok: false,
        reason: "reviewer_model_below_floor",
      });
      expect(attempt("codex", "codex", "gpt-6.1-sol", 4)).toEqual({
        ok: false,
        reason: "same_family_reviewer_denied",
      });
      expect(attempt("codex", "claude", "", 5)).toEqual({
        ok: false,
        reason: "invalid_attempt_outcome",
      });
      expect(existsSync(join(box.dir, ".ut-tdd", "review", "receipts"))).toBe(false);
    });
  });
});

describe("issue #1002 現行 main で既に成立する境界 (回帰 oracle)", () => {
  const AGENT_TOOLS = ["Agent", "Task", "spawn_agent", "spawn_agents_on_csv"];

  it("U-AGBOUND-001: G1 は tool_name 無し・空を code 2 にし bypass しない", () => {
    expect(run(undefined, {}).code).toBe(2);
    expect(run("", {}).code).toBe(2);
    const raw = run("", {}, true);
    expect(raw.code).toBe(2);
    expect(raw.bypassed).toBeUndefined();
  });

  it("U-AGBOUND-002: G2 は Agent 系以外の tool を検査しない", () => {
    for (const tool of ["Bash", "Edit", "Read"]) {
      const result = run(tool, { subagent_type: "foo" });
      expect(result.code, tool).toBe(0);
      expect(result.message, tool).toBeUndefined();
    }
  });

  it("U-AGBOUND-003: 4 tool x 汎用の型 4 種 + sonnet の 16 通りは通る", () => {
    for (const tool of AGENT_TOOLS)
      for (const type of GENERIC) {
        const result = run(tool, { subagent_type: type, model: "sonnet" });
        expect(result.code, `${tool}/${type}`).toBe(0);
        expect(result.bypassed, `${tool}/${type}`).toBeUndefined();
      }
  });

  it("U-AGBOUND-004: 型の解決は最初の非空 field、空は general-purpose 扱い", () => {
    expect(run("Agent", { model: "sonnet" }).code).toBe(0);
    expect(run("Agent", { subagent_type: "", role: "Plan", model: "sonnet" }).code).toBe(0);
    expect(run("Agent", { subagent_type: "Explore", role: "be-api", model: "sonnet" }).code).toBe(
      0,
    );
    expect(run("Agent", {}).code).toBe(2);
  });

  it("U-AGBOUND-007: G4 は全ての汎用の型で model 必須", () => {
    for (const type of GENERIC) {
      const result = run("Agent", { subagent_type: type });
      expect(result.code, type).toBe(2);
      expect(result.message, type).toContain("missing model");
    }
  });

  it("U-AGBOUND-008: G5 は正規化不能・曖昧な model を拒否し正規 ID を通す", () => {
    for (const model of ["gpt-6.1-sol", "sonnet opus", "unknown-model"])
      expect(run("Agent", { subagent_type: "general-purpose", model }).code, model).toBe(2);
    expect(
      run("Agent", { subagent_type: "general-purpose", model: "claude-sonnet-5-5" }).code,
    ).toBe(0);
  });

  it("U-AGBOUND-010: 汎用の型は haiku/sonnet/opus を全て通す (floor 無し)", () => {
    for (const type of GENERIC)
      for (const model of ["haiku", "sonnet", "opus"])
        expect(run("Agent", { subagent_type: type, model }).code, `${type}/${model}`).toBe(0);
  });

  describe("U-AGBOUND-017 発火記録", () => {
    const box = { repo: "" };
    beforeAll(() => {
      box.repo = mkdtempSync(join(tmpdir(), "agbound-017-"));
      mkdirSync(join(box.repo, ".claude", "hooks"), { recursive: true });
      cpSync(
        join(root, ".claude", "hooks", "agent-guard.ts"),
        join(box.repo, ".claude", "hooks", "agent-guard.ts"),
      );
      cpSync(join(root, "src"), join(box.repo, "src"), { recursive: true });
      cpSync(join(root, "node_modules", "zod"), join(box.repo, "node_modules", "zod"), {
        recursive: true,
      });
      writeFileSync(join(box.repo, "package.json"), '{"type":"module"}\n', "utf8");
    }, 120_000);
    afterAll(() => {
      if (box.repo) rmSync(box.repo, { recursive: true, force: true });
    });
    const shim = (value: unknown) =>
      spawnSync(process.execPath, [join(box.repo, ".claude", "hooks", "agent-guard.ts")], {
        input: JSON.stringify(value),
        encoding: "utf8",
        cwd: box.repo,
      });

    it("U-AGBOUND-017: 記録は code 0 かつ型が空でないときだけで、記録の失敗は判定を変えない", () => {
      const state = join(box.repo, ".ut-tdd");
      const pass = {
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", model: "sonnet" },
      };
      expect(shim(pass).status).toBe(0);
      expect(existsSync(state)).toBe(true);
      rmSync(state, { recursive: true, force: true });
      expect(shim({ tool_name: "Agent", tool_input: { model: "sonnet" } }).status).toBe(0);
      expect(existsSync(state)).toBe(false);
      expect(
        shim({ tool_name: "Agent", tool_input: { subagent_type: "foo", model: "fable" } }).status,
      ).toBe(2);
      expect(existsSync(state)).toBe(false);
      writeFileSync(state, "not a directory", "utf8");
      expect(shim(pass).status).toBe(0);
    });
  });

  it("U-AGBOUND-020: 判断ゲート role は族内 frontier tier の review-lane、worker は policy", () => {
    for (const role of GATE_ROLES)
      for (const provider of ["claude", "codex"] as const) {
        const result = resolveDelegationRouting({ provider, role, task: "t" });
        expect(result.ok, `${role}/${provider}`).toBe(true);
        if (result.ok && result.review_lane) {
          expect(result.model_source).toBe("review-lane");
          expect(result.model).toBe(modelPolicy.REVIEW_LANE_MODELS[result.review_lane][provider]);
        } else expect.fail(`${role}/${provider} has no review_lane`);
      }
    for (const role of ["se", "be-api"]) {
      const result = resolveDelegationRouting({ provider: "claude", role, task: "t" });
      expect(result.ok && result.model_source).toBe("policy");
    }
  });

  it("U-AGBOUND-032: evaluateAgentGuard の返り値は code/message/bypassed だけ", () => {
    const allowed = new Set(["code", "message", "bypassed"]);
    const cases: Array<[Record<string, string>, boolean]> = [
      [{ subagent_type: "general-purpose", model: "sonnet" }, false],
      [{ subagent_type: "foo", model: "sonnet" }, false],
      [{ subagent_type: "general-purpose" }, true],
    ];
    for (const [input, raw] of cases)
      for (const key of Object.keys(run("Agent", input, raw)))
        expect(allowed.has(key), key).toBe(true);
  });

  it("U-AGBOUND-033: rule-drift と §Hooks 一覧 ↔ settings.json の機械照合が通る", () => {
    const docs = loadRuleAdapterDocs(root);
    expect(analyzeRuleDrift(docs).ok).toBe(true);
    const parity = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime,
      settingsJson: loadClaudeHookSettings(root),
    });
    expect(parity.ok).toBe(true);
  });
});
