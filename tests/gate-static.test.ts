import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkG8IntegrationWorkflow,
  checkG9SystemWorkflow,
  checkG10UxWorkflow,
} from "../src/doctor/workflow-quality.ts";
import {
  analyzeLayerPairGate,
  evaluateStaticGate,
  readCoverageSummary,
} from "../src/gate/static.ts";
import type { PairDoc } from "../src/vmodel/lint.ts";

const cliPath = join(process.cwd(), "src", "cli.ts");

/**
 * RCDEV-037 実測 baseline: 066b842f1a3161f1cb67c3d383a28d76d9c36041 (G0 merge-base Git archive).
 * Issue #935 confirmed design-pair increment (exact HEAD 2e88e53ae35ca01ba1b633c3916a882e4f277219):
 * direct evaluateStaticGate measured G6 L6 total=32/confirmed=32, G7 pair-freeze=61, verification=60/60 confirmed.
 * 明示採取: node rcdev037-capture.mjs <baseline-root>
 * 採取 script (再生成は明示操作のみ、テスト内で期待値を再生成しない):
 * import { pathToFileURL } from 'node:url';
 * import { resolve, join } from 'node:path';
 * const root = resolve(process.argv[2]);
 * const { evaluateStaticGate } = await import(pathToFileURL(join(root, 'src/gate/static.ts')).href);
 * const workflow = await import(pathToFileURL(join(root, 'src/doctor/workflow-quality.ts')).href);
 * const normalize = (messages) => [...new Set(messages.map(message => message.replaceAll(root, '<repoRoot>').replaceAll(root.replaceAll('\\', '/'), '<repoRoot>')))].sort();
 * const results = [];
 * for (let i = 1; i <= 7; i++) {
 *   const result = evaluateStaticGate({gate: `G${i}`, repoRoot: root});
 *   results.push({gate: result.gate, passed: result.passed, applicable: result.applicable, messages: normalize(result.messages)});
 * }
 * for (const [gate, check] of [['G8', workflow.checkG8IntegrationWorkflow], ['G9', workflow.checkG9SystemWorkflow], ['G10', workflow.checkG10UxWorkflow]]) {
 *   const result = check(root);
 *   results.push({gate, ok: result.ok, messages: normalize(result.messages)});
 * }
 * process.stdout.write(JSON.stringify(results, null, 2));
 * 保存時の明示正規化: message の path separator を / に統一 (それ以外の値は実測のまま)。
 * G8-G10 は doctor API の raw ok/messages。m2 は PR-GR の所有。
 */
const HARNESS_GATE_BASELINE = [
  {
    gate: "G1",
    passed: true,
    applicable: true,
    messages: [
      "g1-pair - OK (L1 total=7, confirmed=7, placeholder=0, draft=0, orphans=0)",
      "g1-trace - OK (business=13, screens=15, p0Fr=19, l3Plans=3)",
    ],
  },
  {
    gate: "G2",
    passed: true,
    applicable: true,
    messages: ["g2-pair - OK (L2 total=6, confirmed=6, placeholder=0, draft=0, orphans=0)"],
  },
  {
    gate: "G3",
    passed: true,
    applicable: true,
    messages: [
      "g3-pair - OK (L3 total=4, confirmed=4, placeholder=0, draft=0, orphans=0)",
      "g3-trace - OK (frL1=51, l3Fr=26, ac=117, at=118, l1Nfr=15, l3Nfr=17)",
    ],
  },
  {
    gate: "G4",
    passed: true,
    applicable: true,
    messages: ["g4-pair - OK (L4 total=7, confirmed=7, placeholder=0, draft=0, orphans=0)"],
  },
  {
    gate: "G5",
    passed: true,
    applicable: true,
    messages: ["g5-pair - OK (L5 total=5, confirmed=5, placeholder=0, draft=0, orphans=0)"],
  },
  {
    gate: "G6",
    passed: true,
    applicable: true,
    messages: ["g6-pair - OK (L6 total=32, confirmed=32, placeholder=0, draft=0, orphans=0)"],
  },
  {
    gate: "G7",
    passed: false,
    applicable: true,
    messages: [
      "g7-coverage - violation: coverage summary not found (<repoRoot>/coverage/coverage-summary.json); run test coverage before G7",
      "g7-static - failed (G7 requires trace evidence and coverage >=80%)",
      "impl-plan-trace — OK (src 全件 PLAN generates / baseline に被覆、NEW orphan 0)",
      "oracle-test-trace — OK (宣言 oracle 全件 tests citation / baseline 被覆、test-label 逆向き citation 断線 0、宣言 provenance 重複 0)",
      "pair-freeze — OK (design⇔test-design 双方向 61 pair、孤児 0)",
      "verification — 実装検証サイクルゲート [L0-L7] (左腕+谷): ✅ base freeze 完了 (60/60 confirmed, L7 plans 9/9 confirmed, evidence 9/9, 孤児0) / active revisions 1/1 confirmed → 検証サイクル発火可",
    ],
  },
  {
    gate: "G8",
    ok: true,
    messages: [
      "g8-integration-workflow - OK (it_cases=140, manifests=2, selected_it=14, mandatory_it=14)",
    ],
  },
  {
    gate: "G9",
    ok: true,
    messages: [
      "g9-system-workflow - OK (st_cases=34, manifests=2, selected_st=28, mandatory_st=28)",
    ],
  },
  {
    gate: "G10",
    ok: true,
    messages: ["g10-ux-workflow - OK (uxv_cases=8, manifests=1, selected_uxv=5, mandatory_uxv=5)"],
  },
];

function normalizedHarnessMessages(messages: string[], root: string): string[] {
  return [
    ...new Set(
      messages.map((message) =>
        message.replaceAll("\\", "/").replaceAll(root.replaceAll("\\", "/"), "<repoRoot>"),
      ),
    ),
  ].sort();
}

it("U-RCDEV-037: preserves harness G1-G7 static and G8-G10 workflow baseline", () => {
  const root = process.cwd();
  const actual = [];
  for (let i = 1; i <= 7; i++) {
    const result = evaluateStaticGate({ gate: `G${i}`, repoRoot: root });
    actual.push({
      gate: result.gate,
      passed: result.passed,
      applicable: result.applicable,
      messages: normalizedHarnessMessages(result.messages, root),
    });
  }
  for (const [gate, check] of [
    ["G8", checkG8IntegrationWorkflow],
    ["G9", checkG9SystemWorkflow],
    ["G10", checkG10UxWorkflow],
  ] as const) {
    const result = check(root);
    actual.push({
      gate,
      ok: result.ok,
      messages: normalizedHarnessMessages(result.messages, root),
    });
  }
  expect(actual).toEqual(HARNESS_GATE_BASELINE);
});

function runCli(args: string[], cwd = process.cwd()) {
  // PLAN-L7-462 step 2: CLI 実発火 oracle は node 直 spawn (cmd.exe/bun 経由なし)。
  return spawnSync("node", [cliPath, ...args], { cwd, encoding: "utf8", windowsHide: true });
}

const doc = (
  path: string,
  layer: string,
  pairArtifact: string | null,
  status = "confirmed",
): PairDoc => ({ path, layer, pairArtifact, status });

describe("static gates", () => {
  it("wires G1 to deterministic pair + trace lint", () => {
    const result = evaluateStaticGate({ gate: "G1", repoRoot: process.cwd() });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("g1-pair");
    expect(result.messages.join("\n")).toContain("g1-trace");
  });

  it("wires G3 to deterministic pair + trace lint", () => {
    const result = evaluateStaticGate({ gate: "G3", repoRoot: process.cwd() });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("g3-pair");
    expect(result.messages.join("\n")).toContain("g3-trace");
  });

  it("wires G2/G4/G5/G6 to deterministic layer pair gates", () => {
    for (const gate of ["G2", "G4", "G5", "G6"]) {
      const result = evaluateStaticGate({ gate, repoRoot: process.cwd() });
      expect(result.applicable).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.messages.join("\n")).toContain(`${gate.toLowerCase()}-pair`);
    }
  });

  it("fails a layer pair gate when pair evidence is missing", () => {
    const result = analyzeLayerPairGate(
      [doc("docs/design/harness/L4-basic-design/function.md", "L4", null)],
      "G4",
      "L4",
    );
    expect(result.ok).toBe(false);
    expect(result.orphanPaths).toEqual(["docs/design/harness/L4-basic-design/function.md"]);
  });

  it("fails G2 when the wireframe mock lacks the L10 test-design pair wiring (RECOVERY-09)", () => {
    const result = analyzeLayerPairGate(
      [
        doc(
          "docs/design/harness/L2-screen/wireframe.md",
          "L2",
          "self", // 旧 self-pair 残骸は配線として認めない
          "placeholder",
        ),
      ],
      "G2",
      "L2",
    );
    expect(result.ok).toBe(false);
    expect(result.mockMissing).toBe(true);
  });

  it("fails G7 closed when coverage evidence is missing", () => {
    const missing = join(tmpdir(), `missing-${Date.now()}-coverage-summary.json`);
    const result = evaluateStaticGate({
      gate: "G7",
      repoRoot: process.cwd(),
      coverageSummaryPath: missing,
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("coverage summary not found");
  });

  it("fails unknown gates closed instead of passing an unregistered check", () => {
    const result = evaluateStaticGate({ gate: "G999", repoRoot: process.cwd() });

    expect(result.applicable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("no deterministic check registered");
  });

  it("allows known review-only gates to rely on the review tier", () => {
    for (const gate of ["G0.5", "R4"]) {
      const result = evaluateStaticGate({ gate, repoRoot: process.cwd() });

      expect(result.applicable).toBe(false);
      expect(result.passed).toBe(true);
      expect(result.messages.join("\n")).toContain("review-tier gate");
    }
  });

  it("U-GATE-005: fails closed when a deterministic static check cannot run", () => {
    const result = evaluateStaticGate({
      gate: "G1",
      repoRoot: join(tmpdir(), "missing-gate-root"),
    });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("deterministic check could not run");
  });

  it("U-GATE-006: reports invalid checklist YAML as a gate failure instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-checklist-"));
    try {
      const checklist = join(dir, "bad-review-checklist.yaml");
      writeFileSync(checklist, "items: [");

      const result = runCli(
        ["gate", "G4", "--mode", "codex-only", "--checklist", checklist, "--json"],
        dir,
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("review checklist - violation");
      expect(result.stdout).toContain('"passed": false');
      expect(result.stderr).not.toContain("error: script");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects coverage below the G7 threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-coverage-"));
    const summary = join(dir, "coverage-summary.json");
    writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 79.99 } } }));
    const result = readCoverageSummary(summary, 80);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("79.99% < 80%");
  });

  it("accepts coverage at the G7 threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-coverage-"));
    const summary = join(dir, "coverage-summary.json");
    writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 80 } } }));
    const result = readCoverageSummary(summary, 80);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("80% >= 80%");
  });

  it("keeps gate command docs aligned with static gate implementation", () => {
    const functionDoc = readFileSync(
      join(process.cwd(), "docs", "design", "harness", "L4-basic-design", "function.md"),
      "utf8",
    );
    const gateRow = functionDoc
      .split(/\r?\n/)
      .find((line) => line.includes("`ut-tdd gate <G-ID>`"));
    expect(gateRow).toContain("deterministic static gate");
    expect(gateRow).not.toContain("gate checks 全量は後続");
    expect(gateRow).not.toContain("部分実装");
  });
});
