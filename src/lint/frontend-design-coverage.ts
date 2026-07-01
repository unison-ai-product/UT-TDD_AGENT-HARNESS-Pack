/**
 * frontend-design-coverage — V-model 各層 (L0-L14) の FE/UI 設計 doc カバレッジ (設計左腕) を
 * fail-close で機械検証する (document-system-map §1c を正本とする)。
 *
 * 背景: 設計左腕の FE 降下は L1 画面要求 → L2 画面設計で止まり、L3-L6 の per-layer FE 設計 doc が
 * 「未定義の穴」だった (PO 指摘 2026-06-24)。§1c がそれを per-layer に定義し、L3/L5/L6 の FE 設計 doc
 * 型を `VALID_SUB_DOCS` へ vocabulary 登録した (PLAN-L4-14)。本 gate は「§1c が現在形で謳う FE 設計
 * カバレッジ」を schema / §1c doc / 実ファイルの 3 者整合で実体担保し、definition の片肺化 (slug が
 * schema から消える / 既存 FE doc が消える / §1c から descent 鎖が消える) を absence-blindness させない。
 *
 * 右腕 (検証) の `proposal-document-coverage` (`frontend-design` routing) と対称の左腕 (設計) gate。
 *
 * 純関数 (analyzeFrontendDesignCoverage) + I/O loader (loadFrontendDesignCoverageInput) を分離
 * (lint 共通様式、architecture §3.2)。slot 登録 = body 完成ではない (coverage ≠ substance): body の
 * substance は body 起票時に確定し、本 gate は「定義 + slot の整合」までを担保する。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VALID_SUB_DOCS } from "../schema/index";

export const DOCUMENT_SYSTEM_MAP_PATH = "docs/governance/document-system-map.md";

/** §1c の per-layer FE 設計 doc カバレッジ正本 (gate が enforce する canonical 定義)。 */
export interface FeCoverageLayer {
  /** V-model 層 (`VALID_SUB_DOCS` の key)。 */
  layer: keyof typeof VALID_SUB_DOCS;
  /** その層の FE 設計 doc sub_doc slug。`VALID_SUB_DOCS[layer]` に登録済であること。 */
  slug: string;
  /** body=present の層で実在を要求する設計 doc ファイル (repo 相対)。pending は body 未起票。 */
  presentFile?: string;
  /** present = body 起票済 / pending = slot のみ (body は段階順で後続、§1c)。 */
  body: "present" | "pending";
}

/**
 * §1c FE/UI 設計 doc カバレッジ正本。document-system-map §1c の表と 1:1 同期する
 * (drift したら本 gate が fail-close するので §1c と本配列を同時更新する)。
 */
export const FE_COVERAGE_MAP: readonly FeCoverageLayer[] = [
  {
    layer: "L1",
    slug: "screen",
    presentFile: "docs/design/harness/L1-requirements/screen-requirements.md",
    body: "present",
  },
  {
    layer: "L2",
    slug: "ui-element",
    presentFile: "docs/design/harness/L2-screen/ui-element.md",
    body: "present",
  },
  {
    layer: "L3",
    slug: "screen-functional",
    presentFile: "docs/design/harness/L3-functional/screen-functional.md",
    body: "present",
  },
  {
    layer: "L4",
    slug: "ui-standard",
    presentFile: "docs/design/harness/L4-basic-design/ui-standard.md",
    body: "present",
  },
  {
    layer: "L5",
    slug: "ui-detail",
    presentFile: "docs/design/harness/L5-detailed-design/ui-detail.md",
    body: "present",
  },
  {
    layer: "L6",
    slug: "screen-spec",
    presentFile: "docs/design/harness/L6-function-design/screen-spec.md",
    body: "present",
  },
] as const;

/**
 * §1c が存在し FE descent 鎖を保持していることの marker (どれかが消えたら §1c rot)。
 * DESCENT_MARKER は §1c リライト耐性のため canonical な実装 path 字句 `src/web` を anchor にする
 * (「L7 src/web 実装」全文より prose 改稿で消えにくい。document-system-map は governance doc ゆえ
 * `src/web` の出現は §1c FE descent 定義に限られる、cross-review I-2 brittleness 緩和)。
 */
export const SECTION_MARKER = "§1c";
export const DESCENT_MARKER = "src/web";

export interface FrontendDesignCoverageInput {
  /** schema 正本 (`VALID_SUB_DOCS`)。 */
  schema: Record<string, readonly string[]>;
  /** document-system-map.md 本文 (§1c marker / slug 言及 / descent 鎖の検査用)。 */
  mapDocText: string;
  /** body=present の presentFile のうち実在するものの集合 (repo 相対)。 */
  existingPresentFiles: Set<string>;
  /** 検査対象の FE カバレッジ正本 (既定 = FE_COVERAGE_MAP)。 */
  coverage?: readonly FeCoverageLayer[];
}

export interface FrontendDesignCoverageViolation {
  kind:
    | "unregistered-slug"
    | "missing-present-doc"
    | "slug-not-in-map"
    | "missing-section"
    | "missing-descent-chain";
  layer?: string;
  detail: string;
}

export interface FrontendDesignCoverageResult {
  checkedLayers: number;
  registeredSlugs: number;
  presentBodies: number;
  pendingBodies: number;
  violations: FrontendDesignCoverageViolation[];
  ok: boolean;
}

/** §1c FE カバレッジ正本を schema / §1c doc / 実ファイルで fail-close 検証する。 */
export function analyzeFrontendDesignCoverage(
  input: FrontendDesignCoverageInput,
): FrontendDesignCoverageResult {
  const coverage = input.coverage ?? FE_COVERAGE_MAP;
  const violations: FrontendDesignCoverageViolation[] = [];
  let registeredSlugs = 0;
  let presentBodies = 0;
  let pendingBodies = 0;

  for (const entry of coverage) {
    const layerSlugs = input.schema[entry.layer] ?? [];
    if (layerSlugs.includes(entry.slug)) {
      registeredSlugs += 1;
    } else {
      violations.push({
        kind: "unregistered-slug",
        layer: entry.layer,
        detail: `${entry.layer} FE slug "${entry.slug}" が VALID_SUB_DOCS[${entry.layer}] に未登録 (3 点同期破れ)`,
      });
    }

    if (!input.mapDocText.includes(entry.slug)) {
      violations.push({
        kind: "slug-not-in-map",
        layer: entry.layer,
        detail: `${entry.layer} FE slug "${entry.slug}" が §1c (document-system-map) に記載されていない`,
      });
    }

    if (entry.body === "present") {
      presentBodies += 1;
      if (!entry.presentFile || !input.existingPresentFiles.has(entry.presentFile)) {
        violations.push({
          kind: "missing-present-doc",
          layer: entry.layer,
          detail: `${entry.layer} body=present だが設計 doc ${entry.presentFile ?? "(path 未定義)"} が実在しない`,
        });
      }
    } else {
      pendingBodies += 1;
    }
  }

  if (!input.mapDocText.includes(SECTION_MARKER)) {
    violations.push({
      kind: "missing-section",
      detail: `document-system-map に ${SECTION_MARKER} (FE/UI 設計 doc カバレッジ定義) が無い`,
    });
  }
  if (!input.mapDocText.includes(DESCENT_MARKER)) {
    violations.push({
      kind: "missing-descent-chain",
      detail: `§1c の FE descent 鎖 marker "${DESCENT_MARKER}" が消えている (descent 定義 rot)`,
    });
  }

  return {
    checkedLayers: coverage.length,
    registeredSlugs,
    presentBodies,
    pendingBodies,
    violations,
    ok: violations.length === 0,
  };
}

export function loadFrontendDesignCoverageInput(repoRoot: string): FrontendDesignCoverageInput {
  let mapDocText = "";
  try {
    mapDocText = readFileSync(join(repoRoot, DOCUMENT_SYSTEM_MAP_PATH), "utf8");
  } catch {
    // §1c doc 不在 → mapDocText 空 (marker/ slug 検査が violation 化、実 repo では存在する)
  }
  const existingPresentFiles = new Set<string>();
  for (const entry of FE_COVERAGE_MAP) {
    if (entry.body === "present" && entry.presentFile) {
      if (existsSync(join(repoRoot, entry.presentFile)))
        existingPresentFiles.add(entry.presentFile);
    }
  }
  return {
    schema: VALID_SUB_DOCS as Record<string, readonly string[]>,
    mapDocText,
    existingPresentFiles,
  };
}

export function frontendDesignCoverageMessages(r: FrontendDesignCoverageResult): string[] {
  if (r.ok) {
    return [
      `frontend-design-coverage — OK (layers ${r.checkedLayers}, registered slug ${r.registeredSlugs}, body present ${r.presentBodies} / pending ${r.pendingBodies}, §1c↔schema↔files drift 0)`,
    ];
  }
  const sample = r.violations.map((v) => `${v.kind}${v.layer ? `(${v.layer})` : ""}: ${v.detail}`);
  return [
    `frontend-design-coverage — violation ${r.violations.length} 件: ${sample.join("; ")} (§1c FE カバレッジ正本 = schema VALID_SUB_DOCS + document-system-map §1c + 実ファイルを 3 者同期せよ、PLAN-L4-14)`,
  ];
}
