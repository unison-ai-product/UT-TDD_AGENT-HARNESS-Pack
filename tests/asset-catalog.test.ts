import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogAutomationAssets, scanSkillCatalog } from "../src/assets/catalog.ts";
import { defaultHarnessDbPath, openHarnessDb } from "../src/state-db/index.ts";
import { migrate, rowCounts } from "../src/state-db/migration.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const legacyRuntimeName = ["he", "lix"].join("");

describe("IT-ASSET-DB-01: automation asset catalog", () => {
  it("exposes asset catalog as a JSON command surface", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-assets-cli-"));
    const cliPath = join(process.cwd(), "src", "cli.ts");
    try {
      mkdirSync(join(repo, "skills"), { recursive: true });
      writeFileSync(
        join(repo, "skills", "testing.md"),
        [
          "---",
          "name: testing",
          "skill_type: testing",
          "applies_to:",
          "  layers: [L7]",
          "  drive_models: [Forward]",
          "description: test skill",
          "---",
          "# Testing",
        ].join("\n"),
      );
      mkdirSync(join(repo, ".ut-tdd"), { recursive: true });
      const db = openHarnessDb(defaultHarnessDbPath(repo), { repoRoot: repo });
      try {
        migrate(db);
      } finally {
        db.close();
      }

      const run = spawnSync(process.execPath, [cliPath, "asset", "catalog", "--json"], {
        cwd: repo,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(run.error?.message ?? "", "spawn error").toBe("");
      expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        ok: true,
        assets: ["skill:testing"],
        findings: [],
      });
    } finally {
      removeTestTree(repo);
    }
  }, 20_000);

  it("catalogs metadata, updates search_index, and never stores prompt bodies", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-assets-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      mkdirSync(join(repo, "docs", "skills"), { recursive: true });
      writeFileSync(
        join(repo, "docs", "skills", "testing.md"),
        [
          "---",
          "name: testing",
          "skill_type: testing",
          "applies_to:",
          "  layers: [L7]",
          "  drive_models: [Forward]",
          "description: test skill",
          "---",
          "# Testing",
          "LONG PROMPT BODY SHOULD NOT BE STORED",
        ].join("\n"),
      );
      writeFileSync(
        join(repo, "docs", "skills", "review-checklist.yaml"),
        [
          "schema_version: review-checklist.v1",
          "name: review-checklist",
          "skill_type: quality-gate-review",
          "applies_to:",
          "  layers: [L7]",
          "  drive_models: [Forward]",
          "description: YAML review skill",
        ].join("\n"),
      );
      const result = catalogAutomationAssets({ repoRoot: repo, db });

      expect(result.ok).toBe(true);
      expect(rowCounts(db).automation_assets).toBe(2);
      expect(rowCounts(db).search_index).toBe(2);
      const stored = db
        .prepare("SELECT capability FROM automation_assets WHERE asset_id = ?")
        .get("skill:testing");
      expect(String(stored?.capability ?? "")).not.toContain("LONG PROMPT BODY");
      expect(
        db
          .prepare("SELECT asset_id FROM automation_assets WHERE asset_id = ?")
          .get("skill:review-checklist"),
      ).toMatchObject({ asset_id: "skill:review-checklist" });
      expect(
        db
          .prepare(
            "SELECT skill_type, applies_layers, applies_drive_models FROM automation_assets WHERE asset_id = ?",
          )
          .get("skill:review-checklist"),
      ).toMatchObject({
        skill_type: "quality-gate-review",
        applies_layers: "L7",
        applies_drive_models: "Forward",
      });
    } finally {
      db.close();
      removeTestTree(repo);
    }
  });

  it("records drift and empty catalog as findings", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-assets-"));
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      mkdirSync(join(repo, "docs", "commands"), { recursive: true });
      writeFileSync(
        join(repo, "docs", "commands", "legacy.md"),
        `run ${legacyRuntimeName} codex directly`,
      );

      const result = catalogAutomationAssets({ repoRoot: repo, db });

      expect(result.ok).toBe(false);
      expect(result.findings.map((finding) => finding.kind)).toContain("asset-drift");
      expect(rowCounts(db).findings).toBeGreaterThan(0);
    } finally {
      db.close();
      removeTestTree(repo);
    }
  });
});

describe("IT-ASSET-04: in-memory skill catalog scan", () => {
  it("scans docs/skills markdown into an in-memory catalog without persistent .ut-tdd state", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-skill-catalog-"));
    try {
      mkdirSync(join(repo, "docs", "skills"), { recursive: true });
      writeFileSync(
        join(repo, "docs", "skills", "testing.md"),
        [
          "---",
          "schema_version: skill.v1",
          "name: testing",
          "skill_type: testing",
          "applies_to:",
          "  layers: [L7, L8]",
          "  drive_models: [Forward, Reverse]",
          "---",
          "# testing",
        ].join("\n"),
      );

      const result = scanSkillCatalog({
        repoRoot: repo,
        optionalRoots: ["docs/skills/optional"],
      });

      expect(result.ok).toBe(true);
      expect(result.entries).toEqual([
        {
          id: "skill:testing",
          name: "testing",
          path: "docs/skills/testing.md",
          skill_type: "testing",
          category: "",
          applies_layers: ["L7", "L8"],
          applies_drive_models: ["Forward", "Reverse"],
        },
      ]);
      expect(result.findings).toEqual([
        {
          kind: "optional-root-empty",
          severity: "info",
          subject_id: "docs/skills/optional",
          evidence_path: "docs/skills/optional",
        },
      ]);
      expect(existsSync(join(repo, ".ut-tdd"))).toBe(false);
    } finally {
      removeTestTree(repo);
    }
  });

  it("scans root skills markdown for distribution packages", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-skill-catalog-"));
    try {
      mkdirSync(join(repo, "skills"), { recursive: true });
      writeFileSync(
        join(repo, "skills", "testing.md"),
        [
          "---",
          "schema_version: skill.v1",
          "name: testing",
          "skill_type: testing",
          "applies_to:",
          "  layers: [L7]",
          "  drive_models: [Forward]",
          "---",
          "# testing",
        ].join("\n"),
      );

      const result = scanSkillCatalog({ repoRoot: repo });

      expect(result.ok).toBe(true);
      expect(result.scannedRoots).toEqual(["skills"]);
      expect(result.entries).toEqual([
        expect.objectContaining({
          id: "skill:testing",
          path: "skills/testing.md",
        }),
      ]);
    } finally {
      removeTestTree(repo);
    }
  });

  it("fails closed on malformed metadata and duplicate skill IDs", () => {
    const repo = mkdtempSync(join(tmpdir(), "ut-skill-catalog-"));
    try {
      mkdirSync(join(repo, "docs", "skills", "nested"), { recursive: true });
      writeFileSync(
        join(repo, "docs", "skills", "one.md"),
        ["---", "name: duplicate", "skill_type: testing", "---", "# one"].join("\n"),
      );
      writeFileSync(
        join(repo, "docs", "skills", "nested", "two.md"),
        ["---", "name: duplicate", "skill_type: testing", "---", "# two"].join("\n"),
      );
      writeFileSync(
        join(repo, "docs", "skills", "bad.md"),
        ["---", "name: [unterminated", "---", "# bad"].join("\n"),
      );

      const result = scanSkillCatalog({ repoRoot: repo });

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "duplicate-skill-id",
            subject_id: "skill:duplicate",
          }),
          expect.objectContaining({
            kind: "invalid-skill-metadata",
            evidence_path: "docs/skills/bad.md",
          }),
        ]),
      );
      expect(existsSync(join(repo, ".ut-tdd"))).toBe(false);
    } finally {
      removeTestTree(repo);
    }
  });

  it("real repo has a non-empty skill markdown catalog and no optional-root blocker", () => {
    const repoRoot = process.cwd();
    const skillRoot = existsSync(join(repoRoot, "skills")) ? "skills" : "docs/skills";
    const result = scanSkillCatalog({
      repoRoot,
      optionalRoots: [`${skillRoot}/optional`],
    });

    expect(result.ok).toBe(true);
    expect(result.entries.length).toBeGreaterThan(40);
    expect(result.entries.map((entry) => entry.path)).toContain(`${skillRoot}/testing.md`);
    expect(result.findings).toContainEqual({
      kind: "optional-root-empty",
      severity: "info",
      subject_id: `${skillRoot}/optional`,
      evidence_path: `${skillRoot}/optional`,
    });
  });
});
