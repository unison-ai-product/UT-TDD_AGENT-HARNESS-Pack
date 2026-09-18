import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeDocConsistency, loadDocConsistencyDocs } from "../lint/doc-consistency.ts";
import {
  analyzeEntityCoverage,
  loadBusiness as loadEntityBusiness,
} from "../lint/entity-coverage.ts";
import { analyzeFrRegistry, loadFrDocs as loadFrRegistryDocs } from "../lint/fr-registry-audit.ts";
import {
  analyzeFixtureManifest,
  fixtureManifestMessages,
  parseContractSections,
  parseFixtureManifest,
  parseL8FixtureRows,
} from "../lint/resource-kernel-fixture-manifest.ts";
import {
  analyzeResourceKernelPairMapping,
  parseContractMappingRows,
  parseFreezeAttributeRows,
  parseLaneDeclarations,
  parseRealRunnerTotal,
  resourceKernelPairMappingMessages,
} from "../lint/resource-kernel-pair-mapping.ts";

const RGK_L8_DOC = "docs/test-design/harness/L8-integration-test-design.md";
const RGK_FIXTURE_MANIFEST = "docs/test-design/harness/resource-kernel-fixture-manifest.yaml";
const RGK_CONTRACT_DOC = "docs/plans/PLAN-L5-25-resource-kernel-physical-protocol.md";

/**
 * D0-R Resource Kernel の fixture 宣言と正本 manifest の突合を hard gate 検査
 * (PLAN-L5-25 §7 pair-freeze 条件、issue #149)。
 *
 * 識別子の宣言だけで「fixture を freeze した」と読ませないための配線。とくに
 * `status: planned` の entry が path を実在させていたら violation (実体の偽装検出)。
 * doc 読み取り失敗も violation (fail-close)。
 */
export function checkResourceKernelFixtureManifest(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const r = analyzeFixtureManifest({
      rows: parseL8FixtureRows(readFileSync(join(repoRoot, RGK_L8_DOC), "utf8")),
      manifest: parseFixtureManifest(readFileSync(join(repoRoot, RGK_FIXTURE_MANIFEST), "utf8")),
      contractSections: parseContractSections(
        readFileSync(join(repoRoot, RGK_CONTRACT_DOC), "utf8"),
      ),
      pathExists: (p) => existsSync(join(repoRoot, p)),
    });
    if (r.ok) {
      const counts = Object.entries(r.statusCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return {
        messages: [`resource-kernel-fixture-manifest — OK (fixture ${counts}、双方向孤児 0)`],
        ok: true,
      };
    }
    return {
      messages: [
        `resource-kernel-fixture-manifest — violation: ${fixtureManifestMessages(r).join(" / ")}`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: [
        "resource-kernel-fixture-manifest — violation: L8 表 / fixture manifest / PLAN-L5-25 を読めなかった",
      ],
      ok: false,
    };
  }
}

/**
 * D0-R の L5 物理契約 → L8 42 oracle 全数写像の双方向孤児 0 を hard gate 検査
 * (PLAN-L5-25 §7.1 pair-freeze 条件、issue #149)。
 *
 * L8 freeze 属性表と PLAN-L5-25 §7.1 写像表を突合し、片側にしか現れない ID・
 * lane 語彙逸脱・空属性を violation とする。doc 読み取り失敗も violation (fail-close)。
 */
export function checkResourceKernelPairMapping(repoRoot: string): {
  messages: string[];
  ok: boolean;
} {
  try {
    const l8Markdown = readFileSync(join(repoRoot, RGK_L8_DOC), "utf8");
    const r = analyzeResourceKernelPairMapping({
      freezeRows: parseFreezeAttributeRows(l8Markdown),
      mappingRows: parseContractMappingRows(readFileSync(join(repoRoot, RGK_CONTRACT_DOC), "utf8")),
      laneDeclarations: parseLaneDeclarations(l8Markdown),
      declaredRealRunnerTotal: parseRealRunnerTotal(l8Markdown),
    });
    if (r.ok) {
      const lanes = Object.entries(r.laneCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return {
        messages: [`resource-kernel-pair-mapping — OK (lane ${lanes}、双方向孤児 0)`],
        ok: true,
      };
    }
    return {
      messages: [
        `resource-kernel-pair-mapping — violation: ${resourceKernelPairMappingMessages(r).join(" / ")}`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: [
        "resource-kernel-pair-mapping — violation: L8 freeze 属性表 / PLAN-L5-25 §7.1 を読めなかった",
      ],
      ok: false,
    };
  }
}

/**
 * doc-consistency lint を hard gate 検査 (PLAN-L7-95、要件 §G.11 の「自動検証」配線)。
 * carry 整合 / screen-id 妥当性 / NFR 件数宣言-実数を fail-close。I/O 失敗も violation。
 */
export function checkDocConsistency(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeDocConsistency(loadDocConsistencyDocs(repoRoot));
    const bad = r.carryOrphans.length + r.screenIdOrphans.length + (r.nfrCount.mismatch ? 1 : 0);
    if (bad === 0) {
      return {
        messages: [
          `doc-consistency — OK (carry/screen-id/NFR 整合, screens=${r.definedScreenCount}, NFR=${r.nfrCount.actual})`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `doc-consistency — violation: carryOrphans=${r.carryOrphans.length}, screenIdOrphans=${r.screenIdOrphans.length}, nfrMismatch=${r.nfrCount.mismatch} (declared=${r.nfrCount.declared}/actual=${r.nfrCount.actual})`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: ["doc-consistency — violation: L1/L3/screen docs could not be read"],
      ok: false,
    };
  }
}

/**
 * entity-coverage lint を hard gate 検査 (PLAN-L7-95)。business §10.1 primary entity と
 * L3 派生 entity の重複 0 を fail-close。I/O 失敗も violation。
 */
export function checkEntityCoverage(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeEntityCoverage(loadEntityBusiness(repoRoot));
    if (r.duplicates.length === 0) {
      return {
        messages: [
          `entity-coverage — OK (primary/L3-derived entity 整合, total=${r.totalCount}, dup 0)`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `entity-coverage — violation: duplicate entity=${r.duplicates.length} (${r.duplicates.join(", ")})`,
      ],
      ok: false,
    };
  } catch {
    return { messages: ["entity-coverage — violation: business doc could not be read"], ok: false };
  }
}

/**
 * fr-registry-audit lint を hard gate 検査 (PLAN-L7-95、要件 §1.10.G.10 の「漏れ監査自動化」配線)。
 * FR-L1 registry の 5 型漏れ (登録/欠番/属性/件数/画面被覆) を fail-close。I/O 失敗も violation。
 */
export function checkFrRegistryAudit(repoRoot: string): { messages: string[]; ok: boolean } {
  try {
    const r = analyzeFrRegistry(loadFrRegistryDocs(repoRoot));
    const bad =
      r.unregistered.length +
      r.unexplainedGaps.length +
      r.attributeOrphans.length +
      r.countMismatches.length +
      r.screenCoverageOrphans.length;
    if (bad === 0) {
      return {
        messages: [
          `fr-registry-audit — OK (FR-L1 registry 5 型漏れ 0, registered=${r.totals.registered})`,
        ],
        ok: true,
      };
    }
    return {
      messages: [
        `fr-registry-audit — violation: unregistered=${r.unregistered.length}, gaps=${r.unexplainedGaps.length}, attr=${r.attributeOrphans.length}, count=${r.countMismatches.length}, screen=${r.screenCoverageOrphans.length}`,
      ],
      ok: false,
    };
  } catch {
    return {
      messages: ["fr-registry-audit — violation: L1/L3/screen docs could not be read"],
      ok: false,
    };
  }
}
