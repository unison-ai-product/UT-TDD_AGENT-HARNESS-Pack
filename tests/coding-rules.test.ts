import { describe, expect, it } from "vitest";
import {
  analyzeCodingRules,
  type CodingRulesDoc,
  codingRulesMessages,
  loadCodingRuleDocs,
  loadCodingRulePolicy,
  loadCodingWorkflowDocs,
} from "../src/lint/coding-rules.ts";

describe("U-CODE coding-rules lint", () => {
  it("detects source naming, explicit any, suppression comments, and >3 source params", () => {
    const suppression = ["// @ts", "-ignore"].join("");
    const docs: CodingRulesDoc[] = [
      {
        path: "src/badName.ts",
        scope: "source",
        text: `
${suppression}
export function tooMany(a: string, b: string, c: string, d: string): unknown {
  const value: any = d;
  return value;
}
`,
      },
    ];
    const result = analyzeCodingRules(docs);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule).sort()).toEqual([
      "file-name-kebab",
      "max-source-params",
      "no-explicit-any",
      "no-suppression-comment",
    ]);
  });

  it("allows >3 params in test helpers while keeping strict typing rules active", () => {
    const docs: CodingRulesDoc[] = [
      {
        path: "tests/runtime-hook-entrypoints.test.ts",
        scope: "test",
        text: "function runCli(cwd: string, args: string[], input: unknown, env: Record<string, string>): void {}",
      },
    ];
    expect(analyzeCodingRules(docs).ok).toBe(true);
  });

  it("formats doctor messages with path and rule samples", () => {
    const result = analyzeCodingRules([
      { path: "src/bad-name.ts", scope: "source", text: "const x: any = 1;" },
    ]);
    expect(codingRulesMessages(result)[0]).toContain("src/bad-name.ts");
    expect(codingRulesMessages(result)[0]).toContain("no-explicit-any");
  });

  it("detects coding-rule SSoT policy drift", () => {
    const result = analyzeCodingRules([], {
      path: "docs/governance/coding-rules.md",
      ruleIds: ["no-explicit-any", "unknown-rule"],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule).sort()).toEqual([
      "coding-policy-missing-rule",
      "coding-policy-missing-rule",
      "coding-policy-missing-rule",
      "coding-policy-missing-rule",
      "coding-policy-missing-rule",
      "coding-policy-missing-rule",
      "coding-policy-unknown-rule",
    ]);
  });

  it("detects missing coding-rule workflow placement", () => {
    const result = analyzeCodingRules(
      [],
      {
        path: "docs/governance/coding-rules.md",
        ruleIds: [
          "no-explicit-any",
          "no-suppression-comment",
          "file-name-kebab",
          "max-source-params",
          "structured-error-handling",
          "module-boundary",
          "machine-surface-language",
        ],
      },
      [
        {
          path: "docs/governance/coding-rules.md",
          exists: true,
          text: "Workflow Placement\nForward L6\nAdd-feature\n",
        },
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("coding-workflow-missing-doc");
  });

  it("detects empty and rethrow-only catch blocks in source", () => {
    const result = analyzeCodingRules([
      {
        path: "src/runtime/bad-error.ts",
        scope: "source",
        text: `
export function emptyCatch(): void {
  try {
    JSON.parse("bad");
  } catch {
  }
}

export function rethrowOnly(): void {
  try {
    JSON.parse("bad");
  } catch (error) {
    throw error;
  }
}
`,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.rule === "structured-error-handling")).toHaveLength(2);
  });

  it("allows a catch block to convert a parser error into a domain integrity error", () => {
    const result = analyzeCodingRules([
      {
        path: "src/execution/parser.ts",
        scope: "source",
        text: `
export function parse(): never {
  try {
    JSON.parse("bad");
    throw new Error("unreachable");
  } catch {
    throw new Error("journal-integrity-failure");
  }
}
`,
      },
    ]);
    expect(result.violations).toEqual([]);
  });

  it("detects source module boundary drift", () => {
    const result = analyzeCodingRules([
      {
        path: "src/lint/bad-boundary.ts",
        scope: "source",
        text: 'import { detectMode } from "../runtime/detect";\nexport const x = detectMode;',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("module-boundary");
  });

  it("U-CODE-010: detects machine-facing status messages without ASCII decision tokens", () => {
    const result = analyzeCodingRules([
      {
        path: "src/lint/bad-language.ts",
        scope: "source",
        text: 'export function badMessages(): string[] { return ["bad-rule — 警告: 日本語だけの判定語"]; }',
      },
      {
        path: "src/lint/good-language.ts",
        scope: "source",
        text: 'export function goodMessages(): string[] { return ["good-rule - warning: 日本語の説明を続けてもよい"]; }',
      },
    ]);

    expect(result.violations.map((v) => v.rule)).toEqual(["machine-surface-language"]);
    expect(result.violations[0].path).toBe("src/lint/bad-language.ts");
  });

  it("real repo guard has no coding-rule violations", () => {
    const result = analyzeCodingRules(
      loadCodingRuleDocs(process.cwd()),
      loadCodingRulePolicy(),
      loadCodingWorkflowDocs(),
    );
    expect(result.violations).toEqual([]);
  });
});

describe("U-CODE-011 test-title literal recognition", () => {
  const fixturePath = "src/candidate-title.ts";
  const machineText = ["bad-rule", " — ", "警告", ": ", "日本語だけ", "の判定語"].join("");
  const literalKinds = ["string", "template"] as const;
  type LiteralKind = (typeof literalKinds)[number];
  const literal = (kind: LiteralKind, value: string): string =>
    kind === "string" ? JSON.stringify(value) : `\`${value}\``;
  const fixtureResult = (text: string) =>
    analyzeCodingRules([{ path: fixturePath, scope: "source", text }]);
  const expectExempt = (text: string): void => {
    const result = fixtureResult(text);
    expect(result.violations).toEqual([]);
  };
  const expectLanguageViolation = (text: string, count = 1): void => {
    const result = fixtureResult(text);
    expect(result.violations.map(({ path, rule }) => ({ path, rule }))).toEqual(
      Array.from({ length: count }, () => ({
        path: fixturePath,
        rule: "machine-surface-language",
      })),
    );
  };

  const modifierCalls = ["describe", "it", "test"].flatMap((receiver) =>
    ["fails", "skip", "only", "todo"].map((modifier) => ({
      name: `${receiver}.${modifier}`,
      expression: `${receiver}.${modifier}`,
    })),
  );
  const eachCalls = [
    { name: "describe.each", expression: "describe.each(data)(TITLE)" },
    { name: "it.each", expression: "it.each(data)(TITLE)" },
    { name: "test.each", expression: "test.each(data)(TITLE)" },
    { name: "it.fails.each", expression: "it.fails.each(data)(TITLE)" },
  ];

  const missingPositiveCases = [
    ...modifierCalls.flatMap(({ name, expression }) =>
      literalKinds.map((kind) => ({
        name: `${name} title ${kind}`,
        kind,
        text: `${expression}(${literal(kind, machineText)});`,
      })),
    ),
    ...eachCalls.flatMap(({ name, expression }) =>
      literalKinds.map((kind) => ({
        name: `${name} returned-call title ${kind}`,
        kind,
        text: `${expression.replace("TITLE", literal(kind, machineText))};`,
      })),
    ),
  ];

  for (const candidate of missingPositiveCases) {
    it(`U-CODE-011: candidate exemption ${candidate.name}`, () => {
      expectExempt(candidate.text);
    });
  }

  for (const receiver of ["describe", "it", "test"]) {
    for (const kind of literalKinds) {
      it(`U-CODE-011: existing bare ${receiver} title ${kind}`, () => {
        expectExempt(`${receiver}(${literal(kind, machineText)});`);
      });
    }
  }

  for (const candidate of missingPositiveCases) {
    it(`U-CODE-011: fixture prerequisite ${candidate.name}`, () => {
      expectLanguageViolation(`const message = ${literal(candidate.kind, machineText)};`);
    });
  }

  for (const { name, expression } of eachCalls) {
    for (const kind of literalKinds) {
      it(`U-CODE-011: data is not a ${name} title (${kind})`, () => {
        const fixture = expression
          .replace("(data)", `(${literal(kind, machineText)})`)
          .replace("(TITLE)", '("neutral")');
        expectLanguageViolation(`${fixture};`);
      });
    }
  }

  const negativeLiteralCases = [
    ...literalKinds.flatMap((kind) => {
      const value = literal(kind, machineText);
      return [
        { name: `unknown receiver ${kind}`, text: `unknownReceiver(${value});` },
        {
          name: `unknown receiver modifier chain ${kind}`,
          text: `unknownReceiver.skip(${value});`,
        },
        {
          name: `unknown receiver each chain ${kind}`,
          text: `unknownReceiver.each(data)(${value});`,
        },
        { name: `unlisted modifier ${kind}`, text: `it.concurrent(${value});` },
        { name: `other chain ${kind}`, text: `it.each(data).skip(${value});` },
        { name: `namespace receiver ${kind}`, text: `vitest.it(${value});` },
        { name: `namespace modifier chain ${kind}`, text: `vitest.it.skip(${value});` },
        { name: `test fails each chain ${kind}`, text: `test.fails.each(data)(${value});` },
        { name: `describe fails each chain ${kind}`, text: `describe.fails.each(data)(${value});` },
        { name: `it only each chain ${kind}`, text: `it.only.each(data)(${value});` },
        { name: `title outside call ${kind}`, text: `const message = ${value}; it("neutral");` },
        { name: `second argument ${kind}`, text: `it("neutral", ${value});` },
        { name: `modifier second argument ${kind}`, text: `it.skip("neutral", ${value});` },
        {
          name: `each returned-call second argument ${kind}`,
          text: `it.each(data)("neutral", ${value});`,
        },
      ];
    }),
  ];
  for (const candidate of negativeLiteralCases) {
    it(`U-CODE-011: negative boundary ${candidate.name}`, () => {
      expectLanguageViolation(candidate.text);
    });
  }

  for (const kind of literalKinds) {
    it(`U-CODE-011: dynamic title expression remains checked (${kind})`, () => {
      expectLanguageViolation(`it(${literal(kind, machineText)} + suffix);`);
    });
  }

  it(`U-CODE-011: template expression remains checked`, () => {
    const expression = ["bad-rule — ", "警告", ": $", "{value}"].join("");
    expectLanguageViolation(`it(\`${expression}\`);`);
  });
});
