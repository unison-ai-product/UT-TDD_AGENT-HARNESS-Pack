import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  AUTHORING_TEMPLATE_INVENTORY,
  authoringArtifactPath,
  authoringSourcePath,
  buildCleanDistributionPlan,
  inspectPackAuthoringEntries,
  materializeReleaseArtifacts,
  projectTrackedTeamBlob,
  type ReleaseSourceEntry,
  type TrackedGitBlob,
  validateAuthoringArtifactSet,
  validateAuthoringTemplateInventory,
} from "../src/setup/index.ts";

const teamSource = ".ut-tdd/teams/example-review-team.yaml";
const teamArtifact = "docs/templates/team/example-review-team.yaml";
const teamBytes = execFileSync("git", [
  "cat-file",
  "blob",
  "0c5e267a46b97699bd5ce7956eba41b3b6138fbf",
]);
const teamBlob: TrackedGitBlob = {
  path: teamSource,
  mode: "100644",
  objectId: "0c5e267a46b97699bd5ce7956eba41b3b6138fbf",
  bytes: teamBytes,
};

const authoringEntries = AUTHORING_TEMPLATE_ARTIFACT_PATHS.map((path) => ({
  path,
  mode: "100644" as const,
  content:
    path === teamArtifact ? teamBytes : readFileSync(join(process.cwd(), ...path.split("/"))),
}));

function trackedSourcePaths(): string[] {
  return execFileSync("git", ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
}

describe("Issue #482 canonical Pack authoring inventory", () => {
  it("U-PACKTPL-001: has six required artifacts and one canonical family inventory", () => {
    expect(AUTHORING_TEMPLATE_ARTIFACT_PATHS).toHaveLength(6);
    expect(validateAuthoringTemplateInventory()).toMatchObject({
      ok: true,
      missingFamilies: [],
      duplicateFamilies: [],
      unknownFamilies: [],
    });
    expect(authoringArtifactPath(teamSource)).toBe(teamArtifact);
    expect(authoringSourcePath(teamArtifact)).toBe(teamSource);
  });

  it.each([
    ["missing family", AUTHORING_TEMPLATE_INVENTORY.slice(0, -1), "missingFamilies"],
    [
      "duplicate family",
      [...AUTHORING_TEMPLATE_INVENTORY, AUTHORING_TEMPLATE_INVENTORY[0]],
      "duplicateFamilies",
    ],
    [
      "unknown family",
      [...AUTHORING_TEMPLATE_INVENTORY, { ...AUTHORING_TEMPLATE_INVENTORY[0], family: "unknown" }],
      "unknownFamilies",
    ],
  ])("U-PACKTPL-005 %s: inventory mutation is Red", (_name, inventory, field) => {
    const result = validateAuthoringTemplateInventory(inventory as never);
    expect(result.ok).toBe(false);
    expect(result[field as keyof typeof result]).not.toEqual([]);
  });

  it("U-PACKTPL-002: resolves the tracked blob before the output deny fence", () => {
    const sourcePaths = [...trackedSourcePaths(), teamSource, ".ut-tdd/harness.db"];
    const plan = buildCleanDistributionPlan({ paths: sourcePaths });
    expect(plan.ok).toBe(true);
    expect(plan.artifactPaths).toEqual(
      expect.arrayContaining([...AUTHORING_TEMPLATE_ARTIFACT_PATHS]),
    );
    expect(plan.artifactPaths).not.toContain(teamSource);
    expect(plan.artifactPaths).not.toContain(".ut-tdd/harness.db");
    expect(plan.authoringInventory.ok).toBe(true);
    expect(plan.excludedPaths).toContain(".ut-tdd/harness.db");
  });

  it.each([
    ["missing", [], "source-missing"],
    ["duplicate", [teamBlob, teamBlob], "source-duplicate"],
    ["escape", [{ ...teamBlob, path: "../escape.yaml" }], "source-path-escape"],
    ["symlink", [{ ...teamBlob, mode: "120000" }], "source-symlink"],
    ["mode drift", [{ ...teamBlob, mode: "100755" }], "source-mode-drift"],
    ["bytes drift", [{ ...teamBlob, bytes: Buffer.from("changed\n") }], "source-bytes-drift"],
  ])("U-PACKTPL-002 %s: projection mutation is typed deny", (_name, blobs, error) => {
    expect(projectTrackedTeamBlob({ blobs: blobs as TrackedGitBlob[] })).toEqual({
      ok: false,
      error,
    });
  });

  it("U-PACKTPL-002: the selected blob has pinned bytes and mode", () => {
    const digest = createHash("sha256").update(teamBytes).digest("hex");
    expect(teamBytes.length).toBe(977);
    expect(digest).toBe("16928b0fbcfa19a3cdcf5eede8f9e4af68ae47088be69b7d6ef0f9b17028a1f2");
    expect(projectTrackedTeamBlob({ blobs: [teamBlob] })).toMatchObject({
      ok: true,
      artifactPath: teamArtifact,
      mode: "100644",
      objectId: teamBlob.objectId,
    });
  });

  it("U-PACKTPL-003: materializer preserves explicit projection bytes and rejects drift", () => {
    const materializerPlan = {
      ok: true,
      channel: "clean-repo-plus-tarball" as const,
      sourceTag: "test",
      cleanRepo: "test",
      artifactPaths: [...AUTHORING_TEMPLATE_ARTIFACT_PATHS],
      excludedPaths: [],
      missingRequired: [],
      denylistViolations: [],
      authoringInventory: {
        ok: true,
        missingFamilies: [],
        duplicateFamilies: [],
        unknownFamilies: [],
        duplicateArtifactPaths: [],
        missingArtifactPaths: [],
      },
      releaseIntegrity: { required: true, artifacts: [] },
    };
    const sourceEntries: ReleaseSourceEntry[] = AUTHORING_TEMPLATE_ARTIFACT_PATHS.map((path) => ({
      path: path === teamArtifact ? teamSource : path,
      mode: "100644",
      content:
        path === teamArtifact ? teamBytes : readFileSync(join(process.cwd(), ...path.split("/"))),
    }));
    const result = materializeReleaseArtifacts(
      { materializerVersion: "1", entries: sourceEntries },
      {
        buildPlan: () => materializerPlan,
        sourcePath: (artifactPath) => (artifactPath === teamArtifact ? teamSource : artifactPath),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projected = result.entries.find((entry) => entry.path === teamArtifact);
    expect(projected?.content).toEqual(new Uint8Array(teamBytes));
    expect(result.entries.map((entry) => entry.path)).not.toContain(teamSource);

    const drifted = sourceEntries.map((entry) =>
      entry.path === teamSource ? { ...entry, content: Buffer.from("drift\n") } : entry,
    );
    expect(
      materializeReleaseArtifacts(
        { materializerVersion: "1", entries: drifted },
        {
          buildPlan: () => materializerPlan,
          sourcePath: (artifactPath) => (artifactPath === teamArtifact ? teamSource : artifactPath),
        },
      ),
    ).toEqual({
      ok: false,
      error: "invalid_artifact",
    });
  });

  it("U-PACKTPL-004: Pack-only smoke parses all authoring files and team schema", () => {
    const entries = authoringEntries;
    expect(inspectPackAuthoringEntries(entries)).toEqual({
      ok: true,
      checked: AUTHORING_TEMPLATE_ARTIFACT_PATHS,
      errors: [],
    });
    expect(inspectPackAuthoringEntries(entries.slice(1)).ok).toBe(false);
    expect(
      inspectPackAuthoringEntries([
        ...entries,
        { ...entries[0], path: "docs/templates/team/unknown.yaml" },
      ]).ok,
    ).toBe(false);
    expect(validateAuthoringArtifactSet([teamSource])).toMatchObject({
      ok: false,
      sourcePaths: [teamSource],
    });
  });

  it("U-PACKTPL-006: broad docs/templates and .ut-tdd wildcard mutations are denied", () => {
    const broadDocs = AUTHORING_TEMPLATE_INVENTORY.map((entry, index) =>
      index === 0 && "sourcePrefix" in entry && "artifactPrefix" in entry
        ? { ...entry, sourcePrefix: "docs/templates/", artifactPrefix: "docs/templates/" }
        : entry,
    );
    const broadRuntime = AUTHORING_TEMPLATE_INVENTORY.map((entry) =>
      "sourcePath" in entry
        ? { ...entry, sourcePath: ".ut-tdd/", artifactPath: "docs/templates/" }
        : entry,
    );
    expect(validateAuthoringTemplateInventory(broadDocs as never).ok).toBe(false);
    expect(validateAuthoringTemplateInventory(broadRuntime as never).ok).toBe(false);
  });

  it("U-PACKTPL-007: personal, Bun, and legacy artifact injections are denied", () => {
    const entries = authoringEntries;
    const legacyTemplateName = "he" + "lix";
    for (const path of [
      "docs/templates/plan/personal.md",
      "docs/templates/plan/run-bun.md",
      `docs/templates/design/${legacyTemplateName}.md`,
    ]) {
      expect(inspectPackAuthoringEntries([...entries, { ...entries[0], path }]).ok).toBe(false);
    }
  });
});
