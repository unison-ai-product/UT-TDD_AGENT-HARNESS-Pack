import { afterEach, describe, expect, it, vi } from "vitest";

const readTrace = vi.hoisted(() => ({
  active: false,
  calls: [] as Array<{ api: "existsSync" | "readFileSync"; path: string }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const tracePath = (path: unknown): string =>
    typeof path === "string" || Buffer.isBuffer(path) ? String(path).replaceAll("\\", "/") : "";
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (readTrace.active) readTrace.calls.push({ api: "existsSync", path: tracePath(path) });
      return actual.existsSync(path);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (readTrace.active) readTrace.calls.push({ api: "readFileSync", path: tracePath(args[0]) });
      return actual.readFileSync(...args);
    },
  };
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDriveModelPassage,
  checkRuleAutomationClosure,
} from "../src/doctor/process-quality.ts";
import {
  analyzeDriveModelPassage,
  driveModelPassageMessages,
  loadDriveModelPassageDocs,
} from "../src/lint/drive-model-passage.ts";
import {
  analyzeRuleAutomationClosure,
  loadRuleAutomationClosureDocs,
  ruleAutomationClosureMessages,
} from "../src/lint/rule-automation-closure.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const L3_PATH = "docs/design/harness/L3-functional/upstream-schedule-reconciliation.md";
const PLAN_PATH = "docs/plans/PLAN-L3-04-upstream-schedule-reconciliation.md";
const PLAN_CONTENT = `# Previous English PLAN fixture

## Section 2.1 Drive-model Passage Certificate Required

| Drive model / entry mode | Required certificate columns |
|---|---|
| Discovery | trigger, Forward target, residual status |
| Scrum | feedback signal, Forward target, residual status |
| Reverse | R4 routing, re-entry gate, residual status |
| Recovery | correction artifact, Forward target, residual status |
| Incident | permanent-fix Forward route, residual status |
| Refactor | behavior-invariance proof, Forward target, residual status |
| Retrofit | migration plan, Forward target, residual status |
| Add-feature | parent PLAN, Forward target, residual status |
| Research | ADR, Forward target, residual status |
| Design-bottomup | backend-derived FE requirement evidence, Forward target, residual status |
| Version-up | version target, activation route, Forward target, residual status |

## Section 2.3 Rule Automation Closure Required

| Rule | Required automation owner | Current status |
|---|---|---|
| FR coverage | doctor + plan-lint | \`closed\` |
| Drive passage | analyzer + doctor | \`closed\` |
| Drive DB | projection writer + DB check | \`closed\` |
| Handover completion | handover guard + doctor | \`closed\` |
| Fail-close rows | table parser + lint | \`closed\` |
`;

const temporaryRoots: string[] = [];

function l3Content(): string {
  return readFileSync(join(headSnapshotRoot(), L3_PATH), "utf8");
}

function fixtureRoot(input: { l3?: string; plan?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "ut-upstream-schedule-"));
  temporaryRoots.push(root);
  if (input.l3 !== undefined) {
    const path = join(root, L3_PATH);
    mkdirSync(join(root, "docs", "design", "harness", "L3-functional"), { recursive: true });
    writeFileSync(path, input.l3, "utf8");
  }
  if (input.plan !== undefined) {
    const path = join(root, PLAN_PATH);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(path, input.plan, "utf8");
  }
  return root;
}

function observeLoader<T>(run: () => T): { value: T; calls: typeof readTrace.calls } {
  readTrace.calls = [];
  readTrace.active = true;
  try {
    return { value: run(), calls: [...readTrace.calls] };
  } finally {
    readTrace.active = false;
  }
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

function replaceExactlyOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
}

function driveMutationVariants(): Array<{
  name: string;
  content: string;
  reason: string;
  mode: string;
}> {
  const source = l3Content();
  return [
    {
      name: "missing_expected_mode",
      content: replaceExactlyOnce(source, "| Discovery |", "| Unregistered-mode |"),
      reason: "missing_expected_mode",
      mode: "Discovery",
    },
    {
      name: "missing_expected_mode_deleted",
      content: replaceExactlyOnce(
        source,
        "| Discovery | 起動条件、仮説、S3 検証証拠、S4 判断、Forward 対象、Reverse 昇格要件、残余状態 |\n",
        "",
      ),
      reason: "missing_expected_mode",
      mode: "Discovery",
    },
    {
      name: "missing_forward_target",
      content: replaceExactlyOnce(
        source,
        "S4 判断、Forward 対象、Reverse 昇格要件",
        "S4 判断、証跡確認、Reverse 昇格要件",
      ),
      reason: "missing_forward_target",
      mode: "Discovery",
    },
    {
      name: "missing_residual_status",
      content: replaceExactlyOnce(
        source,
        "Forward 対象、Reverse 昇格要件、残余状態 |",
        "Forward 対象、Reverse 昇格要件 |",
      ),
      reason: "missing_residual_status",
      mode: "Discovery",
    },
  ];
}

function closureMutationVariants(): Array<{
  name: string;
  content: string;
  reason: string;
  rule: string;
}> {
  const source = l3Content();
  return [
    {
      name: "unknown_owner",
      content: replaceExactlyOnce(
        source,
        "| 駆動モデル通過証明書 | 新規の解析器／チェッカーと doctor または plan-lint への配線 | `closed` |",
        "| 駆動モデル通過証明書 | 未登録担当Z | `closed` |",
      ),
      reason: "unknown_owner",
      rule: "駆動モデル通過証明書",
    },
    {
      name: "unknown_status",
      content: replaceExactlyOnce(
        source,
        "| 駆動モデルDB登録 | 投影 writer と `drive_runs` / `workflow_runs` / `hook_events` / `model_runs` の検査 | `closed` |",
        "| 駆動モデルDB登録 | 投影 writer と `drive_runs` / `workflow_runs` / `hook_events` / `model_runs` の検査 | 未定義状態 |",
      ),
      reason: "unknown_status",
      rule: "駆動モデルDB登録",
    },
  ];
}

afterEach(() => {
  readTrace.active = false;
  readTrace.calls = [];
  for (const root of temporaryRoots.splice(0)) removeTestTree(root);
});

describe("upstream schedule reader candidate oracles", () => {
  it("fixture source is the confirmed L3 topic with 11 passage modes and 5 closure rows", () => {
    const content = l3Content();
    expect(content).toContain("## §2.1 各駆動モデルに通過証明書を必須とする");
    expect(content).toContain("## §2.3 規則の自動化責務割当てを必須とする");
    expect(
      content.match(
        /^\| (Discovery|Scrum|Reverse|Recovery|Incident|Refactor|Retrofit|Add-feature|Research|Design-bottomup|Version-up) \|/gm,
      ),
    ).toHaveLength(11);
    expect(
      content.match(
        /^\| (FR\/carry\/addendum -> WBS\/L7 対象網羅|駆動モデル通過証明書|駆動モデルDB登録|引継ぎ完了の表現|行の欠落／曖昧性に対する fail-close) \|/gm,
      ),
    ).toHaveLength(5);
  });

  it("U-UPSTREAM-SCHEDULE-004 negative fixtures change one non-empty cell and keep table shape", () => {
    const baseline = l3Content();
    const driveVariants = driveMutationVariants();
    const closureVariants = closureMutationVariants();
    const countRows = (content: string, header: string): number => {
      const start = content.indexOf(header);
      expect(start).toBeGreaterThanOrEqual(0);
      const tail = content.slice(start + header.length);
      const nextSection = tail.search(/^##\s+/m);
      const section = nextSection < 0 ? tail : tail.slice(0, nextSection);
      return section
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("|") && line.trim().endsWith("|")).length;
    };
    const driveHeader = "## §2.1 各駆動モデルに通過証明書を必須とする";
    const closureHeader = "## §2.3 規則の自動化責務割当てを必須とする";

    expect(countRows(baseline, driveHeader)).toBe(13);
    expect(countRows(baseline, closureHeader)).toBe(7);
    for (const variant of driveVariants) {
      expect(variant.content).toContain(driveHeader);
      expect(countRows(variant.content, driveHeader)).toBe(
        variant.name === "missing_expected_mode_deleted" ? 12 : 13,
      );
      expect(variant.content).toContain("| Scrum |");
      expect(variant.content).toContain("| Version-up |");
      if (variant.name === "missing_expected_mode_deleted")
        expect(variant.content).not.toContain("| Discovery |");
    }
    for (const variant of closureVariants) {
      expect(variant.content).toContain(closureHeader);
      expect(countRows(variant.content, closureHeader)).toBe(7);
      expect(variant.content).toContain("| FR/carry/addendum -> WBS/L7 対象網羅 |");
      expect(variant.content).toContain("| 行の欠落／曖昧性に対する fail-close |");
    }
    expect(driveVariants.map(({ name }) => name)).toEqual([
      "missing_expected_mode",
      "missing_expected_mode_deleted",
      "missing_forward_target",
      "missing_residual_status",
    ]);
    expect(closureVariants.map(({ name }) => name)).toEqual(["unknown_owner", "unknown_status"]);
  });

  it("U-UPSTREAM-SCHEDULE-001: both loaders read only the L3 topic and never probe PLAN", () => {
    const expected = l3Content();
    const root = fixtureRoot({ l3: expected });
    const drive = observeLoader(() => loadDriveModelPassageDocs(root));
    const closure = observeLoader(() => loadRuleAutomationClosureDocs(root));

    expect(drive.value).toEqual([{ file: L3_PATH, content: expected }]);
    expect(closure.value).toEqual([{ file: L3_PATH, content: expected }]);
    for (const calls of [drive.calls, closure.calls]) {
      expect(calls.filter((call) => /(?:^|\/)docs\/plans\//.test(normalized(call.path)))).toEqual(
        [],
      );
      expect(
        calls.filter(
          (call) => call.api === "readFileSync" && normalized(call.path).endsWith(L3_PATH),
        ),
      ).toHaveLength(1);
    }
  });

  it("U-UPSTREAM-SCHEDULE-002: PLAN absent, old, changed, or malformed cannot replace L3", () => {
    const expected = l3Content();
    const plans: Array<string | undefined> = [
      undefined,
      PLAN_CONTENT,
      PLAN_CONTENT.replace("Forward target", "unrelated target"),
      "# malformed historical PLAN\nnot a table\n",
    ];
    const observed = plans.map((plan) => {
      const root = fixtureRoot({ l3: expected, plan });
      const drive = loadDriveModelPassageDocs(root);
      const closure = loadRuleAutomationClosureDocs(root);
      return {
        drive,
        closure,
        driveResult: analyzeDriveModelPassage(drive),
        closureResult: analyzeRuleAutomationClosure(closure),
      };
    });

    for (const result of observed) {
      expect(result.drive).toEqual([{ file: L3_PATH, content: expected }]);
      expect(result.closure).toEqual([{ file: L3_PATH, content: expected }]);
      expect(result.driveResult.ok).toBe(true);
      expect(result.closureResult.ok).toBe(true);
    }
    expect(observed.every((result) => JSON.stringify(result) === JSON.stringify(observed[0]))).toBe(
      true,
    );
  });

  it("U-UPSTREAM-SCHEDULE-003: missing or damaged L3 fails closed despite a valid PLAN", () => {
    const content = l3Content();
    const missingRoot = fixtureRoot({ plan: PLAN_CONTENT });
    expect(loadDriveModelPassageDocs(missingRoot)).toEqual([]);
    expect(loadRuleAutomationClosureDocs(missingRoot)).toEqual([]);
    expect(checkDriveModelPassage(missingRoot).ok).toBe(false);
    expect(checkRuleAutomationClosure(missingRoot).ok).toBe(false);

    const damagedL3 = content
      .replace("## §2.1 各駆動モデルに通過証明書を必須とする", "## §2.1 damaged heading")
      .replace("## §2.3 規則の自動化責務割当てを必須とする", "## §2.3 damaged heading");
    const damagedRoot = fixtureRoot({ l3: damagedL3, plan: PLAN_CONTENT });
    const driveDocs = loadDriveModelPassageDocs(damagedRoot);
    const closureDocs = loadRuleAutomationClosureDocs(damagedRoot);
    expect(driveDocs).toHaveLength(1);
    expect(closureDocs).toHaveLength(1);
    expect(analyzeDriveModelPassage(driveDocs).ok).toBe(false);
    expect(analyzeRuleAutomationClosure(closureDocs).ok).toBe(false);
    expect(driveModelPassageMessages(analyzeDriveModelPassage(driveDocs))[0]).toContain(
      "violation",
    );
    expect(ruleAutomationClosureMessages(analyzeRuleAutomationClosure(closureDocs))[0]).toContain(
      "violation",
    );
  });

  it("U-UPSTREAM-SCHEDULE-004: the L3 Japanese passage and closure rows preserve their contract meaning", () => {
    const expected = l3Content();
    const root = fixtureRoot({ l3: expected });
    const driveDocs = loadDriveModelPassageDocs(root);
    const closureDocs = loadRuleAutomationClosureDocs(root);
    const drive = analyzeDriveModelPassage(driveDocs);
    const closure = analyzeRuleAutomationClosure(closureDocs);

    expect(driveDocs).toEqual([{ file: L3_PATH, content: expected }]);
    expect(closureDocs).toEqual([{ file: L3_PATH, content: expected }]);
    expect(drive.ok).toBe(true);
    expect(drive.rows.map((row) => row.mode)).toEqual([
      "Discovery",
      "Scrum",
      "Reverse",
      "Recovery",
      "Incident",
      "Refactor",
      "Retrofit",
      "Add-feature",
      "Research",
      "Design-bottomup",
      "Version-up",
    ]);
    expect(drive.rows.every((row) => /対象|経路|再入/.test(row.requiredColumns))).toBe(true);
    expect(drive.rows.every((row) => /残余状態/.test(row.requiredColumns))).toBe(true);
    expect(closure.ok).toBe(true);
    expect(closure.rows).toHaveLength(5);
    expect(closure.rows.map((row) => [row.rule, row.owner, row.status])).toEqual([
      [
        "FR/carry/addendum -> WBS/L7 対象網羅",
        "`fr-roadmap-coverage` lint と doctor への配線",
        "closed",
      ],
      [
        "駆動モデル通過証明書",
        "新規の解析器／チェッカーと doctor または plan-lint への配線",
        "closed",
      ],
      [
        "駆動モデルDB登録",
        "投影 writer と `drive_runs` / `workflow_runs` / `hook_events` / `model_runs` の検査",
        "closed",
      ],
      ["引継ぎ完了の表現", "引継ぎ生成器の guard と doctor／引継ぎ規律の検査", "closed"],
      ["行の欠落／曖昧性に対する fail-close", "既定値を `gap` とする表解析器", "closed"],
    ]);
    expect(expected).toContain("## §2.2 DB 登録ゲートを必須とする");
    expect(expected).toContain("| `drive_runs` |");
    expect(expected).toContain("| `workflow_runs` |");
    expect(expected).toContain("| `hook_events` |");
    expect(expected).toContain("| `model_runs` |");
  });

  for (const variant of driveMutationVariants()) {
    it(`U-UPSTREAM-SCHEDULE-004: ${variant.reason} remains independently observable`, () => {
      const baselineRoot = fixtureRoot({ l3: l3Content() });
      const baselineDocs = loadDriveModelPassageDocs(baselineRoot);
      expect(baselineDocs).toHaveLength(1);
      const baseline = analyzeDriveModelPassage(baselineDocs);
      expect(baseline.ok).toBe(true);
      expect(baseline.rows).toHaveLength(11);

      const root = fixtureRoot({ l3: variant.content });
      const docs = loadDriveModelPassageDocs(root);
      expect(docs).toHaveLength(1);
      const result = analyzeDriveModelPassage(docs);
      expect(result.violations).toContainEqual({
        file: L3_PATH,
        mode: variant.mode,
        reason: variant.reason,
      });
    });
  }

  for (const variant of closureMutationVariants()) {
    it(`U-UPSTREAM-SCHEDULE-004: ${variant.reason} remains independently observable`, () => {
      const baselineRoot = fixtureRoot({ l3: l3Content() });
      const baselineDocs = loadRuleAutomationClosureDocs(baselineRoot);
      expect(baselineDocs).toHaveLength(1);
      const baseline = analyzeRuleAutomationClosure(baselineDocs);
      expect(baseline.ok).toBe(true);
      expect(baseline.rows).toHaveLength(5);

      const root = fixtureRoot({ l3: variant.content });
      const docs = loadRuleAutomationClosureDocs(root);
      expect(docs).toHaveLength(1);
      const result = analyzeRuleAutomationClosure(docs);
      expect(result.violations).toContainEqual({
        file: L3_PATH,
        rule: variant.rule,
        reason: variant.reason,
      });
    });
  }
});
