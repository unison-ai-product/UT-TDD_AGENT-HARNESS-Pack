import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRuntimePortability,
  loadRuntimePortabilityDocs,
  type RuntimePortabilityDoc,
  runtimePortabilityMessages,
} from "../src/lint/runtime-portability.ts";

const validDocs: RuntimePortabilityDoc[] = [
  {
    path: "package.json",
    text: JSON.stringify({
      type: "module",
      bin: { "ut-tdd": "./src/cli.ts" },
      engines: { node: "24.13.0" },
      scripts: {
        build: "node scripts/build-node.mjs",
        test: "vitest run",
        "test:fast":
          "vitest run --exclude tests/cli-surface.test.ts --exclude tests/drive-db-registration.test.ts --exclude tests/projection-writer.test.ts",
        "test:db":
          "npm run db && vitest run tests/db-projection-ingestion.test.ts tests/drive-db-registration.test.ts tests/projection-writer.test.ts",
        "test:cli": "vitest run tests/cli-surface.test.ts tests/runtime-hook-entrypoints.test.ts",
        "test:node-fallback": "vitest run tests/state-db.test.ts tests/runtime-portability.test.ts",
        typecheck: "tsc --noEmit",
      },
    }),
  },
  {
    path: "tsconfig.json",
    text: JSON.stringify({ compilerOptions: { strict: true, types: ["node"] } }),
  },
  {
    path: "src/state-db/index.ts",
    text: 'nodeRequire("node:sqlite");',
  },
  { path: "src/runtime/adapter.ts", text: "export const adapter = true;" },
  { path: ".claude/hooks/session-log.ts", text: "export const hook = true;" },
  {
    path: "scripts/ut-tdd",
    text: '#!/usr/bin/env sh\nset -e\nROOT="$(pwd)"\nexec "$ROOT/dist/ut-tdd" "$@"\nexec node "$ROOT/src/cli.ts" "$@"\n',
  },
  {
    path: "scripts/ut-tdd.ps1",
    text: '$root = "."\n& "$root\\dist\\ut-tdd.exe" @args\n& node (Join-Path $root "src\\cli.ts") @args\n',
  },
];

describe("runtime-portability lint", () => {
  it("U-RPORT-001: accepts sealed Node core with Node types and thin wrappers", () => {
    const result = analyzeRuntimePortability(validDocs);

    expect(result.ok).toBe(true);
    expect(runtimePortabilityMessages(result)[0]).toContain("OK");
  });

  it("U-RPORT-002: rejects Python/Bash runtime files and shell-specific core dispatch", () => {
    const result = analyzeRuntimePortability([
      ...validDocs,
      { path: "src/runtime/legacy.py", text: "print('legacy')" },
      { path: ".claude/hooks/guard.sh", text: "python3 guard.py" },
      { path: "scripts/install-hooks.sh", text: "#!/usr/bin/env bash\npython3 setup.py\n" },
      {
        path: "src/cli.ts",
        text: 'import { execSync } from "node:child_process";\nexecSync("bash run.sh");',
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining([
        "core-non-typescript-file",
        "disallowed-runtime-language",
        "hook-non-typescript-file",
        "script-wrapper-unapproved",
        "source-shell-runtime",
      ]),
    );
  });

  it("U-RPORT-008: requires Vitest full, fast, DB, and CLI test lanes", () => {
    const packageDoc = validDocs.find((doc) => doc.path === "package.json");
    const pkg = JSON.parse(packageDoc?.text ?? "{}") as {
      scripts?: Record<string, string>;
    };
    delete pkg.scripts?.test;
    delete pkg.scripts?.["test:fast"];
    delete pkg.scripts?.["test:db"];
    delete pkg.scripts?.["test:cli"];

    const result = analyzeRuntimePortability([
      ...validDocs.filter((doc) => doc.path !== "package.json"),
      { path: "package.json", text: JSON.stringify(pkg) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining([
        "package-missing-vitest-full-suite",
        "package-missing-fast-test-lane",
        "package-missing-db-test-lane",
        "package-missing-cli-test-lane",
      ]),
    );
  });

  it("U-RPORT-003: rejects package/tsconfig drift that weakens TS runtime guarantees", () => {
    const result = analyzeRuntimePortability([
      { path: "package.json", text: JSON.stringify({ type: "commonjs", scripts: {} }) },
      { path: "tsconfig.json", text: JSON.stringify({ compilerOptions: { strict: false } }) },
      { path: "src/state-db/index.ts", text: 'nodeRequire("bun:sqlite");' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining([
        "package-missing-esm",
        "package-missing-node-engine",
        "package-bin-not-source-cli",
        "package-missing-compiled-build",
        "package-missing-node-fallback-smoke",
        "package-missing-typecheck",
        "tsconfig-not-strict",
        "tsconfig-missing-node-types",
        "sqlite-driver-fallback-missing",
      ]),
    );
  });

  it("U-RPORT-015: node:sqlite alone satisfies the inverted primary-driver contract", () => {
    const result = analyzeRuntimePortability([
      { path: "src/state-db/index.ts", text: 'nodeRequire("node:sqlite");' },
    ]);
    expect(result.violations.map((v) => v.rule)).not.toContain("sqlite-driver-fallback-missing");
  });

  it("U-RPORT-016: fail-closes new bun spawn / bun: import / Bun global outside the debt allowlist (PLAN-L7-462 step 3, AC-3)", () => {
    const result = analyzeRuntimePortability([
      { path: "src/new-module.ts", text: 'spawnSync("bun", ["src/cli.ts"]);' },
      { path: "scripts/new-tool.ts", text: 'import { Database } from "bun:sqlite";' },
      { path: ".claude/hooks/new-hook.ts", text: "await Bun.write(target, data);" },
      // 間接形の再流入 (blind review A-1): findBun launcher / `?? "bun"` fallback /
      // cmd.exe 経由 / runner tuple / shell wrapper。
      { path: "src/new-launcher.ts", text: "const child = spawn(findBun(), args);" },
      { path: "src/new-fallback.ts", text: 'const bin = env.BIN ?? "bun"; spawnSync(bin, a);' },
      { path: "src/new-cmd.ts", text: 'spawnSync(cmdExe, ["/d", "/c", "bun", "--version"]);' },
      { path: "src/new-runner.ts", text: 'const r = ["bun", ["run", "test"]] as const;' },
      { path: "scripts/new-wrapper", text: 'exec bun run "$ROOT/src/cli.ts" "$@"' },
      // globalThis 形 / optional chaining / bracket access (blind review A-4)。
      { path: "src/new-global.ts", text: "(globalThis as any).Bun.write(p, d);" },
      { path: "src/new-optional.ts", text: "Bun?.gc?.(true);" },
      { path: "src/new-bracket.ts", text: 'Bun["write"](p, d);' },
      // tests/ scope の再流入 (blind review A-3)。
      { path: "tests/new-bun.test.ts", text: 'spawnSync("bun", [cliPath, "--help"]);' },
      // typeof / 末尾参照 / process.versions.bun 形 (blind review A-4')。
      {
        path: "src/new-driver.ts",
        text: 'typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node";',
      },
      { path: "src/new-gc.ts", text: "const bun = (globalThis as { Bun?: unknown }).Bun;" },
      { path: "src/new-guard.ts", text: 'if (typeof Bun !== "undefined") { doBunThing(); }' },
      {
        path: "src/new-tern.ts",
        text: "const hasBun = process.versions.bun !== undefined;",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => [v.path, v.rule])).toEqual(
      expect.arrayContaining([
        ["src/new-module.ts", "bun-runtime-spawn"],
        ["scripts/new-tool.ts", "bun-module-import"],
        [".claude/hooks/new-hook.ts", "bun-global-reference"],
        ["src/new-launcher.ts", "bun-runtime-spawn"],
        ["src/new-fallback.ts", "bun-runtime-spawn"],
        ["src/new-cmd.ts", "bun-runtime-spawn"],
        ["src/new-runner.ts", "bun-runtime-spawn"],
        ["scripts/new-wrapper", "bun-runtime-spawn"],
        ["src/new-global.ts", "bun-global-reference"],
        ["src/new-optional.ts", "bun-global-reference"],
        ["src/new-bracket.ts", "bun-global-reference"],
        ["tests/new-bun.test.ts", "bun-runtime-spawn"],
        ["src/new-driver.ts", "bun-global-reference"],
        ["src/new-gc.ts", "bun-global-reference"],
        ["src/new-guard.ts", "bun-global-reference"],
        ["src/new-tern.ts", "bun-global-reference"],
      ]),
    );
  });

  it("U-RPORT-017: debt allowlist stays scoped to the frozen fixture sites (no permanent bypass surface)", () => {
    // 例外サイトは Issue #134 debt として PLAN-L7-462 freeze が帰属した実ファイルに限る。
    // 別 path が同名 suffix でも bypass しないこと (path 完全一致)。
    const result = analyzeRuntimePortability([
      { path: "src/cli/other-distribution.ts", text: 'execFileSync("bun", ["--version"]);' },
      { path: "src/state-db/other-index.ts", text: 'nodeRequire("bun:sqlite");' },
    ]);
    expect(result.violations.map((v) => [v.path, v.rule])).toEqual(
      expect.arrayContaining([
        ["src/cli/other-distribution.ts", "bun-runtime-spawn"],
        ["src/state-db/other-index.ts", "bun-module-import"],
      ]),
    );
  });

  it("U-RPORT-018: allowlisted files fail-close when a new site exceeds the pinned debt count (blind review A-2')", () => {
    // 収載 path でも pin (現 debt 行数) を超えた行は違反になる — file 単位の素通しを作らない。
    const twoProbes = 'execFileSync("bun", ["--version"]);\nspawnSync("bun", ["x"]);\n';
    const result = analyzeRuntimePortability([
      // src/cli/distribution.ts の spawn pin は 2。pin 内 2 行 + 追加 1 行 → 追加行のみ違反。
      {
        path: "src/cli/distribution.ts",
        text: `${twoProbes}spawnSync("bun", ["brand-new-attack.ts"]);\n`,
      },
      // import pin 2 の src/state-db/index.ts へ 3 行目の bun: import → 違反。
      {
        path: "src/state-db/index.ts",
        text: 'nodeRequire("bun:sqlite");\nnodeRequire("node:sqlite");\nimport x from "bun:ffi";\nimport y from "bun:jsc";\n',
      },
    ]);
    const hits = result.violations.map((v) => [v.path, v.rule, v.line]);
    expect(hits).toEqual(
      expect.arrayContaining([
        ["src/cli/distribution.ts", "bun-runtime-spawn", 3],
        ["src/state-db/index.ts", "bun-module-import", 4],
      ]),
    );
    // pin 内の既存 debt 行は違反にならない (burn-down の自由度は保つ)。
    expect(hits).not.toEqual(
      expect.arrayContaining([["src/cli/distribution.ts", "bun-runtime-spawn", 1]]),
    );
  });

  it("U-RPORT-004: current repo keeps Windows-relevant runtime portability guard green", () => {
    const result = analyzeRuntimePortability(loadRuntimePortabilityDocs(process.cwd()));

    expect(result.violations).toEqual([]);
  });

  it("U-RPORT-009: rejects bin contracts that require dist before bun link", () => {
    const packageDoc = validDocs.find((doc) => doc.path === "package.json");
    const pkg = JSON.parse(packageDoc?.text ?? "{}") as {
      bin?: Record<string, string>;
    };
    pkg.bin = { "ut-tdd": "./dist/ut-tdd" };

    const result = analyzeRuntimePortability([
      ...validDocs.filter((doc) => doc.path !== "package.json"),
      { path: "package.json", text: JSON.stringify(pkg) },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("package-bin-not-source-cli");
  });

  it("U-RPORT-004A: POSIX entrypoint remains a thin sh wrapper for Linux", () => {
    const docs = loadRuntimePortabilityDocs(process.cwd());
    const wrapper = docs.find((doc) => doc.path === "scripts/ut-tdd")?.text;

    expect(wrapper).toBeDefined();
    expect(wrapper?.split(/\r?\n/).slice(0, 3)).toEqual([
      "#!/usr/bin/env sh",
      expect.stringContaining("POSIX entrypoint"),
      "set -e",
    ]);
    expect(wrapper).toContain('exec "$ROOT/dist/ut-tdd" "$@"');
    expect(wrapper).toContain('exec node "$ROOT/src/cli.ts" "$@"');
  });

  it("U-RPORT-005: scans untracked runtime files during active Windows setup work", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rport-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      mkdirSync(join(root, "src", "state-db"), { recursive: true });
      writeFileSync(join(root, "package.json"), validDocs[0].text);
      writeFileSync(join(root, "tsconfig.json"), validDocs[1].text);
      writeFileSync(join(root, "src", "state-db", "index.ts"), validDocs[2].text);
      writeFileSync(join(root, "src", "legacy.py"), "print('windows drift')\n");

      const result = analyzeRuntimePortability(loadRuntimePortabilityDocs(root));

      expect(result.violations.map((violation) => violation.rule)).toContain(
        "core-non-typescript-file",
      );
      expect(result.violations.map((violation) => violation.path)).toContain("src/legacy.py");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RPORT-006: rejects legacy runtime markers in product runtime surfaces", () => {
    const legacyName = ["he", "lix"].join("");
    const legacyEnv = ["HE", "LIX_CODEX_BIN"].join("");
    const result = analyzeRuntimePortability([
      ...validDocs,
      {
        path: "src/runtime/adapter.ts",
        text: `const bin = process.env.${legacyEnv};`,
      },
      {
        path: "src/team/run.ts",
        text: `export const command = "${legacyName} codex --role worker";`,
      },
      {
        path: "src/runtime/detect.ts",
        text: `export const statePath = ".${legacyName}/state";`,
      },
      {
        path: ".claude/hooks/agent-guard.ts",
        text: `export const reviewer = "pmo-${legacyName}-explorer";`,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(["legacy-runtime-marker"]),
    );
    expect(result.violations.filter((v) => v.rule === "legacy-runtime-marker")).toHaveLength(4);
  });

  it("U-RPORT-010: accepts the tracked git-hooks entrypoints (PLAN-L7-260 §4 / PLAN-L7-424)", () => {
    const result = analyzeRuntimePortability([
      ...validDocs,
      {
        path: "scripts/git-hooks/pre-push",
        text: '#!/usr/bin/env bash\nset -euo pipefail\nnode "$hook_dir/secret-scan-diff.ts"\n',
      },
      {
        path: "scripts/git-hooks/secret-scan-diff.ts",
        text: 'import { analyzeSecretScan } from "../../src/lint/secret-scan";\nanalyzeSecretScan([]);\n',
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("U-RPORT-011: still rejects unrecognized files under scripts/git-hooks/", () => {
    const result = analyzeRuntimePortability([
      ...validDocs,
      { path: "scripts/git-hooks/other.sh", text: "#!/usr/bin/env bash\necho hi\n" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("script-wrapper-unapproved");
  });

  it("U-RPORT-012: rejects a git-hooks pre-push that reintroduces Python dispatch", () => {
    const result = analyzeRuntimePortability([
      ...validDocs,
      {
        path: "scripts/git-hooks/pre-push",
        text: "#!/usr/bin/env bash\npython3 scan.py\n",
      },
      {
        path: "scripts/git-hooks/secret-scan-diff.ts",
        text: 'import { analyzeSecretScan } from "../../src/lint/secret-scan";\n',
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(["git-hook-entrypoint-python", "git-hook-entrypoint-not-thin"]),
    );
  });

  it("U-RPORT-013: rejects a git-hooks pre-push that stops dispatching to the node scanner", () => {
    const result = analyzeRuntimePortability([
      ...validDocs,
      { path: "scripts/git-hooks/pre-push", text: "#!/usr/bin/env bash\necho no-op\n" },
      {
        path: "scripts/git-hooks/secret-scan-diff.ts",
        text: 'import { analyzeSecretScan } from "../../src/lint/secret-scan";\n',
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("git-hook-entrypoint-not-thin");
  });

  it("U-RPORT-014: rejects a git-hooks scanner that reimplements detection instead of reusing src/lint/secret-scan.ts", () => {
    const result = analyzeRuntimePortability([
      ...validDocs,
      {
        path: "scripts/git-hooks/pre-push",
        text: '#!/usr/bin/env bash\nbun "$hook_dir/secret-scan-diff.ts"\n',
      },
      {
        path: "scripts/git-hooks/secret-scan-diff.ts",
        text: "const SECRET_PATTERN = /ghp_[A-Za-z0-9]+/;\n",
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain("git-hook-scanner-not-reusing-core");
  });

  it("U-RPORT-007: scans src/scripts via filesystem when git is unavailable (zip/tarball)", () => {
    // .git を作らない = git ls-files が失敗し filesystem fallback に落ちる経路 (配布物の検査面欠落回帰)。
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-rport-nogit-"));
    try {
      mkdirSync(join(root, "src", "state-db"), { recursive: true });
      writeFileSync(join(root, "package.json"), validDocs[0].text);
      writeFileSync(join(root, "tsconfig.json"), validDocs[1].text);
      writeFileSync(join(root, "src", "state-db", "index.ts"), validDocs[2].text);
      writeFileSync(join(root, "src", "legacy.py"), "print('zip drift')\n");

      const docs = loadRuntimePortabilityDocs(root);

      // fallback でも src/ が検査面に含まれる (package.json/tsconfig.json だけに縮退しない)。
      expect(docs.map((doc) => doc.path)).toEqual(
        expect.arrayContaining([
          "package.json",
          "tsconfig.json",
          "src/state-db/index.ts",
          "src/legacy.py",
        ]),
      );
      const result = analyzeRuntimePortability(docs);
      expect(result.violations.map((violation) => violation.path)).toContain("src/legacy.py");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
