import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeGithubCiPolicy } from "../src/lint/github-ci-policy.ts";
import { analyzeRuleDrift } from "../src/lint/rule-drift.ts";
import { analyzeRuntimePortability } from "../src/lint/runtime-portability.ts";
import { analyzeToolchainPin } from "../src/lint/toolchain-pin.ts";

const B = ["b", "un"].join("");
const BU = ["B", "un"].join("");
const BX = ["b", "un", "x"].join("");
const BC = ["b", "un", ".cmd"].join("");
const BE = ["b", "un", ".exe"].join("");
const PROBE = "src/__packbun_probe__.ts";

type PortabilitySample = { readonly id: string; readonly rule: string; readonly text: string };
const PORTABILITY_SAMPLES: readonly PortabilitySample[] = [
  { id: "1-bun", rule: `${B}-runtime-spawn`, text: `spawnSync("${B}", args);` },
  { id: "1-bun.cmd", rule: `${B}-runtime-spawn`, text: `spawnSync("${BC}", args);` },
  { id: "1-bun.exe", rule: `${B}-runtime-spawn`, text: `spawnSync("${BE}", args);` },
  { id: "2", rule: `${B}-runtime-spawn`, text: `const p = find${BU}();` },
  { id: "3", rule: `${B}-runtime-spawn`, text: `const exe = env.EXE ?? "${B}";` },
  { id: "4", rule: `${B}-runtime-spawn`, text: `spawn(comspec, ["/c", "${B}", "x"]);` },
  { id: "5", rule: `${B}-runtime-spawn`, text: `const cmd = ["${B}", ["run"]];` },
  { id: "6", rule: `${B}-runtime-spawn`, text: `const sh = "exec ${B} run test";` },
  { id: "7", rule: `${B}-module-import`, text: `import { Database } from "${B}:sqlite";` },
  { id: "8", rule: `${B}-global-reference`, text: `${BU}.write(path, body);` },
  { id: "9", rule: `${B}-global-reference`, text: `if (typeof ${BU} !== "undefined") return 1;` },
  {
    id: "10",
    rule: `${B}-global-reference`,
    text: `const r = (globalThis as { ${BU}?: unknown }).${BU};`,
  },
  { id: "11", rule: `${B}-global-reference`, text: `if (globalThis.${BU}) return 1;` },
  { id: "12", rule: `${B}-global-reference`, text: `if (process.versions.${B}) return 1;` },
];

const packWorkflow = (step: string): string => {
  const template = readFileSync(
    join(process.cwd(), "docs", "templates", "github", "common", "pack-harness-check.yml"),
    "utf8",
  );
  const marker = "    steps:\n";
  const at = template.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const cut = at + marker.length;
  return `${template.slice(0, cut)}      - run: ${step}\n${template.slice(cut)}`;
};

describe("U-PACKBUN-006: BAN lint detection power (PLAN-L7-522 §3.3)", () => {
  it.each(PORTABILITY_SAMPLES)("sample $id still fail-closes as $rule in runtime-portability", ({
    rule,
    text,
  }) => {
    const result = analyzeRuntimePortability([{ path: PROBE, text }]);
    expect(
      result.violations
        .map((violation) => violation.rule)
        .filter((candidate) => candidate.startsWith(`${B}-`)),
    ).toEqual([rule]);
  });

  it("sample 13 still fail-closes as forbidden_raw_vitest", () => {
    const result = analyzeGithubCiPolicy([
      {
        file: ".github/workflows/pack-harness-check.yml",
        content: packWorkflow("vitest run"),
        profile: "pack",
        role: "pack_template",
      },
    ]);
    expect(result.violations.map((violation) => violation.reason)).toContain(
      "forbidden_raw_vitest",
    );
  });

  it("sample 13b still fail-closes as forbidden_source_full_tests", () => {
    const result = analyzeGithubCiPolicy([
      {
        file: ".github/workflows/pack-harness-check.yml",
        content: packWorkflow(`${B} run test`),
        profile: "pack",
        role: "pack_template",
      },
    ]);
    expect(result.violations.map((violation) => violation.reason)).toContain(
      "forbidden_source_full_tests",
    );
  });

  // Issue #504: EVA-1 (`npx bun@<version>`) / EVA-4 (`bun.sh/install` installer 経路) の
  // false negative repair. これらは既存 forbidden_bun_execution rule への分岐追加であり、
  // PLAN-L7-522 §3.3 の定義上 weakening ではないので新規サンプルとして凍結する
  // (strengthening 方向、既存サンプルの変更・削除ではない)。
  it("sample 13c still fail-closes as forbidden_bun_execution for npx bun@<version>", () => {
    const result = analyzeGithubCiPolicy([
      {
        file: ".github/workflows/pack-harness-check.yml",
        content: packWorkflow(`npx ${B}@1.3 run build`),
        profile: "pack",
        role: "pack_template",
      },
    ]);
    expect(result.violations.map((violation) => violation.reason)).toContain(
      "forbidden_bun_execution",
    );
  });

  it("sample 13d still fail-closes as forbidden_bun_execution for bun.sh install pipe", () => {
    const result = analyzeGithubCiPolicy([
      {
        file: ".github/workflows/pack-harness-check.yml",
        content: packWorkflow(`curl -fsSL https://${B}.sh/install | bash`),
        profile: "pack",
        role: "pack_template",
      },
    ]);
    expect(result.violations.map((violation) => violation.reason)).toContain(
      "forbidden_bun_execution",
    );
  });

  it("sample 14 still fail-closes the rule-drift bun execution form marker", () => {
    const adapter = (extra: string): string =>
      ["# Adapter", "", "## Hooks", "", extra, ""].join("\n");
    const clean = analyzeRuleDrift({
      agents: adapter("- `node .ut-tdd/bin/ut-tdd.mjs hook work-guard`"),
      claudeProject: adapter("- `node .ut-tdd/bin/ut-tdd.mjs hook work-guard`"),
      claudeRuntime: adapter("- `node .ut-tdd/bin/ut-tdd.mjs hook work-guard`"),
    });
    for (const executable of [B, BX, BC, BE]) {
      const dirty = analyzeRuleDrift({
        agents: adapter(`- run \`${executable} .ut-tdd/bin/ut-tdd.mjs hook work-guard\``),
        claudeProject: adapter("- `node .ut-tdd/bin/ut-tdd.mjs hook work-guard`"),
        claudeRuntime: adapter("- `node .ut-tdd/bin/ut-tdd.mjs hook work-guard`"),
      });
      expect(dirty.forbiddenMarkers).toHaveLength(clean.forbiddenMarkers.length + 1);
      expect(dirty.forbiddenMarkers.map((entry) => entry.marker)).toEqual([`${B} execution form`]);
    }
  });

  it("sample 15 still fail-closes as bun-direct-parity-drift", () => {
    const result = analyzeToolchainPin({
      packageJson: JSON.stringify({ dependencies: { "some-pkg": "1.0.0" } }),
      bunLock: JSON.stringify({ workspaces: { "": { dependencies: {} } } }),
    });
    expect(result.violations.map((violation) => violation.rule)).toContain(
      `${B}-direct-parity-drift`,
    );
  });

  it("keeps the source package.json build script untouched", () => {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(parsed.scripts.build).toBe("node scripts/build-node.mjs");
  });
});

describe("U-PACKBUN-006 structural supplements (PLAN-L7-522 §3.3)", () => {
  const lintSource = (file: string): string =>
    readFileSync(join(process.cwd(), "src", "lint", file), "utf8");
  it("freezes the github-ci-policy Pack deny rule set", () => {
    const source = lintSource("github-ci-policy.ts");
    const reasons = [...source.matchAll(/reason: "(forbidden_[a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(reasons)).toEqual(
      new Set([
        "forbidden_bun_execution",
        "forbidden_full_doctor",
        "forbidden_job_level_lane_skip",
        "forbidden_lane_skip_step",
        "forbidden_pull_request_input_execution",
        "forbidden_raw_vitest",
        "forbidden_source_full_tests",
      ]),
    );
  });

  it("freezes the runtime-portability Bun debt allowlist paths and pins", () => {
    const source = lintSource("runtime-portability.ts");
    const block = (name: string): ReadonlyArray<readonly [string, number]> => {
      const start = source.indexOf(`const ${name} = new Map<string, number>([`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf("]);", start);
      return [...source.slice(start, end).matchAll(/\["([^"]+)",\s*(\d+)\]/g)].map(
        (m) => [m[1], Number(m[2])] as const,
      );
    };
    expect(Object.fromEntries(block(`${BU.toUpperCase()}_SPAWN_DEBT_ALLOWLIST`))).toEqual({
      "src/cli/distribution.ts": 2,
      "tests/dependency-drift.test.ts": 1,
      "tests/runtime-portability.test.ts": 11,
      "tests/doctor-setup-smoke.test.ts": 1,
      "tests/doctor.test.ts": 1,
      "src/lint/runtime-portability.ts": 4,
    });
    expect(Object.fromEntries(block(`${BU.toUpperCase()}_IMPORT_DEBT_ALLOWLIST`))).toEqual({
      "tests/runtime-portability.test.ts": 5,
    });
    expect(Object.fromEntries(block(`${BU.toUpperCase()}_GLOBAL_DEBT_ALLOWLIST`))).toEqual({
      "tests/runtime-portability.test.ts": 7,
      "tests/doctor-test-repository-isolation.test.ts": 2,
      "src/lint/runtime-portability.ts": 3,
    });
  });
});
