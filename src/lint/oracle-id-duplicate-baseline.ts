/**
 * oracle ID の canonical 宣言 provenance 衝突 baseline (Issue #206)。
 *
 * 値は `ID\\t正規化済み宣言説明` で固定する。候補/概要表と confirmed/freeze 表の
 * 構造的な再掲は collector が列スキーマで畳み込むため、ここには載せない。一方、
 * 同一 ID の別 oracle は見出しが addendum でも折り畳まず、既知債務として明示する。
 * baseline は縮小のみ可で、新しい説明の追加は fail-close する。
 */
export const ORACLE_ID_DUPLICATE_BASELINE: ReadonlySet<string> = new Set([
  "IT-MODULE-01\tA module import graph containing expected schema-first dependency direction. | Import graph check walks public and internal module imports. | No cycle exists and schema remains one-way dependency root. | src module graph -> dependency analyzer boundary. | Cycle count 0; forbidden reverse import count 0. | Injected cycle, helper importing CLI, lint importing doctor.",
  "IT-MODULE-01\tengine-swap module graph | dependency auditを実行する | domain逆依存、barrel cycle、doctor/CLI逆importが0になる | module graph、cycle count 0",
  'U-PHOVER-002\t`buildProviderHandover` | Provider handover packages include `handover_kind: "mechanical"` so machine routing data is not confused with explicit human handover.',
  "U-PHOVER-002\t`runProviderHandover` | `.ut-tdd/handover/provider/<id>.json` + `CURRENT.json` を書く / dry-run は非書込",
]);
