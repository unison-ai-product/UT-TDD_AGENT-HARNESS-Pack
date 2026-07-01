# UT-TDD-agent-harness 要件定義書

- **Version**: 1.2
- **対応構想書**: `ut-tdd-agent-harness-concept_v3.1.md`
- **位置付け**: 要件定義 (L1-L3 受入条件層)
- **工程層体系**: v1.2 で **V2 source snapshot reference の L0-L14 + V-model を base に採用** (§1.4 / §2、構想書 v3.1 連動)
- **想定読者**: Phase 0 Bootstrap 担当 (AI 実装エージェント + TL)
- **対象 OS**:
  - Windows / macOS / Linux: ネイティブ動作を第一級対応
  - Windows: PowerShell entrypoint を提供し、Git Bash 依存を局所化する
  - macOS / Linux: POSIX shell entrypoint を提供する
  - WSL2: 任意の互換実行環境。必須条件にはしない
  - CI: `ubuntu-latest` を基準にしつつ、Windows smoke を追加する

## 本書の位置付け

本書は構想書 v3.1 に対する **要件定義 (HOW を満たす条件)** を確定する。**実装詳細 (TypeScript/Bun core / YAML 全文 / hook wrapper 本体)** は将来の個別 PLAN-XXX 詳細設計で詰める。

| 文書 | 役割 | 抽象レベル |
|------|------|------------|
| 構想書 v3.1 | 概念 / モード / 経路 / 配線 / 補助軸 / 役割 | L1 概念 |
| 本書 (要件定義書 v1.2) | 受入条件 / enum / fail-close 条件 / Phase 0 受入条件 | L1-L3 要件 |
| 個別 PLAN-XXX (将来) | validator 実装 / workflow YAML / hook script | L5 詳細設計 |

## v1.1 で TL Round 4 Critical 8 + Important 9 を fix

| # | 問題 | v1.1 fix |
|---|------|----------|
| R-C1 | S4 outcome (rejected/pivot) が frontmatter 表現不能 | §1.2 `VALID_DECISION_OUTCOMES` 専用 enum 追加、§1.1 variant に `decision_outcome` フィールド追加 |
| R-C2 | §1.1 schema 詳細が §1.10 受入条件未反映 | §1.10 にフィールド単位の機械検証条件を列挙 |
| R-C3 | G4 trace 必須が「4 方向」と「8 directed edge」で矛盾 + coverage 80% 未反映 | §2.7 で「4 artifact + 必須 8 directed edge + coverage ≥80% のいずれか欠落で exit 1」に統一 |
| R-C4 | pre-push 4 項目 fail-close vs warning 矛盾 | §5.3 で item 1-2 = fail-close / item 3-4 = warning に明示分離、§5.4 を整合 |
| R-C5 | design/research kind に branch prefix なし | §6.1 表に全 11 kind 網羅、`docs/*` / `chore/*` 等を追加 |
| R-C6 | Phase 0-A CODEOWNERS なしと §9.1 必須矛盾 | §9.1 に「Phase 0-A 必須 / 0-B 追加必須 / 自動生成」の 3 種別を列挙、CODEOWNERS は 0-B 追加扱い |
| R-C7 | failure_log.jsonl .gitignore vs 必須構造矛盾 | §9.1 で「`.ut-tdd/audit/` ディレクトリ自体が必須、`failure_log.jsonl` は生成時に作成」と明記 |
| R-C8 | テスト PR 8 subjob 全出現は branch type 別矛盾 | §10.2 で branch type 別テスト PR matrix を表化、`non-applicable` subjob は `skipped` 扱い |
| R-I1 | poc/reverse の workflow_phase 対応範囲未制約 | §1.5 に `kind=poc → S0-S4 / kind=reverse → R0-R4` 制約を fail-close 条件として追加 |
| R-I2 | drive × kind 互換性未定義 | §1.6 に kind × drive 許可 matrix を追加 |
| R-I3 | 必須 role 条件未列挙 | §1.8 に kind/drive/layer/gate 別の必須 role 表を追加 |
| R-I4 | PLAN 対象 path / 除外 path 未定義 | §1.10 で `docs/plans/PLAN-*.md` のみ対象、`archived` 除外を明記 |
| R-I5 | §2.4 #11/#12 の方向性検証定義不足 | §2.4 で ②→④ と ④→② の検証根拠を分離 (manifest / coverage map 等) |
| R-I6 | add-* diff 判定の base 揺れ | §4.1 で canonical diff rule を固定 |
| R-I7 | vmodel_validator P1-only exit code 未定義 | §7.3 で `exit 2 = P1 warning のみ` を明記 |
| R-I8 | touched PLAN 0 件時の fail-close 未定義 | §7.4 で PLAN 必須 branch type と例外 branch type を表で定義 |
| R-I9 | pre-commit config 検証コマンド未明記 | §10.1 で `pre-commit run --all-files` 等の検証コマンドを明記 |

---

# §1 PLAN frontmatter スキーマ要件

PLAN ドキュメントの YAML frontmatter は **機械検証可能な必須フィールド** + **enum 制約** で構成する。`ut-tdd plan lint` (§7.1) が CI / pre-push で fail-close 動作する。

## 1.1 必須 9 フィールド (通常 variant)

```yaml
---
plan_id: PLAN-L7-01-slug                      # §1.10 A: PLAN-<layer>-<NN>-<slug>。ID の layer は frontmatter layer と一致
title: "PLAN-L7-01: タイトル"
kind: impl                                    # §1.3 の 12 種から
layer: L7                                      # §1.4 の 16 種 (L0-L14 + cross) から。impl は L7 実装スプリント
drive: be                                     # §1.6 の専門職 5 種から
status: draft                                 # §1.2 の VALID_STATUSES から
parent_design: docs/design/<feature>/<function>.md  # §1.1.parent_design。kind=impl (L7) は必須
agent_slots:                                  # §1.8 の役割スロット
  - role: aim
    slot_label: "AIM — 実装委譲 / 3 点レビュー"
generates:                                    # 双方向 trace の起点
  - artifact_path: src/foo.ts
    artifact_type: source_module              # §1.7 の 19 種から
dependencies:                                 # 親 PLAN / 前提 PLAN / ブロック対象
  parent: PLAN-NNN-master                     # null 可
  requires: []
  blocks: []
---
```

### 1.1.parent_design (kind=impl で必須、V2 由来 / R-V1 fix)

`kind=impl` (layer=L7 実装スプリント) の PLAN は `parent_design:` フィールドを **必須** とする。値は L6 機能設計 doc (① 設計) への path で、その doc に紐づかない実装は V-model 違反 (構想書 v3.1 §3.5 AP-5)。`parent_design` が不在または存在しない path の場合、`vmodel_validator` は **exit 1** (fail-close)。design 系 kind (L0-L6) では任意。

## 1.1.poc kind=poc variant (Scrum 専用、R-C1 fix)

```yaml
---
plan_id: PLAN-DISCOVERY-NN-slug                       # 例示 (NN=仮番号)。kind=poc → token=DISCOVERY (layer=cross)
title: "..."
kind: poc                                     # 固定
layer: cross                                  # 固定
workflow_phase: S2                            # §1.5 から (S0-S4 のみ許容)
drive: fullstack                              # §1.6 専門職 5 種。poc は探索対象 work の専門職を継承 (V7)
status: draft
decision_outcome: null                        # S4 到達時のみ §1.2.2 から指定
agent_slots:
  - role: aim
    slot_label: "AIM — PoC 実装"
generates: []
dependencies:
  parent: null
  requires: []
  blocks: []
---
```

## 1.1.reverse kind=reverse variant (Reverse 専用、R-C1 fix)

```yaml
---
plan_id: PLAN-REVERSE-NN-slug                        # 例示 (NN=仮番号)。kind=reverse → token=REVERSE (layer=cross)
title: "..."
kind: reverse
layer: cross
workflow_phase: R2                            # §1.5 から (R0-R4 のみ許容)
drive: fullstack                              # §1.6 専門職 5 種。reverse は逆引き対象 work の専門職を継承 (V7)
status: draft
confirmed_reverse_type: code                  # §3.3 から (code / design / upgrade / normalization / fullback)
forward_routing: null                         # R4 到達時のみ §3.4 から指定
promotion_strategy: null                      # R4 到達時のみ §3.4 から指定
agent_slots:
  - role: tl
    slot_label: "TL — Reverse 主導"
generates: []
dependencies:
  parent: null
  requires: []
  blocks: []
---
```

## 1.1 排他制約 (validator が fail-close)

- `kind in [poc, reverse, recovery]` (横断駆動) → `layer` は `cross` のみ許可
  - うち `kind in [poc, reverse]` → `workflow_phase` 必須 / `kind=recovery` → `workflow_phase` 禁止 (phase を持たない)
- `kind not in [poc, reverse, recovery]` → 実 `layer` 必須 (cross 不可)、`workflow_phase` 禁止
- `kind=poc` → `workflow_phase ∈ {S0,S1,S2,S3,S4}` のみ許可 (R-I1 fix)
- `kind=reverse` → `workflow_phase ∈ {R0,R1,R2,R3,R4}` のみ許可 (R-I1 fix)
- `kind=poc + workflow_phase=S4` → `decision_outcome` 必須 (R-C1 fix)
- `kind=reverse + workflow_phase=R4` → `forward_routing` 必須
- `kind=reverse + workflow_phase=R4` → `promotion_strategy` 必須
- `kind=reverse` の起点は `decision_outcome=confirmed` の poc PLAN のみ許可。`rejected` / `pivot` から reverse へ接続する参照は exit 1

## 1.2 VALID_STATUSES (4 種)

| status | 意味 |
|--------|------|
| `draft` | 起票直後、未承認 |
| `confirmed` | TL 承認済み、実装/設計着手可 |
| `completed` | 工程完了、参照のみ |
| `archived` | 非アクティブ化、将来参照のみ |

## 1.2.2 VALID_DECISION_OUTCOMES (S4 outcome 専用、R-C1 fix)

`kind=poc` の `workflow_phase=S4` 到達時に必須。

| decision_outcome | 意味 | 後続経路 |
|------------------|------|----------|
| `confirmed` | 仮説検証成功、本実装へ昇格 | Reverse R0 へ接続 (`reverse` kind PLAN を新規起票) |
| `rejected` | 仮説却下、本実装しない | PLAN を `status=archived` に遷移 |
| `pivot` | 仮説修正、別方向で再検証 | 新規 `poc` kind PLAN を起票 (旧 PLAN は `archived`) |

## 1.3 VALID_KINDS (12 種)

| kind | 用途 | 主な layer | 経路 |
|------|------|------------|------|
| `charter` | 企画書起票 (背景 / 目的 / スコープ の高レベル feed-forward。ROI / KGI・KPI 等の定量指標は強制せず L1+ で定義) | L0 | 経路 1 前段 |
| `design` | 設計 / 定義 doc 起票 (業務要求 / 要件 FR+AC / D-API / D-DB / D-CONTRACT 等) | L1-L6 | 経路 1 |
| `impl` | 機能実装 (L7 Sprint) | L7 | 経路 1 |
| `poc` | 仮説検証 (Scrum S0-S4) | cross | 経路 2 |
| `reverse` | 設計復元 (Reverse R0-R4) | cross | 経路 2 |
| `add-design` | 既存設計への追補 | L3-L6 | 経路 3 |
| `add-impl` | 既存実装への機能追加 | L7 | 経路 3 |
| `refactor` | 機能変更なし内部改善 | L7 | 補助 |
| `retrofit` | 既存規約への合わせ込み | L7 | 補助 |
| `recovery` | session 断絶・認識ずれからの再開 | cross | 補助 1 |
| `troubleshoot` | バグ解析・障害対応 | L7 | 補助 1 |
| `research` | 技術調査 doc | L1-L4 | 経路 1 前段 |

> **主な layer 列**は §1.4 L0-L14 scheme に準拠 (旧 v1.1 番号から remap 済)。実装系 kind (impl / add-impl / refactor / retrofit / troubleshoot) は **L7 実装スプリント**。`charter` は L0 企画専用で、G0.5 企画突合 (§2.1.1) を経て `design` kind の L1 業務要求へ接続する。

## 1.4 VALID_LAYERS (16 種 = V2 L0-L14 + cross、v1.2 で L0-L14 + V-model 採用)

v1.2 で **V2 source snapshot reference の L0-L14 + V-model** を base に採用。左 (設計 L0-L6) で書いた設計には同層で ③ テスト設計を対に凍結し、右 (検証 L8-L14) の対応工程で ④ テストコードを実施する。旧 L0-L11+小数層は本表に remap した (構想書 v3.1 §3 連動)。

| layer | 名称 | ① 設計 / ③ テスト設計ペア (V-model) | 旧 v1.1 layer からの remap |
|-------|------|--------------------------------------|----------------------------|
| `L0` | 企画 | 企画書 (G0.5 企画突合) | 旧 L0 基盤整備は Phase 0 (§10) へ分離 |
| `L1` | 要求定義 (業務要求 BR-*/NFR-*) | ① 業務要求 / ③ 運用テスト設計 (→L14 実施) | 旧 L1 (業務要求部分) |
| `L2` | 画面設計 (L1 のフェーズ分離) | ① ワイヤーモック (mock がペア →L10、検証本質=実データ検証) | (新規) |
| `L3` | 要件定義 (FR-*/AC-*、BR から trace) | ① 要件 / ③ 受入テスト設計 (→L12 実施) | 旧 L1 (FR+AC 部分) |
| `L4` | 基本設計 (外部設計) | ① アーキ/ADR / ③ 総合テスト設計 (→L9 実施) | 旧 L2 全体設計 |
| `L5` | 詳細設計 (内部設計) | ① D-API/D-DB/D-CONTRACT / ③ 結合テスト設計 (→L8 実施) | 旧 L3 詳細設計 |
| `L6` | 機能設計 | ① 関数 schema/エッジケース+WBS / ③ 単体テスト設計 (→L7 実施) | 旧 L3.5 機能設計 |
| `L7` | 実装スプリント | ② 実装コード / ④ テストコード (TDD Red 内包、旧 L3.8 統合) | 旧 L3.8 + L4 + L4.5 |
| `L8` | 結合テスト | ④ L5 結合テスト設計の実施 | 旧 L6 (一部) |
| `L9` | 総合テスト | ④ L4 総合テスト設計の実施 | 旧 L6 (一部) |
| `L10` | UX 磨き | L2 mock の本 UX 昇格 | 旧 L5 Visual Refinement |
| `L11` | 総合レビュー + UAT | 要件 ↔ 実装/テストの全体突合 + 要件巻き取り | 旧 L8 受入 (一部) |
| `L12` | デプロイ + 受入 | ④ L3 受入テスト設計の実施 | 旧 L7 デプロイ + L8 受入 |
| `L13` | デプロイ後検証 | 実環境 smoke / 運用立ち上げ | 旧 L9 デプロイ検証 |
| `L14` | 運用検証 + 改善 | ④ L1 運用テスト設計の実施 + 次サイクル feedback | 旧 L10 観測 + L11 運用学習 |
| `cross` | 横断 PLAN (workflow_phase 使用時必須) | — | (据置) |

> **破壊的変更注記**: 小数層 `L3.5` / `L3.8` / `L4.5` は廃止し L6 / L7 へ統合した。既存 PLAN の旧 layer 値は本 remap 表で読み替える。validator は移行期間中、旧 layer 値を含む PLAN を `status: archived` または `is_reference: true` で lint 除外できる (§1.10 / §10 で段階適用)。

> **正規式モデル (PLAN-RECOVERY-02、2026-06-04 PO 確定。非破壊 = 番号・既存 V-pair 据え置きの追加・明確化)**: 上記 L0-L14 の各 V-pair に **検証本質** を与える。
> - **L0 企画 ⇔ 価値検証** (事業目的・価値の実現を L14→L0 feedback で検証) — 従来 L0 はペア無しだった穴を埋める。
> - **谷 = 3 点合算 (最小単位)**: L7 実装は **L6 機能設計 ① + 単体テスト設計 ③** の 2 点を見て、単体テストを先に具体化 (TDD red) → コード ② を実装する。単体テストの居場所は谷 (L6⇔L7) であり独立層ではない。
> - **右腕 = データ実在性エスカレーション** (右腕工程順 L8→L14 に従う): 合成/テストデータ (L6 単体 / L5 結合 → L8 / L4 総合 → L9) → 本番実データ (**L2 実データ検証 = 画面 → L10** が先、**L3 本番受入 = 要件 → L12** が後) → L1 運用 → L14 (実データ×時間) → L0 価値 (実成果)。
> - **L2 画面 = L1 のフェーズ分離**: 画面要求 → 要求/要件 (L1→L3 上流)、画面詳細 → L5 詳細設計に分配。L2 は純粋独立ペアでなく検証本質は実データ検証。
> 詳細・全表は `concept_v3.1.md §2.3` / `docs/process/forward/overview.md §4`。

## 1.5 VALID_WORKFLOW_PHASES (10 種、Scrum / Reverse 専用)

| workflow_phase | 対応 kind | フェーズ |
|---------------|----------|----------|
| `S0` | poc | Backlog 構築 |
| `S1` | poc | Sprint Plan |
| `S2` | poc | PoC 実装 (`verify/*.sh` 化) |
| `S3` | poc | Verify (回帰蓄積) |
| `S4` | poc | Decide (decision_outcome 必須) |
| `R0` | reverse | Evidence Acquisition |
| `R1` | reverse | Observed Contracts (§3.3 で reverse_type 別 skip 判定) |
| `R2` | reverse | As-Is Design |
| `R3` | reverse | Intent Hypotheses (**po 検証**) |
| `R4` | reverse | Gap & Routing (forward_routing 必須) |

validator は `(kind, workflow_phase)` ペアが本表に存在しなければ fail-close。

## 1.6 VALID_DRIVES (5 種 = 専門職) + kind × drive 互換性 matrix (R-I2 fix / V7 再設計)

> **V7 再設計 (PLAN-DISCOVERY-04 V7 → PLAN-REVERSE-01 R3、PO 確定 2026-06-02)**: drive = **「その PLAN にどの専門職 (specialist) / 専門エージェントを招集するか」**(owner_role / mandatory_agents / orchestration_mode を決める、§2.6.4)。旧 9 種は専門職 (be/fe/fullstack/db/agent) と **mode/状況値 (scrum/reverse/poc/troubleshoot) を混在**させ、駆動モデル (mode、構想書 §2.5) と**命名衝突**していた (例: `scrum=仮説検証` は誤り。仮説検証は Discovery)。mode 値を drive から除去し**専門職 5 種**に絞る。入口パターンは駆動モデル (mode) が、招集専門職は drive が担う。

### 5 種 (専門職)

| drive | 専門職 | L10 (UX 磨き) 要否 |
|-------|------|----------------------------|
| `be` | バックエンド / API / ロジック中心 | UI 変更時のみ |
| `fe` | UI / モック駆動 | **常に必要** |
| `fullstack` | BE + FE 同時 (Twin Track) | **常に必要** |
| `db` | スキーマ / データモデル中心 | UI 変更時のみ |
| `agent` | AI エージェント / プロンプト設計 | **常に必要** (会話 UI) |

> 削除した旧値: `scrum` / `reverse` / `poc` / `troubleshoot` (= 駆動モデル/状況。drive でない)。

### kind × drive 許可 matrix (R-I2 fix / V7)

**全 12 kind とも drive = 専門職 5 種のいずれか**。横断駆動 kind (poc/reverse/recovery) と troubleshoot は「**対象 work の専門職を継承**」する (探索/逆引き/復旧/障害対象が何の専門領域か)。

| kind | 許可 drive |
|------|-----------|
| `charter` | `be / fe / fullstack / db / agent` (企画段階で想定する drive を宣言) |
| `design` | `be / fe / fullstack / db / agent` |
| `impl` | `be / fe / fullstack / db / agent` |
| `poc` | `be / fe / fullstack / db / agent` (探索対象 work の専門職) |
| `reverse` | `be / fe / fullstack / db / agent` (逆引き対象 work の専門職) |
| `add-design` | `be / fe / fullstack / db / agent` (親 PLAN と一致必須) |
| `add-impl` | `be / fe / fullstack / db / agent` (親 PLAN と一致必須) |
| `refactor` | `be / fe / fullstack / db / agent` |
| `retrofit` | `be / fe / fullstack / db / agent` |
| `recovery` | `be / fe / fullstack / db / agent` (復旧対象 work の専門職。例: PLAN-RECOVERY-01=fullstack) |
| `troubleshoot` | `be / fe / fullstack / db / agent` (障害対象 work の専門職) |
| `research` | `be / fe / fullstack / db / agent` |

validator は本表で組み合わせ違反を fail-close。**機械強制の実態 (2026-06-22 に doc↔impl drift 是正)**:
本 matrix は全 12 kind × 全 5 drive を許容する (禁止セル無し) ため、`driveSchema` (`src/schema/index.ts`
の `z.enum(VALID_DRIVES)` = 専門職 5 種) が「drive ∈ 専門職」を fail-close するだけで matrix のセル制約は
網羅される。表中の唯一の非自明制約「**add-design/add-impl の drive は親 PLAN と一致必須**」は
`analyzePlanGovernance` (`src/plan/lint.ts`) の `parent_drive_mismatch` が既に fail-close 強制している
(親 drive=fullstack は包摂ゆえ許容)。したがって kind × drive matrix は「将来実装」でなく**現状で機械強制済**
(driveSchema + parent_drive_mismatch)。「駆動モデル (kind、§2.5) と専門職 (drive) の軸分離」も完了済
(VALID_DRIVES から旧 mode 値 scrum/reverse/poc/troubleshoot を除去、PLAN-DISCOVERY-04 V7)。

## 1.7 VALID_ARTIFACT_TYPES (19 種、test_design / test_code 分離済)

| artifact_type | 用途 | V-model |
|---------------|------|---------|
| `design_doc` | 設計ドキュメント | ① |
| `adr_snapshot` | ADR 凍結スナップショット | ① |
| `skill_doc` | UT-TDD 正本化済み skill doc (`docs/skills/*.md`) | — |
| `markdown_doc` | 一般 markdown ドキュメント | — |
| `doc_update` | 既存 doc の更新 | — |
| `source_module` | ソースモジュール (harness core は TypeScript、対象リポジトリは言語非依存。旧 `python_module` を改名、ADR-001) | ② |
| `script` | Bash / PowerShell スクリプト。Windows 配布で必要な `.ps1` shim は提供対象 | ② |
| `cli_extension` | CLI コマンド拡張 | ② |
| `template` | テンプレートファイル | — |
| `test_design` | **テスト設計ドキュメント** | **③** |
| `test_code` | **テストコード** | **④** |
| `hook` | Git / CI hook | — |
| `schema_migration` | DB スキーママイグレーション | ② |
| `config` | 設定ファイル (汎用) | — |
| `yaml_config` | YAML 設定 | — |
| `json_config` | JSON 設定 | — |
| `workflow_config` | GitHub Actions workflow / harness YAML の設定 | — |
| `github_config` | GitHub 関連設定 (CODEOWNERS / PR template 等) | — |
| `other` | 上記に該当しないもの | — |

> **artifact_path × artifact_type 整合ルール (PLAN-DISCOVERY-04 V12)**: `generates[].artifact_path` が **`docs/design/` 配下なら `artifact_type=design_doc`** (① 設計、§2.1)、**`docs/test-design/` 配下なら `test_design`** (③)、`docs/plans/` への自己参照 (master hub 等) は `markdown_doc`。validator は `plan-governance` の `artifact_type_mismatch` で path→type 不整合を fail-close する。kind=design (L1-L6) の child PLAN は設計成果物を `design_doc` で宣言する (`markdown_doc` は hub 自己参照専用)。

## 1.8 VALID_ROLES (7 種) + 必須 role 条件 (R-I3 fix)

### 7 種

| role | 主担当 |
|------|--------|
| `po` | 発注元 — 受入条件・R3 Intent 検証・リリース承認 |
| `tl` | 技術責任者 — 仕様化 (L3 FR+AC) / アーキ (L4-L6) / G0.5-G6 ゲート |
| `qa` | 品質責任者 — テスト戦略 / G8-G9 ゲート (L8 結合・L9 総合) |
| `aim` | AI実装・保守 |
| `uiux` | UI/UX デザイン |
| `se` | 実装委譲先 — Codex / Claude Code |
| `docs` | ドキュメント担当 |

### kind × layer × drive 別の必須 role (R-I3 fix)

validator は以下条件を fail-close 検証:

| 条件 | 必須 role |
|------|-----------|
| `kind=charter` または `layer=L0` (企画) | **`po` 必須** (+ G0.5 で `frontier-reviewer` review、§2.1.1) |
| `kind in [design, impl, add-design, add-impl]` の任意 PLAN | **`tl` 必須** |
| `kind=impl / add-impl` の L7 PLAN | **`qa` 追加必須** |
| `kind=poc / recovery / troubleshoot` の任意 PLAN | **`aim` 必須** |
| `drive in [fe, fullstack, agent]` かつ `layer in [L2, L10]` (画面設計 / UX) | **`uiux` 必須** |
| `layer in [L1`(要求), `L3`(要件 AC), `L11`(UAT), `L12`(受入)`]` | **`po` 必須** |
| `kind=reverse + workflow_phase=R3`(Intent 検証) | **`po` 必須** |
| `kind=recovery` | **`aim` 必須** (本文 7 セクションのため) |
| `kind=research` | **`tl` 必須** (技術調査・方式比較・ADR 判断、§2.5 Research owner) |

`se` と `docs` は任意 role (実装委譲・ドキュメント担当を slot に立てる場合のみ)。

## 1.9 dependencies スキーマ

```yaml
dependencies:
  parent: PLAN-NNN-master | null              # Master Plan 親 (任意)
  requires:                                   # 前提完了 PLAN リスト (status=completed 必須)
    - PLAN-MMM-slug
  blocks:                                     # ブロックされる後段 PLAN
    - PLAN-LLL-slug
  references:                                 # (任意) 参照のみ
    - PLAN-KKK-slug
```

validator は `requires` の各 PLAN の `status=completed` を機械検証。

## 1.10 受入条件 (frontmatter スキーマ、R-C2 / R-I4 / R-P1 fix)

### 対象 path (R-I4 fix)

- 対象: `docs/plans/PLAN-*.md` glob のみ
- 除外: PLAN frontmatter で `status: archived` のもの
- 例外 path (lint 対象外): `docs/plans/archive/`, `docs/plans/_template/`

### 機械検証条件 (R-C2 fix)

#### A. plan_id (phase-aware。旧 `PLAN-NNN` フラット連番から変更)

- [ ] 形式が `^PLAN-(L(?:[0-9]|1[0-4])|DISCOVERY|REVERSE|RECOVERY|M)-\d{2,}(-[a-z0-9-]+)?$` に一致 (`ut-tdd plan lint` で正規表現検証)
  - 構造 `PLAN-<token>-<NN>-<slug>`: **token** = ① Forward 工程 `L0`〜`L14` (該当工程、token↔`layer` 一致) / ② **横断駆動モデル** `DISCOVERY`(kind=poc) / `REVERSE`(kind=reverse) / `RECOVERY`(kind=recovery) (token↔`kind` 一致、`layer=cross`) / ③ `M` (master plan)、**NN** = token 内 2 桁以上連番 (99 到達後は 100+ も許容、`\d{2,}`)、**slug** = kebab。
  - 例: `PLAN-L1-01-business-requirements` / `PLAN-L7-02-plan-lint` / `PLAN-DISCOVERY-01-workflow-metamodel` / `PLAN-RECOVERY-01-internal-asset`。
  - 狙い: **ID 単体で 工程 (L0-L14) または 駆動モデル (Discovery/Reverse/Recovery) が判別でき、phase ↔ PLAN のマッピングが容易**。旧 `X`(cross) は駆動モデルを潰し ID から読めなかったため駆動モデル名トークンへ置換 (option 1、PO 2026-06-01)。archived の旧 flat `PLAN-001..004` とは別名前空間で衝突しない。
  - **mode legibility の射程 (DISCOVERY-04 監査で明文化、2026-06-02)**: ID で mode が読めるのは **横断駆動 (layer=cross) の 3 種 = Discovery/Reverse/Recovery のみ**。これらは実 layer を持たないため駆動モデル名 token で legible 化した (PO 原則「駆動を ID で読む」の対象)。一方 **layer を持つ mode (Refactor/Retrofit=L7 / Add-feature=L3-L7 / Research=L1-L4 / Incident の troubleshoot 部=L7) は layer token を使い、mode 識別は `kind` frontmatter で行う** (ID では保証しない)。これは「横断駆動=mode token / layer-bound=layer token + kind 識別」という意図的設計であり欠陥ではない。**Scrum は kind=poc で Discovery と同一名前空間 (token=DISCOVERY)**、両者は mode (入口) で識別し frontmatter では区別しない (`scrum_type` は §3.2 の 6 仮説タイプであり Discovery/Scrum を区別する軸ではない — 両 mode に共通)。Discovery/Scrum の区別が機械的に必要になった場合は別フィールド (例 `poc_mode`) の新設を要するが、現状は入口識別で足りる (PO 判断保留)。全 mode を ID-legible 化する token 拡張も別途 PO 判断 (現状は本設計で確定)。
- [ ] **ID token が frontmatter と一致** — Forward 工程 (`L0`〜`L14`) は token↔`layer` 一致 / 横断駆動 (`DISCOVERY`/`REVERSE`/`RECOVERY`) は token↔`kind` 一致 (かつ `layer=cross`) / `M`=master (master hub は複数 layer を束ねるため `layer` 自由、token↔layer 検証は対象外)。不一致 → exit 1。
- [ ] リポジトリ内で plan_id がユニーク (重複検出 → exit 1)

#### B. enum 検証

- [ ] `kind` ∈ §1.3 VALID_KINDS (12 種) — 違反 → exit 1
- [ ] `layer` ∈ §1.4 VALID_LAYERS (16 種、`cross` 含む) — 違反 → exit 1
- [ ] `drive` ∈ §1.6 VALID_DRIVES (5 種、専門職) — 違反 → exit 1
- [ ] `status` ∈ §1.2 VALID_STATUSES (4 種) — 違反 → exit 1
- [ ] `workflow_phase` ∈ §1.5 VALID_WORKFLOW_PHASES (使用時のみ、10 種) — 違反 → exit 1
- [ ] `decision_outcome` ∈ §1.2.2 VALID_DECISION_OUTCOMES (kind=poc + workflow_phase=S4 のみ、3 種) — 違反 → exit 1
- [ ] `generates[].artifact_type` ∈ §1.7 VALID_ARTIFACT_TYPES (19 種) — 違反 → exit 1
- [ ] `agent_slots[].role` ∈ §1.8 VALID_ROLES (7 種) — 違反 → exit 1

#### C. 排他制約

- [ ] §1.1 排他制約のすべてに合致
- [ ] §1.5 `(kind, workflow_phase)` ペアが許可表に存在
- [ ] §1.6 `(kind, drive)` ペアが kind × drive 許可 matrix に存在 (R-I2)
- [ ] `kind=add-*` の場合、`drive` が親 PLAN の `drive` と一致
- [ ] 2026-06-23 以降の新規/更新 PLAN は authoring `kind` と `layer` を一致させる。
      `kind=design` は `L1`-`L6`、`kind=add-design` は `L3`-`L6`、`kind=impl/add-impl/refactor/retrofit/troubleshoot` は `L7`、
      `kind=research` は `L1`-`L4` のみ許可する (`master_hub=true` は複数 layer を束ねる hub として例外)。
      欠落時は `plan-governance` の `kind_layer_mismatch` で fail-close する。

#### D. 必須 role

- [ ] §1.8 の必須 role 条件をすべて満たす (kind/layer/drive/gate ごとの必須 role が agent_slots に存在)
- [ ] 2026-06-23 以降の新規/更新 PLAN は、`kind=poc/recovery/troubleshoot` なら `agent_slots[].role=aim`、
      `kind=reverse + workflow_phase=R3` なら `agent_slots[].role=po` を持つ。欠落時は
      `plan-governance` の `missing_required_agent_role` で fail-closeする。

#### E. dependencies

- [ ] `dependencies.requires` の各 PLAN が `status=completed` (未完了 PLAN を requires に持つ → exit 1)
- [ ] `dependencies.parent` が存在する場合、当該 PLAN が repo 内に存在
- [ ] `kind=add-*` の場合、`dependencies.parent` が必須 (null 不可)

#### E2. back-fill pairing 完全性 (駆動モデル整理 / IMP-051、`ut-tdd doctor` checkBackfill)

> 駆動モデルは「設計ドキュメントまで戻す」までが 1 サイクル。bottom-up build した impl を上位設計/governance へ Reverse 合流させ、§6 用語更新を L0 §10 用語集へ back-merge する完全性を機械検証する。要否マトリクスの正本 = `src/lint/backfill-pairing.ts` `KIND_BACKFILL`。

- [ ] **`kind=add-impl` (back-fill required) は、`kind=reverse` PLAN の `dependencies.requires` から参照される** (Reverse 合流の pairing)。参照無し = 「Reverse 無き impl」→ doctor hard violation (fail-close)。
- [ ] 2026-06-23 以降の新規/更新 **`kind=add-impl` は、対応する `kind=reverse` PLAN を自身の `dependencies.requires` にも列挙する**
      (L7→Reverse と Reverse→L7 の双方向 pairing)。片方向のみの場合は `backfill-pairing` の
      `reverseLinkMissing` で fail-close する。
- [ ] **`kind` が `refactor`/`retrofit`/`troubleshoot` (conditional)** は契約/挙動変更時に Reverse 要 (doctor note、人間判断)。`impl`/`design`/`add-design`/`poc`/`reverse`/`recovery` は back-fill 不要。
- [ ] **`kind=refactor` の Green 条件** は before/after behavior 一致、regression exit_code=0、linked regression `test_id` 1 件以上、relation-graph impact closure、review after green を満たすこと。`harness.db` の `findings` / `quality_signals` / `feedback_events` / `impact_results` / `artifact_progress` は Refactor 発火元として扱えるが、DB は projection であり PLAN/doc/source の正本を直接置換しない。
- [ ] **TDD型駆動モデル分類**: Forward design / Add-feature / Refactor / Reverse / Retrofit / Recovery / Incident / screen-design / frontend-design は TDD型 strong、Discovery / Scrum は hypothesis/increment 検証として partial、Research は decision evidence 型として weak とする。Red 発火点は `findings` / `quality_signals` / `feedback_events` / `graph_nodes` / `dependency_edges` / `impact_results` / `artifact_progress` の projection から生成できるが、発火結果は PLAN 入力または workflow signal であり、DB が authored source を直接更新してはならない。
- [ ] 既存 conditional back-fill debt の allowlist は
      `docs/governance/conditional-backfill-decision-audit-2026-06-22.md` の Legacy Debt 表と完全一致する。
      片側だけに存在する場合は `backfill-pairing` の `legacyAuditGaps` で fail-close する。
- [ ] **全 PLAN の `§6 用語更新` で宣言した語が L0 §10 用語集 (`concept_v3.1.md`) に存在** (living glossary back-merge、§G.9 と連動)。未 merge → doctor hard violation。
- 機構: `ut-tdd doctor` の `backfill` 行が `reverseOrphans` / `reverseLinkMissing` / `legacyAuditGaps` /
  `glossaryGaps` / `conditionalPending` / `conditionalDecisionMissing` を surface し、hard violation は
  doctor exit code に連動する。

#### E3. 全プログラム被覆 (program coverage / PLAN-RECOVERY-04、`ut-tdd doctor` program-coverage)

> 工程表 (roadmap) = forward 全プログラムを被覆する**人間向け進行台帳** (concept §10.2)。「実装がどこまで進んだか」を機械が answerable にするため (柱3 state DB 完全性)、forward の各バンド (upstream L0-L3 / design L4-L6 / impl L7 / verification L8-L14 + cutover) に対応する登録工程表があるかを doctor が検証する。バンド定義の正本 = `src/lint/roadmap-registry.ts` `PROGRAM_BANDS` (単一正本 + 直書き根拠コメント)。

- [ ] **forward 各バンドに登録工程表 (frontmatter `roadmap:` ブロックを持つ master PLAN) が存在**する。未登録バンド = 「実装どこまで?」の残り frontier として doctor hard violation (fail-close)。
- [ ] **forward 未降下のバンド (登録対象 PLAN 皆無) は明示 defer (park 宣言 + reason) で uncovered から除外**する (明示 defer = under-design でない、concept §3.1.3.1 / §G.13)。park 宣言なしの放置 uncovered とは機械的に区別する (silent truncation 禁止 = parked バンドも reason 付きで surface)。
- 機構: `ut-tdd doctor` の `program-coverage —` 行が covered / uncovered (= frontier) を surface。`analyzeProgramCoverage` (`src/lint/roadmap-registry.ts`) が判定。`parkedBandIds` 配線 (park 宣言の単一正本化 + doctor 連動) は **PLAN-REVERSE-44 Step 3 (schema 拡張) で実装予定 (carry)**。lint engine 実装時に exit code 連動 (fail-close) へ昇格予定。

#### F. enum source-of-truth と drift 検知 (R-P1 fix)

- **正本**: 本書 §1 の各 enum 表が正本。
- **validator 同期方針**: VALID_* は `src/schema/*.ts` の **zod enum/literal を単一正本**として定義し本書 §1 表と整合させる (型推論 + 実行時検証を 1 本化、enum drift を型で抑止)。drift 検知のため schema 冒頭に「最終同期: requirements vM.N §1.X」コメントを必須化、`ut-tdd doctor` が本書の更新日と schema のコメントを比較し 30 日以上乖離なら warning。
- **将来移行**: 将来的に enum を YAML schema ファイル (`docs/governance/schema/frontmatter-schema.yaml`) に切り出して両者が読み込む構造にする (個別 PLAN-XXX で詳細設計)。

#### G. L 別 sub-doc 構造 (v1.2 で V2 source snapshot reference を UT-TDD 正本へ再定義、構想書 §3.1.2.1 / §3.1.3.1)

V2 source snapshot reference の設計概念では L1-L6 設計層が sub-doc 分割を持つ。UT-TDD ではこれを正本要件として再定義する。`kind=design` の PLAN は単一 sub-doc を generates し、複数関心を 1 PLAN に混在させない (構想書 §3.5 AP-11/AP-12)。

##### G.1 sub-doc 種別 enum

```text
VALID_SUB_DOCS = {
  L1: ["business", "functional", "screen", "technical", "nfr"],                          # 5 種
  L2: ["screen-list", "screen-flow", "wireframe", "ui-element"],                          # 4 種
  L3: ["business", "functional", "nfr", "screen-functional"],                             # 3 コア + 1 FE (screen-functional = 画面/UI 機能要件、② プロダクト選択 UI 有時)
  L4: ["data", "architecture", "function", "external-if", "ui-standard",
       "report", "batch", "notification", "code-value"],                                  # 4 コア + 5 標準成果物 (screen は L2 専用層が持つ。ui-standard = FE 設計標準 = data の FE 対)
  L5: ["internal-processing", "module-decomposition", "physical-data", "if-detail",
       "ui-detail"],                                                                      # 4 コア + 1 FE (ui-detail = FE 内部設計 component/state/routing、② プロダクト選択 UI 有時)
  L6: ["function-spec", "class-design", "edge-case", "screen-spec"],                       # 3 コア + 1 FE (screen-spec = per-screen 機能設計、② プロダクト選択 UI 有時)
}
```

> **正本同期 (IMP-141 解消、2026-06-22)**: 上表は `src/schema/index.ts` の `VALID_SUB_DOCS` (line 50、正本) を mirror する従属物。L3 は slug `business`/`functional`/`nfr` (実 PLAN `PLAN-L3-01〜03` が使用)、L4 は `screen` を含まない (画面は L2 画面専用層が持つ)。本表と schema の drift は `ut-tdd doctor` (`sub-doc-catalog-drift` gate) が fail-close で照合する (silent fix 禁止、errata は双方向に保つ)。

PLAN ID 命名は `PLAN-L<N>-<NN>-<sub-doc-slug>` (例: `PLAN-L1-03-screen-requirements`、`PLAN-L4-02-function`)。NN は layer × sub-doc を跨いだ通し連番 (sub-doc が決まれば slug で識別可)。

> **L4 標準成果物カタログ拡張 (2026-06-22、`report`/`batch`/`notification`/`code-value`)**: L4 基本設計 = 外部設計。[document-system-map.md](./document-system-map.md) §1 が業界標準 (IPA 共通フレーム 2013) で grounding する外部設計成果物は「**画面 / 帳票 / IF / データ / 業務処理**」。画面は L2 (画面専用層) が持つため、残る標準成果物 = `report` (帳票)・`batch` (バッチ)・`notification` (メール/通知)・`code-value` (コード値一覧) を L4 へ追加し SI 標準成果物カタログを完成させる。これらは §G.13 の「**② プロダクト選択**」(当該成果物を産出する製品のみ起票。CLI/BE-only 等の不産出製品は `skip_sub_doc[].reason` で省略) であり、製品非依存の ① 必須ではない。当初「downstream プロダクト形状確定後」と carry されていたが、標準成果物は業界標準で確定済 = 自己スコープ (harness 自身が帳票を持たない) を理由にした先送りは [[judge-tooling-by-mission-not-self-scope]] に反するため本拡張で解消 (PO 指示 2026-06-22「カタログ拡張の完遂」)。正本は `src/schema/index.ts` の `VALID_SUB_DOCS` (本表は §正本同期方針に従いそれを mirror)。

> **L4 FE 設計標準 `ui-standard` 追加 (2026-06-24、PLAN-L4-14)**: 外部設計成果物「画面」は L2 (画面一覧/遷移/UI 要素/wireframe = 画面の棚卸し) が持つが、**再利用 FE 設計標準 (UI 設計標準 + UI 部品カタログ + design tokens=色)** の降下先が L4 に無かった = 「部品/色がどこに降りるか未定義」の穴 (PO 指摘 2026-06-24)。業界標準 (Nablarch 方式設計/開発標準/設計標準 = `UI標準(画面)` + `UI部品カタログ` + `共通コンポーネント設計標準`、`DB設計標準` と同階層) では FE 設計標準は方式設計 (= 当方 L4) に降りる。よって `data` (DB 設計標準) の FE 対応物として `ui-standard` を L4 へ追加する。区分 = 「**② プロダクト選択 (UI 有時)**」(BE-only/no-UI は `skip_sub_doc[].reason` で省略)。L10 (UX 磨き) は `V_MODEL_PAIRS` L2↔L10 のとおり impl **後**の検証ペアであり、impl 前に要る FE 設計標準の降下先ではない (document-system-map §1 L10 行 = 「FE デザイン確定 / UX 検証 WCAG」)。正本は `src/schema/index.ts` の `VALID_SUB_DOCS`。

> **FE/UI 設計 doc カタログ vocabulary 登録 (2026-06-25、PLAN-L4-14 §4)**: [document-system-map.md](./document-system-map.md) §1c が定義する per-layer FE/UI 設計 doc カバレッジ (左腕) のうち、これまで「穴 + 未登録候補 slug」だった L3/L5/L6 の FE 設計 doc 型を `VALID_SUB_DOCS` へ登録し、定義を機械可知にする。**L3 `screen-functional`** (画面/UI 機能要件 + 画面 AC、SyRS/BDD) / **L5 `ui-detail`** (FE 内部設計 = component 分割・状態管理・routing・画面内部処理、IEEE 1016 SDD) / **L6 `screen-spec`** (per-screen 機能設計 = 項目/イベント/バリデーション/画面内遷移、Nablarch システム機能設計書(画面) 相当)。いずれも §G.13 の「**② プロダクト選択 (UI 有時)**」(UI を持つ製品のみ起票、BE-only/no-UI は `skip_sub_doc[].reason` で省略)。**vocabulary 登録が先・各型の必須 § 構造定義と body 実体化は body 起票時 (作成段階) に後続** (`report`/`batch` 等を vocabulary 先行登録した PLAN-L7-97 §4 と同方針、speculative な § 定義をしない)。正本は `src/schema/index.ts` の `VALID_SUB_DOCS`、左腕カバレッジ定義の正本は document-system-map §1c。
>
> **FE/UI 本文実体化 (2026-06-30、PLAN-L3-06 / PLAN-L5-09 / PLAN-L6-36)**: harness central UI は L3 `screen-functional`、L5 `ui-detail`、L6 `screen-spec` の本文を confirmed 化済み。上記の vocabulary-first rule は一般的なプロダクト選択ルールとして残すが、本プロダクトでは `frontend-design-coverage` が FE 左腕 6 本文ファイルすべてを要求し、pending 0 を報告する。

> **内部資産拡張 sub-doc (REVERSE-01 V4 注記、2026-06-04)**: harness 自身が統制する内部資産 (roster / skill-pack / drift-lint) は、上記コア sub-doc enum とは別の **拡張 sub-doc** として L4/L5 に存在する (実 PLAN: `PLAN-L4-10〜13` (internal-asset-master/roster/skill-pack/drift-lint) / `PLAN-L5-05〜07` (roster/skill/drift))。これらは製品ドメインの設計 sub-doc でなく harness メタ資産のため、コア `VALID_SUB_DOCS[L4|L5]` の件数確定 (5/4 種) には含めず、**拡張点**として別管理する。lint engine 実装時は `VALID_SUB_DOCS` を「コア + 内部資産拡張」の 2 群で持つ (件数 audit はコア群で行い、拡張群は allow-list 追加)。

##### G.2 frontmatter フィールド追加

```yaml
sub_doc: business                            # §G.1 の sub-doc 種別。kind=design + layer in [L1-L6] で必須
skip_sub_doc: []                             # 当該 PLAN で扱わない sub-doc + 理由を列挙 (drive 不適合等)
  # 例:
  # - sub_doc: screen
  #   reason: "BE-only drive, no UI"
pair_artifact: docs/test-design/<area>/L14-operational-test-design.md   # V-model pair 相手 (L1 sub-doc は L14、L3 sub-doc は L12 等)
related_l0: docs/governance/ut-tdd-agent-harness-concept_v3.1.md         # L0 概念層への parent_doc reference (anti-corruption layer)
related_br: docs/design/<area>/L1-requirements/business-requirements.md  # NFR / 技術要求 sub-doc のみ、業務要求への relate
next_pair_freeze: L3                                                     # L1 業務/機能 = L3 / L1 技術/NFR = L4 / L4-L6 = 対応する右腕 L
```

`pair_artifact` / `related_l0` は L1-L6 全 sub-doc で必須、`related_br` は L1 nfr/technical sub-doc + L4-L6 全 sub-doc で必須、`next_pair_freeze` は v1.2 で全 design PLAN 必須。

##### G.3 機械検証条件 (validator が fail-close)

- [ ] `kind=design + layer in [L1, L2, L3, L4, L5, L6]` → `sub_doc` 必須 (欠落 → exit 1)
- [ ] `sub_doc` ∈ §G.1 VALID_SUB_DOCS[layer] (層に存在しない sub-doc 値 → exit 1)
- [ ] 同一 layer + sub_doc の 2 重起票 (status ∉ archived のもの) → exit 1
- [ ] `generates[].artifact_path` が `docs/design/<area>/L<N>-requirements/<sub-doc-slug>.md` (L1) / `docs/design/<area>/L<N>-<layer-name>/<sub-doc-slug>.md` (L2-L6) の規約に従う (規約外 path → exit 1)
- [ ] `skip_sub_doc[].reason` 文字列が 10 文字以上 (空文字・null・ダミー → exit 1)
- [ ] **drive × sub_doc 整合** (構想書 §3.7 駆動別 L2-L14 挙動表。**L2 画面要求は drive でなく「UI 有無」で判定** = 2026-05-28 PO 修正):
  - **L2 画面要求 3 件 (screen-list / screen-flow / ui-element) は、UI を持つなら drive 非依存で必須**。wireframe (High-Fi モック) のみ drive で省略可。「UI 有無」は当面 `skip_sub_doc[].reason` のテキスト (`"BE-only"` / `"no UI"` を含むか) で弁別する (将来 `has_ui` フィールド化は別途、§1.6/REVERSE-01 R4→L3)。
  - `drive=be` + `layer=L2`: reason に `"BE-only"` / `"no UI"` を含む全 skip (= UI 完全不在) → 可。理由なしで画面要求 3 件を欠く → exit 1 (UI 有りで画面要求を落としている疑い)。UI 有りの be は screen-list/screen-flow/ui-element 必須・wireframe のみ skip 可。
  - `drive=db` + `layer=L2`: reason に `"UI 無し"` / `"no UI"` を含む全 skip (UI 無し) → 可。管理画面あり (理由なし) は screen-list/screen-flow/ui-element 必須 (欠落 → exit 1)・wireframe のみ skip 可。
  - `drive=fe` で `layer in [L2, L10]` の sub-doc を skip → exit 1 (FE 駆動の核心)
  - `drive=fullstack` で `layer in [L2, L10]` の sub-doc を skip → exit 1
  - `drive=agent` で `layer in [L2, L10]` の sub-doc を skip → exit 1 (会話 UI 必須)

##### G.4 PLAN 本文構造 (構想書 §3.6 PLAN 内蔵物原則)

- [ ] PLAN 本文に **§工程表 (Step + 進捗)** + **§実装計画** の両セクションが存在 (欠落 → exit 1)
- [ ] §工程表 に **review Step (self / pmo-sonnet / tl-advisor のいずれか)** が固定 Step として含まれる (欠落 → exit 1)
- [ ] §工程表 の Step は header `### Step <N>: <タイトル>` 形式 (機械検証可能)
- [ ] §実装計画 に各記載項目の情報源 (Web/TL 調査 / PO ヒアリング / 自動生成 / 既存資料) が明記される
- [ ] **(IMP-049) §工程表 の各 Step が `[並列]` / `[直列]` を明示し、`[直列]` には直列化 3 条件 (file_conflict / downstream_dependency / shared_state) のどれに該当するか 1 行で記す** (3 条件いずれにも非該当なら並列、default 上限 8)。機械支援 = `src/schema/team.ts` `mustSerialize` + agent-slots 並列超過 warn (IMP-050)。「重いから直列」は理由として不可。当面は人手 binding (`.claude/CLAUDE.md` 常時注入)、`ut-tdd plan lint` 実装時に Step の `[並列|直列]` トークン有無を機械検証へ。

##### G.5 v1.2 以前の単一統合 PLAN との後方互換

v1.1 以前に `PLAN-L1-01-business-requirements` 1 件で L1 全要求を扱っていた PLAN は、以下のいずれかで v1.2 整合化:

- (a) 内容を 5 sub-doc に分割し、新規 4 PLAN (functional / screen / technical / nfr) を起票、旧 PLAN は business sub-doc に絞り直し
- (b) 旧 PLAN を `status: archived` に遷移し、5 sub-doc 全件を新規起票

validator は移行期間中 (v1.2 reception session 内)、`sub_doc` 不在の旧 PLAN を warning とし、`status=archived` で除外可。

##### G.6 sub-doc 必須 § 機械検証 (構想書 §3.1.2.1)

5 sub-doc 各々の必須 § (構想書 §3.1.2.1 表) を `ut-tdd plan lint` で fail-close 検証:

| sub-doc | 必須 § header (h2、`^## §<N> <名称>`) | 必須 sub-§ (h3) |
|---|---|---|
| **business** | §1 目的・背景 / §2 対象業務一覧 / §3 業務フロー / §4 ステークホルダー / §5 現状課題 → あるべき姿 / §6 業務スコープ外 / §7 L14 運用テスト pair 対応表 / §8 関連 doc / §9 carry / §10 業務 entity 列挙 | §1.1 WHY / §1.2 WHAT / §1.3 WHO / §3.1 主線 / §3.2 9 mode 分岐 / §3.3 cross-cutting 横断機構 / §10.1 主要業務 entity 一覧 / §10.2 L4 carry / §10.3 SSoT 参照 |
| **functional** | §1 機能一覧 / §2 利用シナリオ / §3 操作とデータの流れ / §4 入出力 / §5 上流 baton 反映 / §6 関連 doc | (無し、§3 内で操作種別を sub-section 化可) |
| **screen** | §1 画面一覧 / §2 画面遷移の要望 / §3 表示・操作への要望 / §4 関連 doc | (無し、画面ごとに sub-section 化可) |
| **technical** | §1 採用技術・技術制約 / §2 外部連携 + IF 要望 / §3 既存システム制約 / §4 state schema 二層構造 / §5 工程別 skill 注入機構 / §6 9 mode 共通基盤 / §7 drift 解消方針 / §8 関連 doc | (無し) |
| **nfr** | §1 可用性 / §2 性能・拡張性 / §3 運用・保守性 / §4 移行性 / §5 セキュリティ / §6 システム環境 / §7 IPA × ISO 25010 二軸タグ表 / §8 関連 doc | (無し) |

- [ ] sub_doc 指定 PLAN は必須 § 全件を h2 として持つ (欠落 → exit 1)
- [ ] business sub-doc は必須 sub-§ 全件を h3 として持つ (欠落 → exit 1)
- [ ] §header に typo / 番号飛び / 順序逸脱があれば warning

##### G.6.1 L4 標準成果物 (外部設計) 必須 § 構造 (IPA 共通フレーム 2013 外部設計 grounding、2026-06-22)

§1b ([document-system-map.md](./document-system-map.md) §1b) の SI 標準成果物カタログ 4 型
(`report`/`batch`/`notification`/`code-value`、いずれも **② プロダクト選択**) の必須 § を、IPA 共通フレーム
外部設計の標準成果物内容で確定する。`sub_doc` ∈ これら 4 型の `kind=design + layer=L4` PLAN は本表の必須 §
を h2 (`^## §<N> <名称>`) として持つことを `ut-tdd plan lint` が fail-close 検証する
(`sub-doc-section-structure` gate)。harness 自身は ② 不産出ゆえ現状 subject 0 = downstream 製品 PLAN 起票時に発火する。

| sub-doc | 標準成果物 | 必須 § header (h2、`^## §<N> <名称>`) | IPA 外部設計 grounding |
|---|---|---|---|
| **report** | 帳票 | §1 帳票一覧 / §2 レイアウト / §3 出力項目定義 / §4 出力条件・タイミング / §5 関連 doc | 帳票設計 (帳票ID/媒体/明細・集計/編集規則/出力契機) |
| **batch** | バッチ | §1 バッチ一覧 / §2 ジョブフロー / §3 入出力 / §4 処理仕様 / §5 実行スケジュール・リカバリ / §6 関連 doc | バッチ設計 (ジョブネット/コミット単位/再実行/異常時) |
| **notification** | メール/通知 | §1 通知一覧 / §2 送信契機 / §3 テンプレート・本文 / §4 宛先・配信制御 / §5 関連 doc | 通知設計 (チャネル/トリガ/差込項目/再送・抑制) |
| **code-value** | コード値一覧 | §1 コード体系 / §2 コード値定義 / §3 利用箇所 / §4 メンテナンス方針 / §5 関連 doc | コード設計 (区分値マスタ/有効期間/履歴) |

- [ ] `sub_doc` ∈ {report, batch, notification, code-value} の design PLAN は本表の必須 § 全件を h2 として持つ (欠落 → exit 1、`sub-doc-section-structure` gate)。
- [ ] 必須 § の §番号順序逸脱 / typo は warning (L1 §G.6 と同方針)。

##### G.7 ドメイン継承チェーン検証 (構想書 §3.1.2.2 DDD anti-corruption layer)

L0 → L1 → L4 のドメイン継承チェーンを `ut-tdd plan lint` (sub_doc=business 時) で検証:

- [ ] business sub-doc §10.1 の業務 entity 一覧 table が以下 4 列を持つ:
  - `業務 entity` / `L0 用語 (参照 path 含む)` / `業務的意味 (BR で扱う側面)` / `対応 .ut-tdd state / CLI subcommand / file`
- [ ] 各業務 entity の `L0 用語` 列が L0 概念層 (`docs/governance/ut-tdd-agent-harness-concept_v3.1.md §10 用語集`) に存在する用語と完全一致 (独自定義 → exit 1、anti-corruption layer)
- [ ] §10.2 L4 carry section に **集約境界 / 値オブジェクト / entity ID 規約 / ライフサイクル / 不変条件 / 集約間整合性 / `ut-tdd doctor check_business_entity_coverage` 新設** の 7 項目が列挙されている (欠落 → P1 warning)
- [ ] §10.3 SSoT 参照 section に **ユビキタス言語 SSoT / Bounded Context SSoT / 業界標準整合 SSoT** の 3 項目が path 付き reference として明示されている

##### G.8 sub-doc 共通ヘッダー要素 (構想書 §3.1.2.3)

5 sub-doc 全件の冒頭 blockquote に以下を必須化:

- [ ] **SSoT 参照宣言ブロック** = `ユビキタス言語 = <L0 §10 用語集 path> / 業界標準整合 = <L0 §11 path> / Bounded Context = <L0 §2.5 9-mode>。本 doc は L0 を parent_doc reference とし、用語独自定義は行わない (anti-corruption layer)` のテンプレ文字列が存在 (欠落 → exit 1)
- [ ] **件数確定宣言** = `<sub-doc 種別> は <要求 prefix> <NN> 件で確定 (根拠: <TL/PMO レビュー record path>)` のパターンが存在 (欠落 → P1 warning)
- [ ] **L3 接続規約** = `next_pair_freeze: <L3 or L4 doc path>` の frontmatter フィールド + 本文 §関連 doc に `L3 PLAN は本 sub-doc 全件を dependencies.requires に列挙する` の記載 (欠落 → exit 1、§G.2 frontmatter と連動)

##### G.9 用語更新 (glossary delta) 検証 (living glossary、構想書 §3.1.2.2)

各 L 層 design / impl PLAN の §用語更新 section を `ut-tdd plan lint` で検証 (living glossary の back-merge 強制、ユビキタス言語の各工程更新):

- [ ] 各 design / impl PLAN に `## §6 用語更新` section が存在 (欠落 → exit 1)。当該工程で新規導入 / 精緻化した用語が無ければ本文に `用語更新なし` を明記
- [ ] §6 用語更新 に挙げた**新規用語**は L0 §10 用語集 (`docs/governance/ut-tdd-agent-harness-concept_v3.1.md`) に同名 entry として back-merge 済み (未 merge の独自定義 → exit 1、anti-corruption layer)
- [ ] back-merge した §10 entry の **導入層** 列が当該 PLAN の `layer` と一致 (不一致 → P1 warning)
- [ ] 既存用語の**意味変更**を行った場合、§10 該当 entry の **更新層** 列に当該 `layer` が追記済み (欠落 → P1 warning)
- [ ] §6 用語更新 で参照する用語名が §10 と表記揺れ無く一致 (揺れ → warning)

##### G.10 機能一覧 (FR registry) 漏れ監査 + 登録機構 (構想書 §3.1.2.2 / A-57)

機能一覧 (L1 functional §1) を FR registry の**単一 SSoT** とし、`ut-tdd doctor` (`fr-registry-audit` gate) / `src/lint/fr-registry-audit.ts` で **漏れ監査を自動化**する (手動 audit A-51/52/54 の lint 化、doctor 配線は PLAN-L7-95)。漏れ 5 型は doc 間 ID 整合で自動判定:

- [ ] **型1 登録漏れ** = screen §5 trace / L3 functional で参照される FR-L1-NN が §1 table に未登録 (carry/forward 宣言済みを除く) → exit 1
- [ ] **型2 欠番漏れ** = FR-L1 連番の gap で carry/forward 宣言の無いもの (現 36/38/43 は宣言済 = OK) → exit 1
- [ ] **型3 属性漏れ** = §1 行が必須 7 列 (機能要求名 / 出典 doc / 必要 input / 出力 output / 重要度 / 対応画面) を欠く or 重要度が P0|P1|P2 でない → exit 1
- [ ] **型4 件数整合** = §1 実数が header 件数確定宣言 (計 N / P0 / P1 / P2) と不一致 → exit 1 (A-54 doc 件数誤りの再発防止)
- [ ] **型5 画面被覆** = P0 FR-L1 に対応画面が無い → exit 1 (P1/P2 は warn、screen §5.3 R3 と連動)
- [ ] **型6 外部 corpus 漏れ (tier-2、自動化対象外)** = source 機能 inventory (legacy source 47 doc 等) との完全性突合は periodic subagent 監査。inventory を登録すれば将来自動化可能だが、それ未満では手動 audit が残る

**登録機構 (registration)**: 各工程で発見した機能要求は PLAN §7 機能要求更新 (FR-L1 delta) に記載 → §1 への back-merge を必須化 (§1.2 back-propagation 6 step を機械強制)。新 FR-L1 は (a) §1 行追加 (b) screen §5 trace 紐付け (c) header 件数確定宣言更新 (d) ledger 記録 を満たさなければ exit 1。

> **architecture 注記**: `implementation_status` (installed/partial/not-implemented) は変動する **runtime state** (`.ut-tdd/state/`) に置き、版管理対象の spec table (§1) には**列として持たない** (mutable status を spec に混入させない)。HM-01 は §1 registry (静的属性) × runtime status を join して表示する。`導入工程` (provenance) は現状 §1 `出典 doc` 列に自由記述で内包 (例: "L3 back-propagation")、正規化列化は将来 increment。

##### G.11 doc 間整合チェック (doc-consistency lint、構想書 §3.1.2.2 / A-58)

doc 間の整合を `src/lint/doc-consistency.ts` で自動検証 (`ut-tdd doctor` の `doc-consistency` gate として配線、PLAN-L7-95) = L3 到達までの手動 audit (A-51/52/54) の機械化。retro (ledger mine) で「手戻りの大半は既に 3 lint 化済 (g3-trace/entity-coverage/fr-registry-audit)、残自動化可は本 G.11 へ集約」と確認。

**第1弾 (実装済、現状 clean)**:

- [ ] **carry-consistency** = L3 functional §3 の純 L4 carry 宣言 FR-L1 (Phase B / L3 直接詳細化 / 委譲 を除く = 残 P1 9 件) が §3.1 詳細表に全件存在 → exit 1 (A-54 carry 不整合の再発防止)
- [ ] **screen-id-validity** = functional §1 「対応画面」列の画面 ID が screen sub-doc で実在定義 (15 画面) → exit 1 (存在しない画面への誤参照検出)
- [ ] **nfr-count** = nfr.md header 件数確定宣言 (計 N 件) と実 NFR 定義数 (unique 行 leader) の一致 → exit 1

**第2弾 (spec のみ、未実装)**:

- [ ] **doc-count 汎用** = 全 sub-doc (business BR / nfr / L12 AT / AC) の header 件数宣言 vs 実数 (nfr-count の一般化、A-54 件数誤りの全面防止)
- [ ] **id-uniqueness** = 同一 ID の二重定義検出 (NFR-17 telemetry vs security 型の衝突、A-54)。定義 context の機械的確立後に実装
- [ ] **frontmatter-path 実在** = PLAN frontmatter `parent_design` / `pair_artifact` / `related_l0` の path を fs 実在検証 (§1.10.G.2 連動)
- [ ] **plan-id-schema** = `docs/plans/PLAN-*.md` の `plan_id` が planIdSchema regex 適合 (現状既存 PLAN debt を warn surface、A-55)

##### G.12 improvement backlog (作業ログ → 機能化 pipeline、構想書 §3.1.2.2 / A-59)

「作業中に発見した不備・改善を蓄積 → triage → 機能化」する living backlog。SSoT = `docs/improvement-backlog.md` §1。FR-L1-19 (Learning Engine) 本実装までの**手動の橋渡し**。`src/lint/improvement-backlog.ts` で構造健全性を検証 (`ut-tdd doctor` の `improvement-backlog` gate として配線、PLAN-L7-95):

- [ ] entry ID が `IMP-NNN` 形式 + 一意 (malformed / duplicate → exit 1)
- [ ] `status` ∈ {observed, triaged, implemented, verified} (enum 外 → exit 1)
- [ ] `自動化候補` ∈ {lint, FR, policy, doc, none} (`/` 区切り複数可、enum 外 → exit 1)
- [ ] 必須 7 列 (ID / 観測日 / 文脈 / 不備・改善 / 自動化候補 / status / 紐付け) 充足 (欠落 → exit 1)

**運用**: 各工程で不備発見 → backlog 登録 (observed) → triage (どの機能化経路 = lint/FR/policy/doc か、triaged) → 実装 (implemented) → 検証 + ledger A-番号紐付け (verified)。`verified` 以外の openCount が「機能化待ち」= 次の ②駆動モデル (検証 / 改修駆動) の trigger 源。**ledger (起きたことの決定台帳) と backlog (これからやる改善候補) を相互参照で分離**する。

##### G.13 design 層 sub-doc の 必須 / プロダクト選択 区分 + PLAN 合成導線 (メタモデル ①②、A-62)

設計層 (L1-L6) の sub-doc は「**① 必須** (プロダクト非依存で常に作成)」と「**② プロダクト/drive 選択** (条件付き、`skip_sub_doc` 判定)」に区分する (PLAN-DISCOVERY-01 メタモデル ①②の具体化)。PLAN 起票の**導線**:

1. **triage**: 当該層 × プロダクト特性 (drive / UI 有無 / 外部連携有無 / DB 有無) を判定
2. **① 必須 sub-doc** は常に `PLAN-L<N>-<NN>-<sub-doc>` を起票 (kind=design)
3. **② 選択 sub-doc** は条件成立時のみ起票。不成立は `skip_sub_doc[]` に reason (≥10 字) で記録 (G.2 / G.3)
4. 各 sub-doc = 1 PLAN (混在禁止 AP-11/12)。複数 sub-doc は Master PLAN (hub、`PLAN-L<N>-00-master`) が束ね、triage 結果・child 一覧・skip 決定・実行順を持つ

**層別 必須 / 選択 区分**:

| 層 | ① 必須 (常時) | ② プロダクト/drive 選択 (skip 条件) |
|---|---|---|
| L1 | business / functional / nfr / technical | screen (UI 無し drive で skip) |
| L2 | screen-list / screen-flow / ui-element (**UI を持つなら drive 非依存で必須**、2026-05-28 PO 修正) | wireframe (drive で省略可) / **UI 完全不在 (be-only / db 無 UI) のみ層ごと全 skip** (skip_sub_doc 理由必須) |
| L3 | functional-requirement / nfr-grade | business-requirement (評価系 BR が無ければ縮退) |
| **L4** | **architecture (方式設計/ADR) / data (ドメインモデル) / function (機能設計)** | **external-if (外部連携無しで skip) / screen (UI 無し or 未確定で skip/defer)** |
| L5 | internal-processing / module-decomposition | physical-data (DB 無しで skip) / if-detail (IF 無しで skip) |
| L6 | function-spec / edge-case | class-design (非 OOP drive で縮退) |

> **L4 の architecture (方式設計) と external-if (外部設計) は別 sub-doc** = document-system-map Z1 (方式設計/外部設計 分離) を既存 enum が満たす。**data** = DbC invariant (ドメイン不変条件)、**external-if** = DbC pre/post (境界契約) を担う (document-system-map §3 配線図=DbC)。**architecture** sub-doc は arc42 §4 (Solution Strategy) + §9 (ADR) を必須 artifact とする (Z1/E1)。

#### H. G1-trace 機械検証ルール (sub-gate、DD1=a / DD2=a PO 承認 2026-05-28)

G1 内 sub-gate「業務 ⇔ 画面 ⇔ 機能 双方向 trace 整合」の機械検証ルール 4 件。SSoT: screen sub-doc §5 trace マトリクス。G1-trace は G1 内の 3 番目 sub-gate であり、G1-content → G1-pair → G1-trace の順で通過後に G1 exit となる (構想書 §3.3.1)。

##### H.1 ルール R1: BR/UX → 画面 trace 必須

検証式: 全 BR/UX-ID (BR-01〜08 + UX-01〜03 + BR-21 + BR-22、計 13 件) が screen §5.1/5.2 マトリクスで最低 1 画面に紐付くこと。

孤児 BR/UX 検出時の動作: **block** (G1-trace fail-close)。

fail メッセージ: 「BR-NN / UX-NN が画面要求に紐付いていません。screen §5 trace マトリクスを更新してください。」

- [ ] 13 件全件が screen sub-doc §5.1 または §5.2 の trace 表に 1 行以上登場する (欠落 → exit 1)

##### H.2 ルール R2: 画面 → BR/UX/FR-L1 trace 必須

検証式: 全 15 画面 (PM-01〜PM-06 + HM-01〜HM-08 + GD-01) が screen §5.5 逆 trace 表で最低 1 つの BR/UX/FR-L1 に紐付くこと。

孤児画面検出時の動作: **block**。

fail メッセージ: 「PM/HM/GD-NN が業務根拠 (BR/UX/FR-L1) に紐付いていません。screen §5.5 逆 trace 表を更新してください。」

- [ ] 15 画面全件が screen sub-doc §5.5 逆 trace 表に BR/UX/FR-L1 のいずれか 1 件以上紐付く (欠落 → exit 1)

##### H.3 ルール R3: FR-L1 P0 → 画面 trace 必須

検証式: FR-L1 P0 19 件のみ最低 1 画面に紐付く必要 (P1 22 件 / P2 5 件は warn 程度、block しない)。

孤児 P0 FR-L1 検出時の動作: **block**。孤児 P1/P2 FR-L1 検出時の動作: **warn** (G1-trace 通過に影響しない、L3 で補完推奨)。

DD2=a 採用根拠: P0 = dashboard 表出必須機能、P1/P2 は背景機能を含む。

- [ ] FR-L1 P0 19 件全件が screen sub-doc §5 trace マトリクスで最低 1 画面に紐付く (欠落 → exit 1)
- [ ] FR-L1 P1/P2 で紐付き無し → P1 warning (exit 0、stdout に warn 出力)

##### H.4 ルール R4: screen sub-doc `requires` 整合

検証式: PLAN-L1-03-screen-requirements 等の screen 関連 PLAN frontmatter `dependencies.requires` に **business + functional の両方が明示列挙** されていること。

不整合検出時の動作: **warn** (G1-trace 通過に影響しない)。

- [ ] screen sub-doc の PLAN frontmatter `dependencies.requires` に business sub-doc PLAN-ID と functional sub-doc PLAN-ID が両方含まれる (欠落 → P1 warning)

##### H.5 検証実装

- CLI: `ut-tdd plan lint --gate G1-trace` で実行
- 設定ファイル: `gate-checks.yaml` の `G1-trace` セクションに R1-R4 を定義 (L4 carry)
- machine 一次判定 (NFR-12 整合)。AI/human 補完は machine 判定の後段でのみ行う
- `harness-check` の `plan-lint` subjob が G1-trace lint を内包する (§6.3 matrix の `design` branch 行)

##### H.6 G1 entry / exit 条件

| フェーズ | 判定内容 | 通過条件 |
|----------|----------|----------|
| G1 entry | 必須 sub-doc 全件起票完了 (screen は UI 有り時のみ必須) | G1-content 通過 |
| G1-content | 必須 sub-doc 全件 status=confirmed + skip は理由記録 | business/functional/nfr/technical が confirmed + screen は UI 有りなら confirmed / UI 無し drive は `skip_sub_doc` 記録で件数対象外 (be-only/db無UI は 4 件で充足) |
| G1-pair | L1↔L14 OT 量閉じ (孤児 0) | 全 BR/NFR が L14 運用テスト設計の OT-* に 1:1 対応 |
| G1-trace | 業務 ⇔ 画面 ⇔ 機能 双方向 trace 整合 (本 §H) | R1/R2/R3 block なし (R4 warn は pass 扱い) |
| G1 exit | 3 sub-gate 全件通過 | G1-content ∧ G1-pair ∧ G1-trace のすべて pass |

各 sub-gate fail 時は当該 sub-gate に戻り修正する。G1 exit は 3 sub-gate 全件通過まで block される (fail-close)。

##### H.7 §1.10.A〜§1.10.G との接続規約

- 本 §H は §G (L 別 sub-doc 構造) の後段に位置する。`ut-tdd plan lint` は §G の sub-doc 種別・フィールド・本文構造検証を先に実行し、G 系 check が pass した screen sub-doc に対して §H の G1-trace lint を実行する (依存順序固定)。
- §G.3 で検証する `sub_doc=screen` の必須フィールド (`pair_artifact`, `related_l0`, `next_pair_freeze`) は G1-trace lint の前提条件。欠落があれば §G.3 で exit 1 となり §H の検証は実行しない。
- §G.6 で検証する screen sub-doc の必須 § 構造 (§1 画面一覧 / §2 画面遷移の要望 / §3 表示・操作への要望 / §4 関連 doc) も G1-trace lint の前提。§5 trace マトリクスは本 §H が追加する screen sub-doc 必須 § であり、G1-trace lint が §5 系セクション (§5.1/5.2/5.5 など) の存在を別途確認する。

---

# §2 V-model 4 artifact 工程要件

## 2.1 4 artifact の物理配置

| Artifact | 配置場所 | artifact_type | 命名規約 |
|----------|----------|---------------|----------|
| ① 設計 | `docs/design/<feature>/<name>.md` | `design_doc` | 例: `D-API-audit.md` |
| ② 実装コード | `src/...` | `source_module` / `script` / `cli_extension` 等 | 言語標準 |
| ③ テスト設計 | `docs/test-design/<feature>/<name>-test-design.md` | `test_design` | 例: `D-API-audit-test-design.md` |
| ④ テストコード | `tests/...` | `test_code` | 例: `test_audit.py` |

## 2.1.1 G0.5 企画突合 (L0 企画書 ⇒ L1 業務要求、軽量 feed-forward ゲート)

`kind=charter` の L0 企画書を L1 要求定義へ渡す前に G0.5 を適用する。**企画書は「次工程へ渡す feed-forward 文書」であり、完全性や作り込みを求めて激しくチェックするゲートではない**。G0.5 は高レベル方向性が L1 へ繋がるか + 整合性破綻がないかだけを軽く確認する。

| ゲート | 確認対象 | fail 条件 (最小) |
|--------|----------|------------------|
| **G0.5** 企画突合 | L0 ① 企画書 (背景 / 目的 / スコープ の高レベル方向性) ⇒ L1 ① 業務要求 (BR-*/NFR-*) | 次のいずれかのみ fail: ① 背景・目的・スコープ の高レベル方向性が無く L1 業務要求へ trace できない / ② 内部矛盾・ロジック破綻 (整合性破綻) がある |

企画書ゲートで見るべき「穴」は 3 種に限る — **A. 書きすぎ** (L1/L3 相当の詳細) / **B. リサーチ不足** (未調査の断定) / **C. 整合性破綻** (内部矛盾・trace 切れ)。これ以外の「完全性不足」では fail させない。

- **ROI / KGI・KPI / 詳細受入指標は fail 条件にしない**。社内システム/開発基盤では企画書段階での定量化を強制せず、必要な指標は L1 NFR-* / L3 で定義する (企画書での二重記述 = 2 度手間を避ける)。
- A 書きすぎは穴とせず **L1 要求定義へ降ろす** (要求側に回す)。企画書を作り込み直さない。
- review は軽量で良い。整合性・方向性の確認を目的とした 1 回の他者レビュー (cross-agent / 専門サブエージェント) を推奨するが、完全性レビューは hard 必須にしない。

## 2.2 3 段階 freeze の fail-close 条件

### 段階 A: Pair freeze (設計⇔テスト設計、V-model 左各層。L7 実装前)

| ゲート | Pair freeze 対象 (① 設計 ⇔ ③ テスト設計) | fail-close 条件 |
|--------|------------------|------------------|
| **G1** 要求完了 | L1 ① 業務要求 ⇔ L1 ③ 運用テスト設計 (→L14) | 片方欠落 → fail |
| **G2** 画面凍結 | L2 ① ワイヤーモック (mock 自体がペア →L10) | mock 欠落 → fail |
| **G3** 要件凍結 | L3 ① 要件 (FR+AC) ⇔ L3 ③ 受入テスト設計 (→L12) | 片方欠落 / AC 不在 → fail |
| **G4** 基本設計凍結 | L4 ① アーキ/ADR ⇔ L4 ③ 総合テスト設計 (→L9) | 片方欠落 → fail |
| **G5** 詳細設計凍結 | L5 ① D-API/D-DB/D-CONTRACT ⇔ L5 ③ 結合テスト設計 (→L8) | 片方欠落 → fail (API/Schema Freeze) |
| **G6** 機能設計凍結 | L6 ① 関数 schema/エッジケース+WBS ⇔ L6 ③ 単体テスト設計 (→L7) | 片方欠落 / WBS 不在 / 関数 sig 未確定 → fail |

### 段階 B: 4 artifact trace freeze (L7 実装後)

| ゲート | trace freeze 対象 | fail-close 条件 (R-C3 fix で統一) |
|--------|------------------|------------------------------------|
| **G7** 実装凍結 | 以下 3 条件をすべて満たす: ① 4 artifact (① + ② + ③ + ④) 揃い / ② §2.4 の **必須 8 directed edge** すべて満たす / ③ カバレッジ ≥ 80% | いずれか欠落 → exit 1 |

### 段階 A2: TDD Red freeze (④ テストコード先行、L7 実装前)

G6 通過後、L7 実装本体へ入る前に、L6 単体テスト設計に対応する ④ 単体テストコードを先行作成する (L7 スプリントの最初のステップ)。対象テストは未実装の ② 実装理由で fail してよいが、構文エラー・import 経路不備・fixture 不備で fail してはいけない。

| ゲート | Red freeze 対象 | fail-close 条件 |
|--------|------------------|------------------|
| **L7 entry (TDD Red)** | L6 ③ 単体テスト設計 ⇔ 先行 ④ 単体テストコード | ③ に対応する ④ が無い / テストが収集不能 / 失敗理由が未実装以外 → fail |

## 2.3 双方向 trace の記述要件

| Pair / 方向 | 記述方法 | 例 |
|------------|----------|----|
| ① 設計 → ② 実装コード | 設計に「実装ファイル: `<path>`」 | `実装ファイル: src/audit.py` |
| ② 実装コード → ① 設計 | docstring に「契約: `<doc>` §`<n>`」 | `"""契約: docs/design/L5-D-API.md §3.1"""` |
| ① 設計 → ③ テスト設計 | 設計に「テスト設計: `<path>`」 | `テスト設計: docs/test-design/L6-audit-unit-test-design.md` |
| ③ テスト設計 → ① 設計 | テスト設計に「対象設計: `<doc>` §`<n>`」 | `対象設計: docs/design/L6-audit-function.md §3.1` |
| ③ テスト設計 → ④ テストコード | テスト設計に「テスト実装: `<path>`, U-XXX-NNN 対応」 | `テスト実装: tests/test_audit.py, U-AUD-001〜023` |
| ④ テストコード → ③ テスト設計 | docstring に「DoD 検証: `<doc>` U-XXX-NNN」 | `"""DoD 検証: docs/test-design/L6-audit-unit-test-design.md U-AUD-001"""` |

## 2.4 双方向 12 directed edge の検証要件 (R-I5 fix)

4 artifact は無向 6 pair = 双方向 12 directed edge。G7 (実装凍結) では以下 **必須 8 directed edge** を fail-close 検証する (残り 4 directed edge は warn 推奨):

| # | Directed edge | Pair | 検証方法 | 必須 |
|---|--------------|------|----------|------|
| 1 | ① 設計 → ② 実装コード | ①⇔② | 設計 doc 内に「実装ファイル: `<path>`」が存在し、参照先 path が repo 内に存在 | ✓ |
| 2 | ② 実装コード → ① 設計 | ①⇔② | 実装ファイル docstring に「契約: `<doc>` §`<n>`」が存在し、参照先が #1 と相互一致 | ✓ |
| 3 | ① 設計 → ③ テスト設計 | ①⇔③ | 設計 doc 内に「テスト設計: `<path>`」が存在し、参照先が repo 内に存在 | ✓ |
| 4 | ③ テスト設計 → ① 設計 | ①⇔③ | テスト設計 doc に「対象設計: `<doc>` §`<n>`」が存在し、参照先が #3 と相互一致 | ✓ |
| 5 | ③ テスト設計 → ④ テストコード | ③⇔④ | テスト設計 doc に「テスト実装: `<path>`, U-XXX-NNN 対応」が存在し、参照先 test_*.py が repo 内に存在 | ✓ |
| 6 | ④ テストコード → ③ テスト設計 | ③⇔④ | テストコード docstring に「DoD 検証: `<doc>` U-XXX-NNN」が存在し、参照先が #5 と相互一致 | ✓ |
| 7 | ② 実装コード → ④ テストコード | ②⇔④ | 実装 PLAN の `generates` に test_code 成果物があり、`tests/` 配下に対応 test_*.py が存在 | ✓ |
| 8 | ④ テストコード → ② 実装コード | ②⇔④ | テストコード内に対応 `src/` モジュールへの `import` または相対参照が存在 (R-I5: manifest / coverage map / import graph のいずれかで検証) | ✓ |
| 9 | ① 設計 → ④ テストコード | ①⇔④ | (派生: #3 + #5 経由で推論可能) | warn |
| 10 | ④ テストコード → ① 設計 | ①⇔④ | (派生: #6 + #4 経由で推論可能) | warn |
| 11 | ② 実装コード → ③ テスト設計 | ②⇔③ | (派生: #2 + #3 経由で推論可能) | warn |
| 12 | ③ テスト設計 → ② 実装コード | ②⇔③ | (派生: #4 + #1 経由で推論可能) | warn |

## 2.5 QA 追加テストの分離 (V-model 補足)

| テスト種別 | 担当 | 設計 doc (③、左で凍結) | 実施タイミング (右) |
|-----------|------|----------|------------|
| 単体テスト | aim / se | L6 単体テスト設計 | L7 実装スプリント内 |
| 結合テスト | aim / se | L5 結合テスト設計 | L8 結合テスト |
| 総合テスト (E2E) | qa / aim | L4 総合テスト設計 | L9 総合テスト |
| 受入テスト | po / qa | L3 受入テスト設計 | L12 デプロイ + 受入 |
| 運用テスト | qa / po | L1 運用テスト設計 | L14 運用検証 |
| **QA 追加テスト** (regression / exploratory / edge-case) | qa | **`docs/test-design/<feature>/qa-additional-test-design.md`** | L8 / L9 検証時 |

`vmodel_lint` は L5 / L6 設計 doc 内に QA 追加テスト記述があれば **P1 (warning)** を出す。

実装後レビューで見つかった不足観点は、以下のどちらかで扱う。

- **仕様・受入の不足**: `add-design` / `add-impl` として差分 PLAN を起票し、再度 Pair freeze / Red freeze / trace freeze を通す。
- **品質保証観点の追加**: QA 追加テスト設計を先に正本化し、その後で対応する追加テストコードを書く。L5 / L6 の frozen test design には混ぜない。

### QA 追加テストの正本化ルール (L8 / L9 検証時)

QA 追加テストは、レビュー指摘から直接 `tests/` を増やしてはいけない。必ず以下の順序で作成する。

1. `docs/test-design/<feature>/qa-additional-test-design.md` に追加観点、対象リスク、対象仕様/実装、test id (`QA-XXX-NNN`) を記録する。
2. 追加テストコードを `tests/` に作成し、docstring またはコメントに `DoD 検証: docs/test-design/<feature>/qa-additional-test-design.md QA-XXX-NNN` を記述する。
3. `vmodel_lint` は QA 追加テストコードから QA 追加テスト設計への trace が無い場合、P0 fail-close とする。
4. 追加観点が仕様不足や受入条件変更を意味する場合は、QA 追加テストではなく `add-design` / `add-impl` (Add-feature mode) に差し戻す。

## 2.6 逆ピラミッド検出 (P0 severity)

| 検出 | severity | 動作 |
|------|----------|------|
| ① ② 存在、③ ④ 無し | **P0** | G6 / G7 で fail-close (マージ不可) |
| ① ② 存在、③ あり ④ 無し | P1 | warning + carry 候補 |

## 2.7 受入条件 (V-model 工程、R-C3 fix で統一。v1.2 で L0-L14 V-model 化)

- [ ] V-model 左各層の pair freeze (①⇔③) 不在 → exit 1 (G1=L1 運用 / G3=L3 受入 / G4=L4 総合 / G5=L5 結合 / G6=L6 単体)
- [ ] L7 実装着手前 (TDD Red) に L6 ③ 単体テスト設計に対応する先行 ④ 単体テストコードが存在し、未実装理由の failing test として収集可能
- [ ] kind=impl (L7) の PLAN に `parent_design:` (L6 機能設計 doc への path) が存在し、参照先が repo 内に存在 (不在 → exit 1、§1.1.parent_design)
- [ ] G7 (実装凍結) 通過時に **以下 3 条件をすべて満たす** (いずれか欠落 → exit 1):
  - [ ] 4 artifact (①+②+③+④) 揃い
  - [ ] §2.4 の **必須 8 directed edge** すべて pass
  - [ ] カバレッジ ≥ 80%
- [ ] L5 / L6 設計 doc 内に QA 追加テスト記述があれば P1 warning
- [ ] QA 追加テストコードが QA 追加テスト設計 doc への trace を持たなければ P0 fail-close
- [ ] 右側工程 (L8 結合 / L9 総合) でペア未凍結のテスト設計を新規起票 → P0 fail-close (V-model 違反、構想書 v3.1 §3.5 AP-7)
- [ ] 逆ピラミッド (① ② のみ存在) → P0 fail-close
- [ ] G8-G10 (L8 結合 / L9 総合 / L10 UX) と G11-G14 (総合レビュー+UAT / デプロイ+受入 / デプロイ後検証 / 運用検証) の fail-close 条件は本版では概念定義 (構想書 v3.1 §3.1 / §3.3) に留め、機械検証は将来 PLAN-XXX で詳細設計する (本 §2 は G7 実装凍結までを機械化)

---

# §3 経路 2: Scrum × Reverse 30 cell matrix 要件

## 3.1 30 cell matrix の意義

Scrum で確定した仮説 (`scrum_type` 6 種) と本実装に昇格させるための Reverse 経路 (`reverse_type` 5 種) を機械的に組み合わせ、各 cell に Primary 推奨を持たせる。R1 skip 判定は §3.3 で `reverse_type` を主キーに行う (構想書 §4.4、v3.0 確定・v3.1 継承)。

## 3.2 30 cell の Primary mapping (推奨)

| Scrum 種別 | reverse: code | reverse: design | reverse: upgrade | reverse: normalization | reverse: fullback |
|--|--------------|-----------------|------------------|------------------------|-------------------|
| **hypothesis-test** | **Primary 推奨** | 代替 Alt | 代替 Alt | 代替 Alt | 代替 Alt |
| **tech-spike** | 代替 Alt | **Primary 推奨** | 代替 Alt | 代替 Alt | 代替 Alt |
| **design-spike** | 代替 Alt | **Primary 推奨** | 代替 Alt | 代替 Alt | 代替 Alt |
| **perf-spike** | 代替 Alt | 代替 Alt | **Primary 推奨** | 代替 Alt | 代替 Alt |
| **security-spike** | **Primary 推奨** | 代替 Alt | 代替 Alt | 代替 Alt | 代替 Alt |
| **ux-spike** | 代替 Alt | **Primary 推奨** | 代替 Alt | 代替 Alt | 代替 Alt |

`scrum_reverse_lint` は Primary 外の選択を warning のみで許容、Alt cell でも fail にはしない。

### S4 outcome ごとの接続ルール

| decision_outcome | 許可される次工程 | 禁止 |
|------------------|------------------|------|
| `confirmed` | `reverse` kind PLAN を新規起票し、R0 から開始 | poc/* から main 直 merge |
| `rejected` | PLAN を `archived` にして終了 | reverse 起票 / feature 昇格 |
| `pivot` | 旧 PLAN を `archived` にし、新規 `poc` kind PLAN を S0 から起票 | 旧 PoC の reverse 起票 / feature 昇格 |

`scrum_reverse_lint` は reverse PLAN の `dependencies.requires` または `references` が `decision_outcome=confirmed` の poc PLAN を指していることを検証する。未確認 PoC、rejected、pivot への参照は exit 1。

## 3.3 R1 (Observed Contracts) 実施/skip の判定

R1 skip 判定は **解決済み `confirmed_reverse_type` を主キーとする** (構想書 v3.1 §4.4 確定):

| confirmed_reverse_type | R1 実施内容 (Observed Contracts) |
|------------------------|--------------------------|
| `code` | **実施** (PoC コードから契約抽出が中核) |
| `design` | **skip** (デザイン資産起点、R2 で起こす) |
| `upgrade` | **実施** (既存版と新版差分から契約抽出) |
| `normalization` | **skip** (設計 drift 修正、R2 で normalize) |
| `fullback` | **実施** (実装完遂後の文書整合、R1 で文書 gap 抽出) |

`scrum_reverse_lint` は `(confirmed_reverse_type, workflow_phase=R1)` ペアが skip 対象 (`design` / `normalization`) であれば exit 1。

## 3.4 経路 2 → 経路 1 合流のルール

R4 outcome の `forward_routing` で Forward 接続点を明示:

| forward_routing | 合流先 (L0-L14) |
|-----------------|--------|
| `L1` | Forward L1 (要求定義) — 仮説確定だが業務要求の構造化未了 |
| `L3` | Forward L3 (要件定義 FR+AC) — 業務要求は固まり機能要件へ |
| `L4` | Forward L4 (基本設計) — 要件確定、アーキ/方式設計から |
| `L5` | Forward L5 (詳細設計) — 方式確定、D-API/D-DB から |
| `gap-only` | Forward Backlog (新 PLAN 起票)、L1 から再開 |

> 旧 v1.1 の `L2`(全体設計)/`L3`(詳細設計) は L0-L14 remap で `L4`/`L5` に対応する。`L2` は画面設計専用になったため forward_routing 値としては使わない。
>
> **`L7` / `L8`-`L11` を forward_routing に含めない理由 (PM アーキ判断で確定、DISCOVERY-04 監査 2026-06-02)**: Reverse は **必ず設計層 (L1/L3/L4/L5) に再入し ①⇔③ pair-freeze gate (G1/G3/G4/G5) を通す** のが V-model 規律。L7 (実装) / L8-L11 (検証) へ直接 routing するのは pair-freeze をバイパスする違反 (source snapshot の緩いモデルでは L7/L8-L11 routing があったが UT-TDD は不採用)。「実装だけで閉じる」案件は `L5` (→pair-freeze→L7)、fullback の文書整合は対象 ③ の設計層へ routing するか `gap-only`。enum は 5 値で確定 (拡張不要)。

R4 outcome の `promotion_strategy` で PoC / 検証成果物の扱いを明示:

| promotion_strategy | 意味 | 必須条件 |
|--------------------|------|----------|
| `reuse-as-is` | PoC 成果を最小修正で機能化する | 既に設計 trace / テスト設計 / Red test / security check が揃う。PoC 直 merge ではなく feature PR で再検証 |
| `reuse-with-hardening` | PoC 成果を土台に本番品質へ補強する | 追加の design/test-design、security/performance hardening PLAN、回帰テストを追加 |
| `redesign` | PoC は知見だけ採用し、実装は再設計する | R4 gap から L1/L2/L3 のいずれかに戻り、PoC コードは main に入れない |
| `discard` | PoC 成果を採用しない | rejected 相当の知見として archive。feature 昇格不可 |

判定基準:

- 契約・セキュリティ・データモデル・運用要件が PoC と本番で同等なら `reuse-as-is` 候補。
- 非機能要件、認証/認可、データ永続化、監査、パフォーマンス、運用設計が不足するなら `reuse-with-hardening` または `redesign`。
- PoC が仮説検証専用の throwaway code、mock、手作業前提、外部 API/secret 直書き、テスト欠落を含むなら `redesign`。
- 検証結果が目的に合わないなら `discard`。

`reuse-as-is` / `reuse-with-hardening` でも `poc/*` から main へ直接 merge してはいけない。必ず `feature/*` PR として Forward の Pair freeze / Red freeze / trace freeze / harness-check を通す。

## 3.5 受入条件 (経路 2)

- [ ] kind=poc PLAN は frontmatter に `scrum_type` (= S0-S2 までは null 可、S3 以降必須) を持つ
- [ ] kind=poc + workflow_phase=S4 は `decision_outcome` 必須 (R-C1)
- [ ] kind=reverse PLAN は frontmatter に `confirmed_reverse_type` を必須
- [ ] kind=reverse PLAN は `decision_outcome=confirmed` の poc PLAN だけを起点にできる
- [ ] `decision_outcome=rejected/pivot` の poc PLAN から reverse / feature 昇格する参照は exit 1
- [ ] R1 phase の PLAN は §3.3 の R1 実施対象 `confirmed_reverse_type` のみ許容 (skip 対象は exit 1)
- [ ] R4 完了 PLAN は `forward_routing` を必須 (§3.4 の 5 値: L1 / L3 / L4 / L5 / gap-only)
- [ ] R4 完了 PLAN は `promotion_strategy` を必須 (§3.4 の 4 値)
- [ ] `confirmed_reverse_type=fullback` かつ `workflow_phase=R4` の confirmed/completed PLAN は、`generates`
      に `docs/design/` / `docs/governance/` / `docs/test-design/` のいずれかを含め、設計・要件・テスト設計へ
      戻した機械証跡を持つ。2026-06-22 以降の新規/更新 PLAN は `plan-governance`
      `reverse_fullback_backprop_missing` で fail-close。既存 legacy 欠落は監査表で debt 管理し、修正時に
      generates 追加または reverse_type 再分類を行う。
- [ ] `confirmed_reverse_type=fullback` かつ `workflow_phase=R4` の confirmed/completed PLAN は、`backprop_scope`
      に `requirements` / `L4-basic-design` / `L5-detailed-design` を列挙し、各層を `updated` / `not_impacted` /
      `deferred` のいずれかで分類する。`updated` は同じ PLAN の `generates` に含まれる `evidence_path` を必須とする。
      欠落時は `plan-governance` の `reverse_fullback_scope_missing` で fail-closeし、基本設計・詳細設計を見たか
      どうかが人間記憶だけに残る状態を禁止する。
- [ ] 2026-06-23 以降の新規/更新 `confirmed_reverse_type=fullback` R4 PLAN は、本文で
      `docs/design/` / `docs/governance/` / `docs/test-design/` 配下の backprop artifact path を明示した場合、
      その path を `generates` にも列挙する。本文だけで「戻した」と主張して機械 trace が欠落する状態は
      `plan-governance` の `reverse_fullback_claimed_artifact_missing` で fail-closeする。
- [ ] 2026-06-23 以降の新規/更新 `confirmed_reverse_type!=fullback` R4 PLAN も、本文で
      `docs/design/` / `docs/governance/` / `docs/test-design/` 配下の artifact path を明示した場合、
      その path を `generates` に列挙する。`design` / `code` / `normalization` reverse が設計・governance・
      test-design への反映を本文だけで主張する状態は `plan-governance` の
      `reverse_r4_claimed_artifact_missing` で fail-closeする。
- [ ] 2026-06-23 以降の新規/更新 `confirmed_reverse_type!=fullback` R4 PLAN が `forward_routing=L1..L6`
      の設計層へ戻る場合、`docs/design/` / `docs/governance/` / `docs/test-design/` のいずれかを
      `generates` に含めるか、`backprop_decision: not_required` と 10 文字以上の
      `backprop_decision_reason` で設計・要件・テスト設計への反映不要を明示する。欠落時は
      `plan-governance` の `reverse_r4_route_backprop_missing` で fail-closeする。
- [ ] `kind in [refactor, retrofit, troubleshoot]` の confirmed/completed PLAN が Reverse PLAN から `requires`
      されていない場合、2026-06-22 以降の新規/更新 PLAN は `backprop_decision: not_required` と
      10 文字以上の `backprop_decision_reason` を持つ。契約・挙動・要件・設計・テスト設計の意味が変わる場合は
      `not_required` を宣言せず Reverse PLAN を起票する。欠落時は `backfill-pairing`
      `conditionalDecisionMissing` で fail-close。既存 legacy 欠落は
      `docs/governance/conditional-backfill-decision-audit-2026-06-22.md` で debt 管理する。
- [ ] `promotion_strategy=reuse-as-is` は trace / test / security 条件が揃わなければ exit 1
- [ ] `promotion_strategy in [reuse-as-is, reuse-with-hardening]` でも feature PR で Forward gate を通さなければ main merge 不可
- [ ] poc/* ブランチから main への直 PR は §6.4 で物理ブロック

---

# §4 経路 3: add-* 受入条件

## 4.1 add-design / add-impl の禁則 (3 原則、R-I6 fix で canonical 化)

### 正規 diff rule

| 検出対象 | 検出コマンド (canonical diff rule) |
|---------|------------------------|
| 既存設計ファイルの変更/削除 | `git diff --name-only --diff-filter=DM origin/main...HEAD -- docs/design/` |
| 既存テストコードの変更/削除 | `git diff --name-only --diff-filter=DM origin/main...HEAD -- tests/` |
| 新規ファイルの追加 | `git diff --name-only --diff-filter=A origin/main...HEAD -- <path>` (許容) |

- `origin/main...HEAD` (3 dots) で merge base からの差分を取得
- `--diff-filter=DM` で D(削除) と M(変更) のみ抽出
- `--diff-filter=A` で A(追加) のみ抽出

### 禁則 → fail-close

| 原則 | 機械検証 |
|------|----------|
| **既存設計を改変しない** | canonical diff rule の検出対象 `docs/design/` で `--diff-filter=DM` が non-empty → exit 1 |
| **既存テストを変更しない** | canonical diff rule の検出対象 `tests/` で `--diff-filter=DM` が non-empty → exit 1 |
| **回帰確認必須** | `harness-check` 内で既存テスト全 PASS を確認、未通過 → exit 1 |

## 4.2 add-* PLAN の frontmatter 要件

- `dependencies.parent` で既存 PLAN を必須指定 (null 不可)
- `drive` は親 PLAN と一致 (§1.6 kind × drive matrix で fail-close)
- `kind=add-design` PLAN の `generates` には新規 `design_doc` + 新規 `test_design` のペアを必須
- `kind=add-impl` PLAN の `generates` には新規 `source_module/script/cli_extension` 等 + 新規 `test_code` を必須

## 4.3 双方向 reference 更新

add-* 完了時、既存 PLAN との双方向 reference を更新:

- 親 PLAN の `dependencies.references` に子 add-* PLAN ID を追加
- 子 PLAN の `dependencies.parent` を必須

## 4.4 受入条件 (経路 3)

- [ ] `kind=add-*` の PLAN は `dependencies.parent` 必須 (null → exit 1)
- [ ] `drive` が親 PLAN と一致 (不一致 → exit 1)
- [ ] §4.1 canonical diff rule で `docs/design/` または `tests/` の DM が non-empty → exit 1
- [ ] 既存テスト回帰 PASS なら harness-check 通過、いずれか fail → exit 1
- [ ] 親 PLAN の `references` 更新が PR に含まれる (validator が機械検証)

---

# §5 補助 1: 緊急経路 (recovery / hotfix) 受入条件

## 5.1 recovery kind の本文 7 必須セクション

| # | セクション header | 内容 |
|---|------------------|------|
| 1 | `## §1 事故記録` | timestamp / impact / 検知元 |
| 2 | `## §2 議論順序 timeline` | 発生 → 検知 → 対応の時系列 |
| 3 | `## §3 認識訂正履歴` | 当初仮説 → 実際の状況の差分 |
| 4 | `## §4 中間結論 list` | 対応中に判明した中間判断 |
| 5 | `## §5 context 再構築` | session 復帰時に必要な前提 |
| 6 | `## §6 再開ポイント` | 次セッションでどこから再開するか |
| 7 | `## §7 再発防止` | 観点リスト / CI チェック追加案 |

`ut-tdd plan lint` は recovery kind PLAN の本文に上記 7 セクション header (h2、`## §N <名称>` 形式) があるか機械検証。1 つでも欠落 → exit 1。

## 5.2 hotfix ブランチの要件

| 要件 | 機械検証 |
|------|----------|
| `hotfix/*` ブランチからの PR は postmortem doc を必須 | PR body に `## Postmortem` セクションがある (`harness-check` の `hotfix-postmortem-required` subjob) |
| postmortem doc は `docs/postmortem/<plan-id>.md` に配置 | path 存在確認 |
| `hotfix/*` PR は recovery kind PLAN へリンク | PR body に `recovery PLAN: PLAN-XXX` の記述 |
| postmortem 完了期限 | merge 完了から 48h (P0/P1 のみ必須、§5.2.1) |

### 5.2.1 postmortem 48h SLA の起算と severity 判定 (R-P2 fix)

| 項目 | 仕様 |
|------|------|
| **起算 timestamp** | hotfix PR の merge 完了時刻 (`gh api` の `merged_at`) |
| **severity source** | `recovery PLAN` 本文の §1 事故記録に `severity: P0 \| P1 \| P2 \| P3` を必須記述、これを source-of-truth とする |
| **対象範囲** | `severity ∈ {P0, P1}` のみ 48h SLA 適用、P2/P3 は SLA なし |
| **自動 reminder** | weekly cron `escalation-stale.yml` が `merged_at + 48h` を超過した未 close postmortem を検出し、PR に `postmortem-overdue` label を自動付与 |

## 5.3 session 終了前 fail-close (4 項目、R-C4 fix で fail-close と warning を明示分離)

ローカル pre-push hook が以下 4 項目を検証:

| # | 項目 | 検証方法 | 判定 |
|---|------|----------|------|
| 1 | **設計 ⇔ 実装 ⇔ テストの整合性** | `vmodel_lint` 軽量版 (current branch の差分対象のみ、§2.4 必須 8 directed edge の P0 のみ検査) | **fail-close (exit 1)** |
| 2 | **未 commit ファイルの取り残し** | `git status --porcelain` が non-empty | **fail-close (exit 1)** |
| 3 | **認識ずれの記録** | session 中に `failure_log.jsonl` 追記があれば recovery PLAN 起票推奨 | **warning** (exit 0、stderr) |
| 4 | **次セッションへの引き継ぎメモ** | `.ut-tdd/handover/CURRENT.json` の `updated_at` が 24h 以内 (`handoverStale`、PLAN-L7-04) | **warning** (exit 0、stderr) |

→ item 1-2 は push を中止、item 3-4 は push 続行 + warning。

## 5.4 受入条件 (補助 1、R-C4 fix で §5.3 と整合)

- [ ] kind=recovery PLAN は本文 7 セクション header (`## §N`) を持つ (validator が機械検証)
- [ ] hotfix/* PR は postmortem doc + recovery PLAN リンクを必須
- [ ] pre-push hook が §5.3 の判定列に従う:
  - item 1 (vmodel 整合) と item 2 (未 commit) → fail-close (exit 1)
  - item 3 (failure_log) と item 4 (handover) → warning (exit 0、stderr 出力)
- [ ] §5.2.1 の SLA 起算 (`merged_at + 48h`) を超過した未 close postmortem に `postmortem-overdue` label が自動付与

---

# §6 補助 2: GitHub 統制要件

## 6.1 ブランチタイプ × kind の対応 (R-C5 fix で全 12 kind + 2 例外 prefix(docs/chore) 網羅)

> 表は 10 prefix 行。うち 8 prefix が §1.3 の全 12 kind を担い (design→design+charter / add→add-design+add-impl / hotfix→recovery+troubleshoot / refactor→refactor+retrofit)、残り 2 prefix (`docs/*` `chore/*`) は PLAN 不要の例外。

`branch-kind-check` (§7.4) が PR 起票時に prefix と PLAN kind の整合を機械検証する。

| ブランチ prefix | 対応 kind | 用途 |
|----------------|-----------|------|
| `feature/*` | `impl` | 通常実装 (経路 1) |
| `design/*` | `design` / `charter` (R-C5 fix) | 設計 doc・L0 企画書起票 (経路 1 / 前段) |
| `research/*` | `research` (R-C5 fix) | 技術調査 (経路 1 前段) |
| `poc/*` | `poc` | 仮説検証 (経路 2 Scrum) |
| `reverse/*` | `reverse` | 設計復元 (経路 2 Reverse) |
| `add/*` | `add-impl` / `add-design` | 既存拡張 (経路 3) |
| `hotfix/*` | `recovery` / `troubleshoot` | 緊急 (補助 1) |
| `refactor/*` | `refactor` / `retrofit` | 内部改善 |
| `docs/*` | (PLAN 不要、例外) | ドキュメントのみ修正 (§7.4 例外 branch) |
| `chore/*` | (PLAN 不要、例外) | 雑務 (依存更新、CI 設定変更等) |

`docs/*` と `chore/*` は PLAN 起票不要の例外 branch (§7.4 で `branch-kind-check` の対象外として扱う)。ただし `docs/skills/*.md` の追加・更新は harness behavior に影響するため例外扱いしない。`skill_doc` 成果物を持つ PLAN 付き branch (`design/*` または `add/*`) で扱う。

## 6.2 Required Status Checks の集約方針

**`harness-check` ワークフロー 1 本のみを Branch Protection の Required Status Checks に指定**。

- 全 PR 共通の必須 check は `harness-check` のみ
- `harness-check` 内部で branch prefix を識別し、branch type 別 subjob を呼び分け
- branch type 別の subjob (例: `poc-no-merge-guard`, `hotfix-postmortem-required`) は `harness-check` 内で呼ばれるため自動的に merge gate となる
- Required Status Checks には登録しない (集約された `harness-check` のみで gate)

実装詳細 (job 定義 / step 順序 / 並列度) は将来の個別 PLAN-XXX で詳細設計する。

## 6.3 harness-check 内 subjob リスト + branch type 適用 matrix (R-C8 fix)

| subjob | feature 系 | design 系 | research 系 | poc 系 | reverse 系 | add 系 | hotfix 系 | refactor 系 | docs 系 | chore 系 |
|--------|---------|--------|----------|-----|---------|-----|--------|----------|------|-------|
| `plan-lint` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `vmodel-lint` | ✓ | ✓ | — | — | — | ✓ | — | ✓ | — | — |
| `branch-kind-check` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `scrum-reverse-lint` | — | — | — | ✓ | ✓ | — | — | — | — | — |
| `poc-no-merge-guard` | — | — | — | ✓ | — | — | — | — | — | — |
| `hotfix-postmortem-required` | — | — | — | — | — | — | ✓ | — | — | — |
| `commitlint` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `regression-test` | ✓ | — | — | — | — | ✓ | ✓ | ✓ | — | — |

→ `harness-check` 内部で適用 subjob を選択し、非適用 subjob は **`skipped` ステータス** で報告 (PR の Checks タブには表示されるが gate に影響しない)。

`harness-check` は PR 通過要件の正本である。ローカル hook は開発者体験と手戻り削減のための早期検知に限定し、全量テスト・重い検証・回帰確認は GitHub Actions 上で実行する。

## 6.4 poc → main 直 merge 物理ブロック

| 要件 | 仕様 |
|------|------|
| event trigger | `harness-check.yml` は `pull_request: branches: [main]` event で実行 |
| 検出ロジック | PR head が `poc/*` で base が `main` なら subjob `poc-no-merge-guard` が exit 1 |
| 例外 | なし (poc/* は S4 confirmed 後に Reverse → feature/* で再 PR する) |

## 6.5 CODEOWNERS bootstrap 2 段階

### Phase 0-A (リポジトリ初期化、CODEOWNERS なし)

- 全 PR は branch protection なしで merge 可能
- `harness-check` workflow は配備するが Required 化しない
- `@<bootstrap-owner>` (1 名) が全 PR レビュー

### Phase 0-B (CODEOWNERS 配備 + Required 化)

- CODEOWNERS を `tl-team` / `qa-team` / `po-team` などのチームに割り当て
- `harness-check` を Required Status Checks に登録
- Branch Protection の `required_pull_request_reviews.required_approving_review_count` を 1 に設定
- bootstrap-owner から各 owner team へレビュー責任を移管

> **`ut-tdd setup` solo/team がこの 2-stage の emission を担う** (PLAN-L6-05/L7-03、REVERSE-04 back-fill): 参加規模 (owner 種別 / collaborator 数 / 既存 CODEOWNERS・protection) を gh で検出 → solo(0-A)/team(0-B) を提案 → 人間確認 → `.ut-tdd/state/setup.json` に確定値記録 → phase 別の GitHub 設定を出し分け生成。数だけで自動確定しない (提案どまり)。`--solo`/`--team` で上書き、検出不能・非対話は solo 安全フォールバック。CODEOWNERS / workflow / ISSUE・PR テンプレ等の **ファイルは harness が emit** するが、**branch protection / Required 化は gh-api 操作で emit-only 既定** (`scripts/setup-branch-protection.sh` 生成のみ、適用は admin 人間サインオフ = 認可・本番影響境界)。境界契約は L4 external-if §3 を正本とする。

## 6.6 commitlint 設定

Conventional Commits v1.0.0 準拠。型は `feat / fix / docs / style / refactor / test / chore / perf / ci / build / revert` のみ許容。

```
type(scope): subject
↓
feat(auth): JWT 認証を追加
fix(api): null pointer 例外を修正
```

PR 内の全 commit が Conventional Commits 形式に従う (`harness-check` 内 `commitlint` subjob で検証)。

## 6.7 受入条件 (補助 2)

- [ ] `harness-check` のみを Branch Protection の Required Status Checks に指定
- [ ] `harness-check` 内で §6.3 matrix に従い 8 subjob が branch type 別に呼ばれる
- [ ] 非適用 subjob は `skipped` ステータスで報告 (R-C8)
- [ ] poc/* → main の PR が `poc-no-merge-guard` で exit 1
- [ ] hotfix/* → main の PR が postmortem doc + recovery PLAN リンクなしで exit 1
- [ ] 全 commit が Conventional Commits 形式 (commitlint subjob で検証)
- [ ] Phase 0-A → 0-B 2-stage で CODEOWNERS bootstrap

## 6.8 PLAN git ライフサイクル (Issue 起点スパイン、TL review 2026-06-02)

> **対象レイヤー**: 本節は **harness の利用者チームに課す製品仕様** (git topology) であり、harness 開発者 (solo / main 直) の手順ではない。Phase 0-A (solo) では本節の branch/PR 強制は緩和され、Phase 0-B (team) で有効化する (§6.5)。

### 6.8.1 Issue = 問題起点スパイン

UT-TDD の全作業は **問題 / ギャップ起点**である。Forward 自体も「発注元 Issue (要件 = 埋めるべきギャップ)」起点 (構想書 §2.5 経路1 entry)。よって **GitHub Issue を作業追跡のスパイン (背骨)** とし、次の一本道で管理する:

```
問題/signal 検出 or 改善 backlog エントリ
  → Issue 起票 (問題・signal の記録)
  → signal→mode routing (§7.8.1) で応答 mode 決定
  → PLAN 起票 (Issue を解決する V-model 作業単位)
  → branch (§6.1 kind↔prefix で隔離)
  → commit (§6.8.3 単位)
  → PR + CI (§6.9 単位で検証)
  → merge + Issue close
```

- **起点は「実観測 signal」と「計画的改善 backlog エントリ (§1.10.G.12 improvement-backlog)」の双方**。Refactor / Retrofit のような能動的負債対処も backlog 起点 Issue として合法 (signal が無くても backlog エントリがあれば起票可)。
- off-Forward (Reverse / Recovery / Incident / Discovery / Scrum / Refactor / Retrofit / Add-feature) は全て「問題への応答」。右腕テスト失敗の差し戻し (§3.1.5) も問題 = Issue 化する。
- 起票主体は **Phase 0 では手動 default** (harness は `next_action` に起票手順を提示するのみ)。半自動 (issue template URL suggest) / 自動 (webhook) は将来 PLAN で詳細設計。

### 6.8.2 Issue / PLAN / branch の粒度 (1:1:1 原則)

| 関係 | 規約 |
|------|------|
| 基本 | **1 Issue = 1 PLAN (または 1 Master hub) = 1 branch** |
| sub-doc 分割時 (L1-L6) | 子 sub-doc PLAN は **Master hub branch から派生**し、子 PR は Master hub PR にまとめて (squash) merge。子ごとに別 Issue/別 branch にしない (並行 merge 衝突回避) |
| 既存バグの顕在化 | **別 Issue + 別 PR** で扱い、進行中 PR に混ぜない (運用ルール書 §2 踏襲) |

PLAN frontmatter に **`github_issue_id`** (optional、Phase 0-B で recommended) を持たせ、`branch-kind-check` が「feature/* / hotfix/* branch の PLAN に `github_issue_id` 設定」を warn、Issue close 漏れ (merge 済なのに Issue open) を機械検知する (§8.6 失敗変換ループの一部)。PR body は `Closes #<github_issue_id>` を必須フィールドとする。

### 6.8.3 status × kind/mode × freeze → git アクション対応

| PLAN フェーズ | git アクション |
|--------------|----------------|
| 問題/signal 検出 (off-Forward) | **Issue 起票** (signal を記録、後続 PLAN/PR を `Refs #NN`) |
| PLAN draft 起票 | §6.1 kind↔prefix で branch 作成 (design→`design/*` / impl→`feature/*` / poc→`poc/*` / reverse→`reverse/*` / incident・recovery→`hotfix/*` / add→`add/*`)。draft PR を即開く (WIP 可視化) |
| 設計層 Pair freeze (G1-G6) | sub-doc 単位 commit。**設計 PLAN 完了 PR (hub→main) で `vmodel-lint` を必須 CI 実行** (G1-G6 pair freeze を CI で機械担保。ローカル hook のみだと `--no-verify` バイパスで AP-8 逆ピラミッドが CI 前に main へ入るため、§6.9 の CI 単位と接続) |
| L7 TDD Red freeze (A2) | ④ 先行テストを RED 状態で 1 commit (trace 用) |
| L7 trace freeze (G7) | 実装 commit → **impl PR を ready-for-review に昇格** (4 artifact + 8 edge + coverage が揃う点) |
| G7 通過 (harness-check green) | **feature/* → main merge** (impl の merge gate = G7) |
| L12 (G12) | deploy gate、po サインオフで本番反映 |
| PLAN completed / Forward 合流 | Issue を `Closes #NN`。off-Forward は fullback / routing 完了で close |

### 6.8.4 右腕 (L8-L14) CI 失敗時の差し戻しスパイン (TL Critical fix)

右腕は §6.9 で **post-merge / scheduled CI** とするため、G7 通過後に L8/L9 等で失敗した実装が main に滞留しうる。スパインを切らさないため:

- 右腕 CI (harness-check schedule job) が **失敗を検知したら Issue を自動起票** (`regression_*` signal 付き) し、**concept §3.1.5「右腕工程の差し戻しルール (L8-L14)」正本**の差し戻し先 (L8→L5/L7・L9→L4・L10→L2・L11→L3/L1・L12→L3/L7・L13→Incident・L14→L1/L3) と紐づける。
- そこから **Recovery (`regression_dev`) または Incident (`regression_prod`) / Add-feature** で差し戻し PLAN を起票する。
- **Accept 条件**: 右腕 CI 失敗から差し戻し Issue 起票まで **検出サイクル 1 周以内** (scheduled job 1 run)。未起票のまま次の merge を進めない。

### 6.8.5 PLAN 完了時 handover (必須、PO 2026-06-02)

**PLAN が `status=completed` に遷移する時、handover の生成を必須**とする (継続性・引き継ぎの担保)。「完了したが何を次にやるか不明」を構造的に防ぐ。

- **必須内容**: ① PLAN サマリ (kind/layer/何をしたか) / ② 成果物 (generates 実体 + commit) / ③ **Next Action** (順序付き) / ④ carry (未了・先送り) / ⑤ 未了 PO 判断 (escalation) / ⑥ 壊さない注意。
- **入力**: **session-log の PLAN ダイジェスト** (`.ut-tdd/logs/plan/<plan_id>.digest.json`、§6.8.1 / PLAN-L6-03) を機械的入力にできる (touched files / commits / failures)。これに人間判断 (Next Action / carry) を足して handover とする。
- **配置**: チーム継続記録 = `docs/handover/session-handover-<date>[suffix].md` (tracked) / 機械ポインタ = `.ut-tdd/handover/CURRENT.json` (local, gitignored)。
- **検証 (IMP-047 で機械 surface 化)**: PLAN 活動 (active_plan + digest) があるのに `CURRENT.json` が未生成 / stale / 別 PLAN を指す (drift) → `checkHandoverDiscipline` が warn を返し、**Stop-hook (`ut-tdd session summary` = `bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session summary`、stderr、fail-open) と `ut-tdd doctor` (`checkHandover`) の 2 機構で機械 surface** する (PLAN-L7-06)。`plan-lint` / pre-push への配線は lint engine (`src/plan/lint.ts` stub) 実装時の carry。それまでは本機構 + 人手 binding が併存。
- **手書き bypass 検知 (IMP-078 gap①、enforcement gap の機械着地)**: 上記 discipline は presence/freshness しか見ず、`ut-tdd handover` を経ない**手書き bypass** (手書き markdown + 手書き CURRENT.json) を素通りさせていた (本 harness 開発で実証 = 柱 2 doc×機械厳格化を自分の handover 規律で破った under-design)。`checkHandoverBypass` が ① CURRENT.json の `generated_by` 署名欠落 (手書き pointer) / ② latest_doc の entry 数 > 記録 `doc_entry_count` (手書き追記) で検知し、Stop-hook が discipline と併せて surface する (PLAN-L7-17)。あわせて gap②(active-plan marker stale = current-plan 2 行目 updated_at + `activePlanStale`) / gap③(commit hash 捕捉 = `headCommit`) / gap④(§1-§2 の session scope = `scopeToSession`/`latestSessionId`) / gap⑤(bare plan_id の family 解決で `(unknown)` kind 防止) を同 PLAN で機械担保する。
- **粒度**: 1 PLAN = 1 handover entry を要しない。**1 作業セッション or 1 駆動サイクル単位で束ねた handover に当該 PLAN の completion を記録**すれば足る (過剰生成を避ける)。
- **詳細設計 (artifact schema + 自動生成機構)** は **`PLAN-L6-06-handover-mechanism` (設計) / `PLAN-L7-04-handover-mechanism` (実装) で確定済** (2026-06-04)。機械ポインタ正本 = `.ut-tdd/handover/CURRENT.json` (CURRENT.md は廃止、PLAN-REVERSE-05)、生成は `ut-tdd handover` (digest から機械部 ①② prefill + ③-⑥ human placeholder)、活性化は `ut-tdd plan use <id>` で `.ut-tdd/state/current-plan` を設定。

### 6.8.6 進捗管理 = log + handover + state DB の 3 層組合せ (PO 2026-06-02)

進捗は単一機構でなく **3 層の組合せ**で管理する。各層は役割が直交し相互補完する:

| 層 | 実体 | 役割 (何を答えるか) | 性質 |
|----|------|---------------------|------|
| **UT-harness DB (state)** | `.ut-tdd/harness.db` SQLite projection DB + `.ut-tdd/` YAML/JSON state。主要 table: plan_registry / artifact_registry / model_runs / trace_edges / coverage / findings / gate_runs (FR-L1-06) | **今どこまで進んだか** (V-model 製本 state、別駆動 model の実行結果、孤児 0 / coverage / ゆがみ・もれを機械保証) | 機械 SSoT、doctor / vmodel lint で fail-close ([[feedback_vmodel_state_db_completeness]]) |
| **log (session-log)** | session イベント + PLAN ダイジェスト (FR-L1-07 ext、§6.8.1、PLAN-L6-03/L7-01) | **どう進めたか** (作業の事実トレイル: touched files / commits / failures) | 観測、fail-open、ephemeral → PLAN digest |
| **handover** | PLAN 完了 / session 境界の継続記録 (§6.8.5) | **次どうするか** (Next Action / carry / 未了 PO 判断) | 人間判断、durable |

**組合せ原則**: state DB = 「正本の進捗」、log = 「事実の裏付け」、handover = 「判断の継続」。3 者を突合して進捗を多面管理する (DB だけでは『なぜ/次』が、log だけでは『正本 state』が、handover だけでは『機械保証』が欠ける)。**session-log の PLAN ダイジェストは log→handover の橋渡し (§6.8.5 入力) かつ state DB 登録 (FR-L1-07 hook) のトリガ**でもあり、3 層の結節点になる。**digest の活性化** = `.ut-tdd/state/current-plan` を `ut-tdd plan use <id>` で設定すること (`resolveActivePlan` の入力)。solo/main 直開発では branch から PLAN を読めず plan_id が null になり digest が生成されない Gap があるため、この明示設定で結節点を活性化する (PLAN-L7-04、`resolveActivePlan` 本体は不変)。

**artifact progress color projection (FR-L1-51 / PLAN-L7-56 / PLAN-REVERSE-56)**: `harness.db` は artifact 単位の進捗色を derived projection として保持しなければならない。`red` は依存関係未確認、未回収の impact、または実装に対する要件/基本設計/詳細設計/テスト back-propagation 欠落を示す。`yellow` は実装中、recovery 中、または linked test evidence 未確認を示す。`green` は linked test ID/path が存在し、依存 impact が clear であることを示す。色は手入力の status ではなく、source artifact、covered-by test edge、impact_results、recovery PLAN から再構築できる derived state とする。


### §6.8.7 DB 参照 feedback と自動化基盤 bundle (2026-06-08)

以下を FR-L1-05/06/07/09/12/13/17/18/19/20/33/37/39/40/41/45/46/47/48/49 の束ね要件として扱う。これは V-model state の保存だけではなく、機械チェック結果・駆動モデル別実行・ログ・skill/model telemetry・workflow 自動化 readiness・guardrail 安全判定・skill/roster/command 文書基盤を SQLite projection DB に投影し、抜け漏れ・依存関係・ゆがみの検出と検索コスト低減に使う要求である。

| 要求 | 受入条件 |
|---|---|
| `harness.db` は参照グラフを持つ | `plan_registry / artifact_registry / trace_edges / gate_runs / coverage / findings / model_runs` に加え、`drive_runs / hook_events / skill_invocations / skill_recommendations / feedback_events / search_index / quality_signals` 相当の投影を持つ。 |
| 全駆動モデル・各ログを PLAN/session と join できる | drive/mode/run/log/finding は `plan_id` または `session_id` の少なくとも一方を持ち、孤児は doctor が finding 化する。 |
| skill 発火率を計算できる | 推薦された skill、実際に発火した skill、採用/却下、理由、layer/drive/model/run を保存し、`fired / recommended` と `accepted / fired` を再計算できる。 |
| フィードバック機構になる | lint/doctor/vmodel/gate/review の機械結果は `findings` と `quality_signals` に並び、同種反復・未解決・依存詰まりを `feedback_events` として再計画入力にできる。 |
| 探すコストを下げる | PLAN/artifact/finding/skill/model/session の検索用 projection を持ち、`ut-tdd find` 相当の CLI が path/ID/reason/evidence を返せる。 |
| workflow 自動化 readiness を判定できる | Forward/Add-feature/Reverse/Recovery などの workflow run、gate/CI/doctor 結果、blocked/human-required 状態を同じ `plan_id` / `session_id` / `drive_run_id` で参照できる。 |
| artifact progress を赤黄緑で検索できる | `artifact_progress` projection は `artifact_path`, `artifact_type`, `state`, `color`, `linked_test_ids`, `linked_test_paths`, `dependency_checked`, `open_dependency_impacts`, `recovery_plan_ids`, `reason` を持ち、`ut-tdd progress artifacts` 相当の CLI が赤/黄/緑と根拠を返せる。green は linked test + dependency clear を必須とし、上位設計反映漏れや依存未確認は red として残る。 |
| guardrail の安全性を証跡化できる | agent-guard、review_evidence、same-model approval 禁止、tests-before-review、escalation 境界、human signoff の判定結果を `guardrail_decisions` 相当の projection として持ち、silent pass を finding 化できる。 |
| skill/roster/command docs を自動化基盤として catalog 化できる | skill/roster/command docs の path、trigger、role/capability、drift status、recommendation reason、search token を catalog projection として持ち、空 catalog・legacy source 前提残存・guard 不整合を検出できる。 |
| UT evidence history を query できる (A-122 / IMP-109) | `test_cases / test_runs / test_results / test_artifact_edges / test_flake_events` 相当の projection を持ち、どの UT がどの PLAN / FR / U-* oracle / artifact を証明したか、いつ green だったか、flake や duration regression があるかを参照できる。 |
| 定量 green profile を再現できる (A-122 / IMP-108) | `review_evidence.tests_green_at <= reviewed_at` に加え、`GreenDefinition` として required command profile、runner (`bun` / powershell / bash / ci)、scope、exit code、evidence path、output digest を記録し、定性レビューが正しい定量 green の後に実施されたことを検証できる。 |
| DB projection 実装 profile を固定する (A-122 / IMP-110) | Core runtime は Bun/TypeScript を前提に `bun:sqlite` を第一候補とし、schema_version、deterministic rebuild、migration fixture、doctor integration、redacted failure digest を持つ。DB は projection であり docs/state/logs を authoring source として残す。 |
| CI / hook / OS evidence matrix を保持できる (A-122 / IMP-114) | PowerShell / Bash / Bun / Claude hook / CI の smoke と green command evidence を同じ projection profile で比較でき、Windows/POSIX 片側欠落を finding 化できる。 |
| 機密を保存しない | provider transcript 本文、secret、credential、PII は保存対象外。DB は ID、digest、metadata、evidence path、redacted summary のみを持つ。 |

補強に使った外部設計 reference: SQLite FTS5 の external/contentless index pattern は再構築可能な検索 projection の参考、OpenTelemetry semantic conventions は traces/logs/metrics/events 命名の参考、W3C PROV entity/activity/agent provenance model は reference graph 思考の参考とする。これらは L5 時点で外部 runtime 依存を追加しない。

L5/L6 降下先: `docs/plans/PLAN-L5-08-harness-db-feedback.md`、`docs/design/harness/L5-detailed-design/physical-data.md` §9 / §9.4、`module-decomposition.md` Appendix B、`internal-processing.md` Appendix B、`if-detail.md` Appendix B、`docs/design/harness/L6-function-design/test-before-review.md` §8、`docs/design/harness/L6-function-design/function-spec.md` Harness DB addendum、`docs/test-design/harness/L8-integration-test-design.md` IT-DB/IT-SEARCH/IT-FEEDBACK/IT-AUTOMATION/IT-GUARDRAIL/IT-ASSET-DB。A-122 の Phase 3/4 seed は IMP-107..116。

### §6.8.8 下位 L discovery の Reverse back-propagation (全体一貫性原則、2026-06-09)

下位 L (L4-L14、特に L6/L7 実装・テスト・レビュー・右腕検証) で追加機能、改善起票、受入条件変更、DB projection、guardrail、workflow rule、automation rule、または既存 FR の意味拡張を発見した場合、局所 carry だけで完了扱いしてはならない。全体一貫性のため、発見時点で PLAN / audit / improvement backlog に **back-propagation decision** を記録し、次のいずれかへ分類する。

| decision | 条件 | 必須処置 |
|----------|------|----------|
| `local_impl_only` | 既存 L1/L3/L4-L6 の意味・受入条件・外部契約・運用手順を変えず、実装内の局所補正だけで閉じる | 理由と対象範囲を audit に記録。上位 doc 更新不要の根拠を残す |
| `requires_design_normalization` | 要求は不変だが、L4-L6 設計、テスト設計、DB/IF/関数分解、workflow detail の整合補正が必要 | Reverse `normalization` または `design` PLAN を起票し、L4-L6 / test-design へ back-fill する |
| `requires_requirement_backprop` | FR、AC、受入条件、ユーザー価値、運用ポリシー、機能一覧、または要件束の意味が増える | Reverse `fullback` / `design` PLAN を起票し、L1/L3 registry・AC/AT・§1.10 registration へ back-merge してから Forward に戻す |
| `requires_concept_policy` | 企画価値、対象ユーザー、責任境界、本番影響、認証・認可・PII・ライセンス等の上位判断を変える | PO / 人間判断を gate とし、concept / requirements 更新後に Forward を再開する |

**完了判定**: 下位 L で発見した追加・起票が `requires_design_normalization` / `requires_requirement_backprop` / `requires_concept_policy` のまま未処理なら、元 PLAN を `completed` / `confirmed` と呼ばない。やむを得ず先行実装する場合は `add-design` / `add-impl` と `reverse/*` の pairing を明示し、未完了 carry ではなく back-prop 未了として handover に残す。

**記録項目**: PLAN §7 機能要求更新、audit record、または `docs/improvement-backlog.md` は `backprop_decision`、`reverse_type`、`target_layer`、`upstream_docs`、`evidence_path`、`closure_status` を持つ。`ut-tdd doctor` は `improvement-backlog` lint の `missingBackpropClassification` で、下位 L 由来の追加起票がこの分類を持たない場合に hard-gate する。G7 / accept では分類未記録を fail-close として扱う。

**未承認 L7 着手の扱い (PLAN-RECOVERY-03)**: `src/**` 追加・変更など L7 実装相当の作業を、parent L6 design / L7 PLAN / TDD Red entry / pair artifact なしに開始した場合は `agent_runaway` 相当の Recovery 事象として扱う。封じ込めでは未承認 source 差分を残さず、Recovery で reopen point を確定した後、Reverse `fullback` で本節・backlog・必要な workflow rule へ戻す。active goal や継続作業を理由に、この back-prop を省略してはならない。

**例**: A-122 の UT evidence history / GreenDefinition / Harness DB projection は単なる L5/L6 carry ではなく、既存 FR-L1-05/06/07/17/18/20/45/50 の `requires_requirement_backprop` 拡張として L1/L3/requirements へ back-propagation 済みと扱う。

#### §6.8.8.1 Forward-convergence fail-close (別フロー集約の機械強制、PLAN-DISCOVERY-08)

§6.8.8 の back-prop 原則を機械強制する。Forward (L0-L14 spine) は「きれいな最終正本 (製本)」であり、別フローの最終実態が Forward へ集約されるまで freeze (= 最終正本成立) を主張してはならない。

- **不変条件**: spine-外 (parent_design が `docs/design/` を含まず、requires が L1-L6 設計 PLAN / `docs/design/` を指さず、roadmap span 未登録) の `kind=impl` が landed (status=confirmed/completed) かつ backprop_decision / Reverse 合流 / version-up parked のいずれも無い場合、**NEW unconverged-landed = fail-close 違反**とする。`ut-tdd doctor` の `forward-convergence` gate が hard-fail する。
- **SSoT 非重複**: poc confirmed の集約は scrum-reverse (IMP-064)、add-impl/refactor/retrofit/troubleshoot は §6.8.8 の back-prop decision (KIND_BACKFILL) が担う。forward-convergence は残ギャップ (kind=impl spine-外 landed) のみを担い、判定を二重実装しない。
- **legacy debt**: fail-close 化以前から存在した未集約は `FORWARD_CONVERGENCE_LEGACY_DEBT` allowlist で grandfather し、`docs/governance/forward-convergence-legacy-debt-audit.md` との双方向一致を `forward-convergence-audit` hard check で担保する (免除でなく繰延。最終 disposition = Forward 集約 or `local_impl_only`、version-up 不可 = landed 済)。
- **version-up parked**: `version_target` (status=draft 限定、landed 付与禁止) を持つ将来版保全は正当な deferred 種別であり違反でない (§2.5 version-up mode、`version_deferral` signal §7.8.1、PLAN-DISCOVERY-09)。

### §6.8.9 成果物横断 relation graph / 可視化 / tool adapters (A-124, 2026-06-09)

UT-TDD は「1 つを直したら、関連する設計・コード・テスト・DB projection・PLAN・FR も合わせて直す」ために、横断 relation graph を `harness.db` projection として持つ。これは authoring source ではなく、docs / source / tests / PLAN / state / logs から再構築できる derived graph である。

**対象 edge**:

| edge kind | from | to | 目的 |
|-----------|------|----|------|
| `imports` | source file/module | source file/module | import graph、循環依存、逆依存、変更影響範囲 |
| `declares_module` | design artifact | module | 設計宣言と実装 module の drift 検出 |
| `implements` | source file/module | FR / PLAN / artifact | impl -> requirement/design/test の back-fill 漏れ検出 |
| `tests` | test case/file | source file/module / artifact / FR | 変更時に必要な test scope を出す |
| `references` | doc / PLAN / ADR / audit | doc / PLAN / FR / IMP | 文書横断の関連修正候補を出す |
| `projects_to` | docs/state/log source | DB projection table | DB projection の生成元・欠落・再構築影響を出す |
| `visualizes` | relation graph snapshot | diagram artifact | Mermaid / DOT / D2 などの図化成果物を trace する |

**必須クエリ**:

- `changed_path -> impacted_artifacts`: 変更ファイルから関連 FR / PLAN / design / test / DB table / diagram を列挙する。
- `module -> reverse_dependencies`: module を直した時に影響する import 逆向き利用者を列挙する。
- `artifact -> required_tests`: artifact / FR / module に対して必要な UT / integration / acceptance test scope を列挙する。
- `open_finding -> impacted_workflow`: finding が閉じるまで止めるべき PLAN / gate / workflow を列挙する。
- `relation_graph -> diagram`: graph snapshot を Mermaid / DOT / D2 のいずれかへ export し、review / handover で読める図にする。

**粒度と再現性 (A-128 F-3 back-fill、2026-06-10)**:

- graph node は doc 粒度に加えて **section 粒度を保持する** (`graph_nodes.section_id`、FR/AC/AT ID は `subject_id`)。section 単位の変更を doc 単位に丸めず、`changed_path -> impacted_artifacts` が FR / AC / AT / § レベルで impact expansion できること (physical-data §9.5 と対)。
- diagram / impact 結果は **`graph_snapshots` (hash / source_digest) から再現可能**であること。同一 snapshot からの再 export は同一 diagram を生む (physical-data §9.5 `graph_snapshots` の要求根拠)。

**tool adapter 方針**:

- Core collector は TypeScript/Bun で実装し、`bun:sqlite` へ projection する。外部 package は authoring source にしない。
- `dependency-cruiser` は JS/TS dependency rule + visualization の optional adapter 候補。循環依存、禁止依存、package.json 欠落、orphan 検出を候補にする。
- `knip` は unused dependency / file / export 検出の optional adapter 候補。relation graph の dead-node 検出補助にする。
- `madge` は circular dependency / dependency graph の optional adapter 候補。Graphviz 連携が必要な図化は optional とする。
- `Graphviz DOT` は large graph の SVG/PDF/PNG export、`Mermaid` は GitHub Markdown で読める軽量 diagram、`D2` は設計レビュー向けの整った diagram export の候補とする。
- tool output は `tool_runs` / `dependency_edges` / `diagram_artifacts` / `findings` に正規化し、tool 固有形式のまま gate 判定しない。

**完了判定**: A-124 の実装が入るまで、`doctor` の `relation-graph / dependency-drift / regression expansion` は scaffold stub として扱う。module/asset/change-impact の現行検査 green は、横断 impact expansion 完了の証拠ではない。

### §6.8.10 MCP / 外部テスト tool の scope と workflow trigger (A-125, 2026-06-09)

A-124 の relation graph / diagram / impact expansion は、MCP server や外部テスト基盤を使うことで大幅に強化できる。ただし MCP server は host 権限・filesystem・browser・GitHub・DB へ接続し得るため、常時接続や raw tool output gate は禁止する。UT-TDD は **allow-list された tool profile を workflow trigger で必要時だけ起動し、結果を DB projection へ正規化して gate が見る**。

#### 採用候補 (Web research 2026-06-09)

| 分類 | 候補 | scope | 採用方針 |
|---|---|---|---|
| MCP discovery / trust | MCP Registry | 公開 MCP server metadata / install metadata / namespace verification | discovery metadata 専用の候補。Registry metadata は security scan ではない。 |
| MCP debug / test | MCP Inspector | MCP server の tools/resources/prompts 接続確認、local server smoke | UT-TDD 管理 MCP server または構成済み server profile の優先検証 tool。 |
| Browser automation MCP | Microsoft Playwright MCP (`@playwright/mcp`) | 探索的 browser verification、self-healing E2E investigation、screenshots | 任意の対話的 verification profile。決定的 CI では Playwright CLI/tests を優先。 |
| GitHub workflow MCP | GitHub MCP Server | issues / PR / repos / actions / code_security toolsets | issue/PR/backlog automation 用の任意 profile。既定は狭い toolset または read-only mode。 |
| Reference MCP servers | filesystem / git / memory / fetch / postgres / sqlite | local file、git、memory graph、web fetch、DB inspection | reference または管理済み local profile のみ。既定 profile で production credential を使わない。 |
| Containerized MCP gateway | Docker MCP Toolkit | signed/attested container images、OAuth、resource limits、profile-based MCP gateway | Docker Desktop 利用時の team/enterprise runtime profile 優先候補。 |
| Test foundation | Vitest Browser Mode + Playwright provider | browser-native component tests と UI interaction checks | UI/browser 対象 harness または target repo 向けの任意 L7/L8 test profile。 |
| Test foundation | Testcontainers for Node.js | disposable DB/service containers for integration/smoke tests | Docker 利用時の任意 integration-test profile。 |
| API mocking | MSW | browser と Node tests の reusable REST/GraphQL/WebSocket mocks | API-bound tests と fixture standardization 向けの任意 mock profile。 |

#### Workflow trigger ルール

- `signal=ui_flow`、`web_target`、または `browser_regression` は `mcp_profile=playwright` や `test_profile=vitest-browser-playwright` を推奨する。
- `signal=external_issue`、`ci_failure`、`pr_review`、または `backlog_sync` はまず `mcp_profile=github-readonly` を推奨し、書き込み toolset は明示的な人間承認を要求する。
- `signal=db_integration`、`migration`、または `service_contract` は `test_profile=testcontainers` と DB projection review を推奨する。
- `signal=api_mock_gap` または `flaky_external_api` は `test_profile=msw` を推奨する。
- `signal=mcp_server_added` または `mcp_profile_changed` は MCP Inspector smoke (`tools/list` minimum) を実行し、`mcp_server_runs` を記録する。

#### 安全性と自動化の制約

- MCP profiles は既定で disabled。`ut-tdd mcp profile enable <name>` は将来 scope とし、Git 管理 secrets の外に generated local config を書く必要がある。
- 各 profile は `allowed_tools`、`read_only`、`requires_network`、`requires_docker`、`requires_auth`、`secret_policy`、`risk_tier`、`trigger_signals` を持つ。
- 既定 GitHub MCP profile は read-only とし、discovery/status に必要な最小 toolset だけを有効化する。PR/issue write actions は明示的な `requires_human_approval` を要求する。
- Filesystem と Git MCP profiles は workspace root に制限し、global home-directory mount を与えない。
- Raw MCP responses、browser traces、screenshots、external tool logs は evidence files とする。Gate decisions は正規化済み `tool_runs`、`mcp_server_runs`、`test_runs`、`dependency_edges`、`impact_results`、`findings` を使う。
- `mcp_server_runs` / `verification_recommendations` は **`session_id` / `plan_id` を保持**し、どの PLAN / session に紐づく外部検証かを trace 可能にする (handover / review evidence と突合できること。physical-data §9.6 カラムの要求根拠、A-128 F-3 back-fill)。
- MCP Registry / Docker Catalog / npm / PyPI metadata は discovery を補助できるが、profile を `trusted` にする前に official source verification と package integrity checks を必須とする。

#### コマンド

- `ut-tdd mcp profile list --json`
- `ut-tdd mcp profile probe <name>`
- `ut-tdd mcp inspect <name> --method tools/list [--allow-external]`
- `ut-tdd verify recommend --changed <path> [--format text|json|mermaid] [--save-evidence]` -> changed-file signal graph -> 推奨 MCP/test profiles
- `ut-tdd verify run --profile <name> [--dry-run] [--allow-external] [--save-evidence]` -> 既定では built-in profiles を実行する。external profiles は実行前に明示 allow-list と probe checks の通過を要求する

`--save-evidence` は後続 DB collector/rebuild 用の normalized JSON records を `.ut-tdd/evidence/verification-profiles/` 配下に書く。これらは bounded metadata evidence であり、raw provider transcripts や secret-bearing tool output ではない。

**完了判定**: A-125 は requirements、physical data、ADR/backlog/audit、workflow docs が candidate tools、trigger rules、安全制約、DB projection tables、commands を定義した時点で scope 済みとする。最初の runtime slice は `ut-tdd mcp profile list/probe`、`ut-tdd mcp inspect` readiness gating、`ut-tdd verify recommend`、`ut-tdd verify run --dry-run`、`--save-evidence`、`doctor` が profile catalog / readiness / recommendation evidence を surface した時点で実装済みとする。Full implementation には、実 MCP Inspector server invocation、external profile execution evidence、external verification rows 用 DB collector/rebuild がまだ必要である。

### §6.8.11 正本 document export (A-126, 2026-06-09)

A-124/A-125 により relation graphs、diagrams、MCP/test profiles、evidence は query 可能になる。人間 reviewer には、正本 UT-TDD documents (concept / planning、requirements、detailed design、PLAN、ADR、test-design documents) の spreadsheet / Excel / PPTX 変換も必要になる。よって UT-TDD は **canonical document export** を derived artifacts として scope する。

**正本境界**:

- Markdown/source documents、PLANs、ADRs、test-design docs、DB projection rows、tests、evidence records を authoritative とする。
- CSV / Markdown summary / XLSX / PPTX files は generated conversion artifacts のみとする。
- Exported files は source document paths、source section IDs、snapshot hash、renderer、format、path、redaction profile、evidence path を記録しなければならない。
- export artifact の削除や手編集は harness truth を変更しない。export に基づく人間判断は review / gate / handover evidence として別途 import または記録する。

**基準出力**:

- `doc-csv-matrix`: built-in、zero-dependency。requirements、design、PLAN、ADR、test-design matrices 向けの deterministic columns を持つ。
- `doc-markdown-summary`: built-in。source links と section IDs を持つ GitHub-readable conversion summary。

**任意 renderer 出力**:

- `doc-xlsx-workbook`: concept、requirements、design、PLAN、ADR、trace、test-design rows の複数 sheet を持つ Excel workbook。候補 adapter は ExcelJS または SheetJS。
- `doc-pptx-deck`: concept、requirements、detailed design、PLAN、ADR、test-design structure から生成する PowerPoint deck。候補 adapter は PptxGenJS。
- `doc-d2-pptx-diagram`: D2 readiness が証明された場合の architecture / workflow / relation graph visuals 向け diagram-to-PPTX export。

**Trigger ルール**:

- `requirements_export`、`fr_ac_at_matrix`、`acceptance_review` -> CSV と任意 XLSX を推奨する。
- `concept_export`、`planning_review`、`stakeholder_brief` -> Markdown summary と任意 PPTX を推奨する。
- `detailed_design_export`、`architecture_review`、`db_contract_review`、`api_contract_review` -> CSV/XLSX と任意 PPTX を推奨する。
- `plan_export`、`adr_export`、`test_design_export`、`handover` -> document family に応じて Markdown summary、CSV、任意 XLSX/PPTX を推奨する。
- `document_export_profile_changed` -> accept 前に renderer probe evidence を要求する。

**安全性と品質制約**:

- Exports は rendering 前に redact し、将来の人間承認済み policy が redacted attachment profile を定義しない限り、raw provider transcripts、credentials、secrets、PII、raw MCP payloads、screenshots、browser traces を含めてはならない。
- Optional renderers は既定で disabled。ExcelJS / SheetJS / PptxGenJS / D2 が無い場合は implicit installation ではなく finding を返す。
- Source section IDs / FR IDs / AC IDs / AT IDs / PLAN IDs / ADR IDs は generated spreadsheet/deck output で見える状態を保つ。
- Generated spreadsheets と decks は、明示 timestamp metadata を除き、同一 source snapshot から deterministic に生成されなければならない。
- Large exports は silent truncation せず、document family または section ごとに rows chunk や sheets/slides 分割を行う。

**完了判定**: A-126 は requirements、research、audit、physical-data、ADR/backlog、workflow docs、L6 function contracts、L7 unit oracles、L6/L7/Reverse PLANs が canonical document export profiles と safety boundaries を定義した時点で scope 済みとする。Runtime implementation には将来の L7 TDD Red entry が必要であり、本節は source changes を承認しない。

## 6.9 CI 起動単位とコスト方針 (GitHub Actions 無料枠制約、tech 裏取り 2026-06-02)

### 6.9.1 前提 (無料枠の実態)

| プラン / repo | 月間 Actions 分数 |
|--------------|------------------|
| Free・private | **2,000 分/月** |
| public (全プラン) | **無制限** |

runner コスト比 Linux : Windows : macOS ≒ **1 : 1.67 : 10** → **PR は Linux runner のみ**。社内 private repo 前提では分の節約が要件。**CI を回す単位 = merge する単位**であり、毎 commit では回さない (二層分担: ローカル hook = 安価・高頻度 / GitHub Actions = 高価・バッチ。Martin Fowler の commit-stage / secondary-stage 原則と整合)。

### 6.9.2 CI 起動単位 (integration-worthy だけ回す)

| 単位 | CI 起動 | 内容 / 理由 |
|------|---------|------------|
| 設計層 Pair freeze (L1-L6 各層) | ❌ ローカルのみ | trace / doc-consistency lint。層ごと CI は無駄 |
| **設計 PLAN / Master hub 完了 PR** | ✅ 1 回 | `vmodel-lint` 必須 (§6.8.3、G1-G6 を CI 担保) + doc-consistency + plan-lint |
| **L7 trace freeze (G7)** | ✅ **本命アンカー** | 全 vitest + coverage ≥ 80% + 8-edge + vmodel-validator (§2.7) |
| 詳細設計 API/Schema freeze (G5) | △ | 契約変更時のみ軽 CI。**ただし L5-L7 を同一 feature branch で完結する場合のみ G7 に畳む**。設計 PR / 実装 PR を分ける運用では G5 CI 必須 |
| 右腕 L8-L14 | ✅ **post-merge / scheduled** | 既に main/staging 上の検証。PR 毎でなく deploy・夜間 schedule。失敗は §6.8.4 で Issue 自動起票 |
| off-Forward 合流 | ✅ 合流先 feature/* の G7 で | **poc/* は merge せず CI を浪費しない** (§6.4 物理ブロック) |

### 6.9.3 GitHub Actions 構成方針

- **Required check は `harness-check` 1 本**に集約 (1 本集約方針は構想書 §7.2)。**workflow レベル `on.paths` フィルタは使わない** (skip された required check が `pending` で PR を永久ブロックする既知問題 = GitHub 公式 doc「Troubleshooting required status checks」)。
- 代わりに **単一 `harness-check` job に集約し、`dorny/paths-filter` + 各 step の `if` 条件**で分岐する (雛形参照)。job 自体は (draft を除き) 常に起動するため required check が `pending` で詰まらず、未該当 step は skip されても job は success/failure を必ず報告する (§6.3 matrix に `docs-only` 判定列を追加)。複数 job に分割する場合のみ、最終 `harness-check` aggregator job に `needs: [...]` + `if: always()` を付け、それだけを Required Status Check に登録する。
- **concurrency**: group = `harness-check-${{ github.head_ref }}`、`cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}` (main は deploy 中断防止で false。重い vmodel-lint の race を避けるため group に workflow 名を含める)。
- **draft PR では重 subjob (vitest / vmodel-lint) を skip** (`if: github.event.pull_request.draft == false`)、ready-for-review で起動。
- **GitHub Merge Queue は不採用** (Free/Team の private repo では利用不可、Enterprise Cloud 専用)。直列化は concurrency で代替。

```yaml
# .github/workflows/harness-check.yml (雛形、§6.3 matrix を実装。利用者チーム repo に harness が配布する template)
name: harness-check
on:
  pull_request: { types: [opened, synchronize, ready_for_review] }
  push: { branches: [main] }
concurrency:
  group: harness-check-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
jobs:
  harness-check:                 # ← これだけを Required Status Check に登録
    runs-on: ubuntu-latest
    if: ${{ !github.event.pull_request.draft }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: f
        with: { filters: "src: ['src/**','tests/**']\ndocs: ['docs/**']" }
      - name: branch-kind-check        # 全 branch (§6.3)
        run: ut-tdd guard branch-kind
      - name: vmodel-lint              # src 変更 or 設計 PLAN 完了 PR
        if: steps.f.outputs.src == 'true'
        run: ut-tdd doctor --vmodel
      - name: test+coverage (G7)       # src 変更時のみ全量
        if: steps.f.outputs.src == 'true'
        run: bun test --coverage
      - name: doc-consistency          # docs 変更時のみ
        if: steps.f.outputs.docs == 'true'
        run: ut-tdd plan lint
      - name: commitlint               # 全 branch
        run: ut-tdd guard commitlint
      # poc-no-merge-guard / hotfix-postmortem-required は branch prefix で条件起動 (§6.3)
```

### 6.9.4 受入条件 (補助 2 拡張)

- [ ] PLAN frontmatter に `github_issue_id` (optional) が存在し `plan-lint` が feature/hotfix branch で warn
- [ ] `harness-check` が doc-only PR で `pending` ブロックしない (job レベル if + aggregator)
- [ ] 右腕 CI 失敗が検出サイクル 1 周以内に差し戻し Issue を自動起票 (§6.8.4)
- [ ] 設計 PLAN 完了 PR で `vmodel-lint` が必須実行 (G1-G6 の CI 担保)
- [ ] poc/* は merge されず CI 分を消費しない

---

# §7 機械検証要件

## 7.1 ut-tdd CLI 構成

`ut-tdd` は **薄い OS 別ラッパー + TypeScript core (Bun)** で実装する (ADR-001)。これは **harness 自身の実装言語**であり、UT-TDD が統制する **対象リポジトリの言語は非依存** (§2.3 等の trace 例に出る `.py` / `tests/*` は target repo の一例で、TS への統一対象ではない)。Windows / macOS / Linux の entrypoint は同一 TypeScript core を呼び、OS 差分は wrapper 層に閉じ込める。Windows では PowerShell entrypoint を提供し、Git Bash が必要な既存 hook / shell script は明示的に bridge する。

```
scripts/
├── ut-tdd                    # POSIX / Git Bash ディスパッチャ (compiled core を呼ぶ)
├── ut-tdd.ps1                # Windows PowerShell ディスパッチャ (compiled core を呼ぶ)
├── install-hooks.sh
└── install-hooks.ps1
```

`plan lint` / `vmodel lint` / `doctor` / `gate` は個別 `.sh` ではなく compiled `ut-tdd` の **サブコマンド**として実装する。PowerShell と POSIX shell の entrypoint は同じ **TypeScript core** (開発時 `bun run`、配布時 `bun build --compile` の単一バイナリ) を呼び、検証結果と exit code を一致させる。`scripts/` 配下は薄い entrypoint / installer / CI helper に限定し、validator や runtime 判定などの実体は `src/` (TypeScript) に置く。OS 片系だけが通る状態は Phase 0 受入不可とする。

### 実行モード検出

`ut-tdd` は Claude Code / Codex 連携を必須にしない。起動時に runtime を検出し、以下の mode を `.ut-tdd/state/runtime.json` に記録する。

| mode | 検出条件 | 動作方針 |
|------|----------|----------|
| `claude-only` | `.claude/` 設定または Claude Code hook が存在し、Codex CLI が未検出 | Claude hook / prompt 生成 / handover を有効化。Codex 委譲は `not-available` |
| `codex-only` | `AGENTS.md` または Codex CLI が存在し、Claude Code runtime が未検出 | Codex TL 駆動 / review / plan lint / doctor を有効化。Claude hook 操作は `not-available` |
| `hybrid` | Claude Code runtime と Codex CLI の両方を検出 | `team run` / role delegation / cross-agent handover を有効化 |
| `standalone` | どちらも未検出 | `setup` / `doctor` / `plan lint` / `vmodel lint` / `gate` のローカル検証のみ有効化 |

`runtime.json` は generated state とし、Git 管理しない。`ut-tdd status --json` は `RuntimeDetection` の 6 フィールド + `nextAction` を返す = `mode`, `claude`, `codex`, `currentRuntime`, `availableRuntimes`, `missingRuntimes`, `nextAction` (`src/runtime/detect.ts`、function-spec §6 型表 / §1.2)。camelCase のこの 7 フィールドが公開サーフェス契約 (実装を正本とし、フィールド名は保存する)。`optional_adapters` / `enabled_commands` / `disabled_commands` の付加と snake_case 別名は**未実装の forward 要件**である。これらの **taxonomy 区分 (A-138 ITEM-1、cross_agent TL/Codex 裏取り済)**: requirements field は 3 区分で扱う — **current** = 実装済かつ公開契約 / **future** = 要件にあるが未実装で着地予定 (追跡 PLAN なし) / **carry** = 能動 defer で追跡 PLAN/gate あり。この区分に従い、`optional_adapters` / `enabled_commands` / `disabled_commands` は **`future`** (adapter/command surface の設計が固まるまで実装しない)。`next_action` は **`current`** に昇格した: 正式フィールド名は既存 6 フィールドの **camelCase 公開契約に揃え `nextAction`** で確定し (snake_case 別名は付さない)、値域は mode→judgment-gate guidance の安定機械契約文字列 (`standalone`=`human-review-required:…` / 単一 runtime=`single-runtime:…` (intra_runtime_subagent 証跡) / `hybrid`=`cross-review-ready:…`)。先頭 token (`:` 手前) で機械 switch でき後続が人間可読。**PLAN-L7-84 で実装・carry discharge 済** (`nextActionForMode`、U-DETECT-001..005)。standalone の判断ゲート提示 (§7.8.7.1 / 「複数 AI orchestration」節) の要件意味と整合。要件を黙って削除しない (実装事実 + 区分を記録)。

### 複数 AI orchestration

`hybrid` mode または `task-capable` 以上の optional adapter が複数ある場合、`ut-tdd team run` は以下の原則で role を割り当てる。モデルの実名は頻繁に変わるため、要件定義では能力クラスを正本とし、実モデル名は `.ut-tdd/teams/*.yaml` または local override で指定する。

| capability_class | 用途 | 推奨割当 | 禁止事項 |
|------------------|------|----------|----------|
| `frontier-reviewer` | 要件分解、設計判断、R4 合流判定、判断ゲート (G0.5 / G2 / G4-G7) レビュー、security/design critique | 現在作業中の AI とは別 provider / 別 runtime の最上位モデルクラス | 自分が生成した設計を単独承認すること |
| `worker` | 実装、テスト追加、ドキュメント更新、リファクタ、機械的修正 | 実行コストと速度のバランスがよい実装向けモデルクラス | 要件・設計・受入条件を独断で変更すること |
| `fast-checker` | lint 補助、要約、差分分類、チェックリスト生成、smoke 診断 | 低コスト高速モデルクラス | merge 可否や設計承認を出すこと |

#### role × capability_class 対応表

| role | primary class | fallback | 備考 |
|------|---------------|----------|------|
| `tl` | `frontier-reviewer` | ② 専門サブエージェント review (§7.8.7.1、単一エージェント時 hard 必須) | 設計判断、G0.5/G2/G4-G6、R4、promotion_strategy |
| `qa` | `frontier-reviewer` | `worker` + CI evidence 必須 | G8/G9、追加 QA test design、risk review |
| `aim` | `worker` | current runtime | 実装監視、PoC、修正指示 |
| `se` | `worker` | current runtime | L7 実装、テスト追加 |
| `docs` | `worker` | `fast-checker` + human/cross review | 文書更新、skill_doc 正本化 |
| `po` | human | `frontier-reviewer` は助言のみ | 受入・優先度・本番影響は人間判断 |

#### orchestration YAML 例

```yaml
team_id: default-hybrid
policy:
  prefer_cross_provider_review: true
  same_model_approval: forbidden
  single_runtime_review: mandatory_subagent_checklist   # 単一エージェント時は ② 専門サブエージェント review を hard 必須 (§7.8.7.1)
  single_runtime_review_checklist: docs/skills/review-checklist.yaml  # DOC/TST/COD/XR/DEP/DUP/MOD 明文化 checklist の正本
members:
  - role: tl
    capability_class: frontier-reviewer
    runtime: claude
    model: local-override
  - role: se
    capability_class: worker
    runtime: codex
    model: local-override
  - role: qa
    capability_class: frontier-reviewer
    runtime: codex
    model: local-override
budgets:
  frontier-reviewer: 30
  worker: 60
  fast-checker: 10
```

#### orchestration 判定

`ut-tdd team run --definition .ut-tdd/teams/<team>.yaml` は実行前に以下を検証する。

1. `members[].role` が §1.8 の role enum に含まれる。
2. `members[].capability_class` が `frontier-reviewer / worker / fast-checker` のいずれか。
3. `budgets` の合計が 100。
4. `prefer_cross_provider_review=true` の場合、reviewer と実装担当が別 runtime / 別 provider である。
5. 別 runtime が無い場合 (単一エージェント) は、判断ゲートで **② 専門サブエージェント review (§7.8.7.1 checklist) を hard 必須**とする。checklist 実行記録があれば `review_kind: intra_runtime_subagent` + `cross_agent_review: unavailable` を記録して継続、無ければ exit 1。`single_runtime_review=mandatory_subagent_checklist` を team policy に持つ。
6. `same_model_approval=forbidden` の場合、設計作成者と承認者の `runtime + model` が同一なら exit 1。
7. **hybrid 機能分散 (MUST、構想書 §2.1.0)**: `hybrid` mode では判断系 role (`frontier-reviewer`) と実行系 role (`worker`) を **別 runtime に割り当てる**。両方を同一 runtime に寄せる、または同一作業を 2 runtime で二重実行する定義は exit 1。

`frontier-reviewer` は high-cost 扱いのため、設計判断 (L4-L6) / R4 合流 / 判断ゲート (G0.5 / G2 / G4-G9) など判断品質が結果を左右する場面に限定する。通常の実装・整形・単純テスト追加に常用しない。

### 任意 AI IDE adapters

Cursor / Google Antigravity / GitHub Copilot などは、Claude Code / Codex と同列の必須 runtime にはしない。検出できるものだけ optional adapter として扱い、adapter 不在で `doctor` / `lint` / `gate` を fail にしない。

| adapter | 検出例 | 連携 level | 方針 |
|---------|--------|------------|------|
| `cursor` | `cursor` CLI / Cursor config / VSCode 系拡張 | detect / status / prompt handoff / CLI task | CLI が利用可能なら task 実行 adapter を提供。無い場合は検出のみ |
| `antigravity` | `antigravity` CLI / Antigravity config | detect / status / CLI task / hosted runtime | CLI が利用可能なら background agent 実行候補。Claude Code を内部呼び出しできる場合は `hosted_runtimes` に記録し、仕様変更が速いため fail-open で扱う |
| `copilot` | `gh copilot` / `github.copilot` extension | detect / status / prompt assist | `gh copilot` が preview のため、自動実装主体ではなく assist adapter として扱う |
| `other` | user-defined adapter config | detect / status | `.ut-tdd/adapters/*.yaml` で拡張可能 |

adapter 結果は `.ut-tdd/state/tool-adapters.json` に generated state として保存する。`ut-tdd adapter list --json` は adapter name、probe_status、version、capabilities、missing、hosted_runtimes、stability (`stable` / `preview` / `experimental`)、integration_level、safe_commands を返す。

`hosted_runtimes` は Antigravity など IDE / adapter の内側から Claude Code や他 agent runtime を呼べる場合に使う。これは中核 runtime 検出 (`claude-only` / `codex-only` / `hybrid`) には直接加算しない。理由は、呼び出し元 adapter の UI / CLI 契約に依存し、Claude Code CLI を直接制御できる状態と同じ保証を置けないためである。

#### capability probe 段階

adapter は「存在する」と「harness から連携できる」を分けて判定する。`ut-tdd adapter probe <name>` は以下の順で評価し、到達した最大段階を `integration_level` として返す。

| integration_level | 意味 | 代表 probe |
|-------------------|------|------------|
| `not-installed` | ツール本体が見つからない | command / app path / extension scan が全て不一致 |
| `detected` | インストールまたは拡張は見つかった | `cursor` / `antigravity` / `gh` / extension ID の存在 |
| `configured` | project-local または user config を読める | settings / auth / adapter yaml を検出 |
| `callable` | CLI help / version が exit 0 | `<tool> --version` / `<tool> --help` / `gh copilot --help` |
| `task-capable` | harness から安全な task / prompt handoff を開始できる | safe command allowlist に一致し、dry-run が通る |
| `roundtrip-capable` | 実行結果を機械回収できる | JSON output / exit code / generated file / PR comment を回収可能 |
| `unsupported` | 検出済みだが自動連携に使わない | GUI 専用、preview 出力不安定、allowlist 不在 |

`detected` だけでは `ut-tdd adapter run` を許可しない。`adapter run` は `task-capable` 以上、かつ `safe_commands` に含まれる command のみ実行する。`roundtrip-capable` でない adapter は実行後に「人間確認待ち」として handover に記録する。

#### adapter JSON 例

```json
{
  "name": "cursor",
  "probe_status": "ok",
  "integration_level": "task-capable",
  "version": "1.0.0",
  "capabilities": ["open-workspace", "prompt-handoff"],
  "hosted_runtimes": [],
  "missing": ["json-result"],
  "stability": "preview",
  "safe_commands": ["open-workspace", "prompt-handoff"]
}
```

ディスパッチャの subcommand:

| Subcommand | 用途 |
|------------|------|
| `ut-tdd status` | mode / runtime / handover / next action の状態確認 |
| `ut-tdd plan lint` | frontmatter schema 検証 |
| `ut-tdd vmodel lint` | 4 artifact + trace 検証 |
| `ut-tdd doctor` | 統合検証 |
| `ut-tdd self-test` | harness 内蔵の小テスト (CLI routing / schema smoke / fixture smoke) |
| `ut-tdd setup` | 初期ディレクトリ / hook / local config の bootstrap |
| `ut-tdd task classify` | 入力文 / PLAN / diff から kind / drive / size / complexity を仮判定 |
| `ut-tdd task estimate` | 三点見積もり + リスク係数で effort_hours / story_points を算出 |
| `ut-tdd skill suggest` | PLAN / diff / text から適用 skill pack 候補を推挙 |
| `ut-tdd gate G<N>` | G0.5-G14 ゲート判定 |
| `ut-tdd claude ...` | Claude Code 用 prompt / hook 状態操作。`claude-only` / `hybrid` で有効 |
| `ut-tdd codex ...` | Codex CLI 実行。`codex-only` / `hybrid` で有効 |
| `ut-tdd team run ...` | Claude Code × Codex 連携実行。`hybrid` のみ有効 |
| `ut-tdd handover ...` | mode をまたぐ引き継ぎ状態の確認・更新 |
| `ut-tdd adapter list` | optional AI IDE adapter の検出状態を表示 |
| `ut-tdd adapter probe <name>` | adapter の integration_level と capability を再判定 |
| `ut-tdd adapter run <name> ...` | safe_commands に含まれる adapter command のみ実行 |

詳細実装は将来の個別 PLAN-XXX で詰める。

### mode 別コマンド保証

| コマンド群 | standalone | claude-only | codex-only | hybrid |
|---------------|------------|-------------|------------|--------|
| `setup` / `status` / `doctor` | ✓ | ✓ | ✓ | ✓ |
| `plan lint` / `vmodel lint` / `gate` | ✓ | ✓ | ✓ | ✓ |
| `task classify` / `task estimate` / `skill suggest` | ✓ | ✓ | ✓ | ✓ |
| `claude` / Claude hook guard | — | ✓ | 利用不可 not-available | ✓ |
| `codex` | — | not-available | ✓ | ✓ |
| `team run` | — | 利用不可 not-available | 利用不可 not-available | ✓ |
| `handover` | local only (ローカルのみ) | ✓ | ✓ | ✓ |

`not-available` は exit 2 とし、stderr に不足 runtime と fallback command を出す。検証系コマンド (`lint` / `doctor` / `gate`) は mode 不足だけで exit 1 にしない。

## 7.2 task classifier / effort / skill suggestion I/O 仕様

### `ut-tdd task classify`

入力文、PLAN frontmatter、または diff から、作業経路の初期判定を返す。AI runtime が無い環境でも rule-based で動作する。

```bash
ut-tdd task classify --text "audit log の vmodel lint を追加"
ut-tdd task classify --plan docs/plans/PLAN-123-audit.md
ut-tdd task classify --diff origin/main...HEAD
```

JSON 出力:

```json
{
  "kind": "impl",
  "drive": "agent",
  "size": "M",
  "complexity": "medium",
  "split_required": false,
  "recommended_path": "forward",
  "recommended_gates": ["G6", "G7"],
  "confidence": 0.82,
  "reasons": ["cli_extension touched", "tests required", "no db migration"]
}
```

#### size / complexity 判定

| 判定 | 目安 | 動作 |
|------|------|------|
| `XS` | 1 file / docs typo / small config | PLAN 不要候補。ただし `docs/skills/*.md` は例外なく PLAN 必須 |
| `S` | 1-3 files / 100 行以下 / API・DB 変更なし | 軽量 Forward |
| `M` | 4-10 files / 101-500 行 / API または DB 片方 | 通常 Forward + L7 TDD Red |
| `L` | 11+ files / 501+ 行 / API+DB / 複数 role | 分割推奨、frontier-reviewer review |
| `XL` | 新規 module / cross-platform / security / production impact | 分割必須、Master PLAN 推奨 |

3 軸 (file count / changed lines / API-DB-ops impact) の最大値を `size` とする。`XL` は `split_required=true`。

### `ut-tdd task estimate`

三点見積もりとリスク係数で effort を出す。見積もりは約束ではなく planning input として扱う。

```bash
ut-tdd task estimate --plan docs/plans/PLAN-123-audit.md
ut-tdd task estimate --text "Windows 対応込みで CLI を追加"
```

JSON 出力:

```json
{
  "optimistic_hours": 3,
  "most_likely_hours": 6,
  "pessimistic_hours": 12,
  "expected_hours": 6.5,
  "risk_factor": 1.4,
  "buffered_hours": 9.1,
  "story_points": 5,
  "risks": ["cross-platform shell", "CI matrix update"]
}
```

算出:

```
expected_hours = (optimistic + 4 * most_likely + pessimistic) / 6
buffered_hours = expected_hours * risk_factor
```

`risk_factor` は 1.0-2.0。cross-platform / security / external API / migration / unclear requirement があるほど上げる。

### `ut-tdd skill suggest`

PLAN / diff / text から、適用する `docs/skills/*.md` の候補を返す。未正本化 skill は `vendor_candidate=true` として表示し、正本化なしに gate input にしない。

```bash
ut-tdd skill suggest --plan docs/plans/PLAN-123-audit.md
ut-tdd skill suggest --text "追加機能設計と QA 追加テストを整理"
```

JSON 出力:

```json
{
  "required": [
    {"skill": "design-pack", "reason": "add-design", "confidence": 0.91},
    {"skill": "test-pack", "reason": "L7 TDD Red and QA trace", "confidence": 0.88}
  ],
  "optional": [
    {"skill": "reverse-pack", "reason": "R4 promotion_strategy mentioned", "confidence": 0.62}
  ],
  "missing": [
    {"skill": "operations-pack", "vendor_candidate": true, "reason": "postmortem reference"}
  ]
}
```

### orchestration 連携

| command | primary class | escalation 条件 |
|---------|---------------|------------|
| `task classify` | `fast-checker` / rule-based | `L` / `XL` / confidence < 0.7 なら `frontier-reviewer` review |
| `task estimate` | rule-based + `fast-checker` | risk_factor ≥ 1.6 または production impact ありなら `frontier-reviewer` review |
| `skill suggest` | `fast-checker` / rule-based | required skill 欠落または vendor_candidate ありなら `tl` review |

> **Dynamic skill injection の実体化 (PLAN-L7-135、2026-06-23)**:
> `ut-tdd skill suggest --inject --json` は provider-neutral manifest を返さなければならない。
> manifest は skill paths/reasons のみを含む。`ut-tdd codex --plan ...`、`ut-tdd claude --plan ...`、
> `ut-tdd team run --plan ...`、`ut-tdd task route --plan ... --execute` などのコマンドは、
> その manifest を argv ではなく provider stdin に実体化しなければならない。
> これにより Claude と Codex は `docs/skills/*` 本文全量を読まず、同一の scoped context を受け取る。

## 7.3 vmodel_validator I/O 仕様 (R-I7 fix で exit code 3 段階明記)

### exit code 仕様

| exit code | 意味 |
|-----------|------|
| **0** | 全 P0 / P1 検出なし (clean pass) |
| **2** | P1 warning のみ検出 (carry 候補、push 続行可) — R-I7 fix |
| **1** | P0 検出あり (fail-close) |

stderr に P0 / P1 メッセージを出力。CI は `exit 0 or exit 2 = pass`、`exit 1 = fail-close` として扱う。

### kind 別検証経路の分岐

```
input: PLAN ファイル または PLAN ディレクトリ (§1.10 対象 path で絞り込み)

検証フロー:
  for each PLAN file in §1.10 対象:
    parse frontmatter (kind / generates / dependencies)
    case kind:
      design / add-design / research:
        → §2.2 段階 A (Pair freeze ①⇔③) を V-model 左各層 (G1/G3/G4/G5/G6) 対象で検証
      impl / add-impl:
        → §2.2 段階 A (G6 まで) + parent_design 存在 (§1.1) + §2.2 段階 B (G7 で 4 artifact trace) 検証
      poc / reverse:
        → workflow_phase に応じた検証 (詳細は将来 PLAN-XXX)
      recovery / troubleshoot:
        → §5.1 の 7 セクション header 検証
      refactor / retrofit:
        → 既存 trace の不変性のみ検証 (新規 trace 不要)
```

### 双方向 8 directed edge 検証 (§2.4)

vmodel_validator は §2.4 の **必須 8 directed edge** を個別検証する。grep ベースだけでなく path 正規化と参照先 path/id 一致まで確認する。実装詳細は将来の個別 PLAN-XXX で詰める。本書では入出力契約と必須検証項目を確定する。

## 7.4 branch-kind-check 仕様 (R-I8 fix で PLAN 必須 / 例外 branch を表化)

### PLAN 必須 branch と例外 branch

| ブランチ prefix | PLAN 必須 | touched PLAN 0 件時の動作 |
|----------------|-----------|---------------------------|
| `feature/*` / `design/*` / `research/*` / `poc/*` / `reverse/*` / `add/*` / `hotfix/*` / `refactor/*` | **必須** | exit 1 (PLAN 不在 → fail-close) |
| `docs/*` / `chore/*` | 不要 | exit 0 (lint 対象外、skip) |
| その他 prefix | 不要 | exit 1 (unknown prefix → fail-close) |

### 判定ロジック

```
input: PR head branch name + PR で touched された PLAN files
output:
  - exit 0: branch prefix と全 touched PLAN の kind が §6.1 表で整合 (または例外 branch)
  - exit 1: 不整合検出 (PLAN 必須 branch で PLAN 0 件 / 不一致)

判定:
  prefix = branch_name.split('/')[0]
  if prefix in {docs, chore} and not touches("docs/skills/*.md"): exit 0  # 例外 branch
  if prefix not in §6.1 表: exit 1   # unknown prefix
  expected_kinds = §6.1 表で prefix から決まる
  touched_plans = PR diff から PLAN ファイル抽出
  if len(touched_plans) == 0: exit 1  # PLAN 必須 branch で 0 件
  for each PLAN file in touched_plans:
    if PLAN.kind not in expected_kinds: exit 1
  exit 0
```

`harness-check` 内 subjob として `|| exit 1` で fail-close (`|| echo WARN` は禁止)。

## 7.5 pre-commit / pre-push hook の責任分離

| Hook | 検証内容 | 想定時間 |
|------|----------|----------|
| **pre-commit** | gitleaks / commitlint format / 軽量 lint (markdown / yaml) + `ut-tdd self-test --smoke` | < 5s |
| **pre-push** | §5.3 session 終了前 4 項目 + 軽量 plan lint + 差分対象 self-test | < 15s |
| **harness-check (CI on PR)** | §6.3 の 8 subjob (重い検証 + 全テスト + 回帰確認) | 数分 |

`vmodel_lint` の完全検証は **pre-push と CI のみ** で実行。pre-commit には乗せない。

### test tier と実行場所

| tier | 内容 | 実行場所 | 目的 |
|------|------|----------|------|
| `smoke` | CLI 起動、subcommand routing、schema fixture、adapter probe dry-run | local hook / `ut-tdd self-test --smoke` | 即時フィードバック |
| `changed` | 差分 PLAN / 差分 script / 差分 docs の lint と軽量 validator | pre-push / PR | push 前の手戻り削減 |
| `full` | 全 PLAN lint、完全 vmodel lint、全テスト、回帰確認、branch matrix | GitHub Actions `harness-check` | PR 通過要件 |
| `nightly` | 長い adapter probe、cross-platform matrix、optional integration | GitHub Actions schedule | flake / 環境差分検出 |

原則として、`full` と `nightly` をローカル hook の必須経路に入れない。ローカルで実行したい場合は明示コマンド (`ut-tdd self-test --full`) とする。

## 7.6 受入条件 (機械検証)

- [ ] `ut-tdd plan lint` が §1 の全 enum 違反を fail-close
- [ ] `ut-tdd vmodel lint` が §7.3 の kind 別経路で正しく分岐し、§7.3 の 3 段 exit code を返す
- [ ] §2.4 の必須 8 directed edge を fail-close 検証
- [ ] `branch-kind-check` が §7.4 の判定ロジックに従い fail-close (echo WARN ではない)
- [ ] `branch-kind-check` が PLAN 必須 branch で touched PLAN 0 件なら exit 1
- [ ] `branch-kind-check` が `docs/*` / `chore/*` を例外として skip (exit 0)
- [ ] `branch-kind-check` が `feature/*` / `hotfix/*` の PLAN `github_issue_id` 未設定を warning として surface
- [ ] pre-commit / pre-push / CI の責任分離 (§7.5) を守る
- [ ] `ut-tdd self-test --smoke` はネットワーク不要・外部 AI runtime 不要で通る
- [ ] PR merge gate は GitHub Actions `harness-check` のみを正本とし、ローカル hook 成否だけを merge 条件にしない
- [x] **ルール同一性 (MUST、構想書 §2.1.0)**: gate / V-model / checklist / enum / route の正本は `ut-tdd` core + governance docs に単一定義され、`.claude/CLAUDE.md` / `AGENTS.md` がルールを再定義・分岐していない (doctor が両 adapter のルール重複・drift を検出し、検出時 fail)。`src/lint/rule-drift.ts` + doctor `checkRuleDrift` が AGENTS / CLAUDE adapter docs の必須 mode / command marker drift を fail-close 検出 (2026-06-08)。
- [x] **rule parity test**: 同一 PLAN / diff を claude-only と codex-only で処理した際、`ut-tdd gate` / `ut-tdd plan lint` / `ut-tdd vmodel lint` の **判定結果と exit code が一致**する (runtime 差で結果が変わらない)。`ut-tdd gate` の判断ゲート review-tier は `evaluateGateReview` parity test で codex-only/claude-only 同一結果を機械検証 (2026-06-08)。
- [x] **hybrid 機能分散 (MUST、構想書 §2.1.0)**: `ut-tdd team run` が `hybrid` で判断系 / 実行系を別 runtime に割り当て、同一 role の同一 runtime 重複・同一作業の二重実行を exit 1 で弾く (§7.1 team run 検証 7)。`validateTeamRun` が worker/reviewer provider 分離・duplicate role/provider を fail-close (2026-06-08)。

### 7.6.1 Coding Rules SSoT (TypeScript core) の正本

ADR-001 により `src/` core は TypeScript/Bun で実装する。coding rules は本要件定義と `docs/governance/coding-rules.md` を SSoT とし、AGENTS / CLAUDE adapter は再定義せず参照する。

- [x] `tsconfig.json` は `strict: true` / `noImplicitOverride: true` / `noFallthroughCasesInSwitch: true` を維持し、`bun run typecheck` を必須検証に含める。
- [x] formatter/linter は Biome (`bun run lint`) を正本とし、手動整形ルールではなく tool output を優先する。
- [x] explicit `any` を禁止する。必要な場合は `unknown`、generic、または具体型を使う。
- [x] `@ts-ignore` / `@ts-expect-error` / `eslint-disable` / `biome-ignore` を禁止する。例外が必要な場合は先に policy PLAN で例外条件を定義する。
- [x] `src/**` の function / method / constructor / arrow function は 3 params 以下とする。4 以上は input object 化する。`tests/**` の helper arity は対象外だが、no-any / suppression / file naming は対象内。
- [x] TypeScript file name は kebab-case、kebab-case + `.test.ts`、または `index.ts` とする。
- [x] Error handling は fail-open を許容するが、無記録の空 `catch` と rethrow-only `catch` を禁止する。catch block は explicit failure state の返却、記録、変換、または fail-open 意図の文書化を行う。
- [x] Module boundary は `lint` / `runtime` / `schema` の逆依存を禁止する。shared logic は低位 module へ移し、governance check が runtime/CLI 実装へ依存しないようにする。
- [x] Workflow placement: Forward L6 は `docs/governance/coding-rules.md` の unchanged/update を確認してから G6/G7 handoff する。Add-feature は `add-design` で coding-rule impact を記録し、`add-impl` は impact 解消後に開始する。
- [x] 機械検出は `docs/governance/coding-rules.md` の rule ID と workflow anchor を `src/lint/coding-rules.ts` が読み、`doctor` `checkCodingRules` で hard failure とする。対応 oracle は L7 `U-CODE-001..009`。

### 7.6.2 DDD/TDD Strictness SSoT

DDD/TDD strictness は `docs/governance/ddd-tdd-rules.md` を SSoT とし、domain boundary / invariant trace / Red-first evidence / test oracle strength / integration GWT を doctor で機械検出する。

- [x] Domain boundary: governance/lint/schema/runtime の逆向き依存を `domain-boundary` として検出する。
- [x] Invariant trace: DDD invariant は L7 U-* oracle を持たなければならない。
- [x] Red-first evidence: `tdd_red_required: true` の confirmed PLAN は `red_at <= green_at` を満たす。
- [x] Test oracle strength: test case は `expect` / `assert` を持ち、truthiness のみの oracle を禁止する。
- [x] Integration GWT: L8 IT-* row は Given/When/Then を持つ。
- [x] Workflow placement: Forward L6 / Add-feature / mode index は `DDD-TDD-WORKFLOW` anchor と SSoT 参照を持つ。
- [x] 定量チェックと定性レビューの使い分け: `vitest` / lint / doctor が green になってから review evidence を付ける。重要 gate / freeze / TDD evidence は `tests_green_at` と reviewer evidence を抱き合わせ、片方だけで confirmed にしない。
- [x] 機械検出は `src/lint/ddd-tdd-rules.ts` + doctor `checkDddTddRules` で hard failure とする。対応 oracle は L7 `U-DDDTDD-001..009` と FR-L1-50。

---

# §7.7 source-derived skill pack の curate / 正本化要件

source-derived skill は `vendor source snapshot` から直接実行しない。UT-TDD で使うものだけを `docs/skills/*.md` に **skill pack** として curate / 正本化し、`artifact_type=skill_doc` の PLAN 成果物として管理する。skill 本文は TypeScript literal 化しないが、catalog / recommender / injector / lint は TypeScript/Bun core で実装する。

## 7.7.1 curate 候補 skill pack

| skill pack | 主な参照元 | UT-TDD での用途 |
|------------|------------|-----------------|
| `planning-pack` | requirements-handover / dev-policy / schedule-wbs | 企画、要件、WBS、引継ぎ |
| `design-pack` | design-doc / api-contract / db / ui | L2-L3 設計、追加機能設計、契約固定 |
| `implementation-pack` | coding / code-review / error-fix / refactoring | L7 実装、レビュー、修正 |
| `test-pack` | testing / verification / quality-lv5 | TDD Red、V-model、追加 QA テスト |
| `reverse-pack` | reverse-r0/r1/r2/r3/r4/rgc | 既存実装からの契約抽出、合流判定 |
| `operations-pack` | runbook / deploy / incident / postmortem | L6 以降の運用、障害、再発防止 |

## 7.7.2 curate / TS 再実装時の変換ルール

- `legacy source` 固有名、個人プロジェクト前提、WSL2 固定、絶対パスは UT-TDD 用語と相対パスへ置換する。
- `Claude Code` 固定の指示は `runtime_mode` (`standalone` / `claude-only` / `codex-only` / `hybrid`) に従う表現へ置換する。
- external API / secret / credential を前提にする手順は core skill へ入れず、optional adapter 側に隔離する。
- skill は「知識・観点・チェックリスト」までを持つ。GitHub Actions や hook の実行条件は workflow / harness 側に置く。

## 7.7.3 成果物一致原則への接続

skill pack は単独の助言文書ではなく、以下の gate に接続する。

| 原則 | 接続先 | fail-close 条件 |
|------|--------|----------------|
| 追加機能設計は既存設計を破壊しない | `add-design` / `add-impl` | 親 PLAN なし、親 PLAN と drive 不一致、既存 design/test の delete/modify |
| ドキュメント、実装、テストは一致する | `vmodel_lint` | §2.4 の必須 8 directed edge 欠落 |
| 追加 QA テストは doc-first | L6 QA 追加テスト | L6 QA test design への trace 欠落 |
| 実装後レビューは追加テストへ還元する | `test-pack` + `review` | 指摘が test design / regression test / debt register のいずれにも残らない |
| 検証成果の機能化は R4 で判定する | `reverse-pack` | `promotion_strategy` 欠落、または reuse 条件未達 |

## 7.7.4 受入条件

- [ ] 正本化済み skill は `docs/skills/*.md` に配置され、PLAN の `generates` に `artifact_type=skill_doc` として記録される
- [ ] skill doc は対応する workflow / harness / gate を明記する
- [ ] legacy source 固有名、個人絶対パス、WSL2 固定表現が残らない
- [ ] `skill_doc` 更新 PR は `docs/*` 例外ではなく、PLAN 付き branch (`design/*` または `add/*`) で扱う
- [ ] skill pack は vendor snapshot を直接参照せず、UT-TDD 正本化済みの本文を参照する

---

# §7.8 配線要件 (signal routing / RecommendedCommandV1 / orchestration_mode / layer-context 注入)

構想書 v3.1 §2.6 の配線を機械検証可能な形に確定する。V2 (`route_engine.py` / ADR-042 / `vmodel-semantics.yaml`) の routing/injection を UT-TDD 向けに翻案する。legacy runtime command name・legacy DB 依存・個人絶対パスは持ち込まず、`ut-tdd *` 相当・`.ut-tdd/` state・package-local に再定義する。

## 7.8.1 signal → mode routing 要件

`ut-tdd route eval --signal <signal> [--env <env>] [--drift-type <type>]` が signal を 9 mode (構想書 §2.5) のいずれかに解決する。最小マッピング (config 化、`.ut-tdd/config/route-map.yaml` 相当):

| signal | mode | 補足 |
|--------|------|------|
| `drift` (+drift_type=schema/contract) | reverse | normalization 経路 |
| `debt_degradation` / `code_smell` / `structural` | refactor | |
| `dependency_outdated` / `upgrade` / `config_drift` | retrofit | upgrade は preflight |
| `agent_runaway` / `context_exhaustion` / `regression_dev` / `runaway` / `forced_stop` | recovery | human approval。`forced_stop` = ユーザー強制停止 (ESC/Ctrl+C/Stop) = 高 severity 負シグナル (concept §2.6.1、PLAN-L6-04/L7-02 dangling-turn 推定で検出) |
| `production_incident` / `hotfix_required` / `regression_prod` | incident | env=prod 必須、human approval |
| `feature_addition` / `scope_extension` | add-feature | §1.3 `kind=add-feature` と同じ正規表記 |
| `version_deferral` | version-up | capability を将来版へ保全 (今スコープ外・破棄しない)。`version_target` 付き draft で起票、活性化時に add-feature で Forward 合流 (§2.5 version-up、PLAN-DISCOVERY-09) |
| `user_feedback_iteration` / `requirement_continuous_refinement` | scrum | |
| `requirement_undefined` / `feasibility_unknown` / `success_condition_unclear` / `design_uncertain` | discovery | 4 象限 P2 (uncertainty 高×impact 低) で Discovery 先行。上流委譲。**`design_uncertain` = 確証なき設計** (紙上で実現性・妥当性が確定できない設計、concept §2.5 / PLAN-DISCOVERY-01 S4 confirmed)。**在層で閉じる `design_gap` (下記 interrupt 分岐 → Forward spot 修正) とは区別**: 設計の確証が PoC を要するなら Discovery、層内で確定できるなら Forward |
| `tech_decision_required` / `option_comparison_needed` / `adr_required` | research | 机上調査で完結 (PoC 不要)。作れるか不明→discovery / 既存実装調査→reverse に切替 |
| `interrupt` (+`subtype=design_gap`/`new_requirement`/`constraint`/`po_change`) | 分岐 (下記) | 開発中割り込み (§2.6.5)。受け皿は subtype + 重大度で決まる |

**`interrupt` の分岐ルール (§2.6.5 横断検出からの routing)**:

| 条件 | 接続先 mode |
|------|-------------|
| `agent_runaway` / `context_exhaustion` を併発 (重大・暴走) | recovery (承認必須) |
| 要件未確定・実現性不透明に昇格 | discovery (前段) |
| 軽微な追加要件 (`new_requirement` / `po_change`、影響限定) | add-feature |
| 設計ギャップ (`design_gap` / `constraint`、当該 layer で閉じる) | Forward 該当 layer で spot 修正 (mode 化せず) |

> **`runaway` は `agent_runaway` の alias** (同義、recovery へ routing)。route-map では正規名 `agent_runaway` に正規化する。

- `env=prod` または regression 系は Incident / Recovery を優先する。
- priority/action は uncertainty × impact の 4 象限で決める (P0=緊急 routing / P1=即 PLAN / P2=Discovery 先行 / P3=suggest_only)。
- signal が本表に無い場合は `exit 2` (not-available) + 上流委譲手順を stderr に返す (fail ではなく明示フォールバック)。
- 複数 token が同時に一致する場合は **最長 token 一致を優先**する。例: `regression_prod` は汎用 `regression` より具体的な incident token として解決し、`forced_stop` は汎用 `stop` より具体的な recovery token として解決する。
- **PLAN 入口 certificate**: 2026-07-01 以降に作成する non-archived PLAN は frontmatter に `route_signal` と `route_mode` を記録する。`route_signal` は本表の token/alias、`route_mode` は `ut-tdd route eval` / `routeSignalCandidates` が返す候補 mode と一致しなければならない。不一致または欠落は `plan-governance` の `route_certificate_missing` / `route_certificate_mismatch` で fail-close する。既存 PLAN は遡及 backfill せず、future authoring の入口適合を強制する。

## 7.8.2 RecommendedCommandV1 schema 要件

route 結果は **人間向け表示 (`suggest_command`、文字列)** と **機械契約 (`recommended_command`、JSON)** を分離する。`ut-tdd route eval --format json` が以下を返す:

```json
{
  "schema_version": "v1",
  "command": "ut-tdd ...",
  "args": { },
  "safety": {
    "auto_apply": false,
    "requires_human_approval": false,
    "requires_preflight": false
  }
}
```

- `command` は必ず `ut-tdd` 始まり (legacy runtime command name を含めば exit 1)。
- `schema_version` は additive 拡張のみ (既存 field の意味変更禁止)。
- `recommended_command` を agent / CI が JSON parse して実行する。`suggest_command` の文字列値は backward-compat 凍結 (変更時は schema_version を上げる)。
- route eval の top-level 結果は `escalation_boundaries[]` を返し、XR-2 に該当する signal では `recommended_command.safety.requires_human_approval=true` に昇格する。

## 7.8.3 requires_human_approval → 承認者解決 要件 (チーム翻案)

`safety.requires_human_approval: true` のとき、**承認者を `.ut-tdd/config/approval-policy.yaml` から解決** し、未承認では当該 command を実行しない。最小ポリシー:

| 引き金 mode/条件 | 承認者 (人間サインオフ) | exit |
|------------------|------------------------|------|
| recovery | tl (リオープン確認) + po (スコープ承認) | 未承認 → exit 1 |
| incident (env=prod) | オンコール + tl + pm の三者 | 未承認 → exit 1 |
| retrofit (config_drift) | tl 単独 | 未承認 → exit 1 |
| escalation / any mode | approval-policy の `mode: "*"` または該当 mode の rule | 未承認 → exit 1 |

- 承認記録 (承認者 identity / timestamp / 対象) を `.ut-tdd/` audit に append する。
- `requires_preflight: true` (upgrade 高リスク) は `ut-tdd doctor --preflight <type>` 相当の前段検証 pass を要求する。

## 7.8.4 layer-context 注入 + orchestration_mode 要件

`.ut-tdd/config/vmodel-semantics.yaml` 相当が drive × layer (L0-L14) に以下を注入する。`ut-tdd vmodel show <drive> <layer> --injection` が取得する:

| 注入 key | 内容 |
|----------|------|
| `owner_role` | §1.8 の 7 role から (drive 別: 例 L4-L6 は be→tl / fe→fe / db→dba 相当) |
| `mandatory_agents` | 工程必須 subagent (`.claude/agents/` エントリ) |
| `recommended_skills` | `docs/skills/*.md` 候補 |
| `recommended_commands` | `ut-tdd *` 候補 |
| `orchestration_mode` | 下記 enum |

**VALID_ORCHESTRATION_MODES (5 種)**:

| 値 | 意味 |
|----|------|
| `pm_lead` | PM 単独主導 (planning 層、AI 委譲なし) |
| `claude_judge` | Claude が判断主体 (requirement 層) |
| `claude_judge_codex_impl` | Claude 設計判断 + Codex 実装 (architecture/detailed 層) |
| `codex_impl_qa_verify` | Codex 実装 + QA 検証 (functional 層) |
| `claude_design_impl` | Claude 設計+実装 (FE mock 駆動 architecture/detailed) |

`orchestration_mode` は実行モード (§7.1 standalone/claude-only/codex-only/hybrid) と直交し、`hybrid` 環境でのみ Codex 委譲系 (`*_codex_impl` 等) を実体化する。`standalone` では owner_role と recommended_* のみ参照し、委譲は要求しない。

## 7.8.5 横断検出の束ね要件

interrupt / debt / drift-check / readiness と doctor 検出器 (relation-graph / doc-drift / connection-deficiency / regression) + test-perspective-gate を `ut-tdd doctor` / `ut-tdd plan lint` に束ねる。検出は `.ut-tdd/` state を参照し、legacy DB には依存しない。test-perspective-gate は V-model 各ペアの **観点網羅** (抜け) と **レベル間非重複** (重複) を `--static-only` で fail-close 検証する。

## 7.8.6 受入条件 (配線)

- [x] `ut-tdd route eval --signal <s> --format json` が RecommendedCommandV1 (schema_version/command/args/safety) を返す (`src/workflow/contracts.ts` + `src/cli.ts`, 2026-06-23)
- [x] §7.8.1 の route token は実装 route-map で coverage される。`drift` は reverse、incident signal (`production_incident` / `hotfix_required` / `regression_prod`) は `mode=incident`、軽微な `new_requirement` / `po_change` は add-feature に解決し、helper `routeSignalToMode` も同じ最長一致 route-map を使う。incident は human approval 未承認なら exit 1 になる (`src/workflow/contracts.ts`, 2026-06-23)
- [x] `command` が legacy runtime command name を含めば exit 1、`ut-tdd` 始まりのみ許可 (`recommendedCommandV1Schema` + route-map fail-close, 2026-06-23)
- [x] `requires_human_approval: true` で承認者ポリシー未解決または未承認なら exit 1 + 承認記録を audit に残す (`src/workflow/contracts.ts` + `.ut-tdd/audit/route-approval.jsonl`, 2026-06-23)
- [x] `ut-tdd route eval` が escalation 境界を `escalation_boundaries[]` として検出し、mode に依存せず `requires_human_approval=true` / 未承認 exit 1 にする (`src/workflow/contracts.ts`, 2026-06-23)
- [x] `ut-tdd vmodel show <drive> <layer> --injection` が 5 注入 key を返し、`orchestration_mode` は VALID_ORCHESTRATION_MODES のいずれか (`src/vmodel/injection.ts`, 2026-06-23)
- [x] 配線 config / 検出器が legacy `legacy DB` / 個人絶対パスに依存しない (`.ut-tdd/` YAML/JSON state + `.ut-tdd/harness.db` projection DB のみ、route-map config fail-close 2026-06-23)

## 7.8.7 execution mode × レビューゲート切り分け (gate 崩壊防止、構想書 v3.1 §2.1.2.1)

cross-agent review は別 runtime / 別モデルが前提のため、単一エージェント環境では成立しない。`ut-tdd gate` が execution mode を見ずに判断ゲートを通すと self-review が cross-agent review に化けて崩れる。これを機械的に防ぐ。レビュー強度は 3 ティア (構想書 §2.1.2.1): ① cross-agent (hybrid) / ② 専門サブエージェント (単一エージェント、明文化 checklist 駆動) / ③ naive self-review (判断ゲート通過根拠として不可)。

> **self-review 前置の原則 (MUST、PLAN-L1-01 で確立)**: 判断ゲートに限らず、**AI が人間 (PO 等) に成果物のレビュー・判断・確定を求める前に、single-agent mode では専門サブエージェント self-review (§7.8.7.1 checklist) を先に通すことを必須**とする。self-review を経ない human escalation は手戻り扱い (review を先に実施してから再提示)。これは「③ naive self-review を gate 根拠にしない」と表裏一体で、human の前段に必ず ② を挟むことで、人間が未検証の成果物をレビューさせられる無駄・silent pass・手戻りを防ぐ。PLAN / Sprint のレビュー step は human 提示の前に置く。

> **機械強制 (IMP-071、2026-06-05)**: 本 MUST と下表「記録欠落 → exit 1」は long く **doc-only で機械強制が無く** (plan lint=stub / doctor 非検査)、freeze (status→confirmed) / commit が review 証跡ゼロで素通りした (本 harness 開発で実証 = review 前置スキップで設計を freeze)。機械着地として **PLAN frontmatter `review_evidence`** (reviewer / review_kind = cross_agent\|intra_runtime_subagent\|human / reviewed_at / verdict / scope) を新設し、**doctor `checkReviewEvidence`** (`src/lint/review-evidence.ts`) が「confirmed の design/impl/add-* PLAN なのに review_evidence なし」を hard violation として `runDoctor.ok` に連動させ、CI fail-close へ接続する。**freeze 後の増分設計変更も entry を append** する (review-skip の silent 化を機械で塞ぐ)。導入 = PLAN-L6-12 / L7-13 / REVERSE-12。
>
> **cross-review semantic 強制 (IMP-076、2026-06-05)**: 上記は review 前置の **presence + review_kind** までを機械強制した。下表「`same_model_approval` を実行時強制」(worker と reviewer の (provider,model) 一致時に承認無効化) の機械着地として、review_evidence entry に **`worker_model` / `reviewer_model`** を追加し、`checkReviewEvidence` が `review_kind=cross_agent` の entry で両 model の同一/欠落を `crossReviewViolations` として fail-close 検出する。単体 runtime (claude-only/codex-only) は相異 model を供給できないため `cross_agent` を僭称できない (self-review が cross-agent に化けるのを静的に防ぐ)。サブエージェント配置 (orchestration_mode cell / worker roster) + checklist 逐条記録は別 scope (defer)。導入 = PLAN-L6-13 / L7-14 / REVERSE-13。
>
> **定量テスト → 定性レビュー順序 (IMP-077、2026-06-05、全駆動モデル普遍)**: 品質保証二軸 (定量テスト × 定性レビュー、§6) の**順序**を機械強制。**定量検証 (vitest/doctor/lint) green 後に定性レビュー**を行う (未検証成果物をレビューしない)。review_evidence entry に **`tests_green_at`** を追加し、`checkReviewEvidence` が confirmed PLAN の review_evidence について `tests_green_at` 欠落 or `> reviewed_at` を `testBeforeReviewViolations` として fail-close 検出。**9 駆動モデルすべての workflow に適用** (各 mode の verify step が review step の前、concept §2.1.2.1 核心ルール 6)。導入 = PLAN-L6-14 / L7-15 / REVERSE-14。

> **定量 green profile 証跡 (IMP-108、2026-06-23)**: `tests_green_at` は「いつ green だったか」だけを示し、どの command / runner / scope / exit code / evidence が green だったかを機械再現できない。2026-06-23 以降に更新された confirmed/completed の `review_evidence` は **`green_commands[]`** を必須とし、`kind` / `command` / `runner` / `scope` / `exit_code=0` / `evidence_path` / `output_digest=sha256:*` を `checkReviewEvidence` が hard violation (`greenCommandViolations`) として検査する。これにより「green はテスト済みで証跡 ID/パスが紐づいている」状態だけを green と扱い、DB projection の `GreenDefinition` / `test_runs` / `quality_signals` へ接続する。導入 = PLAN-L7-108 / REVERSE-108。

### 判定対象ゲートと mode 別挙動

`ut-tdd gate <G>` は起動時に `ut-tdd status` の `mode` を読み、**判断ゲート (G0.5 / G2 / G4-G7 / R4)** で以下を適用する:

| mode | review tier | gate 挙動 |
|------|-------------|-----------|
| `hybrid` | ① cross-agent | worker と reviewer が別 (provider, model) であることを確認。full enforce |
| `claude-only` / `codex-only` | ② 専門サブエージェント (**必須**) | §7.8.7.1 checklist の逐条実行記録を要求。記録欠落 → **exit 1**。揃えば `review_kind: intra_runtime_subagent` + `cross_agent_review: unavailable` を記録し pass |
| `standalone` | レビュアー不在 | サブエージェント起動不可。機械 lint のみ pass、判断ゲートは **人間レビュー必須** を `next_action` に出す (自動 pass 不可) |

### 7.8.7.1 専門サブエージェント review 必須 checklist (明文化)

単一エージェント時の ② レビュアー (claude-only は `.claude/agents/code-reviewer` 等、codex-only は reviewer-role 呼び出し) は、実装者と別 context/persona で以下を **逐条評価**し、各項目に `pass` / `fail` / `n-a` + 根拠を記録する。**ドキュメント / テスト / コードの 3 点を必ず全て**カバーし、3 点の相互 trace を確認する。チェック観点を明文化することでレビュアーのモデル差異 (同一モデル subagent / 別モデル) を吸収し、判断の再現性を担保する — これが ② を gate 通過根拠として認める根拠である。

**レビュースコープは 3 段階**で、diff/単体だけに閉じない (狭いスコープでは依存誤り・重複実装を見逃す):

- **関数単位**: 変更関数自体 (signature / 契約 / ロジック / 境界) — 主に C コード項目。
- **機能単位**: 機能内の関数群の整合・依存関係・インターフェース断片化 — E の DEP / MOD 項目。
- **横断 (repo)**: 重複実装 / 機能被り・呼び出しグラフの大域整合 — E の DUP / DEP 項目。

**A. ドキュメント (① 設計 doc + ③ テスト設計 doc)**
- DOC-1: 対象ゲートの ① 設計 doc が存在し確定している (G3=AC 必須 / G5=API・Schema / G6=関数 signature + WBS)
- DOC-2: ③ テスト設計 doc が同層で存在し ① と pair freeze 済み (V-model 左)
- DOC-3: ① 設計 doc に実装・テスト設計への双方向 reference がある (§2.3)
- DOC-4: アンチパターン AP-1 / AP-2 / AP-6 不在 (設計に実装/テスト混在、L1 に FR 混入)

**B. テスト (③ テスト設計 + ④ テストコード)**
- TST-1: ④ テストコードが ③ テスト設計へ trace (DoD 検証コメント)
- TST-2: 観点網羅 (設計項目に対応するテスト観点の抜けなし) + テストレベル間非重複 (test-perspective-gate)
- TST-3: 逆ピラミッド不在 (① ② あり ③ ④ なし でない)
- TST-4: カバレッジ ≥ 80% (G7 時)
- TST-5: アンチパターン AP-3 / AP-7 / AP-8 不在 (テスト設計とコード混在、右側でペア未凍結テスト設計の新規起票)

**C. コード (② 実装コード)**
- COD-1: ② が ① 設計へ trace (docstring 契約参照)、`parent_design` 実在 (kind=impl)
- COD-2: 正確性 — 要件 / AC との整合、ロジック誤りなし
- COD-3: セキュリティ — 入力検証 / 認証認可 / 秘密情報混入なし
- COD-4: エラーハンドリング / 境界条件
- COD-5: 既存への破壊的影響 / 回帰 (add-* は既存不変 + 回帰 PASS)
- COD-6: アンチパターン AP-4 / AP-5 不在 (AC 無しで G3 通過、`parent_design` 不在で実装)

**D. 横断 (3 点の相互整合 + escalation)**
- XR-1: ① 設計 ⇔ ② 実装 ⇔ ③④ テストの **三位一体に矛盾なし** (構想書 §3.1.4 の 3 点レビュー)。矛盾あれば設計工程へ差し戻し
- XR-2: escalation 境界 (本番影響 / 認証 / 認可 / 決済 / PII / ライセンス / destructive) の該当判定。該当すれば「人間サインオフ必須」フラグを立てる (mode 問わず hard-block)
- XR-3: レビュアーが実装者と別 context/persona であり、`review_kind: intra_runtime_subagent` を記録 (③ naive self-review との区別)

**E. 依存・重複・機能整合 (機能単位 / 横断スコープ)** — diff だけでは見えない範囲

- DEP-1: **依存関係の正しさ** — 呼び出し / import グラフに orphan / missing / cycle が無い。設計層 (L4-L6) のレイヤリング違反 (下位が上位を参照する等) が無い (横断検出 relation-graph、構想書 §2.6.5)
- DEP-2: コンポーネント間接続の欠損が無い (connection-deficiency、構想書 §2.6.5)
- DUP-1: **重複実装 / 機能被りが無い** — 同等機能の既存実装と被っていない。L7 着手前に `ut-tdd code find` / `ut-tdd code dup` (相当) で流用候補を確認した記録があること。被りがある場合は再実装せず Add-feature / Refactor mode へ回す (アンチパターン AP-9)
- MOD-1: **機能単位のインターフェース整合** — 同一機能を構成する関数群が L6 機能設計 / D-API / D-CONTRACT に整合し、断片化 (同目的の関数が複数箇所に散在) していない
- MOD-2: 変更が機能単位の責務境界を越えていない (1 機能の変更が無関係モジュールに波及していない)

> `ut-tdd code find` / `dup` の code-index 実体が未整備の環境では、grep + L6 機能設計 doc / dependency-map との突合で代替し、その手段を根拠欄に記録する。

### 受入条件 (gate 崩壊防止)

- [x] `ut-tdd gate <判断ゲート>` は `ut-tdd status` の `mode` を参照し、`hybrid` 以外では gate 結果 JSON に `cross_agent_review: unavailable` を必ず含める (含まなければ実装不備として exit 1)
- [x] 単一エージェント (claude-only / codex-only) の判断ゲートは **② 専門サブエージェント review を hard 要件**とし、§7.8.7.1 の必須 checklist 項目 (DOC / TST / COD / XR / DEP / DUP / MOD) 全件の逐条実行記録 (各 pass/fail/n-a + 根拠) が無ければ **exit 1**。揃えば `passed: true` + `review_kind: intra_runtime_subagent` を記録する
- [x] ③ naive self-review (実装者の自己読み直し) を判断ゲートの通過根拠として記録してはいけない (cross-agent / intra_runtime_subagent と区別)。`evaluateGateReview` が `self_review` / `self-review` / `naive_self_review` を全 mode で reject し、単一 runtime は `intra_runtime_subagent`、standalone は `human` 以外を fail-close (2026-06-08)。
- [x] `same_model_approval: forbidden` を実行時強制: 承認者 (frontier-reviewer) と worker の `(provider, model)` が一致したら **① cross-agent としては無効化** (hybrid でも同一モデル割当を弾く)。② はそもそも同一モデル前提のため cross-provider 要件には数えない
- [x] checklist のいずれかの項目が `fail` なら gate を止める。`n-a` は根拠必須 (根拠なし n-a は欠落扱いで exit 1)
- [x] `orchestration_mode` が要求する agent が現 execution mode で不在の場合、silent fallback せず縮退 (§7.8.4 / 構想書 §2.1.2.1) を適用し、`degraded_from` / `degraded_to` を記録する (`ut-tdd vmodel show ... --injection --mode <mode>`, 2026-06-23)
- [x] **escalation 境界 (本番影響 / 認証 / 認可 / 決済 / PII / ライセンス / destructive)** に該当する変更 (XR-2 で検出) は execution mode を問わず人間サインオフ必須。未承認なら mode に関わらず exit 1 (② でも代替不可、§8 と整合)。`ut-tdd route eval` が signal から escalation 境界を検出し、`mode: "*", condition: "escalation"` または該当 mode の approval rule が無ければ fail-close する (2026-06-23)

---

# §8 補助 3: エスカレーション要件

## 8.1 L0-L3 reviewer 自動切替

| Level | reviewer | 動作 |
|-------|----------|------|
| L0 | agent | AI レビューのみ |
| L1 | aim | aim の人間レビュー追加 |
| L2 | council | tl + qa + aim 3 者会議 |
| L3 | human | po 直接通知 + 作業一時停止 |

## 8.2 level 算出仕様

### 閾値定義

| Level | 同種失敗 N (累計) | 再失敗 M (累計) |
|-------|------------------|-----------------|
| L1 | ≥ 3 | ≥ 1 |
| L2 | ≥ 7 | ≥ 3 |
| L3 | ≥ 15 | ≥ 7 |

### 冪等算出ロジック (構想書 v3.1 §8.3 確定)

```
input:
  - plan_id × failure_type で集計した同種失敗回数 N
  - 同 plan_id × failure_type の再失敗回数 M
output:
  target_level = max(level satisfied by either N or M threshold)

例:
  N=15, M=0 → L3 (N が L3 閾値を満たす)
  N=2, M=4 → L2 (M が L2 閾値、L3 は未達)
  N=0, M=0 → L0
```

target_level は **冪等算出**。current_level に +1 漸進ではない。

### 昇格イベント記録

```jsonl
{"timestamp":"2026-05-20T10:00:00Z","plan_id":"PLAN-042","failure_type":"vmodel_lint_p0","n_failures":15,"m_refails":0,"level_before":"L0","level_after":"L3"}
```

## 8.3 降格判定 (`check-escalation-stale.sh`)

定期実行 (GitHub Actions schedule: weekly):

| 期間 | 動作 |
|------|------|
| 違反検出ゼロ 90 日継続 | 降格 **推奨表示のみ** (自動降格しない) |
| 未使用 30 日 | warning |
| 未使用 90 日 | archive 候補 (human 確認後に非アクティブ化) |

降格 / archive は **human (po または tl) 確認後にのみ実行**。

## 8.4 failure_log の取扱い (構想書 v3.1 §8.5 確定)

| ログ種別 | 位置 | git 管理 | 書き込み主体 |
|---------|------|---------|--------------|
| **個人作業ログ** | `.ut-tdd/audit/failure_log.jsonl` | **`.gitignore`** | ローカル pre-push hook / `scripts/log-failure.sh` |
| **チーム共有 audit (PR/CI)** | GitHub Actions job summary + artifact / PR comment (audit 集計用、N/M 集計対象)。PR label は状態表示のみ | (Actions が管理) | CI job |
| **状態表示** | PR label (`escalation-L2` / `escalation-L3`) | (Actions が管理) | Actions が level 昇格時に付与 |

### GitHub failure corpus の扱い

組織としての失敗学習は、GitHub 上の証跡から pull する。`failure_log.jsonl` は個人作業ログであり、N/M 集計や再発傾向の正本にしない。

| Source 種別 | 取得例 | 用途 |
|--------|--------|------|
| Workflow runs / jobs | `gh api repos/{owner}/{repo}/actions/runs` / `jobs` | CI 失敗種別、再失敗回数、対象 branch |
| Job logs | `gh run view --log` または Actions API | vitest / lint / vmodel / branch-kind-check の failure_type 抽出 |
| Workflow artifacts | `harness-check` audit artifact | 機械可読な failure event 正本 |
| PR comments / reviews | GitHub Issues / Pulls API | review 指摘が test / PLAN / skill に変換されたか確認 |
| PR labels | `escalation-L*`, `postmortem-overdue` | 状態表示。N/M 集計の入力にはしない |
| Checks conclusion | Checks API | required check の pass/fail と skipped subjob の確認 |

failure event の最小 schema:

```json
{
  "timestamp": "2026-05-21T00:00:00Z",
  "repo": "org/repo",
  "pr_number": 123,
  "run_id": 456,
  "job_name": "harness-check",
  "subjob": "vmodel-lint",
  "plan_id": "PLAN-123",
  "failure_type": "vmodel_lint_p0",
  "severity": "P0",
  "converted_to": ["regression-test", "add-design"],
  "evidence_url": "https://github.com/org/repo/actions/runs/456"
}
```

`converted_to` が空の failure event は §8.6 の失敗変換ループで P1 warning とし、同種失敗が閾値を超えた場合は §8.2 の escalation 対象にする。

### `.gitignore` 必須エントリ

```
.ut-tdd/audit/failure_log.jsonl
.ut-tdd/audit/escalation_state.json
.ut-tdd/cache/*
!.ut-tdd/cache/.gitkeep
```

### `check-escalation-level.sh` の集計仕様

```
1. GitHub Actions API で同 plan_id の過去 90 日 artifact を取得 (チーム共有監査ログ)
2. job summary / artifact 内の failure event から N / M を算出
3. ローカル failure_log.jsonl は読み込まない (個人 advisory のみ)
4. §8.2 の冪等算出で target_level を決定
5. 結果を GitHub Actions artifact / PR label / PR comment に書く。ローカル実行時のみ `.ut-tdd/audit/escalation_state.json` に advisory cache を生成する
```

PR label (`escalation-L2` 等) は **集計対象外** (状態表示のみ、N/M に含めない)。

### CODEOWNERS 動的注入の禁止

CODEOWNERS は静的 path owner のため、level に応じた動的注入は実装不能。代替手段:

| 代替 | 仕組み |
|------|--------|
| PR comment | Actions が level 昇格時に `@<owner>` 付き comment を投稿 |
| label 制御 | `escalation-L2` / `escalation-L3` ラベルを PR に自動付与 |
| review request | Actions が `pulls/{number}/requested_reviewers` API で動的追加 |

## 8.5 受入条件 (エスカレーション)

- [ ] `check-escalation-level.sh` が §8.2 の冪等算出で target_level を出す
- [ ] N=15 を初回観測した場合に L3 (Human 通知) が即発火する
- [ ] failure_log.jsonl が `.gitignore` 対象
- [ ] チーム共有 audit が GitHub Actions artifact / job summary / PR comment 経由であり、PR label は状態表示のみ、個人 failure_log は N/M 集計対象外
- [ ] `escalation_state.json` は git 管理されず、ローカル advisory cache として扱われる
- [ ] CODEOWNERS 動的注入を実装しない (PR comment / label / review request で代替)

## 8.6 失敗変換ループの受入条件

構想書 v3.1 §1.4 の「失敗を仕組みに変換する原則」を、以下の機械検証・成果物更新で扱う。

| 入力 event | 必須変換先 | 機械検証 |
|------------|------------|----------|
| `vmodel_lint` P0 | 修正 commit または `add-design` / `add-impl` PLAN | P0 が残る PR は `harness-check` exit 1 |
| レビューで見つかったテスト不足 | L6 QA 追加テスト設計 + `QA-XXX-NNN` test | L6 QA trace 欠落は §2.5 により P0 |
| session 断絶・認識ずれ | `.ut-tdd/handover/CURRENT.json` または `recovery` PLAN | pre-push は handover なしを warning、recovery 7 セクション欠落を exit 1 |
| PoC confirmed | Reverse PLAN + R4 `forward_routing` + `promotion_strategy` | §3.4 の R4 必須 field 欠落は exit 1 |
| 同種失敗の反復 | escalation L0-L3 event | §8.2 の冪等算出で target_level を出す |
| AI の自己承認 | cross-agent review または P1 warning | `same_model_approval=forbidden` 時は §7.1 orchestration で exit 1 |

失敗 event を単なるコメントで close してはいけない。以下のいずれにも変換されない場合、`harness-check` は P1 warning を出す。

- test / regression test
- design or add-design PLAN
- recovery PLAN / postmortem
- debt register / deferred finding への登録
- skill pack update への反映
- orchestration policy update への反映
- handover note への記録

---

# §9 リポジトリ構造要件

## 9.1 ディレクトリ構造 + Phase 別必須種別 (R-C6 / R-C7 fix で 3 種別に分類)

> **配置ルールの canonical 正本は `docs/governance/repository-structure.md`**（ツリー + 配置ルール + 命名 + 境界 + 禁止事項）。本 §9.1 は **Phase 0 の存在チェック（A/B/G 種別）** に特化する。両者が食い違う場合は repository-structure.md を構成の正、本 §9.1 を Phase 0 受入の正とする。

凡例:
- **A**: Phase 0-A 完了時に必須
- **B**: Phase 0-B 完了時に追加必須
- **G**: 生成時作成 (Phase 0 では不要、利用時に hook / script が作成)
- **[予定]**: 凡例外。未実装で Phase 0 対象外、後続 PLAN で A 化予定 (ADR-005 D2 の `src/web/` 等)

```
<repo-root>/
├── .github/
│   ├── CODEOWNERS                                # B (R-C6 fix: 0-B 追加必須)
│   ├── ISSUE_TEMPLATE/
│   │   ├── recovery.md                           # A
│   │   └── add-feature.md                        # A
│   ├── PULL_REQUEST_TEMPLATE.md                  # A
│   └── workflows/
│       ├── harness-check.yml                     # A (Required 化は 0-B)
│       └── escalation-stale.yml                  # A (weekly cron)
├── .ut-tdd/
│   ├── audit/                                    # A (ディレクトリのみ、.gitkeep)
│   │   ├── failure_log.jsonl                     # G (R-C7 fix: pre-push 実行時に生成、git 管理しない)
│   │   └── escalation_state.json                 # G (local advisory cache、git 管理しない)
│   ├── cache/                                    # A (.gitignore、.gitkeep)
│   ├── state/                                    # A (ディレクトリのみ、.gitkeep)
│   │   ├── runtime.json                          # G (mode 検出結果、git 管理しない)
│   │   └── tool-adapters.json                    # G (optional adapter 検出結果、git 管理しない)
│   ├── teams/                                    # A (orchestration 定義、default YAML は管理対象)
│   │   ├── default-hybrid.yaml                   # G (team run 利用時に作成)
│   │   └── local*.yaml                           # G (個人 model / command override、git 管理しない)
│   └── handover/                                 # A
│       └── CURRENT.json                          # G (機械ポインタ、ut-tdd handover が生成、gitignored)
├── .pre-commit-config.yaml                       # A
├── .gitignore                                    # A (§8.4 エントリ含む)
├── commitlint.config.js                          # A
├── docs/
│   ├── governance/                               # A
│   │   ├── ai-dev-team-concept_v1.1.md           # A (構想書 v1.1)
│   │   ├── ai-dev-team-operations_v1.1.md       # A (運用ルール書 v1.1)
│   │   ├── ut-tdd-agent-harness-concept_v3.1.md  # A (構想書 v3.1)
│   │   └── ut-tdd-agent-harness-requirements_v1.2.md  # A (本書)
│   ├── plans/                                    # A (ディレクトリのみ)
│   │   └── PLAN-NNN-*.md                         # G
│   ├── design/                                   # A (ディレクトリのみ)
│   ├── test-design/                              # A (ディレクトリのみ)
│   ├── adr/                                      # A (ディレクトリのみ)
│   ├── process/                                  # A (ディレクトリのみ、工程(L0-L14)/駆動モデル定義の正本、ADR-005)
│   ├── postmortem/                               # A (ディレクトリのみ)
│   └── skills/                                   # A (ディレクトリのみ、構想書 §8 補助 3 層 1)
├── src/                                          # A (TypeScript core、ADR-001)
│   ├── cli.ts                                   # A (エントリ)
│   ├── schema/                                  # A (zod 単一正本: enum / RecommendedCommandV1 等)
│   ├── plan/                                    # A (plan lint / validator)
│   ├── vmodel/                                  # A (4 artifact trace validator)
│   ├── runtime/                                 # A (mode 検出 / orchestration)
│   ├── doctor/                                  # A
│   └── web/                                     # [予定] 中央 Web UI service (ADR-005 D2、Phase 0-A 不要、後続 PLAN で A 化)
├── tests/                                        # A (vitest、*.test.ts)
├── package.json                                  # A (Node/Bun 依存 + scripts)
├── tsconfig.json                                 # A (strict)
├── scripts/                                        # A (薄い OS entrypoint + installer のみ。core logic 不可 / ADR-001 / repository-structure.md §1)
│   ├── ut-tdd                                    # A (POSIX / Git Bash)
│   ├── ut-tdd.ps1                                # A (Windows PowerShell entrypoint)
│   ├── install-hooks.sh                          # A
│   ├── install-hooks.ps1                         # A (Windows PowerShell hook installer)
│   └── setup-branch-protection.sh                # A (一回限り ops、実行は 0-B)
├── workflows/                                    # A (構想書 §8 補助 3 層 2 設計仕様書)
│   └── *.yaml                                    # G
└── harness/                                      # A (構想書 §8 補助 3 層 3 設計仕様書)
    └── *.yaml                                    # G
```

> **scripts/ 整流 (ADR-001)**: `plan lint` / `vmodel lint` / `doctor` / `gate` / escalation / failure log の各機能は個別 `.sh` ではなく compiled `ut-tdd` の**サブコマンド** (TS core、§7.1) として実装する。`scripts/` には OS entrypoint (`ut-tdd` / `ut-tdd.ps1`) と installer / 一回限り ops のみを置く。TS 依存・config は **root の `package.json` / `tsconfig.json` に集約**し、`scripts/` 配下に重複させない (repository-structure.md §8)。

## 9.2 受入条件 (構造)

- [ ] Phase 0-A 完了時に **A 種別** の全ディレクトリ + 必須ファイルが存在
- [ ] Phase 0-B 完了時に **B 種別** が追加で存在 (CODEOWNERS)
- [ ] **G 種別** は Phase 0 では存在しないことを許容 (clean checkout 後の lint で生成有無を要求しない)
- [ ] `.gitignore` に §8.4 のエントリ (`failure_log.jsonl` / `escalation_state.json` / `.ut-tdd/cache/*` + `.gitkeep` 例外) が含まれる
- [ ] `.ut-tdd/state/runtime.json` は generated state として Git 管理されない
- [ ] `.ut-tdd/state/tool-adapters.json` は generated state として Git 管理されない
- [ ] `.ut-tdd/teams/local*.yaml` は個人 model / command override として Git 管理されない
- [ ] `package.json` に依存 (`yaml` / `zod` / CLI framework 等) と engine pin、lockfile (`bun.lockb` 等) を伴う
- [ ] `docs/design/` と `docs/test-design/` のディレクトリペアが対応

---

# §10 Phase 0 受入条件

## 10.1 Phase 0-A: リポジトリ初期化 (CODEOWNERS なし、R-I9 fix で検証コマンド明記)

### 受入条件 (11 項目)

| # | 条件 | 検証コマンド |
|---|------|--------------|
| 1 | リポジトリ初期化 | `git rev-parse --show-toplevel` exit 0 |
| 2 | §9.1 の全 **A 種別** ディレクトリ作成 | `for d in <dirs>; do test -d $d; done` exit 0 |
| 3 | `.gitignore` に §8.4 エントリ | bash: `grep -q 'failure_log.jsonl' .gitignore && grep -q 'escalation_state.json' .gitignore && grep -q '.ut-tdd/cache/\\*' .gitignore && grep -q '!.ut-tdd/cache/.gitkeep' .gitignore` / PowerShell: `Select-String` で同等確認 |
| 4 | `.pre-commit-config.yaml` 配備 + 動作 | **`pre-commit run --all-files`** exit 0 (gitleaks / commitlint format / 軽量 lint パス) — R-I9 |
| 5 | `commitlint.config.js` 配備 | `npx --no-install commitlint --help` exit 0 |
| 6 | `scripts/ut-tdd*` 配備 + 動作 | bash: `bash scripts/ut-tdd --help && bash scripts/ut-tdd setup --dry-run && bash scripts/ut-tdd status --json` / PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -Command "& { & ./scripts/ut-tdd.ps1 --help; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ./scripts/ut-tdd.ps1 setup --dry-run; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ./scripts/ut-tdd.ps1 status --json; exit $LASTEXITCODE }"` がどちらも exit 0 |
| 7 | `package.json` 配備 | `test -f package.json && grep -q '"zod"' package.json` exit 0 |
| 8 | Node/Bun 依存導入 | `bun install` (または `npm ci`) exit 0 |
| 9 | 実行権限 / Windows shim 確認 | bash: `[ -x scripts/ut-tdd ] && [ -x scripts/install-hooks.sh ]` / PowerShell: `powershell -NoProfile -Command "& { if (!(Test-Path ./scripts/ut-tdd.ps1) -or !(Test-Path ./scripts/install-hooks.ps1)) { exit 1 } }"` がどちらも exit 0 |
| 10 | hook install 実行 | bash: `bash scripts/install-hooks.sh` / PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-hooks.ps1` がどちらも exit 0 |
| 11 | gitleaks binary が pre-commit 経由で動作 | **`pre-commit run gitleaks --all-files`** exit 0 — R-I9 |

### Phase 0-A 完了基準

- 上記 11 項目全て pass
- Linux/macOS POSIX shell と Windows PowerShell の Phase 0-A smoke が両方 pass
- `harness-check.yml` ワークフローは存在するが Required Status Checks に登録しない
- bootstrap-owner 1 名で全 PR レビュー

## 10.2 Phase 0-B: CODEOWNERS + Branch Protection (運用 Stage、R-C8 / R-P2 fix)

### 前提権限 (R-P2 fix)

| 権限 | 要件 |
|------|------|
| GitHub repository | admin 権限 |
| GitHub token (`GH_TOKEN`) | `repo` + `admin:org` (CODEOWNERS team 参照用) scope |
| Local 環境 | `gh auth login` 済み |

### 受入条件 (3 項目)

| # | 条件 | 検証コマンド |
|---|------|--------------|
| 1 | `.github/CODEOWNERS` に team 別 path アサイン | `gh api "repos/$REPO/codeowners/errors" --jq '.errors \| length'` が 0 |
| 2 | Branch Protection を main に設定 (`harness-check` を required、required_approving_review_count=1) | `gh api "repos/$REPO/branches/main/protection" --jq '.required_status_checks.contexts[]'` に `harness-check` が含まれる |
| 3 | テスト PR matrix で `harness-check` の subjob 適用が §6.3 と一致 (R-C8 fix) | 以下 branch type 別テスト PR matrix を参照 |

### branch type 別テスト PR matrix (R-C8 fix)

`harness-check` の subjob 適用が §6.3 表と一致することを branch type 別に検証する。各 branch から軽微な変更で PR を起票し、Checks タブに以下 subjob が **適用 (✓) または skipped (—)** として表示されることを確認。

| テスト PR | 確認対象 (適用 subjob) | skipped 確認 |
|-----------|------------------------|--------------|
| `feature/test-bootstrap` (impl PLAN 同梱) | plan-lint / vmodel-lint / branch-kind-check / commitlint / regression-test | poc-no-merge-guard / hotfix-postmortem-required / scrum-reverse-lint |
| `poc/test-bootstrap` (poc PLAN 同梱) | plan-lint / branch-kind-check / scrum-reverse-lint / poc-no-merge-guard / commitlint | vmodel-lint / hotfix-postmortem-required / regression-test |
| `docs/test-bootstrap` (PLAN なし、軽微修正) | commitlint | plan-lint / vmodel-lint / branch-kind-check 他 (例外 branch) |

→ 「適用」subjob は exit 0 で緑、「skipped」subjob は `skipped` ステータスで表示される。

### Phase 0-B 完了基準

- 上記 3 項目全て pass (matrix 3 種の test PR で確認)
- bootstrap-owner から team に移管完了
- 以後の全 PR は `harness-check` を必須として merge

## 10.3 Phase 0 全体の受入条件

- [ ] Phase 0-A の 11 項目 + Phase 0-B の 3 項目 = 計 14 項目すべて pass
- [ ] §10.2 の branch type 別テスト PR matrix で `harness-check` subjob 適用が §6.3 と一致
- [ ] §5.3 の pre-push 4 項目が動作 (handover/CURRENT.json なしで warning が出る等)

---

# §11 用語差分

構想書 v3.1 §10 の用語集を正本とする。本書では以下の追加用語のみ定義:

| 用語 | 定義 |
|---|---|
| **VALID_STATUSES** | frontmatter `status` の enum: draft / confirmed / completed / archived |
| **VALID_DECISION_OUTCOMES** | frontmatter `decision_outcome` の enum: confirmed / rejected / pivot (kind=poc + workflow_phase=S4 のみ) |
| **VALID_KINDS** | frontmatter `kind` の enum (12 種、§1.3) |
| **VALID_LAYERS** | frontmatter `layer` の enum (16 種、§1.4) |
| **VALID_WORKFLOW_PHASES** | frontmatter `workflow_phase` の enum (10 種、§1.5) |
| **VALID_DRIVES** | frontmatter `drive` の enum (5 種 = 専門職、§1.6。旧 9 種から mode 値除去 = V7) |
| **VALID_ARTIFACT_TYPES** | frontmatter `generates[].artifact_type` の enum (19 種、§1.7) |
| **VALID_ROLES** | frontmatter `agent_slots[].role` の enum (7 種、§1.8) |
| **必須 8 directed edge** | §2.4 の vmodel_validator 必須検証対象 (#1-#8、残り #9-#12 は warn) |
| **harness-check subjob** | `harness-check` 内で呼ばれる 8 種の検証 (§6.3) |
| **canonical diff rule** | §4.1 で確定した `git diff --name-only --diff-filter=DM origin/main...HEAD -- <path>` |
| **exit 2 (P1 only)** | `vmodel_validator` が P1 warning のみ検出時の exit code (§7.3) |

---

# §12 改定履歴

| Version | 日付 | 変更内容 | 策定者 |
|---|---|---|---|
| 1.0 | 2026-05-20 | 初版。構想書 v3.0 と分離して要件定義のみを記述 | PM + TL |
| **1.1** | **2026-05-20** | **Codex TL Round 4 (追突レビュー) で指摘された Critical 8 + Important 9 を全 fix。S4 outcome enum 追加 / G4 fail-close 条件統一 / pre-push fail-close と warning 分離 / branch prefix 全 11 kind 網羅 / Phase 0-A/0-B 必須ファイル区別 / failure_log の必須性とディレクトリ性の整理 / テスト PR matrix 化 / drive×kind matrix / 必須 role 表 / canonical diff rule / exit code 3 段階 / pre-commit 検証コマンド明記** | **PM + TL** |
| **1.2+** | **2026-05-28** | **§1.10.H G1-trace 機械検証ルール追加 (DD1=a / DD2=a PO 承認 2026-05-28)。G1 内 sub-gate「業務⇔画面⇔機能 双方向 trace 整合」としてルール R1-R4 (H.1-H.4) を定義。R1: BR/UX→画面 trace block / R2: 画面→BR/UX/FR-L1 trace block / R3: FR-L1 P0 block + P1-P2 warn (DD2=a) / R4: screen PLAN requires 整合 warn。§H.5 CLI: `ut-tdd plan lint --gate G1-trace`。§H.6 G1 entry/exit 条件 (G1-content→G1-pair→G1-trace の 3 段 fail-close)。§H.7 §G との接続規約 (§G.3/G.6 が前提条件)。構想書 §3.3.1 と連動。** | **PMO (Sonnet)** |
| **1.2** | **2026-05-27** | **V2 source snapshot reference の工程・モード・配線を取り込み (構想書 v3.1 連動)。§1.4 VALID_LAYERS を V2 L0-L14 + V-model に作り替え (旧 L0-L11+小数層を remap、L3.5/L3.8/L4.5 廃止)。§2 の 3 段階 freeze / 受入条件を V-model (G1/G3/G4/G5/G6 pair → G7 trace) に更新。§1.1 に `parent_design` 必須フィールド追加 (kind=impl)。§7.8 配線要件新設 (signal→mode routing / RecommendedCommandV1 safety schema / requires_human_approval→承認者解決 / orchestration_mode enum 5 種 / layer-context 注入 / 横断検出)。必須 role 条件・委譲表・gate 番号を L0-L14 に整合。§7.8.7 execution mode × レビューゲート切り分け新設 (mode 別 gate 挙動 / same_model_approval 実行時強制 / escalation 境界は mode 問わず人間サインオフ必須、gate 崩壊防止)。**単一エージェント時は ② 専門サブエージェント review を hard 要件化し、§7.8.7.1 に doc/test/code 3 点 + 横断の明文化必須 checklist (DOC/TST/COD/XR) を確定** (明文化でレビュアーのモデル差異を吸収)。レビュー範囲を **関数単位 / 機能単位 / 横断** の 3 スコープに拡張し、依存関係 (DEP)・重複実装 (DUP)・機能整合 (MOD) のチェック項目と AP-9 (重複実装) / AP-10 (依存違反) を追加。§7.1 team run 検証 7 + §7.6 受入条件に **ルール同一性 (rule parity test: claude-only と codex-only で同一判定・同一 exit code、CLAUDE.md/AGENTS.md の drift 検出)** と **hybrid 機能分散 (判断系/実行系を別 runtime、二重実行を exit 1)** を MUST 化 (構想書 §2.1.0)。ADR-001 連動で**実装言語を TypeScript (Bun) に確定**し §7.1 / §9.1 / §1.1 / §1.7 / §366 等の言語前提を Python→TS に更新 (`python_module`→`source_module`、`python -m ut_tdd.cli`→TS core、`requirements.txt`→`package.json`、pytest→vitest、pydantic→zod)** | **PM (Opus)** |

---

**本書は UT-TDD-agent-harness の要件定義書である。構想 (WHY/WHAT) は `ut-tdd-agent-harness-concept_v3.1.md` を、各 enum・スクリプト・workflow YAML の実装詳細は将来の個別 PLAN-XXX 詳細設計を参照。**
