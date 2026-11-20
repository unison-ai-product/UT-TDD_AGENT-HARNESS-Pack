import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateStaticGate } from "../src/gate/static.ts";
import * as consumerTrace from "../src/lint/consumer-trace.ts";
import { lintG3Trace } from "../src/lint/g3-trace.ts";
import { writeFixtureDoc } from "./support/consumer-g1-screen-fixtures.ts";
import { createTraceGateFixture } from "./support/g1-g3-trace-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const L1 = "docs/design/L1-requirements/functional-requirements.md";
const L2 = "docs/design/L2-screen/screen-list.md";
const L3 = "docs/design/L3-functional/functional-requirements.md";
const L12 = "docs/test-design/L12-acceptance-test-design.md";
const BUSINESS = "docs/design/L3-functional/business-detail.md";
const NFR = "docs/design/L3-functional/nfr-grade.md";
const rowNumbers = [1, 2, 3];
const TEMPLATE_SLOTS = [
  {
    path: L1,
    template: "L1-requirements.md",
    heading: "#### 第4章 機能要求一覧",
    rows: rowNumbers.map((n) => `| REQ-0${n} | Requirement ${n} | Detail | Must | F-0${n} |`),
  },
  {
    path: L2,
    template: "L2-screen-list.md",
    heading: "#### 第4章 画面一覧",
    rows: rowNumbers.map((n) => `| SC-00${n} | Screen ${n} | Overview | F-0${n} | User |`),
  },
  {
    path: L3,
    template: "L3-functional-requirements.md",
    heading: "##### 3-1 機能一覧",
    rows: rowNumbers.map((n) => `| F-0${n} | Function ${n} | Detail | User | REQ-0${n} |`),
  },
  {
    path: L12,
    template: "L12-acceptance-test-design.md",
    heading: "#### 第3章 テストケース一覧",
    rows: rowNumbers.map(
      (n) =>
        `| AT-0${n} | functional | Case ${n} | execute | pass | REQ-0${n}, SC-00${n}, F-0${n} |`,
    ),
  },
] as const;
const HARNESS_PATHS = [
  "docs/design/harness/L1-requirements/functional-requirements.md",
  "docs/design/harness/L3-functional/functional-requirements.md",
  "docs/design/harness/L3-functional/business-detail.md",
  "docs/design/harness/L3-functional/nfr-grade.md",
  "docs/test-design/harness/L12-acceptance-test-design.md",
] as const;
const SUCCESS = {
  ok: true,
  messages: ["g3-trace - OK (consumer column trace: requirements=3, functions=3, tests=3)"],
};
const VIOLATION_PREFIX = "g3-trace - violation (consumer column trace): ";
const partialCases = [
  {
    path: L1,
    reasons: [
      ...rowNumbers.map(
        (n) => `dangling_reference:DOC-L12-ACCEPTANCE:AT-0${n}:トレース元:REQ-0${n}`,
      ),
      ...rowNumbers.map((n) => `dangling_reference:DOC-L3-FUNCTIONAL:F-0${n}:トレース元:REQ-0${n}`),
      "missing_core_doc:DOC-L1-REQUIREMENTS",
    ],
    totals: { requirements: 0, functions: 3, tests: 3 },
  },
  {
    path: L2,
    reasons: [
      ...rowNumbers.map(
        (n) => `dangling_reference:DOC-L12-ACCEPTANCE:AT-0${n}:トレース元:SC-00${n}`,
      ),
      "missing_core_doc:DOC-L2-SCREEN",
    ],
    totals: { requirements: 3, functions: 3, tests: 3 },
  },
  {
    path: L3,
    reasons: [
      ...rowNumbers.map((n) => `dangling_reference:DOC-L12-ACCEPTANCE:AT-0${n}:トレース元:F-0${n}`),
      "missing_core_doc:DOC-L3-FUNCTIONAL",
    ],
    totals: { requirements: 3, functions: 0, tests: 3 },
  },
  {
    path: L12,
    reasons: ["missing_core_doc:DOC-L12-ACCEPTANCE"],
    totals: { requirements: 3, functions: 3, tests: 0 },
  },
] as const;
const multipleCases = [
  {
    label: "L3 and L12 absent",
    omitted: [L3, L12],
    reasons: ["missing_core_doc:DOC-L12-ACCEPTANCE", "missing_core_doc:DOC-L3-FUNCTIONAL"],
  },
  {
    label: "all four absent",
    omitted: [L1, L2, L3, L12],
    reasons: [
      "missing_core_doc:DOC-L1-REQUIREMENTS",
      "missing_core_doc:DOC-L12-ACCEPTANCE",
      "missing_core_doc:DOC-L2-SCREEN",
      "missing_core_doc:DOC-L3-FUNCTIONAL",
    ],
  },
] as const;
const roots: string[] = [];

function addRows(template: string, heading: string, rows: readonly string[]): string {
  const lines = template.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) throw new Error(`fixture template heading missing: ${heading}`);
  const index = lines.findIndex(
    (line, row) => row > headingIndex && line.trimStart().startsWith("|"),
  );
  if (index < 0 || !lines[index + 1]?.trimStart().startsWith("|---")) {
    throw new Error(`fixture template table missing: ${heading}`);
  }
  lines.splice(index + 2, 0, ...rows);
  return lines.join("\n");
}

function readBase(): Map<string, string> {
  const snapshot = headSnapshotRoot();
  return new Map(
    TEMPLATE_SLOTS.map(({ path, template, heading, rows }) => [
      path,
      addRows(
        readFileSync(join(snapshot, "docs/templates/vmodel", template), "utf8"),
        heading,
        rows,
      ),
    ]),
  );
}

function omit(documents: ReadonlyMap<string, string>, paths: readonly string[]) {
  const remaining = new Map(documents);
  for (const path of paths) remaining.delete(path);
  return remaining;
}

function placeConsumer(documents: ReadonlyMap<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ut-consumer-g3-trace-red-"));
  roots.push(root);
  for (const [path, content] of documents) writeFixtureDoc(root, path, content);
  return root;
}

function observeAnalyzer(documents: ReadonlyMap<string, string>) {
  const requested: string[] = [];
  const reader: consumerTrace.ConsumerTraceReader = (path) => {
    requested.push(path);
    return documents.get(path);
  };
  const analyzer: unknown = Reflect.get(consumerTrace, "analyzeConsumerG3Trace");
  // Keep collection valid before the production export exists. A missing export
  // is represented in the observation so it cannot hide setup failures.
  const result: unknown = typeof analyzer === "function" ? analyzer(reader) : undefined;
  return { result, requested };
}

function observeEntryPoints(documents: ReadonlyMap<string, string>) {
  const root = placeConsumer(documents);
  expect(existsSync(join(root, "docs/design/harness"))).toBe(false);
  expect(existsSync(join(root, "docs/test-design/harness"))).toBe(false);
  const helper = lintG3Trace(root);
  const gate = evaluateStaticGate({ gate: "G3", repoRoot: root }).messages.filter((message) =>
    message.startsWith("g3-trace -"),
  );
  return { helper, gate, analyzer: observeAnalyzer(documents) };
}

function fixtureHarness(missingPath?: string): string {
  const root = createTraceGateFixture("G3", missingPath);
  roots.push(root);
  return root;
}

describe("consumer G3-trace document absence (issue #972)", () => {
  let base: ReturnType<typeof observeEntryPoints>;
  let withExtras: ReturnType<typeof observeEntryPoints>;
  const missing = new Map<string, { helper: ReturnType<typeof lintG3Trace>; result: unknown }>();
  const multiple = new Map<string, unknown>();

  beforeAll(() => {
    const documents = readBase();
    expect(consumerTrace.analyzeConsumerG1Trace((path) => documents.get(path))).toMatchObject({
      ok: true,
      totals: { requirements: 3, screens: 3, functions: 3 },
    });
    base = observeEntryPoints(documents);
    const extras = new Map(documents);
    extras.set(BUSINESS, "#### AC-FR-BR21-01\n");
    extras.set(NFR, "# No NFR rows\n");
    withExtras = observeEntryPoints(extras);

    for (const { path } of partialCases) {
      const remaining = omit(documents, [path]);
      const root = placeConsumer(remaining);
      for (const corePath of documents.keys()) {
        expect(existsSync(join(root, corePath))).toBe(corePath !== path);
      }
      missing.set(path, {
        helper: lintG3Trace(root),
        result: observeAnalyzer(remaining).result,
      });
    }
    for (const { label, omitted } of multipleCases) {
      multiple.set(label, observeAnalyzer(omit(documents, omitted)).result);
    }
  });

  afterAll(() => {
    for (const root of roots) removeTestTree(root);
  });

  it("both public and helper traces are observable on consumer fixtures", () => {
    expect(base.helper.messages).toHaveLength(1);
    expect(base.gate).toEqual(base.helper.messages);
    expect(withExtras.helper.messages).toHaveLength(1);
    expect(withExtras.gate).toEqual(withExtras.helper.messages);
  });

  it("U-CTRACE-046: four consumer docs satisfy both trace entry points", () => {
    expect(base.helper).toEqual(SUCCESS);
    expect(base.gate).toEqual(SUCCESS.messages);
    expect(base.analyzer.result).toEqual({
      branch: "consumer",
      totals: { requirements: 3, functions: 3, tests: 3 },
      violations: [],
      ...SUCCESS,
    });
  });

  it("U-CTRACE-047: irrelevant harness-only docs are never requested", () => {
    expect(withExtras.helper).toEqual(SUCCESS);
    expect(withExtras.gate).toEqual(SUCCESS.messages);
    expect(withExtras.analyzer.result).toEqual(base.analyzer.result);
    expect(withExtras.analyzer.requested).not.toEqual([]);
    expect(
      withExtras.analyzer.requested.filter((path) =>
        /(?:^|[\\/])(?:business-detail|nfr-grade)\.md$/.test(path),
      ),
    ).toEqual([]);
  });

  it.each(partialCases)("U-CTRACE-048: omitting $path reports exact reasons", ({
    path,
    reasons,
    totals,
  }) => {
    const messages = [VIOLATION_PREFIX + reasons.join("; ")];
    expect(missing.get(path)).toEqual({
      helper: { ok: false, messages },
      result: { branch: "consumer", ok: false, violations: reasons, totals, messages },
    });
  });

  it.each(multipleCases)("U-CTRACE-049: $label reports all missing documents in order", ({
    label,
    reasons,
  }) => {
    expect(multiple.get(label)).toMatchObject({ ok: false, violations: reasons });
  });

  it.each(
    HARNESS_PATHS,
  )("U-CTRACE-050: harness G3 retains its missing-doc diagnostic for %s", (path) => {
    expect(lintG3Trace(fixtureHarness(path))).toEqual({
      ok: false,
      messages: [
        `g3-trace - violation: required docs could not be read (Error: required doc not created: ${path})`,
      ],
    });
  });

  it("U-CTRACE-050: harness G3 retains its success with and without L2", () => {
    const withL2 = fixtureHarness();
    writeFixtureDoc(withL2, "docs/design/harness/L2-screen/screen-list.md", "optional L2\n");
    const withoutL2 = lintG3Trace(fixtureHarness());
    expect(withoutL2.ok).toBe(true);
    expect(lintG3Trace(withL2)).toEqual(withoutL2);
  });
});
