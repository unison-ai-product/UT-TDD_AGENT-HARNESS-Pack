import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeGeneration } from "../src/runtime/node-bootstrap.ts";

interface RequiredTemplateExpectation {
  readonly docTypeId: string;
  readonly sourcePath: string;
  readonly consumerPath: string;
}

// Independent frozen oracle transcribed from the confirmed document catalog's
// authoring_source_path column and the PR-T1 port index. Do not derive expected
// paths from the production resolver or expected assets from a runtime index.
const REQUIRED_TEMPLATES: readonly RequiredTemplateExpectation[] = [
  {
    docTypeId: "DOC-L0-CHARTER",
    sourcePath: "docs/templates/vmodel/L0-charter.md",
    consumerPath: "docs/plans/PLAN-L0-01-vmodel-harness-upgrade-charter.md",
  },
  {
    docTypeId: "DOC-L1-REQUIREMENTS",
    sourcePath: "docs/templates/vmodel/L1-requirements.md",
    consumerPath: "docs/design/L1-requirements/functional-requirements.md",
  },
  {
    docTypeId: "DOC-L2-SCREEN",
    sourcePath: "docs/templates/vmodel/L2-screen-list.md",
    consumerPath: "docs/design/L2-screen/screen-list.md",
  },
  {
    docTypeId: "DOC-L3-FUNCTIONAL",
    sourcePath: "docs/templates/vmodel/L3-functional-requirements.md",
    consumerPath: "docs/design/L3-functional/functional-requirements.md",
  },
  {
    docTypeId: "DOC-L4-DATA",
    sourcePath: "docs/templates/vmodel/L4-data.md",
    consumerPath: "docs/design/L4-basic-design/data.md",
  },
  {
    docTypeId: "DOC-L4-ARCHITECTURE",
    sourcePath: "docs/templates/vmodel/L4-architecture.md",
    consumerPath: "docs/design/L4-basic-design/architecture.md",
  },
  {
    docTypeId: "DOC-L4-EXTERNAL-IF",
    sourcePath: "docs/templates/vmodel/L4-external-if.md",
    consumerPath: "docs/design/L4-basic-design/external-if.md",
  },
  {
    docTypeId: "DOC-L4-FUNCTION",
    sourcePath: "docs/templates/vmodel/L4-function.md",
    consumerPath: "docs/design/L4-basic-design/function.md",
  },
  {
    docTypeId: "DOC-L4-UI-STANDARD",
    sourcePath: "docs/templates/vmodel/L4-ui-standard.md",
    consumerPath: "docs/design/L4-basic-design/ui-standard.md",
  },
  {
    docTypeId: "DOC-L4-SECURITY",
    sourcePath: "docs/templates/vmodel/L4-security.md",
    consumerPath: "docs/design/L4-basic-design/security.md",
  },
  {
    docTypeId: "DOC-L5-PHYSICAL-DATA",
    sourcePath: "docs/templates/vmodel/L5-physical-data.md",
    consumerPath: "docs/design/L5-detailed-design/physical-data.md",
  },
  {
    docTypeId: "DOC-L5-MODULE",
    sourcePath: "docs/templates/vmodel/L5-module-decomposition.md",
    consumerPath: "docs/design/L5-detailed-design/module-decomposition.md",
  },
  {
    docTypeId: "DOC-L6-FUNCTION-SPEC",
    sourcePath: "docs/templates/vmodel/L6-function-spec.md",
    consumerPath: "docs/design/L6-function-design/function-spec.md",
  },
  {
    docTypeId: "DOC-L7-UNIT-TEST-DESIGN",
    sourcePath: "docs/templates/vmodel/L7-unit-test-design.md",
    consumerPath: "docs/test-design/L7-unit-test-design.md",
  },
  {
    docTypeId: "DOC-L8-INTEGRATION-TEST-DESIGN",
    sourcePath: "docs/templates/vmodel/L8-integration-test-design.md",
    consumerPath: "docs/test-design/L8-integration-test-design.md",
  },
  {
    docTypeId: "DOC-L9-SYSTEM-TEST-DESIGN",
    sourcePath: "docs/templates/vmodel/L9-system-test-design.md",
    consumerPath: "docs/test-design/L9-system-test-design.md",
  },
  {
    docTypeId: "DOC-L10-UX-VALIDATION",
    sourcePath: "docs/templates/vmodel/L10-ux-validation.md",
    consumerPath: "docs/test-design/L10-ux-validation-test-design.md",
  },
  {
    docTypeId: "DOC-L11-TRACE-UAT",
    sourcePath: "docs/templates/vmodel/L11-trace-uat.md",
    consumerPath: "docs/process/evidence/g11-uat-review-design.md",
  },
  {
    docTypeId: "DOC-L12-ACCEPTANCE",
    sourcePath: "docs/templates/vmodel/L12-acceptance-test-design.md",
    consumerPath: "docs/test-design/L12-acceptance-test-design.md",
  },
  {
    docTypeId: "DOC-L13-PRODUCTION-OBSERVATION",
    sourcePath: "docs/templates/vmodel/L13-production-observation.md",
    consumerPath: "docs/process/evidence/g13-post-deploy-verification-design.md",
  },
  {
    docTypeId: "DOC-L14-OPERATIONAL-TEST",
    sourcePath: "docs/templates/vmodel/L14-operational-test-design.md",
    consumerPath: "docs/test-design/L14-operational-test-design.md",
  },
];

const OPTIONAL_TEMPLATE = {
  id: "ZIP-DOC-016",
  sourcePath: "docs/templates/vmodel/optional/016-batch-design.md",
  consumerPath: "docs/design/optional/016-batch-design.md",
} as const;

type BuiltNodeGeneration = NonNullable<Awaited<ReturnType<typeof buildNodeGeneration>>>;

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-release-consumer-vmodel-template-"));
}

function restoreWritable(path: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) restoreWritable(join(path, entry));
  } else {
    chmodSync(path, 0o644);
  }
}

function removeTestDirectory(path: string): void {
  restoreWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function createFixtureLink(target: string, path: string, kind: "file" | "directory"): void {
  const linkType =
    kind === "directory" ? (process.platform === "win32" ? "junction" : "dir") : "file";
  try {
    symlinkSync(target, path, linkType);
  } catch (error) {
    throw new Error(
      `RCDEV-039 ${kind} link fixture unavailable; provision symlink support instead of skipping: ${String(error)}`,
    );
  }
}

function removeFixtureLink(path: string, kind: "file" | "directory"): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  // Remove only the link itself before recursive cleanup; never chmod or walk
  // its target, which can be outside the consumer fixture.
  if (kind === "directory" && process.platform === "win32") rmdirSync(path);
  else unlinkSync(path);
}

function runBundledCli(
  generation: NonNullable<Awaited<ReturnType<typeof buildNodeGeneration>>>,
  root: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(generation.nodePath, [generation.compiledCliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    input: "{}\n",
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      LOCALAPPDATA: root,
      CODEX_HOME: join(root, ".codex-home"),
      XDG_CONFIG_HOME: join(root, ".config"),
      GH_CONFIG_DIR: join(root, ".gh-config"),
      CLAUDE_PROJECT_DIR: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE: "1",
      UT_TDD_PROJECT_DIR: "",
      UT_TDD_CLAUDE_SESSIONS_DIR: join(root, ".claude", "projects"),
      UT_TDD_CODEX_SESSIONS_DIR: join(root, ".codex", "sessions"),
    },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort();
}

describe("PR-2c release consumer V-model template writer", () => {
  let buildRoot: string | undefined;
  let generation: BuiltNodeGeneration | undefined;
  const repoRoot = process.cwd();

  function bundledGeneration(): BuiltNodeGeneration {
    if (!generation) throw new Error("release-consumer bundle was not built");
    return generation;
  }

  beforeAll(async () => {
    buildRoot = mkdtempSync(join(tmpdir(), "ut-tdd-release-consumer-template-build-"));
    const candidateRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const built = await buildNodeGeneration({ repoRoot, outputRoot: buildRoot, candidateRevision });
    if (!built) throw new Error("release-consumer bundle build returned no generation");
    generation = built;
  });

  afterAll(() => {
    if (buildRoot) removeTestDirectory(buildRoot);
  });

  it("U-RCDEV-014: writes all required slot templates to catalog paths from port-index bytes", () => {
    const root = fixtureRoot();
    try {
      expect(REQUIRED_TEMPLATES).toHaveLength(21);
      const result = runBundledCli(bundledGeneration(), root, ["vmodel", "template", "--required"]);
      expect(result.status).toBe(0);

      const expectedPaths = REQUIRED_TEMPLATES.map((template) => template.consumerPath).sort();
      const writtenLines = result.stdout.trimEnd().split(/\r?\n/).sort();
      expect(writtenLines).toEqual(expectedPaths.map((path) => `+ ${path}`).sort());

      for (const template of REQUIRED_TEMPLATES) {
        const writtenPath = join(root, template.consumerPath);
        const portIndexSource = join(repoRoot, template.sourcePath);
        expect(existsSync(writtenPath), template.docTypeId).toBe(true);
        expect(digest(writtenPath), template.docTypeId).toBe(digest(portIndexSource));
      }
      expect(filesUnder(root)).toEqual(expectedPaths);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-015: preserves existing bytes and reports skip (exists)", () => {
    const root = fixtureRoot();
    const existing = REQUIRED_TEMPLATES.find((template) => template.docTypeId === "DOC-L4-DATA");
    if (!existing) throw new Error("required DOC-L4-DATA oracle is missing");
    const destination = join(root, existing.consumerPath);
    const originalBytes = Buffer.from("consumer-owned template\n", "utf8");
    try {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, originalBytes);
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--slot",
        existing.docTypeId,
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`skip (exists) ${existing.consumerPath}`);
      expect(readFileSync(destination)).toEqual(originalBytes);
      expect(filesUnder(root)).toEqual([existing.consumerPath]);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-015: rejects a mixed known and unknown slot request before writing", () => {
    const root = fixtureRoot();
    const existing = REQUIRED_TEMPLATES.find((template) => template.docTypeId === "DOC-L4-DATA");
    if (!existing) throw new Error("required DOC-L4-DATA oracle is missing");
    const destination = join(root, existing.consumerPath);
    const originalBytes = Buffer.from("pre-existing consumer bytes\n", "utf8");
    try {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, originalBytes);
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--slot",
        "DOC-L4-DATA",
        "DOC-L4-ARCHITECTURE",
        "DOC-UNKNOWN",
      ]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("unknown template DOC-UNKNOWN");
      expect(readFileSync(destination)).toEqual(originalBytes);
      expect(filesUnder(root)).toEqual([existing.consumerPath]);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-015: dry-run reports the write without creating a file", () => {
    const root = fixtureRoot();
    const template = REQUIRED_TEMPLATES.find((entry) => entry.docTypeId === "DOC-L4-DATA");
    if (!template) throw new Error("required DOC-L4-DATA oracle is missing");
    try {
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--slot",
        template.docTypeId,
        "--dry-run",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`+ ${template.consumerPath}`);
      expect(filesUnder(root)).toEqual([]);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-015: requires at least one template selector without writing", () => {
    const root = fixtureRoot();
    try {
      const result = runBundledCli(bundledGeneration(), root, ["vmodel", "template"]);
      expect(result.status).toBe(1);
      expect(filesUnder(root)).toEqual([]);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-015: --json returns written and skipped path arrays", () => {
    const root = fixtureRoot();
    try {
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--required",
        "--json",
      ]);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as { written: string[]; skipped: string[] };
      expect(Object.keys(payload).sort()).toEqual(["skipped", "written"]);
      expect(payload.written.sort()).toEqual(
        REQUIRED_TEMPLATES.map((template) => template.consumerPath).sort(),
      );
      expect(payload.skipped).toEqual([]);
      expect(filesUnder(root)).toEqual(
        REQUIRED_TEMPLATES.map((template) => template.consumerPath).sort(),
      );
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-038: writes only the requested optional template to the optional root", () => {
    const root = fixtureRoot();
    try {
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--optional",
        OPTIONAL_TEMPLATE.id,
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`+ ${OPTIONAL_TEMPLATE.consumerPath}`);
      expect(digest(join(root, OPTIONAL_TEMPLATE.consumerPath))).toBe(
        digest(join(repoRoot, OPTIONAL_TEMPLATE.sourcePath)),
      );
      expect(filesUnder(root)).toEqual([OPTIONAL_TEMPLATE.consumerPath]);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-014/038: accepts multiple slots and required-plus-optional selection", () => {
    const slotsAndOptionalRoot = fixtureRoot();
    const requiredAndOptionalRoot = fixtureRoot();
    const data = REQUIRED_TEMPLATES.find((template) => template.docTypeId === "DOC-L4-DATA");
    const architecture = REQUIRED_TEMPLATES.find(
      (template) => template.docTypeId === "DOC-L4-ARCHITECTURE",
    );
    if (!data || !architecture) throw new Error("required slot oracle is incomplete");
    try {
      const slotResult = runBundledCli(bundledGeneration(), slotsAndOptionalRoot, [
        "vmodel",
        "template",
        "--slot",
        data.docTypeId,
        architecture.docTypeId,
        "--optional",
        OPTIONAL_TEMPLATE.id,
      ]);
      expect(slotResult.status).toBe(0);
      expect(filesUnder(slotsAndOptionalRoot)).toEqual(
        [data.consumerPath, architecture.consumerPath, OPTIONAL_TEMPLATE.consumerPath].sort(),
      );

      const requiredResult = runBundledCli(bundledGeneration(), requiredAndOptionalRoot, [
        "vmodel",
        "template",
        "--required",
        "--optional",
        OPTIONAL_TEMPLATE.id,
      ]);
      expect(requiredResult.status).toBe(0);
      expect(filesUnder(requiredAndOptionalRoot)).toEqual(
        [
          ...REQUIRED_TEMPLATES.map((template) => template.consumerPath),
          OPTIONAL_TEMPLATE.consumerPath,
        ].sort(),
      );
    } finally {
      removeTestDirectory(slotsAndOptionalRoot);
      removeTestDirectory(requiredAndOptionalRoot);
    }
  });

  it("U-RCDEV-038: rejects a slot source ID in the optional namespace", () => {
    const root = fixtureRoot();
    try {
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--optional",
        "ZIP-DOC-004",
      ]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("unknown template ZIP-DOC-004");
      expect(filesUnder(root)).toEqual([]);
    } finally {
      removeTestDirectory(root);
    }
  });

  it("U-RCDEV-039: validates every required destination before the first write", () => {
    const root = fixtureRoot();
    const outsideRoot = fixtureRoot();
    const designRootLink = join(root, "docs", "design");
    const outsideSentinel = join(outsideRoot, "sentinel.txt");
    const sentinelBytes = Buffer.from("external fixture remains unchanged\n", "utf8");
    mkdirSync(dirname(designRootLink), { recursive: true });
    writeFileSync(outsideSentinel, sentinelBytes);

    try {
      createFixtureLink(outsideRoot, designRootLink, "directory");
      const result = runBundledCli(bundledGeneration(), root, ["vmodel", "template", "--required"]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "template destination outside consumer root",
      );
      const firstEscapingTemplate = REQUIRED_TEMPLATES.find(
        (template) =>
          template.consumerPath === "docs/design/L1-requirements/functional-requirements.md",
      );
      if (!firstEscapingTemplate) throw new Error("required L1 destination oracle is missing");
      expect(`${result.stdout}\n${result.stderr}`).toContain(firstEscapingTemplate.consumerPath);
      // L0 is the normal docs/plans destination and precedes this outside
      // ancestor in the frozen port index; validation interleaved with writes
      // would leave a partial charter here.
      expect(filesUnder(root)).toEqual([]);
      expect(filesUnder(outsideRoot)).toEqual(["sentinel.txt"]);
      expect(readFileSync(outsideSentinel)).toEqual(sentinelBytes);
    } finally {
      removeFixtureLink(designRootLink, "directory");
      removeTestDirectory(root);
      removeTestDirectory(outsideRoot);
    }
  });

  it("U-RCDEV-039: allows an ancestor junction that resolves inside the consumer root", () => {
    const root = fixtureRoot();
    const outsideRoot = fixtureRoot();
    const designRootLink = join(root, "docs", "design");
    const internalDesignRoot = join(root, "internal-design");
    const externalSentinel = join(outsideRoot, "sentinel.txt");
    const sentinelBytes = Buffer.from("external fixture remains unchanged\n", "utf8");
    const template = REQUIRED_TEMPLATES.find((entry) => entry.docTypeId === "DOC-L4-DATA");
    if (!template) throw new Error("required DOC-L4-DATA oracle is missing");
    mkdirSync(dirname(designRootLink), { recursive: true });
    mkdirSync(internalDesignRoot, { recursive: true });
    writeFileSync(externalSentinel, sentinelBytes);

    try {
      createFixtureLink(internalDesignRoot, designRootLink, "directory");
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--slot",
        template.docTypeId,
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`+ ${template.consumerPath}`);
      const physicalDestination = join(internalDesignRoot, "L4-basic-design", "data.md");
      expect(existsSync(physicalDestination)).toBe(true);
      expect(digest(physicalDestination)).toBe(digest(join(repoRoot, template.sourcePath)));
      expect(filesUnder(root)).toEqual(["internal-design/L4-basic-design/data.md"]);
      expect(filesUnder(outsideRoot)).toEqual(["sentinel.txt"]);
      expect(readFileSync(externalSentinel)).toEqual(sentinelBytes);
    } finally {
      removeFixtureLink(designRootLink, "directory");
      removeTestDirectory(root);
      removeTestDirectory(outsideRoot);
    }
  });

  it("U-RCDEV-039: denies an outside ancestor during required dry-run without writes", () => {
    const root = fixtureRoot();
    const outsideRoot = fixtureRoot();
    const designRootLink = join(root, "docs", "design");
    const outsideSentinel = join(outsideRoot, "sentinel.txt");
    const sentinelBytes = Buffer.from("external fixture remains unchanged\n", "utf8");
    mkdirSync(dirname(designRootLink), { recursive: true });
    writeFileSync(outsideSentinel, sentinelBytes);

    try {
      createFixtureLink(outsideRoot, designRootLink, "directory");
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--required",
        "--dry-run",
      ]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "template destination outside consumer root",
      );
      const firstEscapingTemplate = REQUIRED_TEMPLATES.find(
        (template) =>
          template.consumerPath === "docs/design/L1-requirements/functional-requirements.md",
      );
      if (!firstEscapingTemplate) throw new Error("required L1 destination oracle is missing");
      expect(`${result.stdout}\n${result.stderr}`).toContain(firstEscapingTemplate.consumerPath);
      expect(filesUnder(root)).toEqual([]);
      expect(filesUnder(outsideRoot)).toEqual(["sentinel.txt"]);
      expect(readFileSync(outsideSentinel)).toEqual(sentinelBytes);
    } finally {
      removeFixtureLink(designRootLink, "directory");
      removeTestDirectory(root);
      removeTestDirectory(outsideRoot);
    }
  });

  it("U-RCDEV-039: denies a dangling final symlink without creating its target", () => {
    const root = fixtureRoot();
    const outsideRoot = fixtureRoot();
    const template = REQUIRED_TEMPLATES.find((entry) => entry.docTypeId === "DOC-L4-DATA");
    if (!template) throw new Error("required DOC-L4-DATA oracle is missing");
    const destination = join(root, template.consumerPath);
    const outsideTarget = join(outsideRoot, "dangling-target.md");
    mkdirSync(dirname(destination), { recursive: true });

    try {
      createFixtureLink(outsideTarget, destination, "file");
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--slot",
        template.docTypeId,
      ]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "template destination outside consumer root",
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain(template.consumerPath);
      expect(existsSync(outsideTarget)).toBe(false);
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(filesUnder(outsideRoot)).toEqual([]);
    } finally {
      removeFixtureLink(destination, "file");
      removeTestDirectory(root);
      removeTestDirectory(outsideRoot);
    }
  });

  it.each([
    { scope: "outside", kind: "file" },
    { scope: "outside", kind: "directory" },
    { scope: "inside", kind: "file" },
    { scope: "inside", kind: "directory" },
  ] as const)("U-RCDEV-039: denies a final $scope $kind link before skip (exists)", ({
    scope,
    kind,
  }) => {
    const root = fixtureRoot();
    const outsideRoot = fixtureRoot();
    const template = REQUIRED_TEMPLATES.find((entry) => entry.docTypeId === "DOC-L4-DATA");
    if (!template) throw new Error("required DOC-L4-DATA oracle is missing");
    const destination = join(root, template.consumerPath);
    const targetRoot = scope === "inside" ? root : outsideRoot;
    const target = join(targetRoot, kind === "file" ? "target.md" : "target-directory");
    const targetFile = kind === "file" ? target : join(target, "sentinel.txt");
    const targetBytes = Buffer.from(`${scope} ${kind} target\n`, "utf8");
    mkdirSync(dirname(destination), { recursive: true });
    if (kind === "directory") mkdirSync(target, { recursive: true });
    writeFileSync(targetFile, targetBytes);

    try {
      createFixtureLink(target, destination, kind);
      const rootBefore = filesUnder(root);
      const outsideBefore = filesUnder(outsideRoot);
      const result = runBundledCli(bundledGeneration(), root, [
        "vmodel",
        "template",
        "--slot",
        template.docTypeId,
      ]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "template destination outside consumer root",
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain(template.consumerPath);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("skip (exists)");
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(readFileSync(targetFile)).toEqual(targetBytes);
      expect(filesUnder(root)).toEqual(rootBefore);
      expect(filesUnder(outsideRoot)).toEqual(outsideBefore);
    } finally {
      removeFixtureLink(destination, kind);
      removeTestDirectory(root);
      removeTestDirectory(outsideRoot);
    }
  });
});
