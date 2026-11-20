/**
 * Pre-distribution scans for `distribution sync-pack` / `package`: the existing secret scan and the
 * Pack privacy scan (issue #1391, docs/design/harness/L6-function-design/privacy-scan.md §5 / §11).
 * The denylist is mandatory here; its contents never reach the output, which carries only the §8
 * finding values. `distribution.ts` only calls into this module; the wiring and the masking live
 * here (the secret scan and the team blob reader were moved here unchanged, PO exception on #1454).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type PrivacyScanResult, privacyScanMessages } from "../lint/privacy-scan.ts";
import { PRIVACY_DENYLIST_RELATIVE_PATH, scanPackPrivacy } from "../lint/privacy-scan-inputs.ts";
import {
  analyzeSecretScan,
  loadSecretScanArtifactsForPaths,
  secretScanMessages,
} from "../lint/secret-scan.ts";
import {
  buildPackSyncPlan,
  type CleanDistributionPlan,
  cleanDistributionSourcePath,
  type PackSyncPlan,
  projectTrackedTeamBlob,
  type TrackedGitBlob,
} from "../setup/index.ts";

const TEAM_SOURCE = ".ut-tdd/teams/example-review-team.yaml";
const DENYLIST_HINT = `~/${PRIVACY_DENYLIST_RELATIVE_PATH.join("/")}`;
const decoder = new TextDecoder("utf-8");

export function readTrackedTeamBlob(repoRoot: string) {
  const tree = spawnSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", ".ut-tdd/teams/example-review-team.yaml"],
    { cwd: repoRoot, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
  );
  const records = Buffer.from(tree.stdout ?? new Uint8Array())
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const blobs: TrackedGitBlob[] = [];
  for (const record of records) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) continue;
    const blob = spawnSync("git", ["cat-file", "blob", match[2]], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (blob.status !== 0) continue;
    blobs.push({
      path: match[3],
      mode: match[1] === "100644" ? "100644" : match[1],
      objectId: match[2],
      bytes: new Uint8Array(blob.stdout ?? new Uint8Array()),
    });
  }
  return projectTrackedTeamBlob({ blobs });
}

export function runDistributionSecretScan(input: {
  repoRoot: string;
  sourcePaths: readonly string[];
  artifactPaths: readonly string[];
}): ReturnType<typeof analyzeSecretScan> {
  const sourceArtifactPaths = input.artifactPaths.map((rel) =>
    cleanDistributionSourcePath(rel, input.sourcePaths),
  );
  const artifacts = loadSecretScanArtifactsForPaths(input.repoRoot, sourceArtifactPaths).filter(
    (artifact) => artifact.path !== ".ut-tdd/teams/example-review-team.yaml",
  );
  if (sourceArtifactPaths.includes(".ut-tdd/teams/example-review-team.yaml")) {
    const projection = readTrackedTeamBlob(input.repoRoot);
    if (!projection.ok)
      return {
        checked: artifacts.length,
        violations: [
          {
            path: ".ut-tdd/teams/example-review-team.yaml",
            line: 1,
            marker: `authoring-projection-${projection.error}`,
          },
        ],
        ok: false,
      };
    try {
      artifacts.push({
        path: ".ut-tdd/teams/example-review-team.yaml",
        text: new TextDecoder("utf-8", { fatal: true }).decode(projection.bytes),
      });
    } catch {
      return {
        checked: artifacts.length,
        violations: [
          {
            path: ".ut-tdd/teams/example-review-team.yaml",
            line: 1,
            marker: "authoring-projection-invalid-utf8",
          },
        ],
        ok: false,
      };
    }
  }
  return analyzeSecretScan(artifacts);
}

type SecretScanResult = ReturnType<typeof analyzeSecretScan>;

export class DistributionPrivacyScanError extends Error {
  readonly privacyScan: PrivacyScanResult;

  constructor(privacyScan: PrivacyScanResult, leading: readonly string[] = []) {
    const lines = [...leading, ...privacyScanTextLines(privacyScan)];
    super(`distribution package source preflight failed: ${lines.join("; ")}`);
    this.privacyScan = privacyScan;
  }
}

/** The Pack artifacts of `exportPlan`, read like the secret scan (the team yaml from its blob). */
export interface PackPrivacySource {
  repoRoot: string;
  sourceRoot: string;
  sourcePaths: readonly string[];
  exportPlan: CleanDistributionPlan;
  homeDirectory: string;
}

export function scanPack(source: PackPrivacySource): PrivacyScanResult {
  const artifacts: { path: string; text: string }[] = [];
  try {
    for (const path of source.exportPlan.artifactPaths) {
      const sourcePath = cleanDistributionSourcePath(path, source.sourcePaths);
      const team = sourcePath === TEAM_SOURCE ? readTrackedTeamBlob(source.sourceRoot) : null;
      if (team !== null && !team.ok) throw new Error("team projection unavailable");
      const bytes =
        team?.ok === true
          ? team.bytes
          : readFileSync(join(source.sourceRoot, ...sourcePath.split("/")));
      artifacts.push({ path, text: decoder.decode(bytes) });
    }
  } catch {
    artifacts.length = 0; // an unreadable artifact must not pass as "no hits"
  }
  return scanPackPrivacy({
    artifacts,
    repoRoot: source.repoRoot,
    homeDirectory: source.homeDirectory,
  });
}

/** One entry point of the pre-distribution scans; `sourceRoot` defaults to `repoRoot`. */
export interface PreDistributionSource
  extends Omit<PackPrivacySource, "sourceRoot" | "homeDirectory"> {
  sourceRoot?: string;
  homeDirectory?: string;
}

function secretScanOf(source: PreDistributionSource, sourceRoot: string): SecretScanResult {
  return runDistributionSecretScan({
    repoRoot: sourceRoot,
    sourcePaths: source.sourcePaths,
    artifactPaths: source.exportPlan.artifactPaths,
  });
}

/** `sync-pack` / `package`: the secret scan, then the privacy scan, both always run. */
export function runPreDistributionScans(source: PreDistributionSource) {
  const sourceRoot = source.sourceRoot ?? source.repoRoot;
  const secretScan = secretScanOf(source, sourceRoot);
  const homeDirectory = source.homeDirectory ?? homedir();
  const privacyScan = scanPack({ ...source, sourceRoot, homeDirectory });
  return { secretScan, privacyScan, ok: secretScan.ok && privacyScan.ok };
}

/** `distribution package`: stops before anything is written, judging both scans together. */
export function assertPreDistributionScans(source: PreDistributionSource): void {
  const { secretScan, privacyScan } = runPreDistributionScans(source);
  const blocked = !source.exportPlan.ok || !secretScan.ok;
  const shown = reportedSecretScan(secretScan, privacyScan);
  const leading = blocked ? [secretScanMessages(shown)[0] ?? "plan"] : [];
  if (!privacyScan.ok) throw new DistributionPrivacyScanError(privacyScan, leading);
  if (blocked) throw new Error(`distribution package source preflight failed: ${leading[0]}`);
}

/** L6 §8 / §12: once the privacy scan rejects, the secret scan reports no path either. */
function reportedSecretScan(leakScan: SecretScanResult, privacy: PrivacyScanResult) {
  if (privacy.ok) return leakScan;
  const violations = leakScan.violations.map((item) => ({
    ...item,
    path: maskedPath(item.path),
  }));
  return { ...leakScan, violations };
}

export function secretScanJson(leakScan: SecretScanResult, privacy: PrivacyScanResult) {
  const result = reportedSecretScan(leakScan, privacy);
  return { ok: result.ok, checked: result.checked, violations: result.violations };
}

export function privacyScanJson(result: PrivacyScanResult) {
  return { ok: result.ok, checked: result.summary.checked, findings: result.findings };
}

/** The `privacyScan` field of a failed `package` JSON output (empty for any other error). */
export function privacyScanErrorJson(error: unknown) {
  return error instanceof DistributionPrivacyScanError
    ? { privacyScan: privacyScanJson(error.privacyScan) }
    : {};
}

export function privacyScanTextLines(result: PrivacyScanResult): string[] {
  const lines = privacyScanMessages(result);
  const denylistBlocked = result.findings.some(
    (finding) =>
      finding.kind === "privacy-denylist-unavailable" ||
      finding.kind === "privacy-denylist-invalid",
  );
  if (denylistBlocked)
    lines.push(`denylist: ${DENYLIST_HINT} に 1 行 1 個の正規表現を置く (# で始まる行は無視)`);
  return lines;
}

/** The sync-pack text-mode lines of the rejected scans (none when both passed). */
export function scanFailureLines(leakScan: SecretScanResult, privacy: PrivacyScanResult): string[] {
  return [
    ...(leakScan.ok ? [] : secretScanMessages(reportedSecretScan(leakScan, privacy))),
    ...(privacy.ok ? [] : privacyScanTextLines(privacy)),
  ];
}

const maskedPath = (path: string) =>
  `path-sha256:${createHash("sha256").update(path, "utf8").digest("hex")}`;

/**
 * L6 §8 / §12: when the scan rejects (a hit, an unreadable artifact, or a missing one), no artifact
 * path is reported: every one is masked. An unreadable artifact drops the findings, so the hit
 * paths cannot be derived and all paths are treated alike. The reported plan and sync plan are
 * rebuilt from the masked list before any command string is made, so no escaped form can leak.
 */
export function reportedPack(input: {
  privacyScan: PrivacyScanResult;
  exportPlan: CleanDistributionPlan;
  sourcePaths: readonly string[];
  sync: PackSyncPlan;
}): { plan: CleanDistributionPlan; sync: PackSyncPlan } {
  const { privacyScan, exportPlan, sourcePaths, sync } = input;
  if (privacyScan.ok) return { plan: exportPlan, sync };
  const plan = { ...exportPlan, artifactPaths: exportPlan.artifactPaths.map(maskedPath) };
  return {
    plan,
    sync: buildPackSyncPlan({
      exportPlan: plan,
      sourcePaths: [...sourcePaths],
      stagingDir: sync.stagingDir,
      branch: sync.branch,
    }),
  };
}

/**
 * Defense in depth for values built from raw paths: on rejection, replaces every raw artifact path
 * wherever it occurs in `value`. It cannot see escaped forms, so reported path lists and commands
 * must come from `reportedPack`.
 */
function redactRejectedArtifactPaths<T>(
  value: T,
  result: PrivacyScanResult,
  artifactPaths: readonly string[],
): T {
  if (result.ok) return value;
  const paths = [...artifactPaths].sort((a, b) => b.length - a.length);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string")
      return paths.reduce(
        (text, raw) => (text.includes(raw) ? text.replaceAll(raw, maskedPath(raw)) : text),
        item,
      );
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}

/**
 * The sync-pack output and evidence: `raw` redacted on rejection, plus the scanner's findings
 * (which already follow L6 §8, a hit path being masked by the scanner itself).
 */
export function reportSyncPack<T extends object>(
  raw: T,
  result: PrivacyScanResult,
  artifactPaths: readonly string[],
): T & { privacyScan: ReturnType<typeof privacyScanJson> } {
  return {
    ...redactRejectedArtifactPaths(raw, result, artifactPaths),
    privacyScan: privacyScanJson(result),
  };
}
