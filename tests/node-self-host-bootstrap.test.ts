import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as bootstrap from "../src/runtime/node-bootstrap.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";

const sourceTrackingObservations = vi.hoisted(() => ({ active: false, gitLsFilesCalls: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const commandArgs = args[1];
      if (
        sourceTrackingObservations.active &&
        args[0] === "git" &&
        Array.isArray(commandArgs) &&
        commandArgs.some((argument) => String(argument) === "ls-files")
      ) {
        sourceTrackingObservations.gitLsFilesCalls += 1;
      }
      return actual.execFileSync(...args);
    },
  };
});

const root = process.cwd();

// chmodTree が seal した generation は read-only (dirs 0555 / files 0444) のため、
// テスト後始末の rmSync が Linux で EACCES になる。掃除前に書込権を戻す test-only helper。
// production の immutability (chmodTree) には触れない。
function rmTestDist(path: string): void {
  const restoreWritable = (target: string): void => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      chmodSync(target, 0o755);
      for (const entry of readdirSync(target)) restoreWritable(join(target, entry));
    } else {
      chmodSync(target, 0o644);
    }
  };
  restoreWritable(path);
  rmSync(path, { recursive: true, force: true });
}
const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
let generation: bootstrap.NodeGeneration;
let realGeneration: bootstrap.NodeGeneration | undefined;
const build = (
  options: {
    nodePath?: string;
    npmCliPath?: string;
    fault?: (barrier: string) => void;
    compileInputs?: Record<string, unknown>;
    outputRoot?: string;
  } = {},
) =>
  bootstrap.buildNodeGeneration({
    repoRoot: root,
    outputRoot: options.outputRoot,
    candidateRevision: candidate,
    nodePath: options.nodePath,
    npmCliPath: options.npmCliPath,
    fault: options.fault,
    compile: async (outfile) => {
      writeFileSync(outfile, "export default 1;\n", "utf8");
      return { inputs: options.compileInputs ?? { "src/cli.ts": {} } };
    },
  });

type BuildObservation =
  | { ok: true; generation: bootstrap.NodeGeneration }
  | { ok: false; error: unknown };

async function observeBuild(options: Parameters<typeof build>[0]): Promise<BuildObservation> {
  try {
    return { ok: true, generation: await build(options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function createDependencyFixture(): {
  outputRoot: string;
  absolute: (path: string) => string;
  input: (path: string) => string;
  write: (path: string, content: string) => string;
  cleanup: () => void;
} {
  const fixtureRoot = mkdtempSync(join(root, "node_modules", ".ut-tdd-node-bootstrap-fixture-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "ut-tdd-node-bootstrap-output-"));
  const absolute = (path: string): string => resolve(fixtureRoot, path);
  return {
    outputRoot,
    absolute,
    input: (path) => relative(root, absolute(path)).replaceAll("\\", "/"),
    write: (path, content) => {
      const target = absolute(path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      return target;
    },
    cleanup: () => {
      rmTestDist(outputRoot);
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

const buildReal = async () => {
  realGeneration ??= await bootstrap.buildNodeGeneration({
    repoRoot: root,
    candidateRevision: candidate,
  });
  return realGeneration;
};

function copyFixtureFile(fixtureRoot: string, relativePath: string): void {
  const target = resolve(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, relativePath), target);
}

function createVerificationFixture(real: bootstrap.NodeGeneration): {
  root: string;
  generationPath: string;
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ut-tdd-node-verification-"));
  const files = new Set([
    "package.json",
    "package-lock.json",
    "tsconfig.node.json",
    "scripts/build-node.mjs",
    "docs/governance/node-toolchain-provenance.json",
    ...real.receipt.source_files.map((file) => file.path),
    ...real.receipt.external_dependencies.flatMap((dependency) => [
      dependency.package_json_path,
      ...dependency.bundle_files.map((file) => file.path),
    ]),
  ]);
  for (const file of files) copyFixtureFile(fixtureRoot, file);

  const generationPath = resolve(
    fixtureRoot,
    "dist/node-generations",
    basename(real.generationPath),
  );
  mkdirSync(generationPath, { recursive: true });
  for (const file of ["receipt.json", "ut-tdd.mjs"]) {
    copyFileSync(resolve(real.generationPath, file), resolve(generationPath, file));
  }
  return { root: fixtureRoot, generationPath };
}

describe("F0b sealed Node producer candidate oracles", () => {
  heavyBeforeAll("pack", async () => {
    rmTestDist(resolve(root, "dist"));
    generation = await build();
  });
  heavyAfterAll("teardown", () => rmTestDist(resolve(root, "dist")));

  it("CAND-NODEBOOT-001/102 seals and reloads one immutable receipt", () => {
    expect(generation.receipt.subject_revision).toBe(candidate);
    expect(generation.receipt.runtime).toBe("node");
    expect(generation.receipt.builder.policy).toBe("compiled-esm-only");
    expect(Object.isFrozen(generation.receipt)).toBe(true);
    expect(
      bootstrap.verifyNodeGeneration(root, generation.generationPath, candidate).receipt
        .receipt_digest,
    ).toBe(generation.receipt.receipt_digest);
  });
  it("CAND-NODEBOOT-002 missing receipt fails closed", () => {
    expect(() =>
      bootstrap.verifyNodeGeneration(
        root,
        resolve(root, "dist/node-generations/missing"),
        candidate,
      ),
    ).toThrow(/receipt-invalid/);
  });
  it("CAND-NODEBOOT-003 compiled byte drift is rejected", () => {
    chmodSync(generation.compiledCliPath, 0o644);
    writeFileSync(
      generation.compiledCliPath,
      `${readFileSync(generation.compiledCliPath, "utf8")}drift`,
      "utf8",
    );
    expect(() =>
      bootstrap.verifyNodeGeneration(root, generation.generationPath, candidate),
    ).toThrow(/cli-digest-mismatch/);
  });
  it("CAND-NODEBOOT-004/008 invocation stays shell-free and absolute", () => {
    const invocation = bootstrap.createNodeInvocation(generation, ["status"]);
    expect(invocation.options).toEqual({ shell: false, windowsHide: true });
    expect(invocation.args[0]).toBe(generation.compiledCliPath);
    expect(generation.nodePath).toMatch(/^[A-Za-z]:[\\/]|^\//);
    expect(generation.compiledCliPath).toMatch(/^[A-Za-z]:[\\/]|^\//);
  });
  it.each([
    ["CAND-NODEBOOT-005", "publishActivation"],
    ["CAND-NODEBOOT-010", "loadNodeGeneration"],
    ["CAND-NODEBOOT-011", "activateNodeGeneration"],
    ["CAND-NODEBOOT-014", "deleteNodeGeneration"],
    ["CAND-NODEBOOT-015", "rollbackNodeGeneration"],
  ])("%s activation/deletion surface is absent", (_id, name) => {
    expect(name in bootstrap).toBe(false);
  });
  it("CAND-NODEBOOT-006/009 substituted npm path is rejected", async () => {
    await expect(build({ npmCliPath: generation.nodePath })).rejects.toThrow(/npm-path-invalid/);
  });
  it("CAND-NODEBOOT-007 substituted Node executable is rejected", async () => {
    await expect(build({ nodePath: generation.compiledCliPath })).rejects.toThrow(/runtime/);
  });
  it("CAND-NODEBOOT-012/013 lease crash residue blocks the next publisher", async () => {
    rmTestDist(resolve(root, "dist"));
    await expect(
      build({
        fault: (barrier) => {
          if (barrier === "generation-staged") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    expect(existsSync(resolve(root, bootstrap.NODE_LEASE))).toBe(true);
    await expect(build()).rejects.toThrow(/publish-lease-busy/);
    rmTestDist(resolve(root, "dist"));
    generation = await build();
  });
  it("CAND-NODEBOOT-016 does not claim unsupported power-loss durability", () => {
    expect("power_loss_durable" in generation.receipt).toBe(false);
  });
  it("CAND-NODEBOOT-018/205 rejects untracked compile input", async () => {
    await expect(build({ compileInputs: { "../untracked.ts": {} } })).rejects.toThrow(
      /source-path-escape|source-untracked/,
    );
  });

  it("issue #1154 rejects an in-root untracked compile input with its typed error", async () => {
    await expect(
      build({ compileInputs: { "src/__issue1154_untracked_input__.ts": {} } }),
    ).rejects.toMatchObject({
      name: "NodeBootstrapError",
      code: "node-bootstrap-source-untracked",
    });
  });

  it("issue #1154 rejects an in-root untracked input even beside a tracked input", async () => {
    await expect(
      build({
        compileInputs: {
          "src/cli.ts": {},
          "src/__issue1154_untracked_among_tracked__.ts": {},
        },
      }),
    ).rejects.toMatchObject({
      name: "NodeBootstrapError",
      code: "node-bootstrap-source-untracked",
    });
  });

  it("issue #1154 rejects a case-variant compile input as untracked", async () => {
    await expect(build({ compileInputs: { "src/CLI.ts": {} } })).rejects.toMatchObject({
      name: "NodeBootstrapError",
      code: "node-bootstrap-source-untracked",
    });
  });

  it("issue #1154 normalizes native separators in tracked compile inputs", async () => {
    const result = await build({
      compileInputs: {
        [join("src", "cli.ts")]: {},
        "package.json": {},
      },
    });
    expect(result.receipt.source_files.map(({ path }) => path)).toEqual([
      "package.json",
      "src/cli.ts",
    ]);
  });

  it("issue #1154 checks three tracked compile inputs with one git ls-files invocation", async () => {
    sourceTrackingObservations.gitLsFilesCalls = 0;
    sourceTrackingObservations.active = true;
    let result: bootstrap.NodeGeneration;
    try {
      result = await build({
        compileInputs: {
          "src/cli.ts": {},
          "package.json": {},
          "tsconfig.node.json": {},
        },
      });
    } finally {
      sourceTrackingObservations.active = false;
    }
    expect(result.receipt.source_files.map(({ path }) => path)).toEqual([
      "package.json",
      "src/cli.ts",
      "tsconfig.node.json",
    ]);
    expect(sourceTrackingObservations.gitLsFilesCalls).toBe(1);
  });

  it("CAND-NODEBOOT-001 Issue #1343 variant resolves a type-only nested manifest to its owner", async () => {
    const fixture = createDependencyFixture();
    const packageRoot = "node_modules/@ut-tdd-test/owner";
    const ownerManifest = `${packageRoot}/package.json`;
    const nestedManifest = `${packageRoot}/lib/esm/package.json`;
    const entry = `${packageRoot}/lib/esm/index.js`;
    try {
      fixture.write(
        ownerManifest,
        JSON.stringify({ name: "@ut-tdd-test/owner", version: "1.0.0" }),
      );
      fixture.write(nestedManifest, JSON.stringify({ type: "module" }));
      fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed).toMatchObject({ ok: true });
      if (!observed.ok) return;
      const dependency = observed.generation.receipt.external_dependencies.find(
        (item) => item.package_name === "@ut-tdd-test/owner",
      );
      expect(dependency?.package_json_path).toBe(fixture.input(ownerManifest));
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-001 Issue #1343 variant does not rescue a missing owner manifest from an ancestor", async () => {
    const fixture = createDependencyFixture();
    const entry = "node_modules/owner-without-manifest/index.js";
    try {
      fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          name: "NodeBootstrapError",
          code: "node-bootstrap-dependency-package-missing",
        }),
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["missing", null],
    ["malformed", "{not-json"],
    ["name-version-missing", JSON.stringify({ type: "module" })],
    ["name-version-invalid", JSON.stringify({ name: 42, version: [] })],
  ] as const)("CAND-NODEBOOT-001 Issue #1343 variant rejects %s owner manifest despite a nested valid manifest", async (_caseName, ownerManifestContent) => {
    const fixture = createDependencyFixture();
    const packageRoot = "node_modules/@ut-tdd-test/invalid-owner";
    const nestedManifest = `${packageRoot}/lib/esm/package.json`;
    const entry = `${packageRoot}/lib/esm/index.js`;
    try {
      if (ownerManifestContent !== null)
        fixture.write(`${packageRoot}/package.json`, ownerManifestContent);
      fixture.write(
        nestedManifest,
        JSON.stringify({ name: "@ut-tdd-test/nested-rescue", version: "9.9.9" }),
      );
      fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          name: "NodeBootstrapError",
          code: expect.stringMatching(/node-bootstrap-dependency-(package-missing|invalid)$/),
        }),
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-001 Issue #1343 variant attributes a scoped package to its package root", async () => {
    const fixture = createDependencyFixture();
    const packageRoot = "node_modules/@ut-tdd-test/scoped";
    const ownerManifest = `${packageRoot}/package.json`;
    const entry = `${packageRoot}/index.js`;
    try {
      fixture.write(
        ownerManifest,
        JSON.stringify({ name: "@ut-tdd-test/scoped", version: "1.2.3" }),
      );
      fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(observed.generation.receipt.external_dependencies).toContainEqual(
        expect.objectContaining({
          package_name: "@ut-tdd-test/scoped",
          package_version: "1.2.3",
          package_json_path: fixture.input(ownerManifest),
        }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-001 Issue #1343 variant selects the inner package in nested node_modules", async () => {
    const fixture = createDependencyFixture();
    const outerRoot = "node_modules/@ut-tdd-test/outer";
    const innerRoot = `${outerRoot}/node_modules/@ut-tdd-test/inner`;
    const outerManifest = `${outerRoot}/package.json`;
    const innerManifest = `${innerRoot}/package.json`;
    const outerEntry = `${outerRoot}/index.js`;
    const innerEntry = `${innerRoot}/index.js`;
    try {
      fixture.write(
        outerManifest,
        JSON.stringify({ name: "@ut-tdd-test/outer", version: "1.0.0" }),
      );
      fixture.write(
        innerManifest,
        JSON.stringify({ name: "@ut-tdd-test/inner", version: "2.0.0" }),
      );
      fixture.write(outerEntry, "export const outer = 1;\n");
      fixture.write(innerEntry, "export const inner = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: {
          [fixture.input(outerEntry)]: {},
          [fixture.input(innerEntry)]: {},
        },
      });
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(
        observed.generation.receipt.external_dependencies.map((item) => [
          item.package_name,
          item.package_json_path,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["@ut-tdd-test/outer", fixture.input(outerManifest)],
          ["@ut-tdd-test/inner", fixture.input(innerManifest)],
        ]),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-004 Issue #1343 variant rejects a lexical compile-input escape", async () => {
    const fixture = createDependencyFixture();
    try {
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { "../outside/node_modules/pkg/index.js": {} },
      });
      expect(observed).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          name: "NodeBootstrapError",
          code: "node-bootstrap-source-path-escape",
        }),
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-004 Issue #1343 variant rejects a symlinked package outside the repository", async () => {
    const fixture = createDependencyFixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), "ut-tdd-node-bootstrap-outside-"));
    try {
      const link = fixture.absolute("node_modules/escaped-package");
      const outsideManifest = join(outsideRoot, "package.json");
      const outsideEntry = join(outsideRoot, "index.js");
      mkdirSync(dirname(link), { recursive: true });
      writeFileSync(outsideManifest, JSON.stringify({ name: "escaped-package", version: "1.0.0" }));
      writeFileSync(outsideEntry, "export const value = 1;\n");
      symlinkSync(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input("node_modules/escaped-package/index.js")]: {} },
      });
      expect(observed).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          name: "NodeBootstrapError",
          code: "node-bootstrap-dependency-path-escape",
        }),
      });
    } finally {
      fixture.cleanup();
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("CAND-NODEBOOT-B1 Issue #1343 variant seals the package-root manifest digest", async () => {
    const fixture = createDependencyFixture();
    const packageRoot = "node_modules/@ut-tdd-test/root-digest";
    const ownerManifest = `${packageRoot}/package.json`;
    const nestedManifest = `${packageRoot}/lib/esm/package.json`;
    const entry = `${packageRoot}/lib/esm/index.js`;
    try {
      const originalManifest = fixture.write(
        ownerManifest,
        JSON.stringify({ name: "@ut-tdd-test/root-digest", version: "1.0.0" }),
      );
      fixture.write(
        nestedManifest,
        JSON.stringify({ name: "@ut-tdd-test/nested-module", version: "1.0.0", type: "module" }),
      );
      fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed).toMatchObject({ ok: true });
      if (!observed.ok) return;
      const original = readFileSync(originalManifest);
      try {
        writeFileSync(originalManifest, Buffer.concat([original, Buffer.from("\nmutation\n")]));
        expect(() =>
          bootstrap.verifyNodeGeneration(root, observed.generation.generationPath, candidate),
        ).toThrow(/dependency-digest-mismatch/);
      } finally {
        writeFileSync(originalManifest, original);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-B1 Issue #1343 variant retains nested-manifest digest coverage", async () => {
    const fixture = createDependencyFixture();
    const packageRoot = "node_modules/@ut-tdd-test/nested-digest";
    const ownerManifest = `${packageRoot}/package.json`;
    const nestedManifest = `${packageRoot}/lib/esm/package.json`;
    const entry = `${packageRoot}/lib/esm/index.js`;
    try {
      fixture.write(
        ownerManifest,
        JSON.stringify({ name: "@ut-tdd-test/nested-digest", version: "1.0.0" }),
      );
      const originalManifest = fixture.write(
        nestedManifest,
        JSON.stringify({ name: "@ut-tdd-test/nested-module", version: "2.0.0", type: "module" }),
      );
      fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      const dependency = observed.generation.receipt.external_dependencies.find(
        (item) => item.package_name === "@ut-tdd-test/nested-digest",
      );
      expect(dependency?.package_json_path).toBe(fixture.input(ownerManifest));
      const bundledPaths = observed.generation.receipt.external_dependencies.flatMap((item) =>
        item.bundle_files.map((file) => file.path),
      );
      expect(bundledPaths).toContain(fixture.input(nestedManifest));
      const original = readFileSync(originalManifest);
      try {
        writeFileSync(originalManifest, Buffer.concat([original, Buffer.from("\nmutation\n")]));
        expect(() =>
          bootstrap.verifyNodeGeneration(root, observed.generation.generationPath, candidate),
        ).toThrow(/dependency-digest-mismatch/);
      } finally {
        writeFileSync(originalManifest, original);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-B1 Issue #1343 variant rejects bundled JavaScript digest drift", async () => {
    const fixture = createDependencyFixture();
    const packageRoot = "node_modules/@ut-tdd-test/javascript-digest";
    const ownerManifest = `${packageRoot}/package.json`;
    const entry = `${packageRoot}/index.js`;
    try {
      fixture.write(
        ownerManifest,
        JSON.stringify({ name: "@ut-tdd-test/javascript-digest", version: "1.0.0" }),
      );
      const originalEntry = fixture.write(entry, "export const value = 1;\n");
      const observed = await observeBuild({
        outputRoot: fixture.outputRoot,
        compileInputs: { [fixture.input(entry)]: {} },
      });
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      const dependency = observed.generation.receipt.external_dependencies.find(
        (item) => item.package_name === "@ut-tdd-test/javascript-digest",
      );
      expect(dependency?.bundle_files.map((file) => file.path)).toContain(fixture.input(entry));
      const original = readFileSync(originalEntry);
      try {
        writeFileSync(originalEntry, Buffer.concat([original, Buffer.from("\nmutation\n")]));
        expect(() =>
          bootstrap.verifyNodeGeneration(root, observed.generation.generationPath, candidate),
        ).toThrow(/dependency-digest-mismatch/);
      } finally {
        writeFileSync(originalEntry, original);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("CAND-NODEBOOT-B1 real bundle seals its external dependency closure", async () => {
    rmTestDist(resolve(root, "dist"));
    const real = await buildReal();
    const dependencies = real.receipt.external_dependencies as Array<{
      package_name: string;
      bundle_files: Array<{ path: string; sha256: string }>;
    }>;
    expect(dependencies.length).toBeGreaterThan(0);
    expect(dependencies.every((dependency) => dependency.bundle_files.length > 0)).toBe(true);
  });

  it("CAND-NODEBOOT-B4 real sealed CLI executes under Node", async () => {
    const real = await buildReal();
    const output = execFileSync(real.nodePath, [real.compiledCliPath, "--help"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toContain("Usage: ut-tdd");
  });

  it("CAND-NODEBOOT-B1 dependency content mutation breaks verification", async () => {
    const real = await buildReal();
    const fixture = createVerificationFixture(real);
    const dependency = real.receipt.external_dependencies[0] as unknown as {
      bundle_files: Array<{ path: string; sha256: string }>;
    };
    const input = dependency.bundle_files[0];
    const inputPath = resolve(fixture.root, input.path);
    const original = readFileSync(inputPath);
    try {
      writeFileSync(inputPath, Buffer.concat([original, Buffer.from("\nmutation\n")]));
      expect(() =>
        bootstrap.verifyNodeGeneration(fixture.root, fixture.generationPath, candidate),
      ).toThrow(/dependency-(digest|closure)-mismatch/);
    } finally {
      writeFileSync(inputPath, original);
      rmTestDist(fixture.root);
    }
  });

  it("CAND-NODEBOOT-B2/B3 runs the authoritative builder and emits real metafile", () => {
    const fixture = mkdtempSync(join(tmpdir(), "ut-tdd-node-builder-"));
    try {
      const outfile = join(fixture, "ut-tdd.mjs");
      const metafile = join(fixture, "meta.json");
      execFileSync(process.execPath, [resolve(root, "scripts/build-node.mjs"), outfile, metafile], {
        cwd: root,
        stdio: "pipe",
      });
      const meta = JSON.parse(readFileSync(metafile, "utf8")) as {
        inputs?: Record<string, unknown>;
      };
      expect(statSync(outfile).size).toBeGreaterThan(0);
      expect(Object.keys(meta.inputs ?? {}).some((path) => path.includes("node_modules"))).toBe(
        true,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("CAND-NODEBOOT-B2 builder digest mutation fails closed", async () => {
    const real = await buildReal();
    const fixture = createVerificationFixture(real);
    const builderPath = resolve(fixture.root, real.receipt.builder.path);
    const original = readFileSync(builderPath);
    const canonicalBuilderPath = resolve(root, real.receipt.builder.path);
    const canonicalOriginal = readFileSync(canonicalBuilderPath);
    try {
      writeFileSync(builderPath, Buffer.concat([original, Buffer.from("\nmutation\n")]));
      expect(() =>
        bootstrap.verifyNodeGeneration(fixture.root, fixture.generationPath, candidate),
      ).toThrow(/builder-digest-mismatch/);
      expect(readFileSync(canonicalBuilderPath)).toEqual(canonicalOriginal);
    } finally {
      writeFileSync(builderPath, original);
      rmTestDist(fixture.root);
    }
  });

  it("ST-NODEPROBE-001 public probe route emits the bound four-check result", async () => {
    const real = await buildReal();
    const invocation = bootstrap.createNodeInvocation(real, [
      "audit",
      "node-invocation-probe",
      "--generation",
      real.generationPath,
      "--json",
    ]);
    const child = spawnSync(real.nodePath, invocation.args, {
      cwd: root,
      ...invocation.options,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout ?? "")).toEqual({
      schema: "node-invocation-probe-result/v1",
      candidate_id: "CAND-NODEBOOT-201",
      probe_id: "CAND-NODEBOOT-201/P1",
      test_source: "src/cli.ts#audit node-invocation-probe",
      production_target: "src/runtime/node-bootstrap.ts#createNodeInvocation",
      generation_id: real.receipt.generation_id,
      subject_revision: real.receipt.subject_revision,
      compiled_cli_sha256: real.receipt.compiled_cli.sha256,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      checks: [
        { id: "invocation-options", result: "passed" },
        { id: "compiled-cli-argv0", result: "passed" },
        { id: "node-path-absolute", result: "passed" },
        { id: "compiled-cli-path-absolute", result: "passed" },
      ],
    });
  });
});
