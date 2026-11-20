/**
 * PLAN-L7-243: mode (駆動モデル) の第一級化 (A-173 F-9 latent-defect の是正)。
 *
 * Oracle:
 *   - drive_runs.mode の導出は route_mode (frontmatter 正本) を最優先し、
 *     legacy PLAN は plan_id prefix → kind の順でフォールバックする。
 *   - kind=refactor / troubleshoot が Forward へ誤投影されない (旧 4 分岐の損失解消)。
 *   - docs/process/modes/ の mode doc は全件 MODE_CATALOG_DOC_FILES 写像を持ち、
 *     新 mode doc 追加時の取りこぼしを mode catalog の検査が検出する。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  MODE_CATALOG_DOC_FILES,
  ROUTE_MODE_DISPLAY,
  routeModesWithoutCatalogDoc,
  unmappedModeCatalogDocs,
  workflowModeForPlan,
} from "../src/schema/mode-catalog.ts";
import { ROUTE_SIGNAL_MAP } from "../src/schema/route-map.ts";

const ORPHAN_INSPECTION_TOKEN = /(?:workflow|model|skill)[\w-]*orphan[\w-]*/i;

function orphanInspectionTokens(path: string, source: string): string[] {
  const findings: string[] = [];
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(path)) {
    const withoutYamlComments = source.replace(/^\s*#.*$/gm, "");
    for (const match of withoutYamlComments.matchAll(
      /(?:workflow|model|skill)[\w-]*orphan[\w-]*/gi,
    )) {
      findings.push(`${path}:${match[0]}`);
    }
    return findings;
  }

  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const inTestFile = path.startsWith("tests/");
  const visit = (node: ts.Node): void => {
    const token = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
    if (token && ORPHAN_INSPECTION_TOKEN.test(token)) {
      const isTestTitle =
        inTestFile &&
        ts.isStringLiteralLike(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        ((ts.isIdentifier(node.parent.expression) &&
          ["it", "test", "describe"].includes(node.parent.expression.text)) ||
          (ts.isPropertyAccessExpression(node.parent.expression) &&
            ["it", "test", "describe"].includes(
              node.parent.expression.expression.getText(sourceFile),
            )));
      if (!isTestTitle) findings.push(`${path}:${token}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings.sort();
}

function trackedOrphanInspectionTokens(repoRoot: string): string[] {
  const trackedPaths = execFileSync("git", ["ls-files", "--", "src", "tests", ".github"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);

  return trackedPaths.flatMap((path) =>
    orphanInspectionTokens(path, readFileSync(join(repoRoot, path), "utf8")),
  );
}

describe("PLAN-L7-243: mode catalog derivation", () => {
  it("route_mode frontmatter wins over plan_id prefix and kind", () => {
    expect(
      workflowModeForPlan({ planId: "PLAN-L7-900-x", routeMode: "refactor", kind: "impl" }),
    ).toBe("Refactor");
    expect(
      workflowModeForPlan({ planId: "PLAN-L7-901-x", routeMode: "add-feature", kind: "add-impl" }),
    ).toBe("Add-feature");
    expect(
      workflowModeForPlan({ planId: "PLAN-L7-902-x", routeMode: "version-up", kind: "impl" }),
    ).toBe("Version-up");
    expect(
      workflowModeForPlan({ planId: "PLAN-L9-903-x", routeMode: "verify", kind: "verify" }),
    ).toBe("Verify");
    expect(
      workflowModeForPlan({ planId: "PLAN-L4-904-x", routeMode: "redesign", kind: "design" }),
    ).toBe("Redesign");
  });

  it("legacy plans without route_mode fall back to plan_id prefix then kind", () => {
    expect(workflowModeForPlan({ planId: "PLAN-DISCOVERY-01-x" })).toBe("Discovery");
    expect(workflowModeForPlan({ planId: "PLAN-REVERSE-56-x" })).toBe("Reverse");
    expect(workflowModeForPlan({ planId: "PLAN-RECOVERY-06-x" })).toBe("Recovery");
    expect(workflowModeForPlan({ planId: "PLAN-M-01-cutover" })).toBe("Verification");
    // A-173 F-9: kind=refactor / troubleshoot の Forward 誤投影を解消する分岐。
    expect(workflowModeForPlan({ planId: "PLAN-L7-230-x", kind: "refactor" })).toBe("Refactor");
    expect(workflowModeForPlan({ planId: "PLAN-L7-231-x", kind: "troubleshoot" })).toBe("Incident");
    expect(workflowModeForPlan({ planId: "PLAN-L7-232-x", kind: "retrofit" })).toBe("Retrofit");
    expect(workflowModeForPlan({ planId: "PLAN-L9-233-x", kind: "verify" })).toBe("Verify");
    expect(workflowModeForPlan({ planId: "PLAN-L4-01-x", kind: "design" })).toBe("Forward");
    expect(workflowModeForPlan({ planId: "PLAN-L7-01-x", kind: "impl" })).toBe("Forward");
  });

  it("every route-map mode token has a display mapping (drift guard)", () => {
    const mappedTokens = Object.keys(ROUTE_MODE_DISPLAY);
    for (const entry of ROUTE_SIGNAL_MAP) {
      expect(mappedTokens, `route-map mode ${entry.mode}`).toContain(entry.mode);
    }
  });

  it("every route-map mode token has a catalog doc unless it is Forward", () => {
    expect(routeModesWithoutCatalogDoc(ROUTE_SIGNAL_MAP.map((entry) => entry.mode))).toEqual([]);
    expect(routeModesWithoutCatalogDoc(["forward", "design-bottomup", "unknown-mode"])).toEqual([
      "unknown-mode",
    ]);
  });

  it("every mode doc in docs/process/modes is mapped (real-repo catalog sync)", () => {
    const files = readdirSync(join(process.cwd(), "docs", "process", "modes"));
    expect(unmappedModeCatalogDocs(files)).toEqual([]);
    for (const file of Object.keys(MODE_CATALOG_DOC_FILES)) {
      expect(files, `catalog doc ${file}`).toContain(file);
    }
  });

  it("mode catalog reports unmapped documentation without a DB registration check", () => {
    expect(
      unmappedModeCatalogDocs(["README.md", "forward.md", "new-mode.md", "notes.txt"]),
    ).toEqual(["forward.md", "new-mode.md"]);
  });

  it("orphan scanner detects function declarations and calls in test files", () => {
    const checkerName = ["check", "Workflow", "Orphans"].join("");
    const fixturePath = ["tests", "orphan-scanner-fixture.test.ts"].join("/");
    const source = [`function ${checkerName}() {}`, `${checkerName}();`].join("\n");
    const finding = `${fixturePath}:${checkerName}`;
    expect(orphanInspectionTokens(fixturePath, source)).toEqual([finding, finding]);
  });

  it("CANDIDATE-U-PLANRET-009: retires drive DB registration and keeps mode catalog coverage", () => {
    const root = process.cwd();
    expect(existsSync(join(root, "src", "lint", "drive-db-registration.ts"))).toBe(false);
    expect(existsSync(join(root, "src", "state-db", "drive-registration.ts"))).toBe(false);
    expect(existsSync(join(root, "tests", "drive-db-registration.test.ts"))).toBe(false);

    const checkGroups = readFileSync(
      join(root, "src", "doctor", "check-definition-groups.ts"),
      "utf8",
    );
    const profiles = readFileSync(join(root, "src", "doctor", "profiles.ts"), "utf8");
    expect(checkGroups).not.toContain('full("drive-db-registration"');
    expect(profiles).not.toContain('"drive-db-registration"');

    const packageJson = readFileSync(join(root, "package.json"), "utf8");
    const runtimePortability = readFileSync(
      join(root, "src", "lint", "runtime-portability.ts"),
      "utf8",
    );
    expect(packageJson).not.toContain("tests/drive-db-registration.test.ts");
    expect(runtimePortability).not.toContain("tests/drive-db-registration.test.ts");
    const dbCurrency = readFileSync(join(root, "src", "lint", "db-currency.ts"), "utf8");
    expect(dbCurrency).not.toContain("collectCurrentPlanRegistryFingerprint");
    expect(trackedOrphanInspectionTokens(root)).toEqual([]);

    const unmapped = unmappedModeCatalogDocs(["README.md", "new-mode.md"]);
    expect(unmapped).toEqual(["new-mode.md"]);
    expect(unmapped).not.toEqual([]);
  });
});
