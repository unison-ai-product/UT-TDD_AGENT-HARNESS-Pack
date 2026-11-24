/**
 * issue #693 windowsHide contract regression.
 * Contract: docs/design/harness/L6-function-design/windows-hide-default.md
 * Test design: docs/test-design/harness/L7-windows-hide-default-test-design.md
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNodeBinary } from "../scripts/run-vitest-snapshot.ts";
import { buildFullDoctorCheckDefinitions } from "../src/doctor/check-definitions.ts";
import { nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import { guardBootstrapHookArgs } from "../src/lint/project-hook.ts";
import { buildCleanDistributionPlan, buildPackSyncPlan } from "../src/setup/distribution.ts";
import { removeTestTree } from "./support/temp-tree.ts";

type ChildProcessFunction = (...args: unknown[]) => unknown;
type FakeChildProcess = Record<string, ChildProcessFunction>;
type WindowsHideSource = { path: string; content: string };
type WindowsHideInput = { sources: WindowsHideSource[]; entries: string[] };
type WindowsHideResult = { ok: boolean; messages: string[] };
type WindowsHideModule = {
  applyWindowsHideDefault(module: FakeChildProcess): void;
  analyzeWindowsHide(input: WindowsHideInput): WindowsHideResult;
};

const root = process.cwd();
const WINDOWS_HIDE_MODULE: string = "../src/runtime/windows-hide.ts";
const WINDOWS_HIDE_DOCTOR_MODULE: string = "../src/doctor/windows-hide.ts";
const WRAPPED = Symbol.for("ut-tdd.windowsHide.wrapped");
const CHILD_PROCESS_FUNCTIONS = [
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
  "fork",
] as const;
const TEST_SETUP_ENTRY = "tests/windows-hide-setup.ts";
const SCRIPT_ENTRIES = [
  "scripts/build-node.mjs",
  "scripts/node-generation-ci.mjs",
  "scripts/pack-canary-acceptance.mjs",
  "scripts/run-vitest-snapshot.ts",
  "scripts/git-hooks/secret-scan-diff.ts",
];
const HOOK_ENTRIES = [
  ".claude/hooks/agent-guard.ts",
  ".claude/hooks/session-log.ts",
  ".claude/hooks/work-guard.ts",
];
const STATIC_ENTRIES = ["src/cli.ts", ...HOOK_ENTRIES, ...SCRIPT_ENTRIES];
const FIXTURE_ROOTS: string[] = [];

afterEach(() => {
  for (const fixtureRoot of FIXTURE_ROOTS.splice(0)) removeTestTree(fixtureRoot);
});

async function loadWindowsHide(): Promise<WindowsHideModule> {
  const [runtime, doctor] = await Promise.all([
    import(WINDOWS_HIDE_MODULE),
    import(WINDOWS_HIDE_DOCTOR_MODULE),
  ]);
  return {
    applyWindowsHideDefault: runtime.applyWindowsHideDefault,
    analyzeWindowsHide: doctor.analyzeWindowsHide,
  };
}

function fakeChildProcess() {
  const calls = new Map<string, unknown[]>();
  const module = {} as FakeChildProcess;
  for (const name of CHILD_PROCESS_FUNCTIONS) {
    module[name] = (...args: unknown[]) => {
      calls.set(name, args);
      return { name, args };
    };
  }
  return { module, calls };
}

function callOptions(args: unknown[]): Record<string, unknown> | undefined {
  for (let index = args.length - 1; index >= 1; index -= 1) {
    const candidate = args[index];
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate))
      return candidate as Record<string, unknown>;
  }
  return undefined;
}

function analyze(
  mod: WindowsHideModule,
  sources: WindowsHideSource[],
  entries: string[],
): WindowsHideResult {
  return mod.analyzeWindowsHide({ sources, entries });
}

function entrySource(path: string, content?: string) {
  const importPath = path.startsWith("src/")
    ? "./runtime/windows-hide.ts"
    : path.startsWith(".claude/hooks/")
      ? "../../src/runtime/windows-hide.ts"
      : path.startsWith("scripts/git-hooks/")
        ? "../../src/runtime/windows-hide.ts"
        : "../src/runtime/windows-hide.ts";
  content ??= `import "${importPath}";\nexport {};`;
  return { path, content };
}

function wrapperSource(): WindowsHideSource {
  return { path: "src/runtime/windows-hide.ts", content: "export {};\n" };
}

function writeFixtureFile(fixtureRoot: string, path: string, content: string): void {
  const destination = join(fixtureRoot, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

function windowsHideCheck(repoRoot: string) {
  const definition = buildFullDoctorCheckDefinitions(nodeDoctorDeps(repoRoot)).find(
    (candidate) => candidate.id === "windows-hide",
  );
  expect(definition, "doctor registers the windows-hide check").toBeDefined();
  if (!definition) throw new Error("doctor does not register the windows-hide check");
  return definition.run();
}

function writeValidWindowsHideFixture(fixtureRoot: string, omitCliImport = false): void {
  const wrapper = wrapperSource();
  writeFixtureFile(fixtureRoot, wrapper.path, wrapper.content);
  for (const path of STATIC_ENTRIES) {
    const content =
      omitCliImport && path === "src/cli.ts" ? "export {};\n" : entrySource(path).content;
    const scriptContent = path.startsWith("scripts/")
      ? content.replace("\nexport {};", '\nimport "node:child_process";\nexport {};')
      : content;
    writeFixtureFile(fixtureRoot, path, scriptContent);
  }
  writeFixtureFile(
    fixtureRoot,
    "vitest.config.ts",
    `export default { test: { setupFiles: ["${TEST_SETUP_ENTRY}"] } };`,
  );
  writeFixtureFile(fixtureRoot, TEST_SETUP_ENTRY, entrySource(TEST_SETUP_ENTRY).content);
  // Per-call omissions are intentionally not part of this gate.
  writeFixtureFile(fixtureRoot, "src/child-process.ts", 'spawnSync("git", ["status"]);\n');
}

function packPlan(sourcePaths: string[]) {
  const exportPlan = buildCleanDistributionPlan({ paths: sourcePaths, sourceTag: "test" });
  return buildPackSyncPlan({
    exportPlan,
    sourcePaths,
    stagingDir: "C:/temporary/ut-tdd-pack-fixture",
  });
}

describe("issue #693 子プロセス windowsHide 既定 (Red)", () => {
  describe("U-WHIDE-001", () =>
    it("U-WHIDE-001: 7 関数すべてが未指定時 true と他 options を保つ", async () => {
      const { applyWindowsHideDefault } = await loadWindowsHide();
      const { module, calls } = fakeChildProcess();
      applyWindowsHideDefault(module);

      const callArgs: Record<(typeof CHILD_PROCESS_FUNCTIONS)[number], unknown[]> = {
        spawn: ["tool", [], { cwd: "fixture" }],
        spawnSync: ["tool", [], { cwd: "fixture" }],
        execFile: ["tool", [], { cwd: "fixture" }],
        execFileSync: ["tool", [], { cwd: "fixture" }],
        exec: ["tool", { cwd: "fixture" }],
        execSync: ["tool", { cwd: "fixture" }],
        fork: ["module", [], { cwd: "fixture" }],
      };
      for (const name of CHILD_PROCESS_FUNCTIONS) {
        module[name](...callArgs[name]);
        expect(callOptions(calls.get(name) ?? []), name).toEqual({
          cwd: "fixture",
          windowsHide: true,
        });
      }
    }));

  describe("U-WHIDE-002", () =>
    it("U-WHIDE-002: syncBuiltinESMExports 後の named import に既定が届く", async () => {
      const script = `
      import childProcess from "node:child_process";
      import { spawnSync } from "node:child_process";
      let observed;
      childProcess.spawnSync = (...args) => { observed = args; return { status: 0 }; };
      await import(${JSON.stringify(pathToFileURL(join(root, "src/runtime/windows-hide.ts")).href)});
      spawnSync("stub");
      process.stdout.write(JSON.stringify(observed));
    `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout) as unknown[];
      expect(observed).toEqual(["stub", [], { windowsHide: true }]);
    }));

  describe("U-WHIDE-003", () =>
    it("U-WHIDE-003: overload の options と callback の位置を正規化する", async () => {
      const { applyWindowsHideDefault } = await loadWindowsHide();
      const { module, calls } = fakeChildProcess();
      applyWindowsHideDefault(module);

      module.spawn("tool");
      expect(calls.get("spawn")).toEqual(["tool", [], { windowsHide: true }]);
      module.spawn("tool", ["arg"]);
      expect(calls.get("spawn")).toEqual(["tool", ["arg"], { windowsHide: true }]);
      module.spawn("tool", { cwd: "fixture" });
      expect(calls.get("spawn")).toEqual(["tool", { cwd: "fixture", windowsHide: true }]);
      module.spawn("tool", null);
      expect(calls.get("spawn")).toEqual(["tool", [], { windowsHide: true }]);
      module.spawn("tool", null, { cwd: "fixture" });
      expect(calls.get("spawn")).toEqual(["tool", null, { cwd: "fixture", windowsHide: true }]);
      module.spawnSync("tool");
      expect(calls.get("spawnSync")).toEqual(["tool", [], { windowsHide: true }]);
      module.spawnSync("tool", ["arg"]);
      expect(calls.get("spawnSync")).toEqual(["tool", ["arg"], { windowsHide: true }]);
      module.spawnSync("tool", { cwd: "fixture" });
      expect(calls.get("spawnSync")).toEqual(["tool", { cwd: "fixture", windowsHide: true }]);
      module.spawnSync("tool", undefined);
      expect(calls.get("spawnSync")).toEqual(["tool", [], { windowsHide: true }]);
      module.spawnSync("tool", null);
      expect(calls.get("spawnSync")).toEqual(["tool", [], { windowsHide: true }]);
      module.spawnSync("tool", undefined, { cwd: "fixture" });
      expect(calls.get("spawnSync")).toEqual([
        "tool",
        undefined,
        { cwd: "fixture", windowsHide: true },
      ]);
      module.spawnSync("tool", ["arg"], { cwd: "fixture" });
      expect(calls.get("spawnSync")).toEqual([
        "tool",
        ["arg"],
        { cwd: "fixture", windowsHide: true },
      ]);

      const callback = () => undefined;
      module.execFile("tool");
      expect(calls.get("execFile")).toEqual(["tool", [], { windowsHide: true }]);
      module.execFile("tool", callback);
      expect(calls.get("execFile")).toEqual(["tool", { windowsHide: true }, callback]);
      module.execFile("tool", ["arg"]);
      expect(calls.get("execFile")).toEqual(["tool", ["arg"], { windowsHide: true }]);
      module.execFile("tool", { cwd: "fixture" });
      expect(calls.get("execFile")).toEqual(["tool", { cwd: "fixture", windowsHide: true }]);
      module.execFile("tool", ["arg"], callback);
      expect(calls.get("execFile")).toEqual(["tool", ["arg"], { windowsHide: true }, callback]);
      module.execFile("tool", { cwd: "fixture" }, callback);
      expect(calls.get("execFile")).toEqual([
        "tool",
        { cwd: "fixture", windowsHide: true },
        callback,
      ]);
      module.execFile("tool", ["arg"], { cwd: "fixture" }, callback);
      expect(calls.get("execFile")).toEqual([
        "tool",
        ["arg"],
        { cwd: "fixture", windowsHide: true },
        callback,
      ]);
      module.execFile("tool", undefined);
      expect(calls.get("execFile")).toEqual(["tool", [], { windowsHide: true }]);
      module.execFile("tool", null, { cwd: "fixture" }, callback);
      expect(calls.get("execFile")).toEqual([
        "tool",
        null,
        { cwd: "fixture", windowsHide: true },
        callback,
      ]);
      module.exec("tool");
      expect(calls.get("exec")).toEqual(["tool", { windowsHide: true }]);
      module.exec("tool", callback);
      expect(calls.get("exec")).toEqual(["tool", { windowsHide: true }, callback]);
      module.exec("tool", { cwd: "fixture" });
      expect(calls.get("exec")).toEqual(["tool", { cwd: "fixture", windowsHide: true }]);
      module.exec("tool", { cwd: "fixture" }, callback);
      expect(calls.get("exec")).toEqual(["tool", { cwd: "fixture", windowsHide: true }, callback]);
      module.execSync("tool");
      expect(calls.get("execSync")).toEqual(["tool", { windowsHide: true }]);
      module.execSync("tool", { cwd: "fixture" });
      expect(calls.get("execSync")).toEqual(["tool", { cwd: "fixture", windowsHide: true }]);
      module.execFileSync("tool");
      expect(calls.get("execFileSync")).toEqual(["tool", [], { windowsHide: true }]);
      module.execFileSync("tool", ["arg"]);
      expect(calls.get("execFileSync")).toEqual(["tool", ["arg"], { windowsHide: true }]);
      module.execFileSync("tool", { cwd: "fixture" });
      expect(calls.get("execFileSync")).toEqual(["tool", { cwd: "fixture", windowsHide: true }]);
      module.execFileSync("tool", null);
      expect(calls.get("execFileSync")).toEqual(["tool", [], { windowsHide: true }]);
      module.execFileSync("tool", undefined, { cwd: "fixture" });
      expect(calls.get("execFileSync")).toEqual([
        "tool",
        undefined,
        { cwd: "fixture", windowsHide: true },
      ]);
      module.execFileSync("tool", ["arg"], { cwd: "fixture" });
      expect(calls.get("execFileSync")).toEqual([
        "tool",
        ["arg"],
        { cwd: "fixture", windowsHide: true },
      ]);
      module.execFileSync("tool", null, { cwd: "fixture" });
      expect(calls.get("execFileSync")).toEqual([
        "tool",
        null,
        { cwd: "fixture", windowsHide: true },
      ]);
      module.fork("module");
      expect(calls.get("fork")).toEqual(["module", [], { windowsHide: true }]);
      module.fork("module", ["arg"]);
      expect(calls.get("fork")).toEqual(["module", ["arg"], { windowsHide: true }]);
      module.fork("module", { cwd: "fixture" });
      expect(calls.get("fork")).toEqual(["module", { cwd: "fixture", windowsHide: true }]);
      module.fork("module", undefined);
      expect(calls.get("fork")).toEqual(["module", [], { windowsHide: true }]);
      module.fork("module", undefined, { cwd: "fixture" });
      expect(calls.get("fork")).toEqual([
        "module",
        undefined,
        { cwd: "fixture", windowsHide: true },
      ]);
      module.fork("module", ["arg"], { cwd: "fixture" });
      expect(calls.get("fork")).toEqual(["module", ["arg"], { cwd: "fixture", windowsHide: true }]);
    }));

  describe("U-WHIDE-004", () =>
    it("U-WHIDE-004: 7 関数で明示 false と true を上書きしない", async () => {
      const { applyWindowsHideDefault } = await loadWindowsHide();
      const { module, calls } = fakeChildProcess();
      applyWindowsHideDefault(module);
      for (const name of CHILD_PROCESS_FUNCTIONS) {
        const optionsIndex = name === "exec" || name === "execSync" ? 1 : 2;
        const args =
          optionsIndex === 1
            ? ["tool", { windowsHide: false }] // windows-hide: explicit false preservation oracle
            : ["tool", [], { windowsHide: false }]; // windows-hide: explicit false preservation oracle
        module[name](...args);
        expect(callOptions(calls.get(name) ?? [])?.windowsHide, `${name} false`).toBe(false);
        args[optionsIndex] = { windowsHide: true };
        module[name](...args);
        expect(callOptions(calls.get(name) ?? [])?.windowsHide, `${name} true`).toBe(true);
      }
    }));

  describe("U-WHIDE-005", () =>
    it("U-WHIDE-005: 適用と module 再評価の両方で wrapper は一段だけ", async () => {
      const first = (await import(`${WINDOWS_HIDE_MODULE}?first`)) as WindowsHideModule;
      const second = (await import(`${WINDOWS_HIDE_MODULE}?second`)) as WindowsHideModule;
      const { module } = fakeChildProcess();
      first.applyWindowsHideDefault(module);
      const once = module.spawnSync;
      first.applyWindowsHideDefault(module);
      expect(module.spawnSync).toBe(once);
      second.applyWindowsHideDefault(module);
      expect(module.spawnSync).toBe(once);

      let layers = 0;
      let current = module.spawnSync as ChildProcessFunction & Record<symbol, unknown>;
      while (typeof current[WRAPPED] === "function") {
        layers += 1;
        current = current[WRAPPED] as ChildProcessFunction & Record<symbol, unknown>;
      }
      expect(current).toBeDefined();
      expect(layers).toBe(1);
    }));

  describe("U-WHIDE-006", () =>
    it("U-WHIDE-006: caller options は書き換えず、同じ object を再利用できる", async () => {
      const { applyWindowsHideDefault } = await loadWindowsHide();
      const { module, calls } = fakeChildProcess();
      applyWindowsHideDefault(module);
      const options = { cwd: "fixture" };
      module.spawn("tool", options);
      const firstOptions = calls.get("spawn")?.[1];
      module.spawn("tool", options);
      const secondOptions = calls.get("spawn")?.[1];
      expect(options).toEqual({ cwd: "fixture" });
      expect(firstOptions).toEqual({ cwd: "fixture", windowsHide: true });
      expect(secondOptions).toEqual({ cwd: "fixture", windowsHide: true });
      expect(firstOptions).not.toBe(options);
      expect(secondOptions).not.toBe(options);
    }));

  describe("U-WHIDE-007", () =>
    it("U-WHIDE-007: 戻り値・例外・this は下位関数と同一", async () => {
      const { applyWindowsHideDefault } = await loadWindowsHide();
      const returned = { exact: true };
      const thrown = new Error("same error");
      const module = {
        spawn() {
          return this;
        },
        spawnSync() {
          throw thrown;
        },
        execFile: () => returned,
        execFileSync: () => returned,
        exec: () => returned,
        execSync: () => returned,
        fork: () => returned,
      } as unknown as FakeChildProcess;
      applyWindowsHideDefault(module);
      expect(module.spawn()).toBe(module);
      expect(module.execFile()).toBe(returned);
      expect(module.execFileSync()).toBe(returned);
      expect(module.exec()).toBe(returned);
      expect(module.execSync()).toBe(returned);
      expect(module.fork()).toBe(returned);
      let caught: unknown;
      try {
        module.spawnSync();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrown);
    }));

  describe("U-WHIDE-008", () =>
    it("U-WHIDE-008: 入口 import の欠落と先頭以外を finding にする", async () => {
      const mod = await loadWindowsHide();
      const entries = [
        "src/cli.ts",
        ".claude/hooks/agent-guard.ts",
        "tests/windows-hide-setup.ts",
        "scripts/build-node.mjs",
      ];
      const good = [wrapperSource(), ...entries.map((path) => entrySource(path))];
      expect(analyze(mod, good, entries).ok).toBe(true);

      const missingHook = good.map((file) =>
        file.path === ".claude/hooks/agent-guard.ts" ? { ...file, content: "export {};" } : file,
      );
      const missing = analyze(mod, missingHook, entries);
      expect(missing.ok).toBe(false);
      expect(missing.messages.join("\n")).toContain("windows-hide-entry-missing");

      const lateImport = good.map((file) =>
        file.path === "src/cli.ts"
          ? { ...file, content: 'import "node:fs";\nimport "../src/runtime/windows-hide.ts";' }
          : file,
      );
      expect(analyze(mod, lateImport, entries).messages.join("\n")).toContain(
        "windows-hide-entry-missing",
      );
    }));

  describe("U-WHIDE-009", () =>
    it("U-WHIDE-009: vitest setupFiles は有効、globalSetup 単独は不足", async () => {
      const mod = await loadWindowsHide();
      const entries = ["src/cli.ts", "tests/windows-hide-setup.ts"];
      const setupFiles = analyze(
        mod,
        [
          wrapperSource(),
          entrySource("src/cli.ts"),
          {
            path: "vitest.config.ts",
            content: 'export default { test: { setupFiles: ["tests/windows-hide-setup.ts"] } };',
          },
          entrySource("tests/windows-hide-setup.ts"),
        ],
        entries,
      );
      expect(setupFiles.ok).toBe(true);

      const globalSetupOnly = analyze(
        mod,
        [
          wrapperSource(),
          entrySource("src/cli.ts"),
          {
            path: "vitest.config.ts",
            content: 'export default { test: { globalSetup: ["tests/windows-hide-setup.ts"] } };',
          },
          entrySource("tests/windows-hide-setup.ts"),
        ],
        ["src/cli.ts"],
      );
      expect(globalSetupOnly.ok).toBe(false);
      expect(globalSetupOnly.messages.join("\n")).toContain("windows-hide-entry-missing");
    }));

  describe("U-WHIDE-010", () =>
    it("U-WHIDE-010: false だけに非空の同一行/直前理由を要求する", async () => {
      const mod = await loadWindowsHide();
      const entries = ["src/cli.ts"];
      const valid = analyze(
        mod,
        [
          wrapperSource(),
          entrySource("src/cli.ts"),
          {
            path: "src/options.ts",
            content: [
              "const sameLine = { windowsHide: false }; // windows-hide: gui を見せる",
              "// windows-hide: GUI 呼び出しの理由",
              "const previousLine = { windowsHide: false };",
              "const hidden = { windowsHide: true };",
            ].join("\n"),
          },
        ],
        entries,
      );
      expect(valid.ok).toBe(true);

      const invalid = analyze(
        mod,
        [
          wrapperSource(),
          entrySource("src/cli.ts"),
          {
            path: "src/options.ts",
            content: [
              "const unexplained = { windowsHide: false };",
              "// windows-hide:",
              "const emptyReason = { windowsHide: false };",
            ].join("\n"),
          },
        ],
        entries,
      );
      expect(invalid.ok).toBe(false);
      expect(
        invalid.messages.filter((message) => message.includes("windows-hide-false-unexplained")),
      ).toEqual([
        expect.stringMatching(/^src\/options\.ts:1:.*windows-hide-false-unexplained/),
        expect.stringMatching(/^src\/options\.ts:3:.*windows-hide-false-unexplained/),
      ]);
    }));

  describe("U-WHIDE-011", () =>
    it("U-WHIDE-011: 入力順を変えても違反順と集計が決定的", async () => {
      const mod = await loadWindowsHide();
      const sources = [
        wrapperSource(),
        { path: "src/second.ts", content: "const x = { windowsHide: false };" },
        { path: "src/cli.ts", content: "export {};" },
        { path: "src/first.ts", content: "const x = { windowsHide: false };" },
      ];
      const entries = ["src/cli.ts"];
      const first = analyze(mod, sources, entries);
      const second = analyze(mod, [...sources].reverse(), [...entries].reverse());
      expect(first.messages).toEqual(second.messages);
      expect(first.messages.at(-1)).toContain("checked=4 entries=1 falses=2 violations=3");
    }));

  describe("U-WHIDE-012", () =>
    it("U-WHIDE-012: 実 repo と doctor の clean/違反 fixture を fail-close する", () => {
      const actual = windowsHideCheck(root);
      expect(actual.ok).toBe(true);

      const validRoot = mkdtempSync(join(tmpdir(), "ut-tdd-windows-hide-valid-"));
      FIXTURE_ROOTS.push(validRoot);
      writeValidWindowsHideFixture(validRoot);
      const valid = windowsHideCheck(validRoot);
      expect(valid.ok).toBe(true);
      expect(valid.messages.at(-1)).toContain("checked=12 entries=9 falses=0 violations=0");

      const invalidRoot = mkdtempSync(join(tmpdir(), "ut-tdd-windows-hide-invalid-"));
      FIXTURE_ROOTS.push(invalidRoot);
      writeValidWindowsHideFixture(invalidRoot, true);
      writeFixtureFile(invalidRoot, "src/options.ts", "const options = { windowsHide: false };\n");
      const invalid = windowsHideCheck(invalidRoot);
      expect(invalid.ok).toBe(false);
      expect(invalid.messages).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/src\/cli\.ts:1:.*windows-hide-entry-missing/),
          expect.stringMatching(/src\/options\.ts:1:.*windows-hide-false-unexplained/),
          expect.stringContaining("checked=13 entries=9 falses=1 violations=2"),
        ]),
      );
    }));

  describe("U-WHIDE-013", () =>
    it("U-WHIDE-013: 実 Pack 配布集合の CLI/template に wrapper が含まれ、除外時は検知する", async () => {
      const mod = await loadWindowsHide();
      const sourcePaths = execFileSync("git", ["ls-files"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      })
        .split(/\r?\n/)
        .filter(Boolean);
      const entries = ["src/cli.ts"];
      const consumerTemplates = [
        "docs/templates/adapter/.claude/settings.json",
        "docs/templates/adapter/.codex/hooks.json",
      ] as const;
      const claudeTemplatePath = consumerTemplates[0];
      const codexTemplatePath = consumerTemplates[1];
      const requiredSources = new Set(["src/runtime/windows-hide.ts", ...entries]);
      const plan = packPlan(sourcePaths);
      const packedPaths = plan.copyPlan.map((entry) => entry.artifactPath);
      expect(packedPaths).toContain("src/runtime/windows-hide.ts");
      expect(packedPaths).toContain("src/cli.ts");
      for (const template of consumerTemplates) expect(packedPaths).toContain(template);
      for (const entry of entries) expect(packedPaths).toContain(entry);

      type ConsumerHook = { command?: string; args?: string[]; matcher?: string };
      type ConsumerTemplate = {
        hooks: Record<string, Array<{ matcher?: string; hooks?: ConsumerHook[] }>>;
      };
      const packedTemplateContent = (artifactPath: string): string => {
        const artifact = plan.copyPlan.find((entry) => entry.artifactPath === artifactPath);
        expect(artifact, `${artifactPath} is in the Pack copy plan`).toBeDefined();
        if (!artifact) throw new Error(`Pack copy plan is missing ${artifactPath}`);
        return readFileSync(join(root, artifact.sourcePath), "utf8");
      };
      const collectCommands = (template: ConsumerTemplate): ConsumerHook[] =>
        Object.values(template.hooks).flatMap((entries) =>
          entries.flatMap(({ matcher, hooks }) =>
            (hooks ?? []).map((hook) => Object.assign(hook, { matcher })),
          ),
        );
      const [claudeTemplate, codexTemplate] = [claudeTemplatePath, codexTemplatePath].map(
        (path) => JSON.parse(packedTemplateContent(path)) as ConsumerTemplate,
      );
      const claudeCommands = collectCommands(claudeTemplate);
      const codexCommands = collectCommands(codexTemplate);
      expect(claudeCommands.length * codexCommands.length).toBeGreaterThan(0);
      const expectedGuards = new Map<string, "agent-guard" | "work-guard">([
        ["Agent|Task", "agent-guard"],
        ["Edit|Write|MultiEdit", "work-guard"],
      ]);
      const isCanonicalClaudeHook = (hook: ConsumerHook): boolean => {
        const guard = expectedGuards.get(hook.matcher ?? "");
        if (hook.command !== "node") return false;
        if (guard)
          return (
            JSON.stringify(hook.args) === JSON.stringify(guardBootstrapHookArgs(guard)) &&
            hook.args?.[1]?.includes("windowsHide:true") === true
          );
        return (
          hook.args?.[0] === ".ut-tdd/bin/ut-tdd.mjs" &&
          !hook.args.some((arg) => arg.includes(".claude/hooks/"))
        );
      };
      expect(claudeCommands.filter((hook) => expectedGuards.has(hook.matcher ?? ""))).toHaveLength(
        2,
      );
      expect(claudeCommands.every(isCanonicalClaudeHook)).toBe(true);
      expect(
        codexCommands.every(
          (hook) =>
            hook.command?.includes(".ut-tdd/bin/ut-tdd.mjs") &&
            !hook.command.includes(".claude/hooks/"),
        ),
      ).toBe(true);

      const mutatedClaude = structuredClone(claudeTemplate);
      const mutatedHook = collectCommands(mutatedClaude)[0];
      if (!mutatedHook) throw new Error("Claude consumer template has no hook command to mutate");
      mutatedHook.args = [".claude/hooks/session-log.ts"];
      expect(collectCommands(mutatedClaude).every(isCanonicalClaudeHook)).toBe(false);

      const packedSources = plan.copyPlan.filter(({ artifactPath }) =>
        requiredSources.has(artifactPath),
      );
      const sources = packedSources.map(({ sourcePath, artifactPath }) => ({
        path: artifactPath,
        content: readFileSync(join(root, sourcePath), "utf8"),
      }));
      expect(analyze(mod, sources, entries).ok).toBe(true);

      const withoutWrapperPlan = packPlan(
        sourcePaths.filter((path) => path !== "src/runtime/windows-hide.ts"),
      );
      const withoutWrapper = withoutWrapperPlan.copyPlan
        .filter(({ artifactPath }) => requiredSources.has(artifactPath))
        .map(({ sourcePath, artifactPath }) => ({
          path: artifactPath,
          content: readFileSync(join(root, sourcePath), "utf8"),
        }));
      const result = analyze(mod, withoutWrapper, entries);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("windows-hide-entry-missing");
    }));

  describe("U-WHIDE-014", () =>
    it("U-WHIDE-014: setupFiles 下で既存 spawn 検証と child_process mock が通る", async () => {
      await loadWindowsHide();
      const files = [
        "tests/release-artifact-resolver.test.ts",
        "tests/release-consumer-setup-artifacts.test.ts",
        "tests/review-live-cli.test.ts",
        "tests/claude-memory-wake.test.ts",
      ];
      // This test already runs inside the canonical detached-HEAD snapshot. Re-entering
      // run-vitest-snapshot here would clone twice and repeat npm ci/DB setup; run the
      // selected regression files with that snapshot's installed Vitest and inherited
      // fence environment instead.
      const result = spawnSync(
        resolveNodeBinary(),
        [join(root, "node_modules/vitest/vitest.mjs"), "run", ...files, "--reporter=dot"],
        { cwd: root, encoding: "utf8", windowsHide: true },
      );
      expect(
        result.status,
        `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
    }, 300000)); // 142s measured, #1063
});
