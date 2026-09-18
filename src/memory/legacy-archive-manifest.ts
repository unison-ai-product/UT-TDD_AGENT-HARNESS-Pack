/**
 * Legacy memory corpus archive manifest (PLAN-L7-566 §3, PLAN-L6-104 §3.1 判断 4 / §5 PR-2).
 *
 * The tracked `.ut-tdd/memory` corpus is renamed into `docs/archive/memory-legacy-2026-09/`
 * with bytes preserved. This module owns the rename digest manifest and the generated
 * summary that bind that rename: every tracked source is listed with its archive path and
 * sha256, while the untracked corpus (moved to a gitignored local archive) contributes only a
 * count and a set digest — never a path, title or body (CANDIDATE-U-MEMCUT-020).
 *
 * The runtime memory readers never consult these paths (memoryStorageRoot is the canonical
 * root only); this module is evidence tooling, not a reader.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_MEMORY_SOURCE_ROOT = ".ut-tdd/memory";
export const LEGACY_MEMORY_ARCHIVE_ROOT = "docs/archive/memory-legacy-2026-09";
export const LEGACY_MEMORY_LOCAL_ARCHIVE_ROOT = ".ut-tdd/archive/memory-legacy-2026-09";
export const LEGACY_MEMORY_MANIFEST_PATH = `${LEGACY_MEMORY_ARCHIVE_ROOT}/MANIFEST.json`;
export const LEGACY_MEMORY_SUMMARY_PATH = `${LEGACY_MEMORY_ARCHIVE_ROOT}/SUMMARY.md`;
export const LEGACY_MEMORY_MANIFEST_SCHEMA = "ut-tdd.memory-legacy-archive-manifest/v1";
/** Files inside the archive root that are not corpus entries. */
export const LEGACY_MEMORY_ARCHIVE_META_FILES: readonly string[] = ["MANIFEST.json", "SUMMARY.md"];

export interface LegacyArchiveTrackedRow {
  /** Source path at the PR-2 base HEAD, always under `.ut-tdd/memory/`. */
  source_path: string;
  /** Archive path at the PR HEAD, always under the archive root, same basename. */
  archive_path: string;
  /** sha256 hex of the file bytes (identical at source and archive). */
  sha256: string;
  bytes: number;
}

export interface LegacyArchiveManifest {
  schema_version: typeof LEGACY_MEMORY_MANIFEST_SCHEMA;
  /** Base HEAD whose `git ls-files .ut-tdd/memory` is the tracked source set. */
  base_commit: string;
  source_root: typeof LEGACY_MEMORY_SOURCE_ROOT;
  archive_root: typeof LEGACY_MEMORY_ARCHIVE_ROOT;
  tracked: LegacyArchiveTrackedRow[];
  untracked: {
    /** Number of untracked corpus files moved to the local archive. */
    count: number;
    /** sha256 hex over the sorted per-file sha256 list joined by "\n" (no paths). */
    set_digest: string;
    local_archive_root: typeof LEGACY_MEMORY_LOCAL_ARCHIVE_ROOT;
  };
}

export interface LegacyArchiveSourceFile {
  /** Path relative to the repository root, under `.ut-tdd/memory/`. */
  sourcePath: string;
  bytes: Buffer;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function legacyArchivePathFor(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  const prefix = `${LEGACY_MEMORY_SOURCE_ROOT}/`;
  if (!normalized.startsWith(prefix) || normalized.slice(prefix.length).includes("/")) {
    throw new Error(`legacy archive source must be a direct child of ${prefix}: ${sourcePath}`);
  }
  return `${LEGACY_MEMORY_ARCHIVE_ROOT}/${normalized.slice(prefix.length)}`;
}

export function untrackedSetDigest(perFileDigests: readonly string[]): string {
  return sha256Hex(`${[...perFileDigests].sort().join("\n")}\n`);
}

export function buildLegacyArchiveManifest(input: {
  baseCommit: string;
  tracked: readonly LegacyArchiveSourceFile[];
  untrackedDigests: readonly string[];
}): LegacyArchiveManifest {
  const seen = new Set<string>();
  const tracked = input.tracked
    .map((file) => {
      const sourcePath = file.sourcePath.replaceAll("\\", "/");
      if (seen.has(sourcePath)) throw new Error(`duplicate legacy archive source: ${sourcePath}`);
      seen.add(sourcePath);
      return {
        source_path: sourcePath,
        archive_path: legacyArchivePathFor(sourcePath),
        sha256: sha256Hex(file.bytes),
        bytes: file.bytes.byteLength,
      };
    })
    .sort((a, b) => (a.source_path < b.source_path ? -1 : a.source_path > b.source_path ? 1 : 0));
  return {
    schema_version: LEGACY_MEMORY_MANIFEST_SCHEMA,
    base_commit: input.baseCommit,
    source_root: LEGACY_MEMORY_SOURCE_ROOT,
    archive_root: LEGACY_MEMORY_ARCHIVE_ROOT,
    tracked,
    untracked: {
      count: input.untrackedDigests.length,
      set_digest: untrackedSetDigest(input.untrackedDigests),
      local_archive_root: LEGACY_MEMORY_LOCAL_ARCHIVE_ROOT,
    },
  };
}

export function serializeLegacyArchiveManifest(manifest: LegacyArchiveManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Digest over the tracked rows' sha256 list, used by the summary so a manifest edit is visible. */
export function trackedSetDigest(manifest: LegacyArchiveManifest): string {
  return sha256Hex(`${manifest.tracked.map((row) => row.sha256).join("\n")}\n`);
}

/**
 * Deterministic summary derived from the manifest alone (CANDIDATE-U-MEMCUT-021). It carries
 * counts and digests only; untracked files never surface a path, title or body here.
 */
export function renderLegacyArchiveSummary(manifest: LegacyArchiveManifest): string {
  const totalBytes = manifest.tracked.reduce((sum, row) => sum + row.bytes, 0);
  const byKind = new Map<string, number>();
  for (const row of manifest.tracked) {
    const kind = row.source_path.slice(`${LEGACY_MEMORY_SOURCE_ROOT}/`.length).split("-", 1)[0];
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const kindRows = [...byKind.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, count]) => `| ${kind} | ${count} |`);
  return [
    "# memory-legacy-2026-09 アーカイブ概要 (generated)",
    "",
    "本ファイルは `MANIFEST.json` から機械生成する (PLAN-L7-566 §3、CANDIDATE-U-MEMCUT-021)。手編集しない。",
    "legacy corpus は runtime の read root (`.ut-tdd/memory`) の外にあり、いずれの reader も読まない。",
    "",
    `- schema: \`${manifest.schema_version}\``,
    `- base commit: \`${manifest.base_commit}\``,
    `- tracked source root: \`${manifest.source_root}\``,
    `- archive root: \`${manifest.archive_root}\``,
    "",
    "## tracked corpus (rename、bytes 保持)",
    "",
    `- files: ${manifest.tracked.length}`,
    `- bytes: ${totalBytes}`,
    `- set digest (sha256 over per-file sha256): \`${trackedSetDigest(manifest)}\``,
    "",
    "| kind prefix | files |",
    "| --- | --- |",
    ...kindRows,
    "",
    "## untracked corpus (local archive、commit しない)",
    "",
    `- files: ${manifest.untracked.count}`,
    `- set digest (sha256 over per-file sha256): \`${manifest.untracked.set_digest}\``,
    `- local archive root (gitignored): \`${manifest.untracked.local_archive_root}\``,
    "",
    "untracked corpus の path・title・本文は secret / PII レビュー前のため記録しない。",
    "linked worktree の legacy corpus は本アーカイブの対象外である (#578)。",
    "",
  ].join("\n");
}

export function readLegacyArchiveManifest(repoRoot: string): LegacyArchiveManifest {
  const raw = JSON.parse(readFileSync(join(repoRoot, LEGACY_MEMORY_MANIFEST_PATH), "utf8"));
  if (raw?.schema_version !== LEGACY_MEMORY_MANIFEST_SCHEMA) {
    throw new Error(`unexpected legacy archive manifest schema: ${String(raw?.schema_version)}`);
  }
  return raw as LegacyArchiveManifest;
}

// ---- pure verifiers (the oracles of CANDIDATE-U-MEMCUT-017 / 018 / 020 run through these) ----

export interface LegacyArchiveFinding {
  kind:
    | "source-missing-from-manifest"
    | "manifest-row-not-in-source"
    | "archive-file-missing"
    | "archive-file-not-in-manifest"
    | "archive-path-mismatch"
    | "digest-mismatch"
    | "bytes-mismatch"
    | "untracked-leak";
  subject: string;
}

const basenameOf = (path: string): string => path.replaceAll("\\", "/").split("/").at(-1) ?? "";

// Exact key allowlists derived from the `LegacyArchiveManifest` type shape (Sol r2 FLAG 3): a key
// outside these sets is itself a finding, independent of whether its value happens to look like a
// leaked filename — an extra top-level field or an extra key on a tracked row must never be
// silently accepted just because `manifest.untracked`'s own keys are still clean.
const MANIFEST_TOP_LEVEL_KEYS = [
  "archive_root",
  "base_commit",
  "schema_version",
  "source_root",
  "tracked",
  "untracked",
].join(",");
const TRACKED_ROW_KEYS = ["archive_path", "bytes", "sha256", "source_path"].join(",");
const UNTRACKED_SECTION_KEYS = ["count", "local_archive_root", "set_digest"].join(",");

const sortedKeys = (value: object): string => Object.keys(value).sort().join(",");

/**
 * CANDIDATE-U-MEMCUT-017: base-HEAD tracked sources, manifest rows and archive files must be a
 * basename bijection. Counts are compared to each other, never to a constant.
 */
export function verifyLegacyArchiveSets(input: {
  baseTrackedPaths: readonly string[];
  manifest: LegacyArchiveManifest;
  archiveFiles: readonly string[];
}): LegacyArchiveFinding[] {
  const findings: LegacyArchiveFinding[] = [];
  const sources = new Set(input.baseTrackedPaths.map(basenameOf));
  const rows = new Map(input.manifest.tracked.map((row) => [basenameOf(row.source_path), row]));
  const archive = new Set(
    input.archiveFiles
      .map(basenameOf)
      .filter((name) => !LEGACY_MEMORY_ARCHIVE_META_FILES.includes(name)),
  );
  for (const name of sources) {
    if (!rows.has(name)) findings.push({ kind: "source-missing-from-manifest", subject: name });
  }
  for (const [name, row] of rows) {
    if (!sources.has(name)) findings.push({ kind: "manifest-row-not-in-source", subject: name });
    if (!archive.has(name)) findings.push({ kind: "archive-file-missing", subject: name });
    if (row.archive_path !== legacyArchivePathFor(row.source_path))
      findings.push({ kind: "archive-path-mismatch", subject: name });
  }
  for (const name of archive) {
    if (!rows.has(name)) findings.push({ kind: "archive-file-not-in-manifest", subject: name });
  }
  return findings;
}

/** CANDIDATE-U-MEMCUT-018: archive bytes must reproduce the manifest row digest and size. */
export function verifyLegacyArchiveRow(
  row: LegacyArchiveTrackedRow,
  archiveBytes: Buffer,
): LegacyArchiveFinding[] {
  const findings: LegacyArchiveFinding[] = [];
  if (sha256Hex(archiveBytes) !== row.sha256)
    findings.push({ kind: "digest-mismatch", subject: row.archive_path });
  if (archiveBytes.byteLength !== row.bytes)
    findings.push({ kind: "bytes-mismatch", subject: row.archive_path });
  return findings;
}

/**
 * CANDIDATE-U-MEMCUT-020: the committed manifest and summary carry no untracked path, title or
 * body. The untracked section is exactly {count, set_digest, local_archive_root}, and no line of
 * the summary names a corpus file outside the tracked archive rows.
 */
export function verifyLegacyArchiveUntrackedOpacity(input: {
  manifest: LegacyArchiveManifest;
  summary: string;
}): LegacyArchiveFinding[] {
  const findings: LegacyArchiveFinding[] = [];
  const topKeys = sortedKeys(input.manifest);
  if (topKeys !== MANIFEST_TOP_LEVEL_KEYS)
    findings.push({ kind: "untracked-leak", subject: `manifest keys: ${topKeys}` });
  input.manifest.tracked.forEach((row, index) => {
    const rowKeys = sortedKeys(row);
    if (rowKeys !== TRACKED_ROW_KEYS)
      findings.push({
        kind: "untracked-leak",
        subject: `manifest.tracked[${index}] keys: ${rowKeys}`,
      });
  });
  const untrackedKeys = sortedKeys(input.manifest.untracked);
  if (untrackedKeys !== UNTRACKED_SECTION_KEYS)
    findings.push({
      kind: "untracked-leak",
      subject: `manifest.untracked keys: ${untrackedKeys}`,
    });
  if (!/^[0-9a-f]{64}$/.test(input.manifest.untracked.set_digest))
    findings.push({ kind: "untracked-leak", subject: "manifest.untracked.set_digest" });
  const tracked = new Set(input.manifest.tracked.map((row) => basenameOf(row.source_path)));
  const scanForLeakedNames = (text: string, where: string): void => {
    for (const match of text.matchAll(/[A-Za-z0-9_.-]+\.md/g)) {
      const name = match[0];
      if (name === "SUMMARY.md" || name === "MANIFEST.json") continue;
      if (!tracked.has(name))
        findings.push({ kind: "untracked-leak", subject: `${where} names ${name}` });
    }
  };
  scanForLeakedNames(input.summary, "summary");
  // Scan every string value the manifest carries (not just its declared shape), so an untracked
  // name smuggled into an unexpected key's value is still caught even where the key-allowlist
  // checks above already flag the key itself — defense in depth for nested structures.
  scanForLeakedNames(JSON.stringify(input.manifest), "manifest");
  if (/^title:/m.test(input.summary) || /^memory_id:/m.test(input.summary))
    findings.push({ kind: "untracked-leak", subject: "summary carries entry frontmatter" });
  return findings;
}
