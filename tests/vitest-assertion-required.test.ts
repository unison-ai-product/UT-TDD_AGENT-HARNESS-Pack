import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #1452 / L7-vitest-assertion-required-test-design.md の候補 oracle。
// 開発リポジトリの vitest 実行設定を通した独立 fixture を CLI 子プロセスで実行する。
const repoRoot = process.cwd();
const created: string[] = [];

interface CaseResult {
  status: string;
  messages: string;
}
interface RunOutcome {
  parsed: boolean;
  exitCode: number | null;
  byName: Map<string, CaseResult>;
  raw: string;
}

function runFixture(files: Record<string, string>): RunOutcome {
  const dir = mkdtempSync(join(tmpdir(), "ut-vitassert-"));
  created.push(dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
  const base = join(repoRoot, "vitest.config.ts").replace(/\\/g, "/");
  writeFileSync(
    join(dir, "vitest.config.mts"),
    `import base from ${JSON.stringify(base)};
export default {
  ...base,
  root: ${JSON.stringify(dir.replace(/\\/g, "/"))},
  test: { ...base.test, include: ["*.test.ts"], setupFiles: [], globalSetup: [] },
};
`,
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const out = join(dir, "out.json");
  const proc = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      join(dir, "vitest.config.mts"),
      "--reporter=json",
      `--outputFile=${out}`,
    ],
    { cwd: dir, encoding: "utf8", timeout: 120_000 },
  );
  const byName = new Map<string, CaseResult>();
  let raw = "";
  let parsed = false;
  try {
    raw = readFileSync(out, "utf8");
    const json = JSON.parse(raw) as {
      testResults: {
        assertionResults: { title: string; status: string; failureMessages: string[] }[];
      }[];
    };
    for (const f of json.testResults) {
      for (const a of f.assertionResults) {
        byName.set(a.title, { status: a.status, messages: a.failureMessages.join("\n") });
      }
    }
    parsed = true;
  } catch {
    raw = `${raw}\n${proc.stdout}\n${proc.stderr}`;
  }
  return { parsed, exitCode: proc.status, byName, raw };
}

function statusOf(run: RunOutcome, name: string): string {
  return run.byName.get(name)?.status ?? `missing(${run.raw.slice(0, 200)})`;
}
function messagesOf(run: RunOutcome, name: string): string {
  return run.byName.get(name)?.messages ?? "";
}

const HEAD = `import { beforeEach, describe, expect, it } from "vitest";
`;
const CTRL = `it("control ok", () => { expect(1).toBe(1); });
`;
const SETUP_TIMEOUT = 150_000;

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

// 反転の外で検証する: 子プロセスの完了、reporter の解析、期待ケースの実行、成功の対照。
function expectSound(run: RunOutcome, names: string[]): void {
  expect(run.parsed, run.raw.slice(0, 300)).toBe(true);
  expect(run.exitCode).not.toBeNull();
  for (const n of ["control ok", ...names]) expect(run.byName.has(n), `case ${n} ran`).toBe(true);
  expect(statusOf(run, "control ok")).toBe("passed");
}

function oracle(
  id: string,
  title: string,
  fixture: string,
  names: string[],
  contract: (run: RunOutcome) => void,
): void {
  describe(`${id}: ${title}`, () => {
    let run: RunOutcome;
    beforeAll(() => {
      run = runFixture({ "a.test.ts": `${HEAD}${CTRL}${fixture}` });
    }, SETUP_TIMEOUT);
    it("fixture 実行が健全 (反転しない)", () => {
      expectSound(run, names);
    });
    it.fails(`${id} 契約`, () => {
      contract(run);
    });
  });
}

oracle(
  "CANDIDATE-U-VITASSERT-001",
  "早期 return は 0 件で FAIL し CLI は非 0",
  `it("zero early return", () => { if (Date.now() > 0) return; expect(1).toBe(1); });
`,
  ["zero early return"],
  (run) => {
    expect(statusOf(run, "zero early return")).toBe("failed");
    expect(messagesOf(run, "zero early return")).toMatch(/assertion/i);
    expect(run.exitCode).not.toBe(0);
  },
);

oracle(
  "CANDIDATE-U-VITASSERT-002",
  "it.fails は反転を維持し 0 件判定を適用しない",
  `it("zero normal", () => { return; });
it.fails("fails returns normally", () => { return; });
it.fails("fails really throws", () => { expect(1).toBe(2); });
`,
  ["zero normal", "fails returns normally", "fails really throws"],
  (run) => {
    expect(statusOf(run, "zero normal")).toBe("failed");
    expect(statusOf(run, "fails returns normally")).toBe("failed");
    expect(messagesOf(run, "fails returns normally")).toMatch(/expect test to fail/i);
    expect(statusOf(run, "fails really throws")).toBe("passed");
  },
);

oracle(
  "CANDIDATE-U-VITASSERT-003",
  "import と context.expect は同じ counter",
  `it("import only", () => { expect(1).toBe(1); });
it("local only", (ctx) => { ctx.expect(1).toBe(1); });
it("both two", (ctx) => { expect.assertions(2); expect(1).toBe(1); ctx.expect(1).toBe(1); });
it("local get only", (ctx) => { void ctx.expect; });
it("soft only", () => { expect.soft(1).toBe(1); });
it("poll only", async () => { await expect.poll(() => 1).toBe(1); });
`,
  ["import only", "local only", "both two", "local get only", "soft only", "poll only"],
  (run) => {
    for (const n of ["import only", "local only", "both two", "soft only", "poll only"])
      expect(statusOf(run, n)).toBe("passed");
    expect(statusOf(run, "local get only")).toBe("failed");
  },
);

oracle(
  "CANDIDATE-U-VITASSERT-004",
  "helper・parameterized・例外",
  `function check(): void { expect(1).toBe(1); }
it("via helper", () => { check(); });
it.each([[true], [false]])("param %s", (flag) => { if (flag) expect(1).toBe(1); });
it("throws originally", () => { throw new Error("boom-original"); });
`,
  ["via helper", "param true", "param false", "throws originally"],
  (run) => {
    expect(statusOf(run, "via helper")).toBe("passed");
    expect(statusOf(run, "param true")).toBe("passed");
    expect(statusOf(run, "param false")).toBe("failed");
    expect(statusOf(run, "throws originally")).toBe("failed");
    expect(messagesOf(run, "throws originally")).toContain("boom-original");
    expect(messagesOf(run, "throws originally")).not.toMatch(/no assertion|0 assertion/i);
  },
);

oracle(
  "CANDIDATE-U-VITASSERT-005",
  "retry は最終試行の 0 件を診断し skip/todo は維持",
  `let n = 0;
it("retry zero", { retry: 1 }, (ctx) => { n += 1; if (n === 1) ctx.expect(1).toBe(2); });
it.skip("skipped", () => { return; });
it.todo("todoed");
`,
  ["retry zero", "skipped", "todoed"],
  (run) => {
    expect(statusOf(run, "retry zero")).toBe("failed");
    expect(messagesOf(run, "retry zero")).toMatch(/assertion/i);
    expect(messagesOf(run, "retry zero")).not.toMatch(/expected 2|toBe\(2\)/);
    expect(run.exitCode).not.toBe(0);
    expect(["skipped", "pending"]).toContain(statusOf(run, "skipped"));
    expect(["todo", "pending"]).toContain(statusOf(run, "todoed"));
  },
);

oracle(
  "CANDIDATE-U-VITASSERT-006",
  "hook と並行する別ケースの assertion を混ぜない",
  `describe("hook", () => {
  beforeEach(() => { expect(1).toBe(1); });
  it("hook only zero", () => { return; });
});
describe.concurrent("concurrent", () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  it("waiting zero", async () => { await gate; });
  it("calls expect", () => { expect(1).toBe(1); release(); });
});
`,
  ["hook only zero", "waiting zero", "calls expect"],
  (run) => {
    expect(statusOf(run, "hook only zero")).toBe("failed");
    expect(statusOf(run, "waiting zero")).toBe("failed");
    expect(statusOf(run, "calls expect")).toBe("passed");
  },
);

oracle(
  "CANDIDATE-U-VITASSERT-007",
  "標準診断を上書きしない",
  `it("mismatch three", (ctx) => { expect.assertions(3); expect(1).toBe(1); ctx.expect(1).toBe(1); });
it("assertions two none", () => { expect.assertions(2); });
it("has assertions none", () => { expect.hasAssertions(); });
`,
  ["mismatch three", "assertions two none", "has assertions none"],
  (run) => {
    expect(messagesOf(run, "mismatch three")).toMatch(
      /expected 3 assertions to be called but got 2/,
    );
    expect(messagesOf(run, "assertions two none")).toMatch(
      /expected 2 assertions to be called but got 0/,
    );
    expect(messagesOf(run, "has assertions none")).toMatch(/expected any number of assertion/);
  },
);
