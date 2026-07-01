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
} from "../src/lint/runtime-portability";

const validDocs: RuntimePortabilityDoc[] = [
  {
    path: "package.json",
    text: JSON.stringify({
      type: "module",
      bin: { "ut-tdd": "./src/cli.ts" },
      engines: { bun: ">=1.3" },
      scripts: {
        build: "bun build src/cli.ts --compile --outfile dist/ut-tdd",
        test: "vitest run",
        "test:fast":
          "vitest run --exclude tests/cli-surface.test.ts --exclude tests/drive-db-registration.test.ts --exclude tests/projection-writer.test.ts",
        "test:db":
          "bun run src/cli.ts db rebuild && vitest run tests/db-projection-ingestion.test.ts tests/drive-db-registration.test.ts tests/projection-writer.test.ts",
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
    text: 'nodeRequire("bun:sqlite"); nodeRequire("node:sqlite");',
  },
  { path: "src/runtime/adapter.ts", text: "export const adapter = true;" },
  { path: ".claude/hooks/session-log.ts", text: "export const hook = true;" },
  {
    path: "scripts/ut-tdd",
    text: '#!/usr/bin/env sh\nset -e\nROOT="$(pwd)"\nexec "$ROOT/dist/ut-tdd" "$@"\nexec bun run "$ROOT/src/cli.ts" "$@"\n',
  },
  {
    path: "scripts/ut-tdd.ps1",
    text: '$root = "."\n& "$root\\dist\\ut-tdd.exe" @args\n& bun run (Join-Path $root "src\\cli.ts") @args\n',
  },
];

describe("runtime-portability lint", () => {
  it("U-RPORT-001: accepts TS/Bun core with Node types and thin wrappers", () => {
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
        "package-missing-bun-engine",
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
    expect(wrapper).toContain('exec bun run "$ROOT/src/cli.ts" "$@"');
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
