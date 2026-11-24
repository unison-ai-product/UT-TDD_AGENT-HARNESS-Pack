import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  collectDistributionCandidatePaths,
  packageConsumerRuntimeRelease,
  resolveConsumerRuntimeReleaseSourceBinding,
} from "../src/cli/distribution.ts";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import {
  AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  cleanDistributionSourcePath,
  digestConsumerRuntimeBytes,
  releaseArtifactFileNames,
} from "../src/setup/index.ts";
import {
  observePackPublication,
  type PackPublicationGitRunner,
} from "../src/setup/pack-publication-observe.ts";
import {
  createLocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../src/setup/release-artifact-resolver.ts";
import { materializeReleaseArtifacts } from "../src/setup/release-materializer.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { fakeGenerationBuilder } from "./support/pack-publication-audit-generation.ts";
import {
  expectTreeEntry,
  git,
  stageSpecial,
  write,
  writeStaged,
} from "./support/pack-publication-audit-git.ts";
import { useSyntheticPrivacyHome } from "./support/privacy-denylist-home.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// Red (issue #1894): U-PKAUD-001..011 と 013..017 を it.fails で登録する。
// 004 / 005 は既存の拒否 (artifact_mismatch) の特性化で、main で既に通るため it.fails にしない (回帰の oracle)。
// 012 は L12 の手動受入 (CI の対象外) なので、ここには登録しない (省略)。
// 契約: docs/design/harness/L6-function-design/pack-publication-audit-wiring.md
// oracle: docs/test-design/harness/L7-pack-publication-audit-wiring-test-design.md
// 解釈: 失敗の JSON の `publicationAudit` は、CLI が出力へ写せるように、投げられる
// ConsumerRuntimeReleaseProducerError の `publicationAudit` フィールドに載ると読む (設計 §4 / §5)。

const planResults = vi.hoisted(() => [] as boolean[]);
vi.mock("../src/setup/pack-publication-staging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/setup/pack-publication-staging.ts")>();
  return {
    ...actual,
    buildPackPublicationStagingPlan: (
      ...args: Parameters<typeof actual.buildPackPublicationStagingPlan>
    ) => {
      const result = actual.buildPackPublicationStagingPlan(...args);
      planResults.push(result.ok);
      return result;
    },
  };
});

const privacyHome = useSyntheticPrivacyHome();
const TAG = "v0.2.0-canary.2";
const SECRET_TEXT = "PKAUD-SECRET-PRIVATE-CONTENT-9f3a";
const FIXED_BUILD_INPUTS = [
  "docs/governance/node-toolchain-provenance.json",
  "docs/governance/vmodel-document-catalog.md",
  "tsconfig.node.json",
] as const;
const ARTIFACT_PATHS = [
  "README.md",
  "LICENSE",
  "NOTICE",
  "package.json",
  ".node-version",
  "src/cli.ts",
  "src/setup/index.ts",
  "docs/governance/oracle-test-trace-baseline.json",
  "docs/templates/adapter/AGENTS.md",
  "docs/templates/adapter/CLAUDE.md",
  "docs/templates/adapter/.codex/config.toml",
  "docs/templates/adapter/.codex/hooks.json",
  "docs/templates/adapter/.claude/CLAUDE.md",
  "docs/templates/adapter/.claude/settings.json",
  "docs/templates/adapter/.claude/commands/build.md",
  "docs/templates/adapter/.claude/commands/code-simplify.md",
  "docs/templates/adapter/.claude/commands/sdd-plan.md",
  "docs/templates/adapter/.claude/commands/sdd-review.md",
  "docs/templates/adapter/.claude/commands/ship.md",
  "docs/templates/adapter/.claude/commands/spec.md",
  "docs/templates/adapter/.claude/commands/test.md",
  "docs/templates/adapter/.claude/commands/ut-tdd-status.md",
  "docs/templates/adapter/.claude/commands/ut-tdd-test.md",
  ...AUTHORING_TEMPLATE_ARTIFACT_PATHS,
];
const TEMPLATES = [
  "docs/templates/vmodel/L0-charter.md",
  "docs/templates/vmodel/L1-requirements.md",
];

// ---------------------------------------------------------------------------
// fixture: 共有の基底 (C1 の中身、manifest 無し) を 1 回だけ作り、case ごとに local clone する
// ---------------------------------------------------------------------------

let scratchRoot = "";
let baseRoot = "";
let baseEntries: Array<{ path: string; mode: "100644" | "100755"; content: Buffer }> = [];
let baseDigest = "";
let buildInputCount = 0;

heavyBeforeAll("pack", async () => {
  scratchRoot = mkdtempSync(join(tmpdir(), "ut-tdd-pkaud-"));
  baseRoot = join(scratchRoot, "base");
  mkdirSync(baseRoot);
  const repositoryRoot = resolve(process.cwd());
  const sourcePaths = collectDistributionCandidatePaths(repositoryRoot);
  const copy = (path: string, from: string) => {
    mkdirSync(dirname(join(baseRoot, path)), { recursive: true });
    cpSync(from, join(baseRoot, path), { recursive: true });
  };
  for (const path of ARTIFACT_PATHS)
    copy(path, join(repositoryRoot, cleanDistributionSourcePath(path, sourcePaths)));
  for (const path of [...FIXED_BUILD_INPUTS, ...TEMPLATES])
    if (!ARTIFACT_PATHS.includes(path)) {
      copy(path, join(repositoryRoot, path));
      buildInputCount += 1;
    }
  rmSync(join(baseRoot, ".github", "workflows", "harness-check.yml"), { force: true });
  git(baseRoot, ["init", "--quiet", "-b", "main"]);
  git(baseRoot, ["config", "core.autocrlf", "false"]);
  git(baseRoot, ["config", "user.email", "test@example.invalid"]);
  git(baseRoot, ["config", "user.name", "PKAUD Test"]);
  git(baseRoot, ["config", "commit.gpgsign", "false"]);
  git(baseRoot, ["add", "--", "."]);
  git(baseRoot, ["commit", "--quiet", "-m", "base C1"]);
  const resolved = await resolveReleaseArtifacts(
    {
      repository: baseRoot,
      release: {
        releaseId: "fixture-release",
        materializerVersion: "1",
        artifactSourceCommit: git(baseRoot, ["rev-parse", "HEAD"]),
        artifactSetDigest: `sha256:${"0".repeat(64)}`,
      },
    },
    { git: createLocalGitObjectReader(), materialize: materializeReleaseArtifacts },
  );
  if (!resolved.ok) throw new Error(`base artifact resolution failed: ${resolved.error}`);
  baseDigest = resolved.digest;
  baseEntries = resolved.entries.map((entry) => {
    if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error("unsupported mode");
    return { path: entry.path, mode: entry.mode, content: Buffer.from(entry.content) };
  });
});

heavyAfterAll("teardown", () => {
  if (scratchRoot) removeTestTree(scratchRoot);
});

type EntryOverride = { mode: string; content: Buffer };

function manifestFor(
  c1: string,
  overrides: Readonly<Record<string, EntryOverride>> = {},
): Record<string, unknown> {
  const artifacts = baseEntries
    .map((base) => ({ ...base, ...overrides[base.path] }))
    .map((entry) => ({
      sourcePath: entry.path,
      destinationPath: entry.path,
      mode: entry.mode,
      size: entry.content.length,
      contentDigest: digestConsumerRuntimeBytes(entry.content),
    }));
  const base = {
    materializerVersion: "1",
    artifactSourceCommit: c1,
    artifactSetDigest: baseDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(
      artifacts as Parameters<typeof deriveArtifactInventoryDigest>[0],
    ),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts,
  };
  const releaseId = deriveReleaseId("1", c1, baseDigest);
  return {
    schema_version: "v2",
    releases: { [releaseId]: { ...base, releaseRecordDigest: deriveReleaseRecordDigest(base) } },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
}

interface Case {
  readonly root: string;
  readonly c1: string;
  readonly c2: string;
}

let caseSeq = 0;
/** C1 に mutate を足して commit し、その上に release/ だけを足した C2 を commit して tag する。 */
function makeCase(
  mutateC1?: (root: string) => void,
  c2Extra: Readonly<Record<string, string>> = {},
  opts: {
    mutateC2?: (root: string) => void;
    manifestOverrides?: Readonly<Record<string, EntryOverride>>;
  } = {},
): Case {
  caseSeq += 1;
  const root = join(scratchRoot, `case-${caseSeq}`);
  execFileSync(
    "git",
    ["clone", "--quiet", "--local", "--no-tags", "-c", "core.autocrlf=false", baseRoot, root],
    { stdio: "pipe" },
  );
  git(root, ["config", "core.autocrlf", "false"]);
  // mode だけの変更 (update-index --chmod) を、後続の git add が working tree の mode で上書きしない。
  git(root, ["config", "core.fileMode", "false"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "PKAUD Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  if (mutateC1) {
    mutateC1(root);
    git(root, ["commit", "--quiet", "-m", "C1 mutation"]);
  }
  const c1 = git(root, ["rev-parse", "HEAD"]);
  writeStaged(root, "release/manifest.yaml", stringify(manifestFor(c1, opts.manifestOverrides)));
  for (const [path, text] of Object.entries(c2Extra)) writeStaged(root, path, text);
  opts.mutateC2?.(root);
  git(root, ["commit", "--quiet", "-m", "C2 release manifest"]);
  git(root, ["tag", TAG]);
  return { root, c1, c2: git(root, ["rev-parse", "HEAD"]) };
}

interface Attempt {
  readonly result?: Record<string, unknown>;
  readonly error?: { code?: string; publicationAudit?: Record<string, unknown>; message: string };
  readonly installCalls: number;
  readonly outFiles: string[];
}

async function attempt(fixture: Case, runGit?: PackPublicationGitRunner): Promise<Attempt> {
  planResults.length = 0; // 計画の呼び出しの記録は case ごとに始める (テスト間で溜めない)
  const outDir = mkdtempSync(join(scratchRoot, "out-"));
  let installCalls = 0;
  const files = () => (existsSync(outDir) ? readdirSync(outDir) : []);
  try {
    const options = {
      repoRoot: fixture.root,
      tag: TAG,
      outDir,
      homeDirectory: privacyHome.path,
      installDependencies: () => {
        installCalls += 1;
      },
      buildGeneration: fakeGenerationBuilder(),
    };
    const result = await packageConsumerRuntimeRelease({ ...options, runGit } as Parameters<
      typeof packageConsumerRuntimeRelease
    >[0]);
    return {
      result: result as unknown as Record<string, unknown>,
      installCalls,
      outFiles: files(),
    };
  } catch (error) {
    return { error: error as Attempt["error"], installCalls, outFiles: files() };
  }
}

function expectRejected(run: Attempt, code: string): void {
  expect(run.error?.code).toBe(code);
  expect(run.installCalls).toBe(0);
  expect(run.outFiles).toEqual([]);
}

function expectRejectedMessage(run: Attempt, text: string): void {
  expect(run.error?.message).toContain(text);
  expect(run.installCalls).toBe(0);
  expect(run.outFiles).toEqual([]);
}

const addExtra = (path = "private/pkaud-extra.txt") => {
  return (root: string) => writeStaged(root, path, `${SECRET_TEXT}\n`);
};

describe("U-PKAUD package の公開照合の配線", () => {
  it.fails("U-PKAUD-001: 正しい C1 / C2 は attested で、5 asset が書かれ照合の結果が出力される", async () => {
    const fx = makeCase();
    const run = await attempt(fx);
    expect(run.error).toBeUndefined();
    const names = Object.values(releaseArtifactFileNames(TAG));
    expect([...run.outFiles].sort()).toEqual([...names].sort());
    const trackedInC2 = git(fx.root, ["ls-tree", "-r", "--name-only", fx.c2]).split(/\r?\n/);
    expect(run.result?.publicationAudit).toMatchObject({
      status: "attested",
      c1: fx.c1,
      c2: fx.c2,
      entryCount: trackedInC2.length,
      buildInputCount,
    });
  });

  it.fails("U-PKAUD-002: 期待外の file が C1 にあれば extra で拒否し、asset を作らない", async () => {
    const run = await attempt(makeCase(addExtra()));
    expectRejected(run, "pack_publication_audit_commit_entries_mismatch");
    expect(run.error?.publicationAudit?.details).toContainEqual({
      category: "extra",
      path: "private/pkaud-extra.txt",
    });
  });

  it.fails("U-PKAUD-003: release/ 配下の release/manifest.yaml 以外の file は extra で拒否する", async () => {
    const run = await attempt(makeCase(undefined, { "release/notes.md": "notes\n" }));
    expectRejected(run, "pack_publication_audit_commit_entries_mismatch");
    expect(run.error?.publicationAudit?.details).toContainEqual({
      category: "extra",
      path: "release/notes.md",
    });
  });

  it("U-PKAUD-004: artifact の blob を 1 byte 変えると、既存の tar の導出が artifact_mismatch で拒否する (計画も観測も呼ばれない)", async () => {
    const license = baseEntries.find((entry) => entry.path === "LICENSE")?.content.toString("utf8");
    const run = await attempt(makeCase((root) => writeStaged(root, "LICENSE", `${license}x`)));
    expectRejectedMessage(
      run,
      "distribution package tar materialization failed: artifact_mismatch",
    );
  });

  it("U-PKAUD-005: artifact の mode だけが manifest と違うと、既存の tar の導出が artifact_mismatch で拒否する", async () => {
    const run = await attempt(
      makeCase((root) => git(root, ["update-index", "--chmod=+x", "--", "LICENSE"])),
    );
    expectRejectedMessage(
      run,
      "distribution package tar materialization failed: artifact_mismatch",
    );
  });

  it.fails("U-PKAUD-006: C2 の release/ の中の mode 120000 は観測が entry を作らず extra として拒否する", async () => {
    const fx = makeCase(
      undefined,
      {},
      {
        mutateC2: (root) => stageSpecial(root, "120000", "release/link"),
      },
    );
    expectTreeEntry(fx.root, fx.c2, "release/link", "120000", "target.ts");
    const run = await attempt(fx);
    expectRejected(run, "pack_publication_audit_commit_entries_mismatch");
    expect(run.error?.publicationAudit?.details).toContainEqual({
      category: "extra",
      path: "release/link",
    });
  });

  it.fails("U-PKAUD-007: 観測の git が失敗すれば indeterminate で止まり、asset を作らない (計画は作られている)", async () => {
    const fx = makeCase();
    expect(resolveConsumerRuntimeReleaseSourceBinding(fx.root, TAG)).toMatchObject({
      releaseRevision: fx.c2,
      artifactSourceRevision: fx.c1,
    });
    for (const failing of ["ls-tree", "cat-file"]) {
      planResults.length = 0;
      const failedAt: string[] = [];
      const runGit: PackPublicationGitRunner = (args) => {
        if (args.includes(failing)) {
          failedAt.push(failing);
          return { status: 128, stdout: new Uint8Array() };
        }
        const r = spawnSync("git", ["-C", fx.root, ...args], { maxBuffer: 256 * 1024 * 1024 });
        return { status: r.status ?? 1, stdout: r.stdout };
      };
      const run = await attempt(fx, runGit);
      expect(planResults).toEqual([true]);
      expect(failedAt).toEqual([failing]);
      expectRejected(run, "pack_publication_audit_observation_unavailable");
      expect(run.error?.publicationAudit?.status).toBe("indeterminate");
    }
  });

  it.fails("U-PKAUD-008: 観測は C2 の tree だけを対象にし、index と working tree を読まない", async () => {
    const clean = makeCase();
    write(clean.root, "untracked-extra.txt", "untracked\n");
    write(clean.root, "staged-extra.txt", "staged\n");
    git(clean.root, ["add", "--", "staged-extra.txt"]);
    const accepted = await attempt(clean);
    expect(accepted.result?.publicationAudit).toMatchObject({ status: "attested" });

    const committed = await attempt(makeCase(addExtra()));
    expectRejected(committed, "pack_publication_audit_commit_entries_mismatch");
  });

  it("U-PKAUD-009: ビルド入力の欠落は pack_build_input_* のまま報告され、照合の理由に上書きされない", async () => {
    const run = await attempt(
      makeCase((root) => git(root, ["rm", "-q", "--", "tsconfig.node.json"])),
    );
    expect(run.error?.code).toMatch(/^pack_build_input_/);
    expect(run.installCalls).toBe(0);
    expect(run.outFiles).toEqual([]);
  }, 180_000);

  it.fails("U-PKAUD-010: 失敗の出力は理由コード・path・分類・SHA だけで、bytes・digest・内容を含まない", async () => {
    const fx = makeCase(addExtra());
    const run = await attempt(fx);
    expect(run.error?.code).toBe("pack_publication_audit_commit_entries_mismatch");
    const audit = run.error?.publicationAudit ?? {};
    expect(Object.keys(audit).sort()).toEqual(["c1", "c2", "details", "status"]);
    expect(audit).toMatchObject({ status: "partial_publication", c1: fx.c1, c2: fx.c2 });
    const details = audit.details as Array<Record<string, unknown>>;
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(Object.keys(detail).sort()).toEqual(["category", "path"]);
      expect(["missing", "extra", "mode", "content"]).toContain(detail.category);
    }
    const serialized = JSON.stringify({
      ok: false,
      error: run.error?.code,
      publicationAudit: audit,
    });
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toMatch(/sha256:[0-9a-f]{64}/);
  });

  it.fails("U-PKAUD-011: 観測は固定した C2 の SHA だけで git を呼び、cat-file の入力は ls-tree の blob OID と 1 対 1 に対応する", () => {
    const fx = makeCase();
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const runGit: PackPublicationGitRunner = (args, stdin) => {
      calls.push({
        args: [...args],
        stdin: stdin ? Buffer.from(stdin).toString("utf8") : undefined,
      });
      const r = spawnSync("git", ["-C", fx.root, ...args], {
        input: stdin,
        maxBuffer: 256 * 1024 * 1024,
      });
      return { status: r.status ?? 1, stdout: r.stdout };
    };
    const first = observePackPublication({ repoRoot: fx.root, c1: fx.c1, c2: fx.c2, runGit });
    const lsTree = calls.find((call) => call.args.includes("ls-tree"));
    const catFile = calls.find((call) => call.args.includes("cat-file"));
    expect(lsTree).toBeDefined();
    expect(catFile).toBeDefined();
    expect(lsTree?.args.filter((arg) => /^[0-9a-f]{40}$/.test(arg))).toEqual([fx.c2]);
    expect(catFile?.args).toContain("--batch");
    const treeOut = git(fx.root, ["ls-tree", "-r", "--full-tree", fx.c2]);
    const oids = treeOut.split(/\r?\n/).map((line) => line.split(/\s+/)[2]);
    expect(catFile?.stdin?.split("\n").filter(Boolean)).toEqual(oids);
    const flat = JSON.stringify(calls);
    for (const name of ["HEAD", TAG, "main", fx.c1]) expect(flat).not.toContain(name);
    git(fx.root, ["tag", "-f", TAG, fx.c1]);
    const second = observePackPublication({ repoRoot: fx.root, c1: fx.c1, c2: fx.c2 });
    expect(second).toEqual(first);
    expect(first.status).toBe("observed");
  });

  it.fails("U-PKAUD-013: package.json の末尾の空白は計画を通り、観測が生の blob の違いを content として拒否する", async () => {
    const pkg = baseEntries
      .find((entry) => entry.path === "package.json")
      ?.content.toString("utf8");
    const run = await attempt(makeCase((root) => writeStaged(root, "package.json", `${pkg} `)));
    expectRejected(run, "pack_publication_audit_commit_entries_mismatch");
    expect(run.error?.publicationAudit?.details).toContainEqual({
      category: "content",
      path: "package.json",
    });
  });

  // 014 は main の既存の拒否 (invalid_artifact) の特性化で、main で既に通るため it.fails にしない (回帰の oracle)。
  it("U-PKAUD-014: C1 の 160000 は resolveReleaseArtifacts が invalid_artifact で拒否し、観測へ進まない", async () => {
    const fx = makeCase((root) => stageSpecial(root, "160000", "private/sub"));
    expectTreeEntry(fx.root, fx.c1, "private/sub", "160000");
    const run = await attempt(fx);
    expectRejectedMessage(run, "distribution package tar materialization failed: invalid_artifact");
    expect(planResults).toEqual([]);
  });

  // 015 / 016 は main の既存の拒否 (tar mode unsupported / invalid_artifact) の特性化で、main で既に通るため it.fails にしない。
  it("U-PKAUD-015: 安全な artifact の symlink は tar mode is unsupported で拒否する", async () => {
    const fx = makeCase((root) => stageSpecial(root, "120000", "LICENSE", "NOTICE"));
    expectTreeEntry(fx.root, fx.c1, "LICENSE", "120000", "NOTICE");
    const run = await attempt(fx);
    expectRejectedMessage(run, "distribution package tar mode is unsupported: LICENSE");
  });

  it("U-PKAUD-016: 危険な (絶対 path の) target の artifact の symlink は materializer の invalid_artifact で拒否する", async () => {
    // 先行の privacy scan は artifact を readFileSync で読む。Linux の snapshot は symlink を実体化するので、
    // dangling な target (例: C:/x) は privacy-input-unreadable で先に止まる。target を実在する無害な file の
    // 絶対 path にして scan を通し、materializer の validSymlink の拒否 (絶対 path) だけを成功条件にする。
    const harmless = join(scratchRoot, "harmless-target.txt");
    write(scratchRoot, "harmless-target.txt", "harmless");
    const target = harmless.replaceAll("\\", "/");
    const fx = makeCase((root) => stageSpecial(root, "120000", "LICENSE", target));
    expectTreeEntry(fx.root, fx.c1, "LICENSE", "120000", target);
    const run = await attempt(fx);
    expectRejectedMessage(run, "distribution package tar materialization failed: invalid_artifact");
    expect(planResults).toEqual([]);
  });

  it.fails("U-PKAUD-017: artifact でない path の symlink は観測が commit_entries_mismatch (extra) で拒否する", async () => {
    const fx = makeCase((root) => stageSpecial(root, "120000", "notes/link"));
    expectTreeEntry(fx.root, fx.c1, "notes/link", "120000", "target.ts");
    const run = await attempt(fx);
    expectRejected(run, "pack_publication_audit_commit_entries_mismatch");
    expect(run.error?.publicationAudit?.details).toContainEqual({
      category: "extra",
      path: "notes/link",
    });
  });

  // U-PKAUD-012 は L12 の手動受入 (canary.7 形の 52 件 + 実機) で CI の対象外のため、ここには登録しない。
});
