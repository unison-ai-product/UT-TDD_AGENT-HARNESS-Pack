import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitFinalBunRetirement,
  type BunRetirementAdmissionReceipt,
  BunRetirementError,
  type BunRetirementInput,
  classifyTrackedSurface,
  collectFinalRetirementSurfaceInventory,
  verifyFinalRetirementSurfaces,
} from "../src/lint/bun-final-retirement.ts";
import {
  type NodeBanDocuments,
  type NodeBanF0cAggregateBinding,
  type NodeBanGenerationBinding,
  runNodeBanAudit,
} from "../src/lint/bun-permanent-ban.ts";
import {
  classifyRuntimeImageProcess,
  NodeOnlyProcessObserver,
} from "../src/runtime/runtime-image-observer.ts";
import { gitObjectIdSchema } from "../src/schema/node-slice-admission.ts";

const BUN_RUNTIME = ["b", "un"].join("");
const subject = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const predecessorSubject = execFileSync("git", ["rev-parse", "HEAD^"], {
  encoding: "utf8",
}).trim();
const digest = `sha256:${"a".repeat(64)}`;
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
}
function sha256Value(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}
function surfaceInventoryDigest(): `sha256:${string}` {
  return sha256Value(
    collectFinalRetirementSurfaceInventory(process.cwd())
      .map((surface) => `${surface.path}\0${surface.symbol}\0${surface.classification}`)
      .sort(),
  );
}
const f0c: NodeBanF0cAggregateBinding = {
  ok: true,
  schema_version: "node-generation-aggregate.v1",
  generation_id: "node-ci-retirement-run-1",
  artifact_digest: digest,
  subject_revision: predecessorSubject,
  workflow_revision: predecessorSubject,
  run_id: "retirement-run-1",
  run_attempt: 1,
};
const f0b: NodeBanGenerationBinding = {
  lane: "linux",
  generation_id: "node-sealed-retirement-1",
  subject_revision: predecessorSubject,
  artifact_digest: digest,
  receipt_digest: "b".repeat(64),
  runtime: "node",
};
const lanes = ["linux", "windows"].map((lane) => ({
  schema_version: "node-generation-ci.v1" as const,
  lane: lane as "linux" | "windows",
  generation_id: f0c.generation_id,
  sealed_generation_id: lane === "linux" ? f0b.generation_id : "node-windows-sealed-1",
  artifact_digest: digest,
  subject_revision: predecessorSubject,
  workflow_revision: predecessorSubject,
  run_id: f0c.run_id,
  run_attempt: f0c.run_attempt,
  conclusion: "success" as const,
}));
const documents = (): NodeBanDocuments => ({
  runtime: [
    {
      path: "package.json",
      text: JSON.stringify({
        type: "module",
        bin: { "ut-tdd": "./src/cli.ts" },
        engines: { node: "24.13.0" },
        scripts: {
          build: "node scripts/build-node.mjs",
          test: "vitest run",
          "test:fast": "vitest run",
          "test:db": "npm run db",
          "test:cli": "vitest run",
          "test:node-fallback": "vitest run",
          typecheck: "tsc --noEmit",
        },
      }),
    },
    {
      path: "tsconfig.json",
      text: JSON.stringify({ compilerOptions: { strict: true, types: ["node"] } }),
    },
    { path: "src/state-db/index.ts", text: 'nodeRequire("node:sqlite");' },
    { path: "src/clean.ts", text: "export const clean = true;" },
    { path: ".claude/hooks/session-log.ts", text: "export const hook = true;" },
    { path: "scripts/ut-tdd", text: '#!/usr/bin/env sh\nset -e\nexec "$ROOT/dist/ut-tdd" "$@"\n' },
    { path: "scripts/ut-tdd.ps1", text: '& node "src/cli.ts" @args\n' },
  ],
  workflows: [
    {
      file: ".github/workflows/clean.yml",
      content: "name: clean",
      profile: "source",
      role: "runtime",
    },
  ],
  instructions: {
    agents: "shared",
    claudeProject: "shared",
    claudeRuntime: "shared",
    instructionSurfaces: { "status.md": "status" },
  },
  toolchain: {
    packageJson: JSON.stringify({
      packageManager:
        "npm@11.6.2+sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==",
      engines: { node: "24.13.0", npm: "11.6.2" },
      devDependencies: { "@biomejs/biome": "2.4.15", esbuild: "0.21.5" },
      utTdd: {
        nodeToolchain: {
          phase: "node_production",
          nodeAuthority: "sealed",
          executableReceipt: "required",
        },
      },
    }),
    bunLock: null,
    packageLock: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { "@biomejs/biome": "2.4.15", esbuild: "0.21.5" } },
      },
    }),
    nodeVersion: "24.13.0",
  },
  debtBaseline: "schema_version: bun-migration-debt.v1\ninventory: []\n",
});
function q0Receipt() {
  const observer = new NodeOnlyProcessObserver();
  for (const [scope, args] of [
    ["status", ["status"]],
    ["doctor", ["doctor"]],
    ["test", ["test"]],
    ["hook", ["hook"]],
  ] as const)
    observer.inspect(
      { command: process.execPath, args, options: { shell: false, windowsHide: true } },
      scope,
    );
  observer.proveNoFallback("descendant", "none");
  observer.proveNoFallback("download", "none");
  const result = runNodeBanAudit({
    repoRoot: process.cwd(),
    subjectRevision: predecessorSubject,
    f0c,
    node: f0b,
    f0cLanes: lanes,
    documents: documents(),
    processObservations: observer.snapshot(),
    observedScopes: ["status", "doctor", "test", "hook", "descendant", "download"],
    classifyProcess: classifyRuntimeImageProcess,
  });
  return result.receipt;
}
function cleanInput(overrides: Partial<BunRetirementInput> = {}): BunRetirementInput {
  const q0 = q0Receipt();
  const unsigned = {
    schema_version: "bun-final-retirement.v1" as const,
    subject_revision: predecessorSubject,
    generation_id: f0b.generation_id,
    artifact_digest: f0c.artifact_digest,
    retirement_subject: subject,
    f0b_receipt_digest: sha256Value(f0b),
    f0c_receipt_digest: sha256Value(f0c),
    q0_receipt_digest: q0.receipt_digest,
    surface_inventory_digest: surfaceInventoryDigest(),
  };
  const retirementReceipt: BunRetirementAdmissionReceipt = {
    ...unsigned,
    receipt_digest: sha256Value(unsigned),
  };
  return {
    repoRoot: process.cwd(),
    f0b,
    f0c,
    q0,
    f0cLanes: lanes,
    retirementSubject: subject,
    retirementReceipt,
    surfaces: collectFinalRetirementSurfaceInventory(process.cwd()),
    ...overrides,
  };
}

describe("CAND-NODEBOOT-023/027/028/208 final Bun retirement", () => {
  it("U-PACKBUN-006: independently keeps synthetic production Bun surfaces Red", () => {
    const syntheticProduction = [
      ["src/state-db/index.ts", `import "${BUN_RUNTIME}:sqlite";`],
      ["package.json", `"build": "${BUN_RUNTIME} build src/cli.ts --compile"`],
      [".claude/hooks/launch.ts", `#!/usr/bin/env ${BUN_RUNTIME}`],
      ["src/runtime/runner.ts", `spawn("${BUN_RUNTIME}", ["run", "src/cli.ts"])`],
    ] as const;
    expect(syntheticProduction.map(([path, line]) => classifyTrackedSurface(path, line))).toEqual([
      "reachable_production",
      "reachable_production",
      "reachable_production",
      "reachable_production",
    ]);
    // A deletion/allowlist mutation must not turn the independent oracle into
    // a clean result: every synthetic production surface remains classified.
    expect(syntheticProduction).toHaveLength(4);
    expect(
      syntheticProduction.some(
        ([path, line]) => classifyTrackedSurface(path, line) !== "reachable_production",
      ),
    ).toBe(false);
  });

  it("U-PACKBUN-006: path-only lockfile evidence is production and unknown paths fail closed", () => {
    expect(classifyTrackedSurface("bun.lock", "", true)).toBe("reachable_production");
    expect(classifyTrackedSurface("bun.lockb", "", true)).toBe("reachable_production");
    expect(classifyTrackedSurface("scripts/bun", "", true)).toBe("reachable_production");
    expect(classifyTrackedSurface("tests/fixture.bin", "", true)).toBe("indeterminate");
  });

  it("U-PACKBUN-006: runtime launcher tests cannot hide an executable Bun path", () => {
    expect(
      classifyTrackedSurface(
        "tests/runner.test.ts",
        `spawn("${BUN_RUNTIME}", ["run", "src/cli.ts"]);`,
      ),
    ).toBe("reachable_production");
  });

  it("U-PACKBUN-006: no test or fixture path name retains a Bun launch written as code", () => {
    // PLAN-L7-530 §3: the path name alone never retains a line. Support helpers,
    // arbitrary test files and vendor code launching Bun are reachable.
    const executable = [
      ["tests/support/runner.ts", `spawnSync("${BUN_RUNTIME}", ["run", "src/cli.ts"]);`],
      ["tests/e2e.test.ts", `execFileSync("${BUN_RUNTIME}", ["x", "vitest"]);`],
      ["vendor/lib/launch.ts", `spawn("${BUN_RUNTIME}x", ["tsx"]);`],
      ["tests/support/db.ts", `import { Database } from "${BUN_RUNTIME}:sqlite";`],
    ] as const;
    for (const [path, line] of executable)
      expect(classifyTrackedSurface(path, line), path).toBe("reachable_production");
    // The same launch quoted as oracle data (a string literal) stays a retained fixture.
    expect(
      classifyTrackedSurface(
        "tests/e2e.test.ts",
        `{ text: 'spawnSync("${BUN_RUNTIME}", [cliPath]);' },`,
      ),
    ).toBe("retained_fixture");
    // A template-literal interpolation is code again, so a launch inside `${...}`
    // is reachable, while a launch in a line comment or block comment is not.
    expect(
      classifyTrackedSurface(
        "tests/support/runner.ts",
        'const out = `${spawnSync("' + BUN_RUNTIME + '", [cli]).stdout}`;',
      ),
    ).toBe("reachable_production");
    expect(
      classifyTrackedSurface(
        "tests/support/runner.ts",
        `// spawnSync("${BUN_RUNTIME}", [cli]) was the legacy launcher`,
      ),
    ).toBe("retained_fixture");
    expect(
      classifyTrackedSurface(
        "tests/support/runner.ts",
        `/* spawn("${BUN_RUNTIME}", ["run"]) */ run(process.execPath);`,
      ),
    ).toBe("retained_fixture");
  });

  it("U-PACKBUN-006: independent admission oracle rejects a reachable surface", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-bun-surface-oracle-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "runner.ts"),
        `spawn("${BUN_RUNTIME}", ["run", "src/cli.ts"]);\n`,
      );
      writeFileSync(join(root, "bun.lock"), Buffer.from([4, 5, 6]));
      writeFileSync(join(root, "bun.lockb"), Buffer.from([0, 1, 2, 3]));
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "UT-TDD test"]);
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "synthetic reachable Bun surface"]);
      const surfaces = collectFinalRetirementSurfaceInventory(root);
      expect(surfaces).toHaveLength(3);
      expect(surfaces).toEqual(
        expect.arrayContaining([
          { path: "bun.lock", symbol: "path:bun.lock", classification: "reachable_production" },
          { path: "bun.lockb", symbol: "path:bun.lockb", classification: "reachable_production" },
          {
            path: "src/runner.ts",
            symbol: "line:1:bun",
            classification: "reachable_production",
          },
        ]),
      );
      expect(() => verifyFinalRetirementSurfaces(root, surfaces)).toThrow(
        new BunRetirementError("reachable_bun_surface"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-PACKBUN-006: independently rejects an indeterminate inventory surface", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-bun-indeterminate-oracle-"));
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "fixture.txt"), `${BUN_RUNTIME}\n`);
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "UT-TDD test"]);
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "synthetic indeterminate Bun surface"]);
      const surfaces = collectFinalRetirementSurfaceInventory(root);
      expect(surfaces).toEqual([
        { path: "tests/fixture.txt", symbol: "line:1:bun", classification: "indeterminate" },
      ]);
      expect(() => verifyFinalRetirementSurfaces(root, surfaces)).toThrow(
        new BunRetirementError("indeterminate_bun_surface"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the complete existing F0b/F0c/Q0 chain and emits prefixed tuple ids", () => {
    const result = admitFinalBunRetirement(cleanInput());
    expect(result.ok).toBe(true);
    expect(gitObjectIdSchema.safeParse(result.tuple.subject_revision).success).toBe(true);
    expect(result.tuple.subject_revision).toBe(`git-sha1:${predecessorSubject}`);
    expect(result.tuple.retirement_subject).toBe(`git-sha1:${subject}`);
  });

  it("rejects a predecessor receipt whose subject is the retirement commit", () => {
    const sameSubject = {
      ...f0c,
      subject_revision: subject,
      workflow_revision: subject,
    };
    expect(() =>
      admitFinalBunRetirement(
        cleanInput({
          f0b: { ...f0b, subject_revision: subject },
          f0c: sameSubject,
        }),
      ),
    ).toThrow(new BunRetirementError("predecessor_equals_retirement"));
  });

  it.each([
    ["F0b missing", { f0b: null }, "f0b_receipt_missing"],
    ["F0c missing", { f0c: null }, "f0c_receipt_missing"],
    ["Q0 missing", { q0: null }, "q0_receipt_missing"],
    [
      "stale retirement subject",
      { retirementSubject: `git-sha1:${"c".repeat(40)}` },
      "retirement_subject_mismatch",
    ],
    [
      "wrong artifact",
      { f0c: { ...f0c, artifact_digest: `sha256:${"c".repeat(64)}` } },
      "artifact_digest_mismatch",
    ],
  ] as const)("denies %s without production admission", (_label, mutation, reason) => {
    expect(() => admitFinalBunRetirement(cleanInput(mutation))).toThrow(
      new BunRetirementError(reason),
    );
  });

  it.each([
    [
      "F0b subject drift",
      { f0b: { ...f0b, subject_revision: `git-sha1:${"c".repeat(40)}` } },
      "subject_revision_mismatch",
    ],
    [
      "F0c subject drift",
      { f0c: { ...f0c, subject_revision: `git-sha1:${"c".repeat(40)}` } },
      "subject_revision_mismatch",
    ],
    [
      "F0b generation drift",
      { f0b: { ...f0b, generation_id: "node-sealed-other" } },
      "generation_id_mismatch",
    ],
    [
      "F0c generation drift",
      { f0c: { ...f0c, generation_id: "node-ci-other" } },
      "generation_id_mismatch",
    ],
  ] as const)("denies independent tuple drift: %s", (_label, mutation, reason) => {
    expect(() => admitFinalBunRetirement(cleanInput(mutation))).toThrow(
      new BunRetirementError(reason),
    );
  });

  it("denies a stale Q0 subject instead of accepting a receipt from an older chain", () => {
    const stale = q0Receipt();
    const mutated = { ...stale, subject_revision: `git-sha1:${"c".repeat(40)}` };
    expect(() => admitFinalBunRetirement(cleanInput({ q0: mutated }))).toThrow(
      new BunRetirementError("q0_binding_invalid"),
    );
  });

  it("denies a receipt re-used for a later retirement subject even when its tuple is otherwise valid", () => {
    const previous = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
    const current = cleanInput();
    const receipt = current.retirementReceipt;
    if (!receipt) throw new Error("cleanInput must provide a retirement receipt");
    const unsigned = {
      ...receipt,
      receipt_digest: undefined,
      retirement_subject: `git-sha1:${previous}`,
    };
    expect(() =>
      admitFinalBunRetirement(
        cleanInput({
          retirementReceipt: {
            ...unsigned,
            receipt_digest: sha256Value(unsigned),
          },
        }),
      ),
    ).toThrow(new BunRetirementError("retirement_subject_mismatch"));
  });

  it.each([
    "reachable_production",
    "indeterminate",
  ] as const)("denies %s surfaces", (classification) => {
    expect(() =>
      admitFinalBunRetirement(
        cleanInput({
          surfaces: [{ path: "src/cli.ts", symbol: "entry", classification }],
        }),
      ),
    ).toThrow(BunRetirementError);
  });

  it("denies an empty inventory rather than treating missing evidence as clean", () => {
    expect(() => admitFinalBunRetirement(cleanInput({ surfaces: [] }))).toThrow(
      new BunRetirementError("indeterminate_bun_surface"),
    );
  });
});
