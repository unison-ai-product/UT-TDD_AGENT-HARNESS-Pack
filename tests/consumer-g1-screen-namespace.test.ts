import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const readTrace = vi.hoisted(() => ({
  active: false,
  root: "",
  paths: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const normalized = (path: unknown): string =>
    typeof path === "string" || Buffer.isBuffer(path) ? String(path).replaceAll("\\", "/") : "";
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      const resolved = normalized(path);
      if (readTrace.active && resolved.toLowerCase().startsWith(readTrace.root)) {
        readTrace.paths.push(resolved);
      }
      return actual.existsSync(path);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const resolved = normalized(args[0]);
      if (readTrace.active && resolved.toLowerCase().startsWith(readTrace.root)) {
        readTrace.paths.push(resolved);
      }
      return actual.readFileSync(...args);
    },
  };
});

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateStaticGate } from "../src/gate/static.ts";
import { analyzeConsumerG1Trace } from "../src/lint/consumer-trace.ts";
import {
  analyzeG1Trace,
  extractG1ScreenTrace,
  g1TraceOk,
  lintG1Trace,
  loadG1TraceDocs,
} from "../src/lint/g1-trace.ts";
import {
  buildConsumerScreenFixture,
  type ConsumerScreenFixtureOptions,
  writeFixtureDoc,
} from "./support/consumer-g1-screen-fixtures.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const CORE_G1_PATHS = [
  "docs/design/L1-requirements/functional-requirements.md",
  "docs/design/L2-screen/screen-list.md",
  "docs/design/L3-functional/functional-requirements.md",
] as const;

const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-consumer-g1-screen-namespace-"));
  temporaryRoots.push(root);
  return root;
}

function readTemplate(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function consumerFixture(options?: ConsumerScreenFixtureOptions): string {
  return buildConsumerScreenFixture(fixtureRoot(), readTemplate, options);
}

function observeFixture<T>(root: string, run: () => T): { result: T; paths: string[] } {
  readTrace.root = resolve(root).replaceAll("\\", "/").toLowerCase();
  readTrace.paths = [];
  readTrace.active = true;
  try {
    return { result: run(), paths: [...readTrace.paths] };
  } finally {
    readTrace.active = false;
    readTrace.root = "";
  }
}

function screenTraceCalls(paths: readonly string[]): string[] {
  return paths.filter((path) =>
    /(?:^|\/)docs\/design\/L1-requirements\/(business-requirements|screen-requirements)\.md$/i.test(
      path,
    ),
  );
}

function fixtureReader(root: string): {
  reader: (relativePath: string) => string | undefined;
  requestedPaths: string[];
} {
  const requestedPaths: string[] = [];
  return {
    reader: (relativePath) => {
      requestedPaths.push(relativePath);
      const path = join(root, relativePath);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    requestedPaths,
  };
}

function pureAnalyze(root: string) {
  const fake = fixtureReader(root);
  return { result: analyzeConsumerG1Trace(fake.reader), requestedPaths: fake.requestedPaths };
}

function consumerTraceReasons(messages: readonly string[]): string[] {
  const message = messages.find((entry) =>
    entry.startsWith("g1-trace - violation (consumer column trace): "),
  );
  return message?.replace("g1-trace - violation (consumer column trace): ", "").split("; ") ?? [];
}

afterEach(() => {
  readTrace.active = false;
  readTrace.root = "";
  readTrace.paths = [];
});

describe("consumer G1 screen namespace (issue #1273)", () => {
  const fixtures = {
    fixture042: "",
    fixture043a: "",
    fixture043b: "",
    fixture044: { "SC-001": "", "sc-01": "", "ＳＣ-01": "" } as Record<
      "SC-001" | "sc-01" | "ＳＣ-01",
      string
    >,
    fixture044d: "",
  };
  const mismatchTokens = ["SC-001", "sc-01", "ＳＣ-01"] as const;
  beforeAll(() => {
    fixtures.fixture042 = consumerFixture();
    fixtures.fixture043a = consumerFixture({
      requirementRows: [
        "| REQ-01 | First requirement | details | Must | SC-01, F-01 |",
        "| REQ-02 | Second requirement | details | Must | SC-02, F-02 |",
        "| REQ-03 | Third requirement | details | Must | SC-03, F-03 |",
      ],
      screenRows: [],
    });
    fixtures.fixture043b = consumerFixture({
      requirementRows: [
        "| REQ-01 | First requirement | details | Must | PM-01, F-01 |",
        "| REQ-02 | Second requirement | details | Must | SC-02, F-02 |",
        "| REQ-03 | Third requirement | details | Must | SC-03, F-03 |",
      ],
      screenRows: [],
      extraLegacyScreenLabels: true,
    });
    for (const token of mismatchTokens) {
      fixtures.fixture044[token] = consumerFixture({
        requirementRows: [
          "| REQ-01 | First requirement | details | Must | SC-01〜03, F-01 |",
          `| REQ-02 | Second requirement | details | Must | ${token}, F-02 |`,
          "| REQ-03 | Third requirement | details | Must | SC-03, F-03 |",
        ],
      });
    }
    fixtures.fixture044d = consumerFixture({
      requirementRows: [
        "| REQ-01 | First requirement | details | Must | SC-01〜03, F-01 |",
        "| REQ-02 | Second requirement | details | Must | SC-02, F-02 |",
        "| REQ-03 | Third requirement | details | Must | ADM-01, F-03 |",
      ],
      screenRows: [
        "| SC-01 | Screen 1 | overview | F-01 | user |",
        "| SC-02 | Screen 2 | overview | F-02 | user |",
        "| SC-03 | Screen 3 | overview | F-03 | user |",
        "| ADM-01 | Admin screen | overview | F-01 | admin |",
      ],
    });
  });

  it("U-CTRACE-042: pure analyzer import and result shape are valid", () => {
    const { result } = pureAnalyze(fixtures.fixture042);

    expect(result.branch).toBe("consumer");
    expect(Array.isArray(result.violations)).toBe(true);
    expect(typeof result.ok).toBe("boolean");
    expect(Object.keys(result.totals).sort()).toEqual(["functions", "requirements", "screens"]);
    expect(Object.values(result.totals).every((count) => typeof count === "number")).toBe(true);
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.every((message) => message.includes("consumer column trace"))).toBe(
      true,
    );
  });

  it("U-CTRACE-042: pure result reports the fixture's three-by-three totals", () => {
    const { result } = pureAnalyze(fixtures.fixture042);
    expect(result.totals).toEqual({ requirements: 3, screens: 3, functions: 3 });
  });

  it("U-CTRACE-042: pure result has the fixture's contract OK message", () => {
    const { result } = pureAnalyze(fixtures.fixture042);
    expect(result.messages).toEqual([
      "g1-trace - OK (consumer column trace: requirements=3, screens=3, functions=3)",
    ]);
  });

  it("U-CTRACE-042: pure reader requests the three consumer core documents", () => {
    const { requestedPaths } = pureAnalyze(fixtures.fixture042);
    expect([...new Set(requestedPaths)].sort()).toEqual([...CORE_G1_PATHS].sort());
  });

  it("U-CTRACE-042: pure reader does not request the legacy business/screen documents", () => {
    const { requestedPaths } = pureAnalyze(fixtures.fixture042);
    expect(screenTraceCalls(requestedPaths)).toEqual([]);
  });

  it("U-CTRACE-042: uses consumer columns and never reads harness business/screen docs", () => {
    const observed = observeFixture(fixtures.fixture042, () => lintG1Trace(fixtures.fixture042));
    const gate = evaluateStaticGate({ gate: "G1", repoRoot: fixtures.fixture042 });
    const expected =
      "g1-trace - OK (consumer column trace: requirements=3, screens=3, functions=3)";

    expect(observed.result.ok).toBe(true);
    const lintTraceMessages = observed.result.messages.filter((message) =>
      message.startsWith("g1-trace - OK (consumer column trace:"),
    );
    const gateTraceMessages = gate.messages.filter((message) =>
      message.startsWith("g1-trace - OK (consumer column trace:"),
    );
    expect(lintTraceMessages).toEqual([expected]);
    expect(gateTraceMessages).toEqual([expected]);
    expect(observed.result.messages.join("\n")).not.toMatch(/orphan(Business|Screen|P0Fr)/);
    expect(gate.messages.join("\n")).not.toMatch(/orphan(Business|Screen|P0Fr)/);
    expect(screenTraceCalls(observed.paths)).toEqual([]);
  });

  it("U-CTRACE-043(a): empty L2 declaration does not fall back to harness screen docs", () => {
    const result = lintG1Trace(fixtures.fixture043a);
    const reasons = consumerTraceReasons(result.messages);

    expect(result.ok).toBe(false);
    expect(reasons).toContain("empty_required_set:DOC-L2-SCREEN:画面ID");
    expect(reasons).toContain("dangling_reference:DOC-L1-REQUIREMENTS:REQ-01:展開先:SC-01");
    expect(result.messages.join("\n")).not.toContain("required docs could not be read");
  });

  it("U-CTRACE-043(a): pure result counts zero declared screens", () => {
    const { result } = pureAnalyze(fixtures.fixture043a);
    expect(result.totals.screens).toBe(0);
  });

  it("U-CTRACE-043(a): pure result reports the empty screen declaration", () => {
    const { result } = pureAnalyze(fixtures.fixture043a);
    expect(result.violations).toContain("empty_required_set:DOC-L2-SCREEN:画面ID");
  });

  it("U-CTRACE-043(a): pure result keeps the SC-01 dangling reference", () => {
    const { result } = pureAnalyze(fixtures.fixture043a);
    expect(result.violations).toContain(
      "dangling_reference:DOC-L1-REQUIREMENTS:REQ-01:展開先:SC-01",
    );
  });

  it("U-CTRACE-043(b): empty declaration ignores fixed-prefix labels outside the L2 table", () => {
    const result = lintG1Trace(fixtures.fixture043b);
    const reasons = consumerTraceReasons(result.messages);

    expect(result.ok).toBe(false);
    expect(reasons).toContain("empty_required_set:DOC-L2-SCREEN:画面ID");
    expect(reasons).toContain("dangling_reference:DOC-L1-REQUIREMENTS:REQ-01:展開先:PM-01");
    expect(result.messages.join("\n")).not.toContain("required docs could not be read");
  });

  it("U-CTRACE-043(b): pure result counts zero declared screens", () => {
    const { result } = pureAnalyze(fixtures.fixture043b);
    expect(result.totals.screens).toBe(0);
  });

  it("U-CTRACE-043(b): pure result reports the empty screen declaration", () => {
    const { result } = pureAnalyze(fixtures.fixture043b);
    expect(result.violations).toContain("empty_required_set:DOC-L2-SCREEN:画面ID");
  });

  it("U-CTRACE-043(b): pure result keeps the PM-01 dangling reference", () => {
    const { result } = pureAnalyze(fixtures.fixture043b);
    expect(result.violations).toContain(
      "dangling_reference:DOC-L1-REQUIREMENTS:REQ-01:展開先:PM-01",
    );
  });

  it("U-CTRACE-044(a): SC-001 is not equal to declared SC-01", () => {
    const result = lintG1Trace(fixtures.fixture044["SC-001"]);
    const reasons = consumerTraceReasons(result.messages);
    expect(result.ok).toBe(false);
    expect(reasons).toContain("dangling_reference:DOC-L1-REQUIREMENTS:REQ-02:展開先:SC-001");
  });

  it("U-CTRACE-044(a): pure result rejects SC-001 by exact equality", () => {
    const { result } = pureAnalyze(fixtures.fixture044["SC-001"]);
    expect(result.violations).toContain(
      "dangling_reference:DOC-L1-REQUIREMENTS:REQ-02:展開先:SC-001",
    );
  });

  it("U-CTRACE-044(b): sc-01 is not equal to declared SC-01", () => {
    const result = lintG1Trace(fixtures.fixture044["sc-01"]);
    const reasons = consumerTraceReasons(result.messages);
    expect(result.ok).toBe(false);
    expect(reasons).toContain("dangling_reference:DOC-L1-REQUIREMENTS:REQ-02:展開先:sc-01");
  });

  it("U-CTRACE-044(b): pure result rejects sc-01 by exact equality", () => {
    const { result } = pureAnalyze(fixtures.fixture044["sc-01"]);
    expect(result.violations).toContain(
      "dangling_reference:DOC-L1-REQUIREMENTS:REQ-02:展開先:sc-01",
    );
  });

  it("U-CTRACE-044(c): fullwidth ＳＣ-01 is not equal to declared SC-01", () => {
    const result = lintG1Trace(fixtures.fixture044["ＳＣ-01"]);
    const reasons = consumerTraceReasons(result.messages);
    expect(result.ok).toBe(false);
    expect(reasons).toContain("dangling_reference:DOC-L1-REQUIREMENTS:REQ-02:展開先:ＳＣ-01");
  });

  it("U-CTRACE-044(c): pure result rejects fullwidth ＳＣ-01 by exact equality", () => {
    const { result } = pureAnalyze(fixtures.fixture044["ＳＣ-01"]);
    expect(result.violations).toContain(
      "dangling_reference:DOC-L1-REQUIREMENTS:REQ-02:展開先:ＳＣ-01",
    );
  });

  it("U-CTRACE-044(a-c): pure results retain the three declared screens", () => {
    const screenCounts = mismatchTokens.map(
      (token) => pureAnalyze(fixtures.fixture044[token]).result.totals.screens,
    );
    expect(screenCounts).toEqual([3, 3, 3]);
  });

  it("U-CTRACE-044(d): permits a second declared screen prefix", () => {
    const result = lintG1Trace(fixtures.fixture044d);

    expect(result.ok).toBe(true);
    expect(
      result.messages.filter((message) =>
        message.startsWith("g1-trace - OK (consumer column trace:"),
      ),
    ).toEqual(["g1-trace - OK (consumer column trace: requirements=3, screens=4, functions=3)"]);
  });

  it("U-CTRACE-044(d): pure result includes the additional declared screen", () => {
    const { result } = pureAnalyze(fixtures.fixture044d);
    expect(result.totals.screens).toBe(4);
  });

  const rangeRows = (...cells: string[]): string[] => [
    `| REQ-01 | First requirement | details | Must | ${cells[0]} |`,
    `| REQ-02 | Second requirement | details | Must | ${cells[1] ?? "SC-02, F-02"} |`,
    `| REQ-03 | Third requirement | details | Must | ${cells[2] ?? "SC-03, F-03"} |`,
  ];
  const manyScreens = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, i) => `| SC-${String(i + 1).padStart(4, "0")} | Screen | overview | F-01 | user |`,
    );
  const invalidRanges = (violations: readonly string[]): string[] =>
    violations.filter((v) => v.startsWith("invalid_range:"));

  it("CANDIDATE-U-CTRACE-051: expands a range of exactly 1000 and keeps the document green", () => {
    const root = consumerFixture({
      requirementRows: rangeRows("SC-0001〜1000, F-01", "F-02", "F-03"),
      screenRows: manyScreens(1000),
    });
    const { result } = pureAnalyze(root);

    expect(invalidRanges(result.violations)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("CANDIDATE-U-CTRACE-052: a range of 1001 is invalid_range without expanded dangling references", () => {
    const root = consumerFixture({
      requirementRows: rangeRows("SC-0001〜1001, F-01", "F-02", "F-03"),
      screenRows: manyScreens(1000),
    });
    const { result } = pureAnalyze(root);

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("invalid_range:DOC-L1-REQUIREMENTS:SC-0001〜1001");
    expect(result.violations.filter((v) => v.startsWith("dangling_reference:"))).toEqual([]);
  });

  it("CANDIDATE-U-CTRACE-053: a huge range is rejected without expansion and keeps the other tokens", () => {
    const root = consumerFixture({
      requirementRows: rangeRows("SC-0〜9007199254740991, F-01", "SC-0〜9007199254740990"),
    });
    const started = Date.now();
    const { result } = pureAnalyze(root);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.violations).toEqual([
      "invalid_range:DOC-L1-REQUIREMENTS:SC-0〜9007199254740990",
      "invalid_range:DOC-L1-REQUIREMENTS:SC-0〜9007199254740991",
    ]);
  });

  it("doc_type_id outside the frontmatter does not identify the document (Sol r3, #1855)", () => {
    const root = consumerFixture();
    const l2 = join(root, "docs/design/L2-screen/screen-list.md");
    const body = readFileSync(l2, "utf8").replace(/^doc_type_id:.*\r?\n/m, "");
    writeFileSync(l2, `${body}\n${"```"}yaml\ndoc_type_id: DOC-L2-SCREEN\n${"```"}\n`);
    const { result } = pureAnalyze(root);

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("doc_type_mismatch:DOC-L2-SCREEN");
  });

  it("L3 トレース元 is not read by G1: a bad range there does not change the result (Sol r4, #1847)", () => {
    const root = consumerFixture();
    const l3 = join(root, "docs/design/L3-functional/functional-requirements.md");
    const body = readFileSync(l3, "utf8");
    const pattern = /(\| F-01 \|.*)REQ-01/;
    expect(body).toMatch(pattern);
    writeFileSync(l3, body.replace(pattern, "$1REQ-05〜02"));
    const { result } = pureAnalyze(root);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("CANDIDATE-U-CTRACE-054: endpoints beyond the safe integer range are invalid_range", () => {
    const tokens = ["SC-1〜9007199254740993", "SC-9007199254740993〜9007199254740995"];
    const root = consumerFixture({ requirementRows: rangeRows(`${tokens.join(", ")}, F-01`) });
    const { result } = pureAnalyze(root);

    expect(result.ok).toBe(false);
    expect(invalidRanges(result.violations)).toEqual(
      tokens.map((token) => `invalid_range:DOC-L1-REQUIREMENTS:${token}`).sort(),
    );
  });

  it("CANDIDATE-U-CTRACE-055(a): range reasons stay one per range token", () => {
    const tokens = Array.from({ length: 50 }, (_, i) => `SC-0〜${100000 + i}`);
    const root = consumerFixture({ requirementRows: rangeRows(`${tokens.join(", ")}, F-01`) });
    const { result } = pureAnalyze(root);

    expect(result.violations).toHaveLength(50);
    expect(invalidRanges(result.violations)).toHaveLength(50);
  });

  it("CANDIDATE-U-CTRACE-055(a): the same range token repeated N times yields N reasons", () => {
    const tokens = Array.from({ length: 50 }, () => "SC-0〜9007199254740991");
    const root = consumerFixture({ requirementRows: rangeRows(`${tokens.join(", ")}, F-01`) });
    const { result } = pureAnalyze(root);

    expect(invalidRanges(result.violations)).toHaveLength(50);
    expect(result.violations).toHaveLength(50);
  });

  it("CANDIDATE-U-CTRACE-055(b): ordinary dangling references are not suppressed by range reasons", () => {
    const root = consumerFixture({
      requirementRows: rangeRows("SC-0〜9007199254740991, SC-404, F-01"),
    });
    const { result } = pureAnalyze(root);

    expect(invalidRanges(result.violations)).toHaveLength(1);
    expect(result.violations).toContain(
      "dangling_reference:DOC-L1-REQUIREMENTS:REQ-01:展開先:SC-404",
    );
  });

  it("U-CTRACE-045: keeps the harness screen prefix fixed, including the direct trace map", () => {
    const root = fixtureRoot();
    writeFixtureDoc(
      root,
      "docs/design/harness/L1-requirements/business-requirements.md",
      "| BR-01 | Business requirement |\n",
    );
    writeFixtureDoc(
      root,
      "docs/design/harness/L1-requirements/functional-requirements.md",
      "| **FR-L1-01** | P0 |\n",
    );
    const baseScreen = [
      "## §1 画面一覧",
      "| PM-01 | Main screen |",
      "## §2 画面詳細",
      "### §5.1 BR/UX to screen trace",
      "| BR-01 | PM-01 |",
      "### §5.3 Functional trace",
      "| **FR-L1-01** | PM-01 |",
      "### §5.5 Screen trace",
      "| **PM-01** | BR-01 / FR-L1-01 |",
      "### §5.6 Details",
    ].join("\n");
    writeFixtureDoc(root, "docs/design/harness/L1-requirements/screen-requirements.md", baseScreen);

    const loadedBase = loadG1TraceDocs(root);
    const baseResult = analyzeG1Trace(loadedBase);
    const screenWithCustomId = baseScreen
      .replace(
        "## §2 画面詳細",
        "| SC-99 | Custom screen | Custom overview | FR-L1-01 | user |\n\n## §2 画面詳細",
      )
      .replace(
        "| **PM-01** | BR-01 / FR-L1-01 |",
        "| **PM-01** | BR-01 / FR-L1-01 |\n| **SC-99** | BR-01 | FR-L1-01 |",
      );
    const loadedWithCustomId = loadG1TraceDocs(root);
    const result = analyzeG1Trace({ ...loadedWithCustomId, screen: screenWithCustomId });
    const trace = extractG1ScreenTrace(screenWithCustomId);
    const screenBusinessTraceOnlyCustomId = screenWithCustomId.replace(
      "| BR-01 | PM-01 |",
      "| BR-01 | SC-99 |",
    );
    const brokenBusinessTrace = analyzeG1Trace({
      ...loadedWithCustomId,
      screen: screenBusinessTraceOnlyCustomId,
    });

    expect(g1TraceOk(baseResult)).toBe(true);
    expect(baseResult.totals.screen).toBe(1);
    expect(baseResult.orphanBusiness).toEqual([]);
    expect(baseResult.orphanScreen).toEqual([]);
    expect(baseResult.orphanP0Fr).toEqual([]);
    expect(g1TraceOk(result)).toBe(true);
    expect(result.totals.screen).toBe(baseResult.totals.screen);
    expect(result.orphanScreen).toEqual([]);
    expect(g1TraceOk(brokenBusinessTrace)).toBe(false);
    expect(brokenBusinessTrace.orphanBusiness).toContain("BR-01");
    expect(trace.has("SC-99")).toBe(false);
    expect([...trace.keys()]).toEqual(["PM-01"]);
    expect([...trace.keys()].every((id) => /^(PM|HM|GD)-\d{2}$/.test(id))).toBe(true);
  });
});

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) removeTestTree(root);
});
