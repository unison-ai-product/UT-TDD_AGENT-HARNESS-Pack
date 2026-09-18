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
  const out = execFileSync("git", ["-C", root, ...args], { encoding });
  return encoding === "utf8" ? String(out).trim() : (out as Buffer);
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
    let mutated = false;
    for (const row of manifest.tracked) {
      const baseOid = git(["rev-parse", `${manifest.base_commit}:${row.source_path}`], "utf8");
      const headOid = git(["rev-parse", `HEAD:${row.archive_path}`], "utf8");
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
    for (const oid of rangeBlobs) {
      const type = git(["cat-file", "-t", oid], "utf8");
      if (type !== "blob") continue;
      if (untrackedDigests.has(sha256Hex(git(["cat-file", "-p", oid], "buffer")))) leaked += 1;
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
