import { analyzeDocConsistency, loadDocConsistencyDocs } from "../lint/doc-consistency";
import { analyzeEntityCoverage, loadBusiness as loadEntityBusiness } from "../lint/entity-coverage";
import { analyzeFrRegistry, loadFrDocs as loadFrRegistryDocs } from "../lint/fr-registry-audit";

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
