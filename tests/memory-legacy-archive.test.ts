import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeArtifacts } from "../src/lint/readability.ts";
import { analyzeSecretScan } from "../src/lint/secret-scan.ts";
import {
  LEGACY_MEMORY_ARCHIVE_META_FILES,
  LEGACY_MEMORY_ARCHIVE_ROOT,
  LEGACY_MEMORY_LOCAL_ARCHIVE_ROOT,
  LEGACY_MEMORY_MANIFEST_PATH,
  LEGACY_MEMORY_SOURCE_ROOT,
  LEGACY_MEMORY_SUMMARY_PATH,
  type LegacyArchiveManifest,
  readLegacyArchiveManifest,
  renderLegacyArchiveSummary,
  sha256Hex,
  verifyLegacyArchiveRow,
  verifyLegacyArchiveSets,
  verifyLegacyArchiveUntrackedOpacity,
} from "../src/memory/legacy-archive-manifest.ts";
import { buildCleanDistributionPlan } from "../src/setup/distribution.ts";

// The PR-2 archive is a repository fact: the manifest, the archive tree and the base-HEAD source
// set are read from the execution root once (test-repository-isolation contract: 1 call).
const root = process.cwd();

function git(args: readonly string[], encoding: "utf8"): string;
function git(args: readonly string[], encoding: "buffer"): Buffer;
function git(args: readonly string[], encoding: "utf8" | "buffer"): string | Buffer {
  // PR 範囲の blob 走査は、数 MB の追跡ファイル (棚卸しの JSON 等) を含みうる。既定の 1MB を超えると
  // ENOBUFS で落ちるため上限を広げる (2026-10-13、PR #965 / #966 で実測)。
  const out = execFileSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
  return encoding === "utf8" ? String(out).trim() : (out as Buffer);
}

// `git ls-tree -r -z <rev> -- <dir>` を 1 回だけ流し、path -> blob oid の Map にする。
// 行ごとの `git rev-parse` (607 行 x 2 回の子プロセス) を避けるためのバッチ化 (#1063)。
function blobOids(rev: string, dir: string): Map<string, string> {
  const oids = new Map<string, string>();
  for (const entry of git(["ls-tree", "-r", "-z", rev, "--", dir], "utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const oid = entry.slice(0, tab).split(" ")[2];
    if (oid) oids.set(entry.slice(tab + 1), oid);
  }
  return oids;
}

// `git cat-file --batch` を 1 プロセスだけ起動し、全 oid の type と内容をまとめて読む (#1063)。
// 出力は `<oid> <type> <size>\n<content>\n` の繰り返し。`<oid> missing` は旧 `cat-file -t` の失敗と同じく throw する。
function catFileBatch(oids: readonly string[]): { type: string; content: Buffer }[] {
  const out = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
    input: `${oids.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  const objects: { type: string; content: Buffer }[] = [];
  let pos = 0;
  for (const oid of oids) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) throw new Error(`cat-file --batch: truncated output at ${oid}`);
    const header = out.toString("utf8", pos, eol);
    const [gotOid, type, size] = header.split(" ");
    if (gotOid !== oid || !type || type === "missing" || size === undefined) {
      throw new Error(`cat-file --batch: object not readable: ${oid} (${header})`);
    }
    const start = eol + 1;
    const end = start + Number(size);
    if (end > out.length) throw new Error(`cat-file --batch: truncated content at ${oid}`);
    objects.push({ type, content: out.subarray(start, end) });
    pos = end + 1;
  }
  if (pos !== out.length) throw new Error("cat-file --batch: unexpected trailing output");
  return objects;
}

function manifestOf(): LegacyArchiveManifest {
  return readLegacyArchiveManifest(root);
}

function archiveFiles(): string[] {
  return readdirSync(join(root, LEGACY_MEMORY_ARCHIVE_ROOT)).filter(
    (name) => !LEGACY_MEMORY_ARCHIVE_META_FILES.includes(name),
  );
}

function baseTrackedPaths(manifest: LegacyArchiveManifest): string[] {
  return git(
    ["ls-tree", "-r", "--name-only", manifest.base_commit, LEGACY_MEMORY_SOURCE_ROOT],
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

describe("memory clean-cut PR-2: legacy corpus archive (U-MEMCUT-017..021, P-MEMCUT-023, P-MEMCUT-030)", () => {
  it("U-MEMCUT-017: base-HEAD tracked sources, manifest rows and archive files are a basename bijection; a dropped or added row is Red", () => {
    const manifest = manifestOf();
    const sources = baseTrackedPaths(manifest);
    const archive = archiveFiles();
    expect(sources.length).toBeGreaterThan(0);
    expect(
      verifyLegacyArchiveSets({ baseTrackedPaths: sources, manifest, archiveFiles: archive }),
    ).toEqual([]);
    // Counts are compared with each other only (no constant): sources == rows == archive files.
    expect(manifest.tracked.length).toBe(sources.length);
    expect(archive.length).toBe(sources.length);
    // Negative 1: one row dropped from the manifest.
    const dropped = { ...manifest, tracked: manifest.tracked.slice(1) };
    expect(
      verifyLegacyArchiveSets({
        baseTrackedPaths: sources,
        manifest: dropped,
        archiveFiles: archive,
      }).map((f) => f.kind),
    ).toEqual(["source-missing-from-manifest", "archive-file-not-in-manifest"]);
    // Negative 2: one row added that no source has.
    const extra = {
      ...manifest,
      tracked: [
        ...manifest.tracked,
        {
          source_path: `${LEGACY_MEMORY_SOURCE_ROOT}/feedback-not-a-real-source.md`,
          archive_path: `${LEGACY_MEMORY_ARCHIVE_ROOT}/feedback-not-a-real-source.md`,
          sha256: "0".repeat(64),
          bytes: 1,
        },
      ],
    };
    expect(
      verifyLegacyArchiveSets({
        baseTrackedPaths: sources,
        manifest: extra,
        archiveFiles: archive,
      }).map((f) => f.kind),
    ).toEqual(["manifest-row-not-in-source", "archive-file-missing"]);
  });

  it("U-MEMCUT-018: every row's base blob equals the archive blob, sha256 and size match, and git sees a 100% rename; a 1-byte mutation is Red", () => {
    const manifest = manifestOf();
    const renames = new Map<string, string>();
    for (const line of git(
      [
        "diff",
        "--name-status",
        "-M100%",
        "--diff-filter=R",
        manifest.base_commit,
        "HEAD",
        "--",
        LEGACY_MEMORY_SOURCE_ROOT,
        LEGACY_MEMORY_ARCHIVE_ROOT,
      ],
      "utf8",
    ).split(/\r?\n/)) {
      const [status, from, to] = line.split("\t");
      if (status?.startsWith("R") && from && to) renames.set(from, to);
    }
    const baseOids = blobOids(manifest.base_commit, LEGACY_MEMORY_SOURCE_ROOT);
    const headOids = blobOids("HEAD", LEGACY_MEMORY_ARCHIVE_ROOT);
    let mutated = false;
    for (const row of manifest.tracked) {
      const baseOid = baseOids.get(row.source_path);
      const headOid = headOids.get(row.archive_path);
      // 旧 `git rev-parse` は path 不在で throw した。Map では undefined 同士が一致しうるため明示的に落とす。
      expect(baseOid, `${row.source_path} (base blob)`).toBeDefined();
      expect(headOid, `${row.archive_path} (HEAD blob)`).toBeDefined();
      expect(headOid, row.source_path).toBe(baseOid);
      expect(renames.get(row.source_path), row.source_path).toBe(row.archive_path);
      const bytes = readFileSync(join(root, row.archive_path));
      expect(verifyLegacyArchiveRow(row, bytes)).toEqual([]);
      if (!mutated) {
        const flipped = Buffer.from(bytes);
        flipped[0] = flipped[0] ^ 0x01;
        expect(verifyLegacyArchiveRow(row, flipped).map((f) => f.kind)).toEqual([
          "digest-mismatch",
        ]);
        mutated = true;
      }
    }
    expect(mutated).toBe(true);
  });

  it("U-MEMCUT-019: the local archive is ignored and untracked, and no local untracked corpus digest appears in the PR range blobs", () => {
    expect(git(["ls-files", "--", ".ut-tdd/archive"], "utf8")).toBe("");
    const probe = `${LEGACY_MEMORY_LOCAL_ARCHIVE_ROOT}/probe.md`;
    const ignored = execFileSync("git", ["-C", root, "check-ignore", "-q", probe], {
      stdio: "ignore",
      encoding: "utf8",
    });
    expect(ignored).toBeDefined();
    // Untracked corpus present in this execution root (none in CI): its content digests must not
    // be any blob committed in the PR range. Judged by content, not by path.
    const manifest = manifestOf();
    const untracked = git(
      ["ls-files", "--others", "--exclude-standard", "--", LEGACY_MEMORY_SOURCE_ROOT],
      "utf8",
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const untrackedDigests = new Set(untracked.map((p) => sha256Hex(readFileSync(join(root, p)))));
    const rangeBlobs = git(["rev-list", "--objects", `${manifest.base_commit}..HEAD`], "utf8")
      .split(/\r?\n/)
      .map((line) => line.split(" ")[0])
      .filter(Boolean);
    let leaked = 0;
    for (const { type, content } of catFileBatch(rangeBlobs)) {
      if (type !== "blob") continue;
      if (untrackedDigests.has(sha256Hex(content))) leaked += 1;
    }
    expect(leaked).toBe(0);
  });

  it("U-MEMCUT-020: manifest and summary expose no untracked path, title or body; a leaked name, an extra top-level manifest field or an extra tracked-row key is each Red", () => {
    const manifest = manifestOf();
    const summary = readFileSync(join(root, LEGACY_MEMORY_SUMMARY_PATH), "utf8");
    expect(verifyLegacyArchiveUntrackedOpacity({ manifest, summary })).toEqual([]);
    // Extra key inside manifest.untracked, carrying an untracked-looking name: caught both by the
    // untracked-section key allowlist and by the manifest-wide string scan (Sol r2 FLAG 3).
    const leaked = {
      ...manifest,
      untracked: {
        ...manifest.untracked,
        paths: ["secret-note.md"],
      } as LegacyArchiveManifest["untracked"],
    };
    const leakedFindings = verifyLegacyArchiveUntrackedOpacity({
      manifest: leaked,
      summary,
    }).map((f) => f.kind);
    expect(leakedFindings).toContain("untracked-leak");
    expect(leakedFindings.length).toBeGreaterThanOrEqual(1);
    expect(
      verifyLegacyArchiveUntrackedOpacity({
        manifest,
        summary: `${summary}\n- feedback-some-untracked-lesson.md\n`,
      }).map((f) => f.kind),
    ).toEqual(["untracked-leak"]);
    // Extra top-level manifest field carrying an untracked path (Sol r2 FLAG 3 negative a).
    const extraTopLevel = {
      ...manifest,
      leaked_untracked_paths: ["feedback-some-untracked-lesson.md"],
    } as unknown as LegacyArchiveManifest;
    expect(
      verifyLegacyArchiveUntrackedOpacity({ manifest: extraTopLevel, summary }).map((f) => f.kind),
    ).toContain("untracked-leak");
    // Extra key on a tracked row carrying an untracked body/title (Sol r2 FLAG 3 negative b).
    const firstRow = manifest.tracked[0];
    expect(firstRow, "manifest has at least one tracked row").toBeDefined();
    const extraTrackedRowKey = {
      ...manifest,
      tracked: [
        {
          ...firstRow,
          leaked_body: "untracked body text",
        } as unknown as LegacyArchiveManifest["tracked"][number],
        ...manifest.tracked.slice(1),
      ],
    };
    expect(
      verifyLegacyArchiveUntrackedOpacity({ manifest: extraTrackedRowKey, summary }).map(
        (f) => f.kind,
      ),
    ).toContain("untracked-leak");
  });

  it("U-MEMCUT-021: the committed summary is byte-identical to the summary regenerated from the manifest", () => {
    const manifest = manifestOf();
    const committed = readFileSync(join(root, LEGACY_MEMORY_SUMMARY_PATH), "utf8");
    expect(committed).toBe(renderLegacyArchiveSummary(manifest));
    expect(committed).toContain(`- files: ${manifest.tracked.length}`);
    expect(committed).toContain(`- files: ${manifest.untracked.count}`);
    expect(
      renderLegacyArchiveSummary({ ...manifest, tracked: manifest.tracked.slice(1) }),
    ).not.toBe(committed);
    expect(existsSync(join(root, LEGACY_MEMORY_MANIFEST_PATH))).toBe(true);
  });

  it("P-MEMCUT-023: the clean Pack plan excludes the archive and the local archive; a non-denied prefix would leak", () => {
    const paths = git(["ls-tree", "-r", "--name-only", "HEAD"], "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const plan = buildCleanDistributionPlan({ paths });
    const leak = (prefix: string) => plan.artifactPaths.filter((p) => p.startsWith(prefix));
    expect(leak(`${LEGACY_MEMORY_ARCHIVE_ROOT}/`)).toEqual([]);
    expect(leak(`${LEGACY_MEMORY_LOCAL_ARCHIVE_ROOT}/`)).toEqual([]);
    expect(
      plan.excludedPaths.filter((p) => p.startsWith(`${LEGACY_MEMORY_ARCHIVE_ROOT}/`)).length,
    ).toBe(archiveFiles().length + LEGACY_MEMORY_ARCHIVE_META_FILES.length);
    // Falsification: the same predicate on an undenied prefix is not vacuous.
    const undenied = buildCleanDistributionPlan({
      paths: [...paths, "docs/process/memory-legacy-2026-09/feedback-probe.md"],
    });
    expect(
      undenied.artifactPaths.filter((p) => p.startsWith("docs/process/memory-legacy-2026-09/")),
    ).toEqual(["docs/process/memory-legacy-2026-09/feedback-probe.md"]);
  });

  it("P-MEMCUT-030: the archive corpus passes readability and secret-scan without changing scanner scope; a mojibake fixture is Red", () => {
    const artifacts = archiveFiles().map((name) => {
      const path = `${LEGACY_MEMORY_ARCHIVE_ROOT}/${name}`;
      const bytes = readFileSync(join(root, path));
      return { path, text: bytes.toString("utf8"), bytes };
    });
    expect(artifacts.length).toBeGreaterThan(0);
    const readability = analyzeArtifacts(artifacts);
    expect(readability.violations).toEqual([]);
    const secrets = analyzeSecretScan(artifacts);
    expect(secrets.violations).toEqual([]);
    const mojibake = Buffer.from("---\ntitle: 縺ｯ縺ｾ\n---\n", "utf8");
    expect(
      analyzeArtifacts([
        {
          path: `${LEGACY_MEMORY_ARCHIVE_ROOT}/mojibake.md`,
          text: mojibake.toString("utf8"),
          bytes: mojibake,
        },
      ]).violations.length,
    ).toBeGreaterThan(0);
  });
});
