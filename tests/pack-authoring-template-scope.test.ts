import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

const planRetirementInputs = (() => {
  const root = process.cwd();
  const walkFiles = (directory: string): string[] =>
    readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
    });
  const templatePaths = walkFiles("docs/templates");
  const templateBytes = templatePaths.map((path) => ({
    path,
    bytes: readFileSync(join(root, path), "utf8"),
  }));
  const vmodelIndex =
    templateBytes.find(({ path }) => path === "docs/templates/vmodel/README.md")?.bytes ?? "";
  const slotPaths = [...vmodelIndex.matchAll(/^\|\s*`DOC-[^`]+`\s*\|\s*`([^`]+\.md)`/gm)].map(
    ([, path]) => `docs/templates/vmodel/${path}`,
  );
  const optionalPaths = [
    ...vmodelIndex.matchAll(/^\|\s*\d{3}\s*\|.*`optional\/([^`]+\.md)`\s*\|/gm),
  ].map(([, path]) => `docs/templates/vmodel/optional/${path}`);
  const section6Paths = [
    "docs/templates/design/L6-function-spec-template.md",
    "docs/templates/vmodel/README.md",
    ...slotPaths,
    ...optionalPaths,
  ];
  const frontmatter = new Map<string, string | null>(
    templateBytes
      .filter(({ path }) => path.endsWith(".md"))
      .map(({ path, bytes }): [string, string | null] => [
        path,
        /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes)?.[1] ?? null,
      ]),
  );
  const mirror = readFileSync(join(root, "src", "setup", "templates.ts"), "utf8");
  return {
    frontmatter,
    section6Paths,
    slotPaths,
    optionalPaths,
    templateBytes,
    trackedPaths: trackedSourcePaths(),
    templateAndMirrorBytes: [...templateBytes, { path: "src/setup/templates.ts", bytes: mirror }],
    mirror,
    inventory: readFileSync(join(root, "src", "setup", "authoring-template-inventory.ts"), "utf8"),
    canary: readFileSync(join(root, "scripts", "pack-canary-acceptance.mjs"), "utf8"),
    vmodelState: readFileSync(join(root, "docs", "templates", "state", "vmodel.json"), "utf8"),
  };
})();

const retiredPlanTemplatePaths = [
  "docs/templates/plan/design/template.md",
  "docs/templates/plan/impl/template.md",
];

describe("Issue #482 canonical Pack authoring inventory", () => {
  it("U-PACKTPL-001: has four required artifacts and one canonical family inventory", () => {
    expect([...AUTHORING_TEMPLATE_ARTIFACT_PATHS].sort()).toEqual(
      [
        "docs/templates/design/L6-function-spec-template.md",
        "docs/templates/state/vmodel.json",
        "docs/templates/prompts/effort-classify.md",
        "docs/templates/team/example-review-team.yaml",
      ].sort(),
    );
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
    for (const entry of entries) {
      const missing = inspectPackAuthoringEntries(
        entries.filter((candidate) => candidate.path !== entry.path),
      );
      expect(missing.ok, `missing ${entry.path}`).toBe(false);
      expect(missing.errors).toContain(`missing:${entry.path}`);

      const duplicate = inspectPackAuthoringEntries([...entries, entry]);
      expect(duplicate.ok, `duplicate ${entry.path}`).toBe(false);
      expect(duplicate.errors).toContain(`duplicate:${entry.path}`);
    }
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

  it.each(
    retiredPlanTemplatePaths,
  )("U-PACKTPL-004: retired PLAN template entry is fail-close (%s)", (path) => {
    expect(
      inspectPackAuthoringEntries([...authoringEntries, { ...authoringEntries[0], path }]),
    ).toMatchObject({
      ok: false,
      errors: [`unknown:${path}`],
    });
  });

  it("U-PACKTPL-004: generic artifact sets remain valid but a retired-only set is denied", () => {
    expect(validateAuthoringArtifactSet(["docs/design/consumer-note.md"])).toMatchObject({
      ok: true,
      missingArtifactPaths: [],
      unknownArtifactPaths: [],
    });

    const retiredPath = retiredPlanTemplatePaths[0];
    expect(validateAuthoringArtifactSet([retiredPath])).toMatchObject({
      ok: false,
      unknownArtifactPaths: [retiredPath],
    });
    expect(inspectPackAuthoringEntries([{ ...authoringEntries[0], path: retiredPath }]).ok).toBe(
      false,
    );
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
      "docs/templates/design/personal.md",
      "docs/templates/design/run-bun.md",
      `docs/templates/design/${legacyTemplateName}.md`,
    ]) {
      expect(inspectPackAuthoringEntries([...entries, { ...entries[0], path }]).ok).toBe(false);
    }
  });

  it("U-PLANRET-017 fixture: §6 template set exists after #1512", () => {
    const { section6Paths, slotPaths, optionalPaths, frontmatter, templateBytes } =
      planRetirementInputs;
    expect(slotPaths).toHaveLength(21);
    expect(optionalPaths).toHaveLength(27);
    expect(section6Paths).toHaveLength(50);
    expect(new Set(section6Paths).size).toBe(50);
    expect(section6Paths[0]).toBe("docs/templates/design/L6-function-spec-template.md");
    const availablePaths = new Set(templateBytes.map(({ path }) => path));
    expect(section6Paths.filter((path) => !availablePaths.has(path))).toEqual([]);
    expect(section6Paths.filter((path) => !frontmatter.get(path)?.trim())).toEqual([]);
    expect(retiredPlanTemplatePaths).toHaveLength(2);
    expect(new Set(retiredPlanTemplatePaths).size).toBe(2);
    expect(planRetirementInputs.trackedPaths).toContain("docs/templates/state/vmodel.json");
    expect(planRetirementInputs.vmodelState.trim().length).toBeGreaterThan(0);
    expect(JSON.parse(planRetirementInputs.vmodelState)).toMatchObject({
      schema_version: expect.any(Number),
    });
    expect(planRetirementInputs.inventory.trim().length).toBeGreaterThan(0);
    expect(planRetirementInputs.canary.trim().length).toBeGreaterThan(0);
    expect(planRetirementInputs.mirror.trim().length).toBeGreaterThan(0);
  });

  it("U-PLANRET-017: no Pack template has plan frontmatter", () => {
    const violations = [...planRetirementInputs.frontmatter]
      .filter(([, bytes]) => bytes?.match(/^\s*plan\s*:/m))
      .map(([path]) => path);
    expect(violations).toEqual([]);
  });

  it("U-PLANRET-017: all §6 templates use issue frontmatter", () => {
    const violations = planRetirementInputs.section6Paths.filter(
      (path) => !planRetirementInputs.frontmatter.get(path)?.match(/^\s*issue\s*:\s*\S+/m),
    );
    expect(violations).toEqual([]);
  });

  it("U-PLANRET-017: authoring inventory has no PLAN template family", () => {
    const inventoryPaths = AUTHORING_TEMPLATE_INVENTORY.flatMap((entry) =>
      "sourcePath" in entry
        ? [entry.sourcePath, entry.artifactPath]
        : [entry.sourcePrefix, entry.artifactPrefix],
    );
    expect(
      inventoryPaths.some((path) => path.toLowerCase().startsWith("docs/templates/plan/")),
    ).toBe(false);
  });

  it("U-PLANRET-017: retired PLAN templates are not tracked", () => {
    const stillTracked = retiredPlanTemplatePaths.filter((path) =>
      planRetirementInputs.trackedPaths.includes(path),
    );
    expect(stillTracked).toEqual([]);
  });

  it("U-PLANRET-017: state vmodel template has no plan_id field", () => {
    const state = JSON.parse(planRetirementInputs.vmodelState) as Record<string, unknown>;
    expect(Object.hasOwn(state, "plan_id")).toBe(false);
  });

  it("U-PLANRET-017: canary does not invoke plan draft or plan lint", () => {
    expect(planRetirementInputs.canary).not.toMatch(
      /\[\s*["']plan["']\s*,\s*["'](?:draft|lint)["']/i,
    );
  });

  it("U-PLANRET-017: templates and mirror do not point to docs/plans", () => {
    const violations = planRetirementInputs.templateAndMirrorBytes
      .filter(({ bytes }) => /docs[\\/]plans/i.test(bytes))
      .map(({ path }) => path);
    expect(violations).toEqual([]);
  });

  it("U-PLANRET-017: templates and mirror have no ut-tdd plan command", () => {
    const planCommand =
      /(?:[`"'|]|(?:^|\r?\n)\s*(?:[$>]\s*)?|\b(?:run|use|invoke|execute)\s+)(?:\.\/)?ut-tdd(?:\.cmd)?\s+plan\b/i;
    const violations = planRetirementInputs.templateAndMirrorBytes
      .filter(({ bytes }) => planCommand.test(bytes))
      .map(({ path }) => path);
    expect(violations).toEqual([]);
  });

  it("U-PLANRET-017: templates and mirror have no PLAN-prefixed required values", () => {
    const violations = planRetirementInputs.templateAndMirrorBytes.flatMap(({ path, bytes }) =>
      bytes
        .split(/\r?\n/)
        .flatMap((line, index) =>
          /["'`]?[\w-]+["'`]?:\s*["'`]?\s*PLAN-/i.test(line) ? [`${path}:${index + 1}`] : [],
        ),
    );
    expect(violations).toEqual([]);
  });
});
