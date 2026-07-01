> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# ゲート体系 (G0.5-G14) — Forward + mode 横断集約

出典: concept v3.1 §3.1 各層 gate / requirements v1.2 §2.2 Pair freeze + trace freeze / §7.8.3 requires_human_approval 承認者 / §7.8.5 横断検出

---

G8-G14 planning route (current): PLAN-L7-130-right-arm-gate-planning /
PLAN-REVERSE-130-right-arm-gate-planning. `right-arm-gate-planning` is the
doctor hard gate that prevents the G8-G14 carry from returning to an unplanned
state.

G8-WORKFLOW minimum mechanization (PLAN-L8 ascent): G8 is no longer closed by
IT-* row presence alone. A passing G8 slice requires an integration evidence
manifest, selected IT-* coverage, executable test procedures, and explicit
exit blocks for missing evidence, stale defers, or failed mandatory IT cases.
The required gate artifact is an integration evidence manifest.
The source of workflow granularity is
`docs/test-design/harness/L8-integration-test-design.md` §6 G8-WORKFLOW.

G9-WORKFLOW minimum mechanization (PLAN-L9 ascent): G9 is no longer closed by
ST-* row presence alone. A passing G9 slice requires a system evidence
manifest, selected ST-* coverage across ST-DATA / ST-ARCH / ST-FUNC / ST-ASSET
/ ST-EXT families, executable test procedures, and explicit exit blocks for
missing evidence, stale defers, or failed mandatory ST cases. The required gate
artifact is a system evidence manifest. The source of workflow granularity is
`docs/test-design/harness/L9-system-test-design.md` §6 G9-WORKFLOW.

G9 full-row evidence rule (PLAN-L9 ascent): family-spanning ST-* coverage is the
minimum shape only. A passing G9 slice also requires every designed ST-* row in
`docs/test-design/harness/L9-system-test-design.md` to appear in the system
evidence manifest as either `mandatory_st_ids` with passing coverage or
`deferred_st_ids` with an explicit non-stale defer. Missing row evidence is a
doctor-blocking gate failure.

G10-WORKFLOW minimum mechanization (PLAN-L10 ascent): G10 is no longer closed by
placeholder UX prose alone. A passing G10 slice requires a UX evidence manifest,
selected UXV-* coverage across UXV-VISUAL / UXV-TOKEN / UXV-A11Y / UXV-VRT /
UXV-REVIEW families, executable test or review procedures, and explicit exit
blocks for missing evidence, stale defers, or failed mandatory UXV cases. The
required gate artifact is a UX evidence manifest. The source of workflow
granularity is `docs/design/harness/L10-ux/visual-design.md` §6 G10-WORKFLOW.

## 1. gate 一覧表

| gate | タイミング (L 遷移) | 確認対象 | fail 時動作 |
|------|-------------------|---------|------------|
| **G0.5** | L0 → L1 | 企画書が L1 業務要求へ trace できるか + L0⇔価値検証ペアの方向 (軽量: 方向性・整合破綻のみ) | block → L0 修正 |
| **G1** | L1 完了 | 3 sub-gate 全通過: G1-content (5 sub-doc 揃い) / G1-pair (L1↔L14 OT ペア孤児 0) / G1-trace (BR/UX→画面 trace) | block → 当該 sub-gate へ戻る (fail-close、§2.2) |
| **G2** | L2 完了 | ワイヤーモック / 画面要求凍結 | block → L2 修正 |
| **G3** | L3 完了 | FR+AC ⇔ 受入テスト設計 ペア凍結 / AC 不在 → fail | block → L3 修正 |
| **G4** | L4 完了 | アーキ/ADR ⇔ 総合テスト設計 ペア凍結 | block → L4 修正 |
| **G5** | L5 完了 | D-API/D-DB/D-CONTRACT ⇔ 結合テスト設計 凍結 (API/Schema Freeze) | block → L5 修正 |
| **G6** | L6 完了 | 関数 signature + WBS ⇔ 単体テスト設計 凍結 | block → L6 修正 |
| **G7** | L7 完了 | 4 artifact trace freeze: ① 4 artifact 揃い / ② 必須 8 directed edge 全充足 / ③ coverage ≥ 80% — **3 条件いずれか欠落 → exit 1** (§2.2 R-C3 fix) | exit 1 → L7 差分修正 |
| **G8** | L8 完了 | 結合テスト品質 (概念定義、機械化は将来 PLAN) | block → L8 修正 |
| **G9** | L9 完了 | 総合テスト品質 (概念定義、機械化は将来 PLAN) | block → L9 修正 |
| **G10** | L10 完了 | UX 磨き品質 + G10-WORKFLOW evidence manifest | block → L10 修正 |
| **G11** | L11 完了 | 総合レビュー + UAT (概念定義) | block → L11 修正 |
| **G12** | L12 完了 | デプロイ + 受入テスト通過 | block → L12 修正 |
| **G13** | L13 完了 | デプロイ後検証 (概念定義) | block → L13 修正 |
| **G14** | L14 完了 | 運用検証 (概念定義) | block → L14 修正 |

注: G8-G10 は minimum workflow lint + evidence manifest で機械化済み。G11-G14 の機械検証条件はまだ概念定義に留まる。残機械化は将来の個別 PLAN で詳細設計する (§2.2 末尾)。全 Reverse は confirmed 化済 (2026-06-04) で、G8-G14 機械化 route は `right-arm-gate-planning` で PLAN 参照を維持する。G1-G7 は §2.2 段階 A/B で機械化済み (または計画済み)。

> **正規式モデル (PLAN-RECOVERY-02、2026-06-04、非破壊)**: 各 gate の V-pair は対応する検証本質を凍結/検証する — L6 単体 / L5 結合 / L4 総合 / L3 本番受入 / L2 実データ検証 / L1 運用 / **L0 価値検証 (G0.5 + L14→L0 feedback、従来ペア無しの穴埋め)**。右腕 = データ実在性エスカレーション (合成→本番→運用→価値)。番号・既存ゲートは据え置き。正本 = gate-design.md / concept §2.3 / overview §4。

---

## 2. G7 (4 artifact trace freeze) 詳細

G7 は L7 実装完了の唯一の exit gate。以下 3 条件をすべて満たすまで exit 1 で block する (§2.2 段階 B、R-C3 fix)。

| 条件 | 内容 |
|------|------|
| ① 4 artifact 揃い | ① 設計 (docs/design/) / ② 実装コード (src/) / ③ テスト設計 (docs/test-design/) / ④ テストコード (tests/) が対象スコープ分揃っていること |
| ② 必須 8 directed edge | §2.4 で定義された ① ↔ ②、① ↔ ③、② ↔ ④、③ ↔ ④ の 8 方向すべてに孤児が無いこと |
| ③ coverage ≥ 80% | `ut-tdd gate G7` が coverage 80% 以上を確認 |

詳細メカニクス: `docs/process/forward/` 各 L 定義 (将来 L07-implementation.md §4) に委譲。G7 は trace freeze の集約 entry point として機能する。

---

## 3. 人間サインオフ必須ゲート (§7.8.3)

以下のゲート/条件は **承認記録なしで当該コマンドを実行すると exit 1** (§7.8.3)。承認記録は `.ut-tdd/audit/` に append。

| 引き金 mode/条件 | 承認者 (人間サインオフ) | 備考 |
|-----------------|----------------------|------|
| **Recovery 起動** | `tl` (リオープン確認) + `po` (スコープ承認) | `recovery` mode 開始時 |
| **prod Incident** (`env=prod`) | オンコール + `tl` + `pm` の三者 | `env=prod` または `regression_prod` signal |
| **config_drift Retrofit** | `tl` 単独 (環境影響限定) | `config_drift` signal の Retrofit 起動時 |
| **L0 G0.5** (frontier-reviewer adversarial) | `frontier-reviewer` (別 runtime) | `hybrid` mode 時。`standalone`/`claude-only` 時は subagent self-review で代替 (§7.8.2) |
| **L12 リリース承認** | `po` サインオフ必須 | デプロイ + 受入完了後の本番リリース |

---

## 4. 横断検出ゲート (§7.8.5)

`ut-tdd doctor` / `ut-tdd plan lint` に束ねられる横断検出器。いずれも fail-close で該当 mode への接続を強制する。

| 検出器 | fail 条件 | 接続先 mode |
|--------|----------|------------|
| `drift-check` (schema/contract drift) | 設計↔実装のコントラクト不一致 | **Reverse** (normalization) |
| `connection-deficiency` (§7.8.7 DEP-2) | コンポーネント間接続の欠損 | **Reverse** または **Refactor** (影響範囲による) |
| `relation-graph` (DEP-1) | orphan / cycle / レイヤリング違反 | **Refactor** または **Reverse** |
| `test-perspective-gate` (TST-2) | テスト観点の抜け / レベル間重複 | 当該 L の設計層へ差し戻し (G1-G6 再通過) |
| `doc-drift` | 設計文書と実装の乖離 (drift) | **Reverse** (R0 起点) |
| `regression_dev` (開発中回帰) | テスト緑が壊れた | **Recovery** (human approval 必須) |
| `regression_prod` (本番回帰) | `env=prod` での回帰 | **Incident** (三者承認必須) |
| `debt_degradation` / `code_smell` | コード劣化検出 | **Refactor** |
| `dependency_outdated` / `upgrade` | 依存陳腐化 | **Retrofit** (upgrade preflight 必須) |

検出は `.ut-tdd/` state を参照し、`legacy DB` には依存しない (§7.8.5)。`--static-only` フラグで AI 不要の機械判定のみ実行可能。
