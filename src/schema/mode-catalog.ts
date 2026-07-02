/**
 * PLAN-L7-243: mode (駆動モデル) の第一級化。
 *
 * 宣言正本 = PLAN frontmatter の `route_mode` (route certificate lint により
 * created>=2026-07-01 の PLAN で fail-close 必須、PLAN-L7-212/263)。
 * `route_mode` を持たない legacy PLAN は plan_id prefix → kind の順でフォールバックする。
 * plan_id prefix 4 分岐のみの旧導出 (Forward 落ち) はこの module で置換された。
 *
 * mode カタログの doc 正本は docs/process/modes/ (README 台帳 + 1 ファイル 1 mode)。
 * `MODE_CATALOG_DOC_FILES` はその機械側写像で、drive-db-registration lint が
 * doc ↔ 写像の差分を fail-close 検出する (新 mode doc 追加時の取りこぼし防止)。
 */

/** route_mode token (src/schema/route-map.ts の mode 値) → drive_runs.mode 表示値。 */
export const ROUTE_MODE_DISPLAY: Record<string, string> = {
  forward: "Forward",
  reverse: "Reverse",
  recovery: "Recovery",
  retrofit: "Retrofit",
  refactor: "Refactor",
  discovery: "Discovery",
  "design-bottomup": "Design-bottomup",
  scrum: "Scrum",
  incident: "Incident",
  "add-feature": "Add-feature",
  "version-up": "Version-up",
  research: "Research",
};

/** cutover / migration (PLAN-M-*) の工程検証 mode (docs/process/modes カタログ外)。 */
export const VERIFICATION_MODE = "Verification";

/** legacy (route_mode 無し) PLAN の kind フォールバック (modes README 台帳 §2 準拠)。 */
const KIND_FALLBACK_DISPLAY: Record<string, string> = {
  reverse: "Reverse",
  recovery: "Recovery",
  refactor: "Refactor",
  retrofit: "Retrofit",
  // 台帳 §2: kind=troubleshoot は Incident mode に内包される。
  troubleshoot: "Incident",
  // poc は Discovery / Scrum の両 mode を持つが frontmatter だけでは判別できない。
  // Discovery へ寄せる (plan_id prefix PLAN-DISCOVERY- が先に効く)。
  poc: "Discovery",
  research: "Research",
  "add-design": "Add-feature",
  "add-impl": "Add-feature",
};

export interface ModeDerivationInput {
  planId: string;
  routeMode?: string;
  kind?: string;
}

/** mode 導出: route_mode (正本) → plan_id prefix (legacy) → kind (legacy) → Forward。 */
export function workflowModeForPlan(input: ModeDerivationInput): string {
  if (input.planId.startsWith("PLAN-M-")) return VERIFICATION_MODE;
  const route = input.routeMode?.trim().toLowerCase() ?? "";
  if (route && ROUTE_MODE_DISPLAY[route]) return ROUTE_MODE_DISPLAY[route];
  if (input.planId.startsWith("PLAN-DISCOVERY-")) return "Discovery";
  if (input.planId.startsWith("PLAN-REVERSE-")) return "Reverse";
  if (input.planId.startsWith("PLAN-RECOVERY-")) return "Recovery";
  const kind = input.kind?.trim().toLowerCase() ?? "";
  if (kind && KIND_FALLBACK_DISPLAY[kind]) return KIND_FALLBACK_DISPLAY[kind];
  return "Forward";
}

/**
 * docs/process/modes/ の mode doc ファイル ↔ 表示 mode の写像 (Forward は
 * docs/process/forward/ 正本、Verification はカタログ外のため含まない)。
 */
export const MODE_CATALOG_DOC_FILES: Record<string, string> = {
  "add-feature.md": "Add-feature",
  "discovery.md": "Discovery",
  "incident.md": "Incident",
  "recovery.md": "Recovery",
  "refactor.md": "Refactor",
  "research.md": "Research",
  "retrofit.md": "Retrofit",
  "reverse.md": "Reverse",
  "scrum.md": "Scrum",
  "version-up.md": "Version-up",
};

/** カタログ doc ファイル名のうち mode 写像に無いもの (新 mode doc の取りこぼし検出)。 */
export function unmappedModeCatalogDocs(docFileNames: string[]): string[] {
  return docFileNames
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .filter((name) => !(name in MODE_CATALOG_DOC_FILES))
    .sort();
}
