import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkResourceKernelFixtureManifest } from "../src/doctor/doc-registry.ts";
import {
  ALLOWED_FIXTURE_STATUSES,
  analyzeFixtureManifest,
  type FixtureManifest,
  fixtureManifestMessages,
  parseContractSections,
  parseFixtureManifest,
  parseL8FixtureRows,
} from "../src/lint/resource-kernel-fixture-manifest.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot, workspaceRead } from "./support/workspace-roots.ts";

const L8 = "docs/test-design/harness/L8-integration-test-design.md";
const MANIFEST = "docs/test-design/harness/resource-kernel-fixture-manifest.yaml";
const L5_CANONICAL = "docs/design/harness/L5-detailed-design/resource-kernel-wire-custody.md";
const SOURCE_2_FIXTURE_IDS = [
  "fx-rgk-frame-split",
  "fx-rgk-predecode-corpus",
  "fx-rgk-response-mutate",
  "fx-rgk-response-inject",
];
const SOURCE_4_1_FIXTURE_IDS = [
  "fx-rgk-deadline-race",
  "fx-rgk-recovery-overdue",
  "fx-rgk-same-boot-restart",
  "fx-rgk-cross-boot",
  "fx-rgk-boot-fence-missing",
  "fx-rgk-recovery-lanes",
];

function snapshotRoot(): string {
  // U-RGKFIX: fixture manifest は immutable HEAD の L8 表・manifest・契約節と突合して判定する。
  return headSnapshotRoot();
}

function loadRepoInput() {
  const root = snapshotRoot();
  const manifest = parseFixtureManifest(readFileSync(join(root, MANIFEST), "utf8"));
  return {
    root,
    rows: parseL8FixtureRows(readFileSync(join(root, L8), "utf8")),
    manifest,
    contractSections: parseContractSections(readFileSync(join(root, manifest.contractDoc), "utf8")),
    pathExists: (p: string) => existsSync(join(root, p)),
  };
}

/** L8・manifest・新L5だけを置き、docs/plans/ を含めない候補snapshotを作る。 */
function planlessManifestFixture(manifestMutation?: (text: string) => string) {
  const source = snapshotRoot();
  const root = mkdtempSync(join(tmpdir(), "rgk-fixture-planless-"));
  const l8Text = readFileSync(join(source, L8), "utf8");
  const sourceManifestText = readFileSync(join(source, MANIFEST), "utf8");
  const changedManifestText = sourceManifestText.replace(
    /^contract_doc: .*$/m,
    `contract_doc: ${L5_CANONICAL}`,
  );
  const contractDocLines = changedManifestText.match(/^contract_doc: .*$/gm) ?? [];
  if (contractDocLines.length !== 1 || contractDocLines[0] !== `contract_doc: ${L5_CANONICAL}`) {
    throw new Error("fixture manifest contract_doc must be the canonical design path exactly once");
  }
  const manifest = parseFixtureManifest(changedManifestText);
  const l5Text = readFileSync(join(source, manifest.contractDoc), "utf8");
  const manifestText = manifestMutation
    ? manifestMutation(changedManifestText)
    : changedManifestText;
  for (const [rel, text] of [
    [L8, l8Text],
    [MANIFEST, manifestText],
    [L5_CANONICAL, l5Text],
  ] as const) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  const isolatedRoot = workspaceRead({
    id: "U-RGKPAIR-PLANLESS-004",
    mode: "isolated_fixture",
    root,
    reason: "候補Redはmanifest contract_docと実L5 parserをPLANなしsnapshotで検証する",
  });
  const isolatedManifest = parseFixtureManifest(readFileSync(join(isolatedRoot, MANIFEST), "utf8"));
  const actualL5Text = readFileSync(join(isolatedRoot, isolatedManifest.contractDoc), "utf8");
  const input = {
    rows: parseL8FixtureRows(readFileSync(join(isolatedRoot, L8), "utf8")),
    manifest: isolatedManifest,
    // 実export parserの出力をそのままresolverへ渡す。テスト側でlocator集合を合成しない。
    contractSections: parseContractSections(actualL5Text),
    pathExists: (p: string) => existsSync(join(isolatedRoot, p)),
  };
  return {
    root: isolatedRoot,
    l5Text: actualL5Text,
    input,
    sourceManifest: parseFixtureManifest(sourceManifestText),
    cleanup: () => removeTestTree(root),
  };
}

function analyzePlanlessManifest(
  l5Text: string,
  fixture: ReturnType<typeof planlessManifestFixture>,
) {
  return analyzeFixtureManifest({
    ...fixture.input,
    // locator coverage under mutation is always produced by the actual exported parser.
    contractSections: parseContractSections(l5Text),
  });
}

function withoutSourceHeading(markdown: string, section: string): string {
  const heading = new RegExp(`^#{4,5} source §${section.replaceAll(".", "\\.")} —.*\\r?$`, "m");
  const changed = markdown.replace(heading, "");
  if (changed === markdown) throw new Error(`source §${section} heading not found`);
  return changed;
}

function moveSourceHeadingOutsideD6(markdown: string, section: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    new RegExp(`^#{4,5} source §${section.replaceAll(".", "\\.")} —`).test(line),
  );
  const d6Index = lines.findIndex((line) => /^### D\.6 /.test(line));
  if (headingIndex < 0 || d6Index < 0 || headingIndex <= d6Index) {
    throw new Error(`cannot move source §${section} outside D.6`);
  }
  let end = headingIndex + 1;
  while (end < lines.length && !/^#{1,4} /.test(lines[end])) end++;
  const block = lines.splice(headingIndex, end - headingIndex);
  const destination = lines.findIndex((line) => /^### D\.6 /.test(line));
  lines.splice(destination, 0, ...block, "");
  return lines.join("\n");
}

const baseEntry = {
  id: "fx-rgk-frame-split",
  case: "IT-RGK-PHYS-001",
  lane: "mock",
  status: "planned",
  path: "tests/fixtures/resource-kernel/frame-split",
  contractRef: "§2",
  inputs: ["frame bytes"],
  generation: "split and write",
};

function manifestOf(entries: (typeof baseEntry)[]): FixtureManifest {
  return {
    contractDoc: L5_CANONICAL,
    fixtureRoot: "tests/fixtures/resource-kernel",
    entries,
  };
}

describe("Resource Kernel fixture manifest lint (U-RGKFIX, PLAN-L5-25 §7)", () => {
  it("U-RGKFIX-001: 実 repo の L8 fixture 42 件が manifest と双方向一致し、属性が揃う", () => {
    const input = loadRepoInput();
    expect(input.rows).toHaveLength(42);
    expect(input.manifest.entries).toHaveLength(42);
    const r = analyzeFixtureManifest(input);
    expect(fixtureManifestMessages(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.missingFromManifest).toEqual([]);
    expect(r.danglingInManifest).toEqual([]);
    expect(r.duplicateIds).toEqual([]);
  });

  it("U-RGKFIX-002: 実 repo の 42 件は全て planned で、path は 1 件も実在しない", () => {
    const input = loadRepoInput();
    const r = analyzeFixtureManifest(input);
    // 実装未着地なので materialized は 0。planned の path が実在したら実体の偽装として Red。
    expect(r.statusCounts).toEqual({ planned: 42 });
    expect(r.plannedPathExists).toEqual([]);
    for (const e of input.manifest.entries) {
      expect(ALLOWED_FIXTURE_STATUSES).toContain(e.status);
      expect(input.pathExists(e.path)).toBe(false);
    }
  });

  it("U-RGKFIX-003: planned で path 実在 / materialized で path 不在の双方を fail-close 検出する", () => {
    const rows = [{ case: "IT-RGK-PHYS-001", lane: "mock", fixtureId: "fx-rgk-frame-split" }];
    const plannedButExists = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([baseEntry]),
      contractSections: new Set(["2"]),
      pathExists: () => true,
    });
    expect(plannedButExists.ok).toBe(false);
    expect(plannedButExists.plannedPathExists).toHaveLength(1);

    const materializedButMissing = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([{ ...baseEntry, status: "materialized" }]),
      contractSections: new Set(["2"]),
      pathExists: () => false,
    });
    expect(materializedButMissing.ok).toBe(false);
    expect(materializedButMissing.materializedPathMissing).toHaveLength(1);
  });

  it("U-RGKFIX-004: 欠落・dangling・重複・case/lane 不一致・属性欠落・不明節を検出する", () => {
    const rows = [
      { case: "IT-RGK-PHYS-001", lane: "mock", fixtureId: "fx-rgk-frame-split" },
      { case: "IT-RGK-PHYS-002", lane: "mock", fixtureId: "fx-rgk-predecode-corpus" },
      { case: "IT-RGK-PHYS-003", lane: "mock", fixtureId: "" },
    ];
    const r = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([
        { ...baseEntry, case: "IT-RGK-PHYS-009", lane: "real-OS", contractRef: "§99" },
        { ...baseEntry },
        { ...baseEntry, id: "fx-rgk-not-in-l8" },
        { ...baseEntry, id: "fx-rgk-empty", inputs: [], generation: "", path: "" },
      ]),
      contractSections: new Set(["2"]),
      pathExists: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.missingFromManifest).toContain("fx-rgk-predecode-corpus");
    expect(r.missingFromManifest).toContain("IT-RGK-PHYS-003 (fixture 未記載)");
    expect(r.danglingInManifest).toEqual(["fx-rgk-empty", "fx-rgk-not-in-l8"]);
    expect(r.duplicateIds).toEqual(["fx-rgk-frame-split"]);
    expect(r.caseMismatch).toHaveLength(1);
    expect(r.laneMismatch).toHaveLength(1);
    expect(r.emptyFields).toEqual(["fx-rgk-empty"]);
    expect(r.unknownContractRef).toEqual(["fx-rgk-frame-split: §99"]);
    expect(fixtureManifestMessages(r).length).toBeGreaterThan(5);
  });

  it("U-RGKFIX-005: fixture_root 外の path と status 語彙外を検出する", () => {
    const rows = [{ case: "IT-RGK-PHYS-001", lane: "mock", fixtureId: "fx-rgk-frame-split" }];
    const r = analyzeFixtureManifest({
      rows,
      manifest: manifestOf([{ ...baseEntry, status: "assumed-green", path: "tests/elsewhere/x" }]),
      contractSections: new Set(["2"]),
      pathExists: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.invalidStatus).toEqual(["fx-rgk-frame-split: assumed-green"]);
    expect(r.pathOutsideRoot).toEqual(["fx-rgk-frame-split: tests/elsewhere/x"]);
  });

  it("U-RGKPAIR-PLANLESS-004 setup: 42件のmanifest属性とD.6 locator見出しを保持したplanless fixture", () => {
    const fixture = planlessManifestFixture();
    try {
      expect(existsSync(join(fixture.root, "docs/plans"))).toBe(false);
      expect(fixture.input.rows).toHaveLength(42);
      expect(fixture.input.manifest.entries).toHaveLength(42);
      expect(fixture.input.manifest.contractDoc).toBe(L5_CANONICAL);
      expect(fixture.input.manifest.entries).toEqual(fixture.sourceManifest.entries);
      expect(fixture.l5Text).toContain("### D.6 ");
      for (const locator of ["1", "2", "3", "4", "4.1", "5", "6"]) {
        expect(fixture.l5Text).toMatch(
          new RegExp(`^#{4,5} source §${locator.replaceAll(".", "\\.")} —`, "m"),
        );
      }
      expect(
        fixture.input.manifest.entries
          .filter((entry) => entry.contractRef === "§2")
          .map((entry) => entry.id),
      ).toEqual(SOURCE_2_FIXTURE_IDS);
      expect(
        fixture.input.manifest.entries
          .filter((entry) => entry.contractRef === "§4.1")
          .map((entry) => entry.id),
      ).toEqual(SOURCE_4_1_FIXTURE_IDS);
    } finally {
      fixture.cleanup();
    }
  });

  it("U-RGKPAIR-PLANLESS-004: canonical L5 D.6が42 locator refを解決し、PLANなしでも全fixtureを保つ", () => {
    const fixture = planlessManifestFixture();
    try {
      const result = analyzePlanlessManifest(fixture.l5Text, fixture);
      expect(result.unknownContractRef).toEqual([]);
      expect(fixtureManifestMessages(result)).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("U-RGKPAIR-PLANLESS-004: doctorのmanifest checkがplanless L5 contract_docを受理する", () => {
    const fixture = planlessManifestFixture();
    try {
      const result = checkResourceKernelFixtureManifest(fixture.root);
      expect(result.ok).toBe(true);
      expect(result.messages.join(" ")).toContain("resource-kernel-fixture-manifest — OK");
    } finally {
      fixture.cleanup();
    }
  });

  it("U-RGKPAIR-PLANLESS-004: D.6 source §2削除は対応する全4fixtureをunknownにする", () => {
    const fixture = planlessManifestFixture();
    try {
      const changed = withoutSourceHeading(fixture.l5Text, "2");
      expect(analyzePlanlessManifest(changed, fixture).unknownContractRef).toEqual(
        SOURCE_2_FIXTURE_IDS.map((id) => `${id}: §2`),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("U-RGKPAIR-PLANLESS-004: D.6 source §2改名は対応する全4fixtureをunknownにする", () => {
    const fixture = planlessManifestFixture();
    try {
      const changed = fixture.l5Text.replace(
        /^#### source §2 —.*$/m,
        "#### source §2-renamed — wire framingとschema配置",
      );
      expect(changed).not.toBe(fixture.l5Text);
      expect(analyzePlanlessManifest(changed, fixture).unknownContractRef).toEqual(
        SOURCE_2_FIXTURE_IDS.map((id) => `${id}: §2`),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("U-RGKPAIR-PLANLESS-004: D.6外のsource §2は同番号でも救済せず対応4件をunknownにする", () => {
    const fixture = planlessManifestFixture();
    try {
      const changed = moveSourceHeadingOutsideD6(fixture.l5Text, "2");
      expect(analyzePlanlessManifest(changed, fixture).unknownContractRef).toEqual(
        SOURCE_2_FIXTURE_IDS.map((id) => `${id}: §2`),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("U-RGKPAIR-PLANLESS-004: D.6 source §4.1欠落は対応する全6fixtureをunknownにする", () => {
    const fixture = planlessManifestFixture();
    try {
      const changed = withoutSourceHeading(fixture.l5Text, "4.1");
      expect(analyzePlanlessManifest(changed, fixture).unknownContractRef).toEqual(
        SOURCE_4_1_FIXTURE_IDS.map((id) => `${id}: §4.1`),
      );
    } finally {
      fixture.cleanup();
    }
  });
});
