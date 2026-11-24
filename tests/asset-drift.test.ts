import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AssetDoc,
  type AssetDriftInput,
  analyzeAssetDrift,
  assetDriftMessages,
  loadAssetDriftInput,
} from "../src/lint/asset-drift.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// production 定数から独立させるため、旧ソース repo 名はテスト側で実行時に連結する (リテラル禁止)。
const legacySourceName = ["ai", "dev", "kit", "vscode"].join("-");

const agent = (id: string, text = "---\nmodel: claude-sonnet-4-6\n---\nbody"): AssetDoc => ({
  path: `.claude/agents/${id}.md`,
  type: "agent",
  id,
  text,
});

const skill = (id: string, text = "name: review-checklist"): AssetDoc => ({
  path: `docs/skills/${id}.md`,
  type: "skill",
  id,
  text,
});

const input = (overrides: Partial<AssetDriftInput>): AssetDriftInput => ({
  assets: [agent("pmo-sonnet"), skill("review-checklist")],
  skillRootExists: true,
  skillDocCount: 1,
  enrolledRootCount: 2,
  ...overrides,
});

const legacyRuntimeName = ["he", "lix"].join("");

describe("asset-drift lint (U-FR-L1-49)", () => {
  it("detects legacy source personal path residue in enrolled assets", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [agent("pmo-sonnet", `Read ~/${legacySourceName}/skills/SKILL_MAP.md`)],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("legacy-source-path-residue");
  });

  it("detects arbitrary personal absolute paths in enrolled assets", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [
          agent("pmo-sonnet", "Read C:\\Users\\alice\\workspace\\local-notes.md"),
          skill("review-checklist", "Fallback: /home/bob/private/SKILL.md"),
        ],
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "legacy-source-path-residue",
          path: ".claude/agents/pmo-sonnet.md",
        }),
        expect.objectContaining({
          kind: "legacy-source-path-residue",
          path: "docs/skills/review-checklist.md",
        }),
      ]),
    );
  });

  it("does not treat URL path segments as personal absolute paths", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [agent("pmo-sonnet", "Read https://example.com/home/alice/guide.md")],
      }),
    );

    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("detects legacy runtime command delegation residue", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [agent("pdm-tech", `Run ${legacyRuntimeName} codex --role tl-advisor`)],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("legacy-command-residue");
  });

  it("detects legacy runtime agent and env-name residue", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [
          agent("pdm-tech", `Use pmo-${legacyRuntimeName}-explorer`),
          skill("runtime-env", `${legacyRuntimeName.toUpperCase()}_CODEX_BIN=true`),
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("legacy-runtime-name-residue");
  });

  it("detects empty docs-skills catalog source", () => {
    const r = analyzeAssetDrift(input({ skillDocCount: 0 }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("empty-docs-skills");
  });

  it("passes when enrolled assets are UT-TDD local", () => {
    const r = analyzeAssetDrift(input({}));
    expect(r.ok).toBe(true);
    expect(assetDriftMessages(r)[0]).toContain("OK");
  });

  it("real repo has no active internal asset drift", () => {
    const loaded = loadAssetDriftInput(process.cwd());
    const r = analyzeAssetDrift(loaded);

    expect(r.violations).toEqual([]);
    expect(r.checkedAssets).toBeGreaterThan(0);
  });

  it("U-ASSETDRIFT-007: loads nested agent memory as an enrolled asset source", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-asset-drift-"));
    try {
      const memoryDir = join(root, ".claude", "agent-memory", `pmo-${legacyRuntimeName}-explorer`);
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, "MEMORY.md"), `Use pmo-${legacyRuntimeName}-explorer`);
      mkdirSync(join(root, "docs", "skills"), { recursive: true });
      writeFileSync(join(root, "docs", "skills", "review.md"), "name: review");

      const r = analyzeAssetDrift(loadAssetDriftInput(root));

      expect(r.ok).toBe(false);
      expect(r.violations).toContainEqual({
        kind: "legacy-runtime-name-residue",
        path: `.claude/agent-memory/pmo-${legacyRuntimeName}-explorer/MEMORY.md`,
        detail: "legacy runtime name residue",
      });
    } finally {
      removeTestTree(root);
    }
  });
});
