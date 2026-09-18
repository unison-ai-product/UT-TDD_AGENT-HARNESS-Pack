import { createHash } from "node:crypto";

/**
 * Clean Pack で authoring に必要なテンプレート集合の唯一の正本。
 *
 * sourcePrefix の family は配下の tracked file を同じ相対名で出力する。
 * sourcePath の family は、選択 revision の Git blob 一件だけを固定 destination
 * へ read-only projection する。.ut-tdd 全体を配布 allowlist にしてはいけない。
 */
export const AUTHORING_TEMPLATE_INVENTORY = Object.freeze([
  Object.freeze({
    family: "PLAN",
    sourcePrefix: "docs/templates/plan/",
    artifactPrefix: "docs/templates/plan/",
    requiredArtifactPaths: Object.freeze([
      "docs/templates/plan/design/template.md",
      "docs/templates/plan/impl/template.md",
    ]),
  }),
  Object.freeze({
    family: "design",
    sourcePrefix: "docs/templates/design/",
    artifactPrefix: "docs/templates/design/",
    requiredArtifactPaths: Object.freeze(["docs/templates/design/L6-function-spec-template.md"]),
  }),
  Object.freeze({
    family: "state",
    sourcePrefix: "docs/templates/state/",
    artifactPrefix: "docs/templates/state/",
    requiredArtifactPaths: Object.freeze(["docs/templates/state/vmodel.json"]),
  }),
  Object.freeze({
    family: "prompt",
    sourcePrefix: "docs/templates/prompts/",
    artifactPrefix: "docs/templates/prompts/",
    requiredArtifactPaths: Object.freeze(["docs/templates/prompts/effort-classify.md"]),
  }),
  Object.freeze({
    family: "team projection (explicit)",
    sourcePath: ".ut-tdd/teams/example-review-team.yaml",
    artifactPath: "docs/templates/team/example-review-team.yaml",
    requiredArtifactPaths: Object.freeze(["docs/templates/team/example-review-team.yaml"]),
    projection: "tracked-git-blob",
  }),
] as const);

export type AuthoringTemplateInventoryEntry = (typeof AUTHORING_TEMPLATE_INVENTORY)[number];
export type AuthoringTemplateFamily = AuthoringTemplateInventoryEntry["family"];

export const AUTHORING_TEMPLATE_ARTIFACT_PATHS = Object.freeze(
  AUTHORING_TEMPLATE_INVENTORY.flatMap((entry) => entry.requiredArtifactPaths),
);

const EXPECTED_TEAM_BLOB = Object.freeze({
  sourcePath: ".ut-tdd/teams/example-review-team.yaml",
  artifactPath: "docs/templates/team/example-review-team.yaml",
  mode: "100644" as const,
  objectId: "0c5e267a46b97699bd5ce7956eba41b3b6138fbf",
  byteLength: 977,
  sha256: "16928b0fbcfa19a3cdcf5eede8f9e4af68ae47088be69b7d6ef0f9b17028a1f2",
});

export interface AuthoringInventoryValidation {
  readonly ok: boolean;
  readonly missingFamilies: readonly string[];
  readonly duplicateFamilies: readonly string[];
  readonly unknownFamilies: readonly string[];
  readonly duplicateArtifactPaths: readonly string[];
  readonly missingArtifactPaths: readonly string[];
}

const FAMILY_NAMES = new Set<string>(AUTHORING_TEMPLATE_INVENTORY.map((entry) => entry.family));

function normalized(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function validRelativePath(path: string): boolean {
  const value = normalized(path).replace(/\/$/, "");
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function matchesCanonicalInventoryShape(entry: AuthoringTemplateInventoryEntry): boolean {
  const expected = AUTHORING_TEMPLATE_INVENTORY.find(
    (candidate) => candidate.family === entry.family,
  );
  if (!expected) return false;
  if ("sourcePath" in entry) {
    return (
      "sourcePath" in expected &&
      "artifactPath" in expected &&
      entry.sourcePath === expected.sourcePath &&
      entry.artifactPath === expected.artifactPath
    );
  }
  return (
    "sourcePrefix" in expected &&
    "artifactPrefix" in expected &&
    entry.sourcePrefix === expected.sourcePrefix &&
    entry.artifactPrefix === expected.artifactPrefix
  );
}

export function validateAuthoringTemplateInventory(
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): AuthoringInventoryValidation {
  const familyCounts = new Map<string, number>();
  const artifactCounts = new Map<string, number>();
  for (const entry of inventory) {
    familyCounts.set(entry.family, (familyCounts.get(entry.family) ?? 0) + 1);
    for (const path of entry.requiredArtifactPaths) {
      const key = normalized(path);
      artifactCounts.set(key, (artifactCounts.get(key) ?? 0) + 1);
    }
  }
  const expectedFamilies = [...FAMILY_NAMES];
  const presentFamilies = new Set(familyCounts.keys());
  const duplicateFamilies = [...familyCounts]
    .filter(([, count]) => count > 1)
    .map(([family]) => family)
    .sort();
  const unknownFamilies = [...presentFamilies].filter((family) => !FAMILY_NAMES.has(family)).sort();
  const missingFamilies = expectedFamilies.filter((family) => !presentFamilies.has(family)).sort();
  const duplicateArtifactPaths = [...artifactCounts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
  const expectedArtifacts = new Set(AUTHORING_TEMPLATE_ARTIFACT_PATHS);
  const missingArtifactPaths = [...expectedArtifacts]
    .filter((path) => (artifactCounts.get(path) ?? 0) !== 1)
    .sort();
  const malformed = inventory.some((entry) => {
    const paths = [
      ...entry.requiredArtifactPaths,
      "sourcePath" in entry ? entry.sourcePath : entry.sourcePrefix,
      "artifactPath" in entry ? entry.artifactPath : entry.artifactPrefix,
    ];
    if (paths.some((path) => !validRelativePath(path))) return true;
    if (!matchesCanonicalInventoryShape(entry)) return true;
    if ("sourcePath" in entry) {
      return (
        entry.requiredArtifactPaths.length !== 1 ||
        entry.requiredArtifactPaths[0] !== entry.artifactPath
      );
    }
    const artifactPrefix = normalized(entry.artifactPrefix);
    return entry.requiredArtifactPaths.some((path) => !normalized(path).startsWith(artifactPrefix));
  });
  return Object.freeze({
    ok:
      !malformed &&
      missingFamilies.length === 0 &&
      duplicateFamilies.length === 0 &&
      unknownFamilies.length === 0 &&
      duplicateArtifactPaths.length === 0 &&
      missingArtifactPaths.length === 0,
    missingFamilies,
    duplicateFamilies,
    unknownFamilies,
    duplicateArtifactPaths,
    missingArtifactPaths,
  });
}

function entryForSource(path: string, inventory: readonly AuthoringTemplateInventoryEntry[]) {
  const value = normalized(path);
  return inventory.find((entry) =>
    "sourcePath" in entry
      ? value === normalized(entry.sourcePath)
      : value.startsWith(normalized(entry.sourcePrefix)),
  );
}

function entryForArtifact(path: string, inventory: readonly AuthoringTemplateInventoryEntry[]) {
  const value = normalized(path);
  return inventory.find((entry) =>
    "artifactPath" in entry
      ? value === normalized(entry.artifactPath)
      : value.startsWith(normalized(entry.artifactPrefix)),
  );
}

/** Returns the Pack path for a source path, or null when it is not authoring inventory. */
export function authoringArtifactPath(
  sourcePath: string,
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): string | null {
  const value = normalized(sourcePath);
  const entry = entryForSource(value, inventory);
  if (!entry) return null;
  if ("artifactPath" in entry) return entry.artifactPath;
  return `${entry.artifactPrefix}${value.slice(entry.sourcePrefix.length)}`;
}

/** Returns the source path for a Pack path without any implicit fallback. */
export function authoringSourcePath(
  artifactPath: string,
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): string | null {
  const value = normalized(artifactPath);
  const entry = entryForArtifact(value, inventory);
  if (!entry) return null;
  if ("sourcePath" in entry) return entry.sourcePath;
  return `${entry.sourcePrefix}${value.slice(entry.artifactPrefix.length)}`;
}

export function isAuthoringArtifactPath(
  path: string,
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): boolean {
  return entryForArtifact(path, inventory) !== undefined;
}

function isInAuthoringFamilyPath(
  path: string,
  inventory: readonly AuthoringTemplateInventoryEntry[],
): boolean {
  const value = normalized(path);
  return inventory.some((entry) => {
    if ("artifactPath" in entry) {
      const parent = entry.artifactPath.slice(0, entry.artifactPath.lastIndexOf("/") + 1);
      return value === entry.artifactPath || value.startsWith(parent);
    }
    return value.startsWith(entry.artifactPrefix);
  });
}

export interface AuthoringArtifactSetValidation {
  readonly ok: boolean;
  readonly missingArtifactPaths: readonly string[];
  readonly duplicateArtifactPaths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly unknownArtifactPaths: readonly string[];
}

/**
 * Validates only the authoring portion of a larger Pack artifact set. An artifact set with no
 * authoring paths remains valid for backwards-compatible generic publication callers.
 */
export function validateAuthoringArtifactSet(
  paths: readonly string[],
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): AuthoringArtifactSetValidation {
  const normalizedPaths = paths.map(normalized);
  const authoringPaths = normalizedPaths.filter((path) => isInAuthoringFamilyPath(path, inventory));
  const sourcePaths = normalizedPaths.filter((path) =>
    inventory.some((entry) => "sourcePath" in entry && path === normalized(entry.sourcePath)),
  );
  if (authoringPaths.length === 0 && sourcePaths.length === 0)
    return {
      ok: true,
      missingArtifactPaths: [],
      duplicateArtifactPaths: [],
      sourcePaths: [],
      unknownArtifactPaths: [],
    };
  const counts = new Map<string, number>();
  for (const path of authoringPaths) counts.set(path, (counts.get(path) ?? 0) + 1);
  const duplicateArtifactPaths = [...counts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
  const required = AUTHORING_TEMPLATE_ARTIFACT_PATHS.filter((path) =>
    inventory.some((entry) => entry.requiredArtifactPaths.includes(path)),
  );
  const missingArtifactPaths = required.filter((path) => (counts.get(path) ?? 0) !== 1);
  const unknownArtifactPaths = authoringPaths.filter((path) => !required.includes(path));
  return Object.freeze({
    ok:
      sourcePaths.length === 0 &&
      duplicateArtifactPaths.length === 0 &&
      missingArtifactPaths.length === 0 &&
      unknownArtifactPaths.length === 0,
    missingArtifactPaths,
    duplicateArtifactPaths,
    sourcePaths,
    unknownArtifactPaths,
  });
}

export interface TrackedGitBlob {
  readonly path: string;
  readonly mode: string;
  readonly objectId?: string;
  readonly bytes: Uint8Array;
}

export type AuthoringProjectionError =
  | "source-missing"
  | "source-duplicate"
  | "source-path-escape"
  | "source-symlink"
  | "source-mode-drift"
  | "source-bytes-drift";

export type AuthoringProjectionResult =
  | {
      readonly ok: true;
      readonly sourcePath: string;
      readonly artifactPath: string;
      readonly mode: "100644";
      readonly objectId?: string;
      readonly bytes: Uint8Array;
    }
  | { readonly ok: false; readonly error: AuthoringProjectionError };

/** Resolve the explicit team projection from a tracked Git tree, never from a worktree path. */
export function projectTrackedTeamBlob(input: {
  readonly blobs: readonly TrackedGitBlob[];
  readonly expected?: Partial<typeof EXPECTED_TEAM_BLOB>;
}): AuthoringProjectionResult {
  const expected = { ...EXPECTED_TEAM_BLOB, ...(input.expected ?? {}) };
  if (input.blobs.some((blob) => !validRelativePath(blob.path)))
    return { ok: false, error: "source-path-escape" };
  const candidates = input.blobs.filter((blob) => normalized(blob.path) === expected.sourcePath);
  if (candidates.length === 0) return { ok: false, error: "source-missing" };
  if (candidates.length !== 1) return { ok: false, error: "source-duplicate" };
  const source = candidates[0];
  if (!validRelativePath(source.path) || source.path !== expected.sourcePath)
    return { ok: false, error: "source-path-escape" };
  if (source.mode === "120000") return { ok: false, error: "source-symlink" };
  if (source.mode !== expected.mode) return { ok: false, error: "source-mode-drift" };
  const bytes = new Uint8Array(source.bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== expected.byteLength ||
    digest !== expected.sha256 ||
    (source.objectId !== undefined && source.objectId !== expected.objectId)
  )
    return { ok: false, error: "source-bytes-drift" };
  return Object.freeze({
    ok: true,
    sourcePath: expected.sourcePath,
    artifactPath: expected.artifactPath,
    mode: "100644",
    objectId: source.objectId,
    bytes,
  });
}

export function authoringInventoryRequiredPaths(
  inventory: readonly AuthoringTemplateInventoryEntry[] = AUTHORING_TEMPLATE_INVENTORY,
): readonly string[] {
  return Object.freeze(inventory.flatMap((entry) => entry.requiredArtifactPaths));
}
