import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import { stringify } from "yaml";
import { packageConsumerRuntimeRelease } from "../src/cli/distribution.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  buildCleanDistributionPlan,
  cleanDistributionSourcePath,
  transformCleanDistributionArtifact,
} from "../src/setup/distribution.ts";
import {
  digestConsumerRuntimeBytes,
  digestMaterializedReleaseEntries,
} from "../src/setup/index.ts";
import { heavyAfterAll, heavyBeforeAll, heavyIt } from "./support/hook-bounds.ts";
import {
  useSyntheticPrivacyHome,
  writeSyntheticPrivacyDenylist,
} from "./support/privacy-denylist-home.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// Red (issue #1882): U-PKBIN-006..011 (sync-pack / package の配線)。純粋関数と staging は pack-build-inputs.test.ts。

const FIXED = [
  "docs/governance/node-toolchain-provenance.json",
  "docs/governance/vmodel-document-catalog.md",
  "tsconfig.node.json",
] as const;

// ---------------------------------------------------------------------------
// CLI / producer fixtures (006-009, 011)
// ---------------------------------------------------------------------------

const TAG = "v0.0.0-test";
let authorRoot = "";
let scratchRoot = "";
let seedRoot = "";
let seedBuildInputs: string[] = [];
// seed に入れた artifact の基準集合 (ビルド入力を足す前の plan から独立に取る)。
let seedArtifactPaths: string[] = [];
const privacyHome = useSyntheticPrivacyHome();

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function fixtureBuildInputPaths(): string[] {
  // fixture 側の入力は契約の規則を独立に書いたもの (被検の selectPackBuildInputs には依存しない)。
  return git(authorRoot, ["ls-files"])
    .split(/\r?\n/)
    .filter(
      (path) =>
        FIXED.includes(path as (typeof FIXED)[number]) ||
        (path.startsWith("docs/templates/vmodel/") &&
          path.endsWith(".md") &&
          !path.startsWith("docs/templates/vmodel/review-examples/")),
    );
}

function commitSeed(root: string): void {
  const sourcePaths = git(authorRoot, ["ls-files"]).split(/\r?\n/).filter(Boolean);
  const plan = buildCleanDistributionPlan({ paths: sourcePaths, sourceTag: TAG });
  seedArtifactPaths = [...plan.artifactPaths].sort();
  for (const rel of plan.artifactPaths) {
    const from = join(authorRoot, cleanDistributionSourcePath(rel, sourcePaths));
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (rel === "package.json") {
      writeFileSync(to, transformCleanDistributionArtifact(rel, readFileSync(from, "utf8")));
    } else {
      cpSync(from, to, { recursive: true });
    }
  }
  for (const rel of seedBuildInputs) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(authorRoot, rel), join(root, rel));
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "PKBIN Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "clean artifacts and build inputs"]);
}

function cloneSource(label: string, mutate?: (root: string) => void): string {
  const root = join(scratchRoot, label);
  git(scratchRoot, [
    "clone",
    "--quiet",
    "--shared",
    "--no-tags",
    "-c",
    "core.autocrlf=false",
    seedRoot,
    root,
  ]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "PKBIN Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  if (mutate) {
    mutate(root);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "case mutation"]);
  }
  return root;
}

function releaseManifest(artifactSourceCommit: string): Record<string, unknown> {
  const content = Buffer.from("export const fixture = true;\n", "utf8");
  const artifacts = [
    {
      sourcePath: "src/artifact.ts",
      destinationPath: "src/artifact.ts",
      mode: "100644" as const,
      size: content.length,
      contentDigest: digestConsumerRuntimeBytes(content),
    },
  ];
  const artifactSetDigest = digestMaterializedReleaseEntries([
    { path: "src/artifact.ts", mode: "100644", content },
  ]);
  const base = {
    materializerVersion: "1",
    artifactSourceCommit,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts,
  };
  const releaseId = deriveReleaseId("1", artifactSourceCommit, artifactSetDigest);
  return {
    schema_version: "v2",
    releases: { [releaseId]: { ...base, releaseRecordDigest: deriveReleaseRecordDigest(base) } },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
}

function tagRelease(root: string): void {
  const c1 = git(root, ["rev-parse", "HEAD"]);
  write(root, "release/manifest.yaml", stringify(releaseManifest(c1)));
  git(root, ["add", "--", "release/manifest.yaml"]);
  git(root, ["commit", "-q", "-m", "release manifest"]);
  git(root, ["tag", TAG]);
}

function runDistribution(cwd: string, home: string, args: string[]) {
  return spawnSync(process.execPath, [join(authorRoot, "src", "cli.ts"), "distribution", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 300_000,
    windowsHide: true,
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads a nested JSON value without trusting its shape. */
function pick(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function kindsOf(stdout: string): unknown[] {
  const findings = pick(parseJson(stdout), "privacyScan", "findings");
  return Array.isArray(findings) ? findings.map((finding) => pick(finding, "kind")) : [];
}

function registeredPackTests(ctx: TestContext, id: string) {
  return (ctx.task.suite?.tasks ?? [])
    .filter((task) => task.type === "test")
    .filter((task) => task.name.startsWith(`${id}:`));
}

function walkBytes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(directory, entry.name);
      if (entry.isDirectory()) visit(abs, rel);
      else out.set(rel, readFileSync(abs).toString("latin1"));
    }
  };
  visit(root, "");
  return out;
}

describe("U-PKBIN sync-pack / package wiring", () => {
  beforeAll(() => {
    authorRoot = process.cwd();
    scratchRoot = mkdtempSync(join(tmpdir(), "pkbin-red-"));
  });
  heavyBeforeAll(["pack", 180_000], () => {
    seedBuildInputs = fixtureBuildInputPaths();
    seedRoot = join(scratchRoot, "seed");
    commitSeed(seedRoot);
  });
  heavyAfterAll(["teardown", 120_000], () => {
    if (seedRoot) removeTestTree(seedRoot);
    if (scratchRoot) removeTestTree(scratchRoot);
  });

  it("U-PKBIN-006: ビルド入力が欠けた source の sync-pack は repoDir を 1 byte も変えず exit 1", () => {
    const source = cloneSource("c006", (root) => {
      git(root, ["rm", "-q", "--", "tsconfig.node.json"]);
    });
    const packDir = join(scratchRoot, "c006-pack");
    write(packDir, "existing.txt", "keep me\n");
    write(packDir, "stale/old.txt", "stale\n");
    const before = walkBytes(packDir);
    const result = runDistribution(source, privacyHome.path, [
      "sync-pack",
      "--repo-dir",
      packDir,
      "--prune-local",
      "--json",
    ]);
    const json = parseJson(result.stdout);
    expect(result.status).toBe(1);
    expect(pick(json, "pack", "buildInputs", "ok")).toBe(false);
    expect(pick(json, "pack", "buildInputs", "reasons")).toContainEqual({
      code: "pack_build_input_missing",
      path: "tsconfig.node.json",
    });
    expect(walkBytes(packDir)).toEqual(before);
  });

  it("U-PKBIN-006 (regression, L6 privacy-scan §12): 拒否時はビルド入力の path を escape 後の形も含めて nextCommands に出さない", () => {
    // tests/ は Pack に入るので、denylist の語は実行時に結合する。
    const term = ["zz", "build", "input", "word"].join("-");
    const home = mkdtempSync(join(tmpdir(), "pkbin-deny-home-"));
    write(home, ".ut-tdd/privacy-denylist.txt", `${term}\n`);
    const rel = `docs/templates/vmodel/${term}$person.md`;
    const source = cloneSource("c006-mask", (root) => write(root, rel, "template\n"));
    const packDir = join(scratchRoot, "c006-mask-pack");
    mkdirSync(packDir, { recursive: true });
    try {
      const result = runDistribution(source, home, ["sync-pack", "--repo-dir", packDir, "--json"]);
      expect(result.status).toBe(1);
      expect(kindsOf(result.stdout)).toContain("privacy-denylist-hit");
      const commands = pick(parseJson(result.stdout), "pack", "nextCommands") as string[];
      expect(commands.join("\n")).toContain("path-sha256:");
      for (const text of [result.stdout, result.stderr, commands.join("\n")]) {
        expect(text).not.toContain(term);
        expect(text).not.toContain("$person");
      }
    } finally {
      removeTestTree(home);
    }
  }, 180_000);

  it("U-PKBIN-007: sync-pack はビルド入力を bytes 同一で copy し artifact の集合は変えない", () => {
    const source = cloneSource("c007");
    const packDir = join(scratchRoot, "c007-pack");
    mkdirSync(packDir, { recursive: true });
    const result = runDistribution(source, privacyHome.path, [
      "sync-pack",
      "--repo-dir",
      packDir,
      "--json",
    ]);
    const json = parseJson(result.stdout);
    expect(result.status).toBe(0);
    const paths = [...seedBuildInputs].sort();
    const artifactPaths = (pick(json, "export", "artifactPaths") as string[] | undefined) ?? [];
    // artifact の集合と件数は基準と一致する (ビルド入力の混入を許さない)。
    expect([...artifactPaths].sort()).toEqual(seedArtifactPaths);
    // artifact と重なる path は変換後 bytes を出荷する (§2.2) ので bytes 同一の対象外。重なりは基準から求める。
    const overlap = paths.filter((rel) => seedArtifactPaths.includes(rel));
    const pureBuildInputs = paths.filter((rel) => !seedArtifactPaths.includes(rel));
    expect(pureBuildInputs.length).toBeGreaterThan(0);
    for (const rel of pureBuildInputs) {
      expect(artifactPaths).not.toContain(rel);
      expect(readFileSync(join(packDir, rel)).equals(readFileSync(join(source, rel)))).toBe(true);
    }
    for (const rel of overlap) expect(existsSync(join(packDir, rel))).toBe(true);
    const nextCommands =
      (pick(json, "pack", "nextCommands") as string[] | undefined)?.join("\n") ?? "";
    for (const rel of paths) expect(nextCommands).toContain(rel);
    expect(pick(json, "pack", "buildInputs")).toMatchObject({ ok: true, count: paths.length });
    expect(
      [...((pick(json, "pack", "buildInputs", "paths") as string[] | undefined) ?? [])].sort(),
    ).toEqual(paths);
    expect(pick(json, "pack", "copiedArtifacts")).toBe(seedArtifactPaths.length);
  });

  heavyIt(
    "U-PKBIN-008: --prune-local はビルド入力を消さず、一覧に無い stale file だけを消す",
    ["pack", 75_000],
    () => {
      const source = cloneSource("c008");
      const packDir = join(scratchRoot, "c008-pack");
      mkdirSync(packDir, { recursive: true });
      const first = runDistribution(source, privacyHome.path, [
        "sync-pack",
        "--repo-dir",
        packDir,
        "--json",
      ]);
      expect(first.status).toBe(0);
      write(packDir, "stale/leftover.txt", "stale\n");
      const second = runDistribution(source, privacyHome.path, [
        "sync-pack",
        "--repo-dir",
        packDir,
        "--prune-local",
        "--json",
      ]);
      const json = parseJson(second.stdout);
      expect(second.status).toBe(0);
      for (const rel of seedBuildInputs) {
        expect(existsSync(join(packDir, rel))).toBe(true);
        expect(pick(json, "pack", "unmanagedExistingPaths")).not.toContain(rel);
        expect(pick(json, "pack", "prunedPaths")).not.toContain(rel);
      }
      expect(pick(json, "pack", "prunedPaths")).toEqual(["stale/leftover.txt"]);
      expect(existsSync(join(packDir, "stale", "leftover.txt"))).toBe(false);
    },
  );

  it("U-PKBIN-009: package はビルド入力の欠落を install の前に理由コードで止め outDir を空に保つ", async () => {
    const source = cloneSource("c009", (root) => {
      git(root, ["rm", "-q", "--", "docs/governance/vmodel-document-catalog.md"]);
    });
    tagRelease(source);
    const outDir = mkdtempSync(join(tmpdir(), "pkbin-009-out-"));
    let installCalls = 0;
    try {
      await expect(
        packageConsumerRuntimeRelease({
          repoRoot: source,
          tag: TAG,
          outDir,
          homeDirectory: privacyHome.path,
          installDependencies: () => {
            installCalls += 1;
          },
          buildGeneration: async () => {
            throw new Error("must stop before generation");
          },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^pack_build_input_/) });
      expect(installCalls).toBe(0);
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      removeTestTree(outDir);
    }
  });

  heavyIt(
    "U-PKBIN-011: ビルド入力の denylist 一致は sync-pack / package の書き出し前に止める",
    ["pack", 75_000],
    () => {
      const home = writeSyntheticPrivacyDenylist(mkdtempSync(join(tmpdir(), "pkbin-011-home-")));
      const term = ["example", "fixture", "denylist", "term"].join("-");
      try {
        const source = cloneSource("c011", (root) => {
          const target = seedBuildInputs.find((rel) => rel.startsWith("docs/templates/vmodel/"));
          if (!target) throw new Error("fixture has no template build input");
          write(root, target, `${readFileSync(join(root, target), "utf8")}\nmentions ${term}\n`);
        });
        tagRelease(source);
        const packDir = join(scratchRoot, "c011-pack");
        mkdirSync(packDir, { recursive: true });
        const sync = runDistribution(source, home, ["sync-pack", "--repo-dir", packDir, "--json"]);
        expect(sync.status).toBe(1);
        expect(kindsOf(sync.stdout)).toContain("privacy-denylist-hit");
        expect(readdirSync(packDir)).toEqual([]);
        expect(`${sync.stdout}${sync.stderr}`).not.toContain(term);
        const releaseDir = join(scratchRoot, "c011-release");
        const pkg = runDistribution(source, home, [
          "package",
          "--tag",
          TAG,
          "--out",
          releaseDir,
          "--json",
        ]);
        expect(pkg.status).toBe(1);
        expect(kindsOf(pkg.stdout)).toContain("privacy-denylist-hit");
        expect(existsSync(join(releaseDir, `${TAG}.tar.gz`))).toBe(false);
        expect(`${pkg.stdout}${pkg.stderr}`).not.toContain(term);
      } finally {
        removeTestTree(home);
      }
    },
  );

  it("the two Pack CLI cases each have one numeric timeout registration", (ctx) => {
    for (const id of ["U-PKBIN-008", "U-PKBIN-011"]) {
      const matches = registeredPackTests(ctx, id);
      expect(matches, id).toHaveLength(1);
      expect(matches[0]?.timeout, id).toEqual(expect.any(Number));
    }
  });

  it("U-PKBIN-018: U-PKBIN-008 has a 75 second timeout", (ctx) => {
    expect(registeredPackTests(ctx, "U-PKBIN-008")[0]?.timeout).toBe(75_000);
  });

  it("U-PKBIN-019: U-PKBIN-011 has a 75 second timeout", (ctx) => {
    expect(registeredPackTests(ctx, "U-PKBIN-011")[0]?.timeout).toBe(75_000);
  });
});

describe("U-PKBIN-010 single source of truth (static)", () => {
  const literals = [
    "node-toolchain-provenance.json",
    "tsconfig.node.json",
    "vmodel-document-catalog.md",
    "docs/templates/vmodel/",
  ];
  const selectors = ["src/cli/distribution.ts", "tests/support/pack-internal-canary.ts"];

  it("U-PKBIN-010: 選択経路に独自の一覧は無く、全員が selectPackBuildInputs を呼ぶ", () => {
    for (const rel of selectors) {
      const text = readFileSync(join(process.cwd(), rel), "utf8");
      expect(text, `${rel} must call selectPackBuildInputs`).toContain("selectPackBuildInputs");
      expect(text, `${rel} must import the single source`).toMatch(/pack-build-inputs(\.ts)?["']/);
      for (const literal of literals) {
        expect(text, `${rel} must not own build-input literal ${literal}`).not.toContain(literal);
      }
    }
  });
});
