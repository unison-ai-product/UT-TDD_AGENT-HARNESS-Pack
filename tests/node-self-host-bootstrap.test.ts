import { execFileSync } from "node:child_process";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as bootstrap from "../src/runtime/node-bootstrap.ts";

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
  } = {},
) =>
  bootstrap.buildNodeGeneration({
    repoRoot: root,
    candidateRevision: candidate,
    nodePath: options.nodePath,
    npmCliPath: options.npmCliPath,
    fault: options.fault,
    compile: async (outfile) => {
      writeFileSync(outfile, "export default 1;\n", "utf8");
      return { inputs: options.compileInputs ?? { "src/cli.ts": {} } };
    },
  });

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
  beforeAll(async () => {
    rmTestDist(resolve(root, "dist"));
    generation = await build();
  });
  afterAll(() => {
    rmTestDist(resolve(root, "dist"));
  });

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
    const builderPath = resolve(root, real.receipt.builder.path);
    const original = readFileSync(builderPath);
    try {
      writeFileSync(builderPath, Buffer.concat([original, Buffer.from("\nmutation\n")]));
      expect(() => bootstrap.verifyNodeGeneration(root, real.generationPath, candidate)).toThrow(
        /builder-digest-mismatch/,
      );
    } finally {
      writeFileSync(builderPath, original);
    }
  });
});
