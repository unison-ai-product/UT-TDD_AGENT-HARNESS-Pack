import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AssetDoc,
  type AssetDriftInput,
  analyzeAssetDrift,
  assetDriftMessages,
  loadAssetDriftInput,
} from "../src/lint/asset-drift";

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
  allowlist: ["pmo-sonnet"],
  enrolledRootCount: 2,
  ...overrides,
});

const legacyRuntimeName = ["he", "lix"].join("");

describe("asset-drift lint (U-FR-L1-49)", () => {
  it("detects legacy source personal path residue in enrolled assets", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [agent("pmo-sonnet", "Read ~/ai-dev-kit-vscode/skills/SKILL_MAP.md")],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("legacy-source-path-residue");
  });

  it("detects legacy runtime command delegation residue", () => {
    const r = analyzeAssetDrift(
      input({
        assets: [agent("pdm-tech", `Run ${legacyRuntimeName} codex --role tl-advisor`)],
        allowlist: ["pdm-tech"],
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
        allowlist: ["pdm-tech"],
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

  it("detects guard allowlist entries without matching agent docs", () => {
    const r = analyzeAssetDrift(input({ allowlist: ["pmo-sonnet", "missing-agent"] }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("missing-allowlisted-agent");
  });

  it("passes when enrolled assets are UT-TDD local and guard allowlist resolves", () => {
    const r = analyzeAssetDrift(input({}));
    expect(r.ok).toBe(true);
    expect(assetDriftMessages(r)[0]).toContain("OK");
  });

  it("real repo has no active internal asset drift", () => {
    const loaded = loadAssetDriftInput(process.cwd());
    expect(loaded.assets.some((a) => a.path === "docs/templates/prompts/effort-classify.md")).toBe(
      true,
    );

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
      rmSync(root, { recursive: true, force: true });
    }
  });
});
