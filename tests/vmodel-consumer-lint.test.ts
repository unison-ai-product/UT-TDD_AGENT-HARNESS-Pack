import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintVmodel } from "../src/vmodel/lint.ts";

const consumerTemplateSlots = [
  [
    "docs/templates/vmodel/L1-requirements.md",
    "docs/design/L1-requirements/functional-requirements.md",
  ],
  ["docs/templates/vmodel/L2-screen-list.md", "docs/design/L2-screen/screen-list.md"],
  [
    "docs/templates/vmodel/L3-functional-requirements.md",
    "docs/design/L3-functional/functional-requirements.md",
  ],
  ["docs/templates/vmodel/L4-data.md", "docs/design/L4-basic-design/data.md"],
  ["docs/templates/vmodel/L4-architecture.md", "docs/design/L4-basic-design/architecture.md"],
  ["docs/templates/vmodel/L4-external-if.md", "docs/design/L4-basic-design/external-if.md"],
  ["docs/templates/vmodel/L4-function.md", "docs/design/L4-basic-design/function.md"],
  ["docs/templates/vmodel/L4-ui-standard.md", "docs/design/L4-basic-design/ui-standard.md"],
  ["docs/templates/vmodel/L4-security.md", "docs/design/L4-basic-design/security.md"],
  ["docs/templates/vmodel/L5-physical-data.md", "docs/design/L5-detailed-design/physical-data.md"],
  [
    "docs/templates/vmodel/L5-module-decomposition.md",
    "docs/design/L5-detailed-design/module-decomposition.md",
  ],
  ["docs/templates/vmodel/L6-function-spec.md", "docs/design/L6-function-design/function-spec.md"],
  ["docs/templates/vmodel/L7-unit-test-design.md", "docs/test-design/L7-unit-test-design.md"],
] as const;

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-vmodel-consumer-lint-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/probe.git"], {
      cwd: root,
    });
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function writeFixtureDoc(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

/** Copy the frozen PR-T1 L1-L7 slots and adapt only their fixture-local pair paths. */
function writeConsumerTemplateFixture(root: string): number {
  const repositoryRoot = process.cwd();
  for (const [templatePath, targetPath] of consumerTemplateSlots) {
    const source = join(repositoryRoot, templatePath);
    const template = requireTemplate(source);
    const isTestDesign = targetPath.startsWith("docs/test-design/");
    const pairTarget = isTestDesign ? "docs/design/" : "docs/test-design/L7-unit-test-design.md";
    const adapted = template.replace(/^pair_artifact: .*$/m, `pair_artifact: ${pairTarget}`);
    writeFixtureDoc(root, targetPath, adapted);
  }
  return consumerTemplateSlots.length;
}

function requireTemplate(path: string): string {
  if (!existsSync(path)) throw new Error(`PR-T1 template missing: ${path}`);
  return readFileSync(path, "utf8");
}

describe("release-consumer vmodel lint (PLAN-L7-676 PR-VL)", () => {
  it("U-RCDEV-036: lints the complete consumer L1-L7 template fixture and reports its trace", () => {
    const root = fixtureRoot();
    try {
      const expectedDocumentCount = writeConsumerTemplateFixture(root);

      const result = lintVmodel(undefined, root);

      expect(result).toMatchObject({ status: "checked", documentCount: expectedDocumentCount });
      expect(result.ok).toBe(true);
      expect(result.messages).toContain(`vmodel — 文書 ${expectedDocumentCount} 件`);
      expect(result.messages.join("\n")).toContain(`双方向 ${expectedDocumentCount - 1} pair`);
      expect(result.messages.join("\n")).toContain("孤児 0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-RCDEV-036: reports missing consumer documents as typed not-created without ENOENT", () => {
    const root = fixtureRoot();
    try {
      const result = lintVmodel(undefined, root);

      expect(result).toMatchObject({ status: "not-created", documentCount: 0 });
      expect(result.messages.join("\n")).toContain("未作成");
      expect(result.messages.join("\n")).not.toContain("ENOENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the existing trace-orphan failure when one reciprocal pair reference is changed", () => {
    const root = fixtureRoot();
    try {
      writeFixtureDoc(
        root,
        "docs/design/L4-basic-design/function.md",
        "---\nlayer: L4\npair_artifact: docs/test-design/L7-unit-test-design.md\n---\n",
      );
      writeFixtureDoc(
        root,
        "docs/test-design/L7-unit-test-design.md",
        "---\nlayer: L4\npair_artifact: docs/design/L5-other/\n---\n",
      );

      const result = lintVmodel(undefined, root);

      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("逆参照なし");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses harness document roots ahead of consumer roots when both layouts exist", () => {
    const root = fixtureRoot();
    try {
      writeFixtureDoc(
        root,
        "docs/design/harness/L4-basic-design/function.md",
        "---\nlayer: L4\npair_artifact: docs/test-design/harness/L7-unit-test-design.md\n---\n",
      );
      writeFixtureDoc(
        root,
        "docs/test-design/harness/L7-unit-test-design.md",
        "---\nlayer: L4\npair_artifact: docs/design/harness/L4-basic-design/\n---\n",
      );
      writeFixtureDoc(
        root,
        "docs/design/L4-basic-design/consumer-only.md",
        "---\nlayer: L4\npair_artifact: docs/test-design/missing.md\n---\n",
      );

      const result = lintVmodel(undefined, root);

      expect(result).toMatchObject({ status: "checked", documentCount: 2 });
      expect(result.ok).toBe(true);
      expect(result.messages.join("\n")).toContain("双方向 1 pair");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
