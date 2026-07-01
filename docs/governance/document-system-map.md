# UT-TDD ドキュメント体系マップ (業界標準 grounding + フロー改善)

> 各 V/V-model 工程の **① 必須スケルトン (作成必須ドキュメント)** を業界標準 (日本式 IPA 共通フレーム + 国際標準 + Design by Contract) で裏付ける正本。
> メタモデルの ① 必須タスク/doc の grounding 資料 ([[ut-tdd-agent-harness-concept_v3.1]] §3 V/V-model と連動)。
> 出典は §5 に集約。調査基準日: 2026-05-29 (A-61、pmo-tech-docs 調査)。

## §0 用語の確定 — 基本設計 = 外部設計 / 詳細設計 = 内部設計 / 機能設計 = 仕様設計

IPA 共通フレーム 2013 (SLCP-JCF) では次が**同義**として扱われる (情報処理技術者試験でも併記):

| 日本 SI 用語 | 同義語 | 設計の視点 | UT-TDD 層 | V-pair (テスト設計) |
|---|---|---|---|---|
| **基本設計** | **外部設計** | ユーザー (発注者/エンドユーザー) から見える側。画面/帳票/IF/データ/業務処理の **振る舞い (what)** | L4 (一部) | ↔ L9 総合テスト (システム粒度) |
| **詳細設計** | **内部設計** | システム内部構造。モジュール分割/関数/DB 物理設計の **実装 (how)** | L5 | ↔ L8 結合テスト (module 結合粒度) |
| **機能設計** | **仕様設計** | 各関数の仕様そのもの (signature + 事前/事後条件 + エッジケース)。「この関数は何を保証するか」 | L6 | ↔ L7 単体テスト設計 (関数 = 単体粒度) |
| 方式設計 | アーキテクチャ設計 | 技術スタック/構造方針。日本 SI では基本設計の入口、国際標準では独立文書 | L4 (一部) | (ADR) |

> **重要 (1)**: UT-TDD の **L4 基本設計は「方式設計 (arch) + 外部設計 (外部 IF)」の両方を含む**。国際標準 (arc42 / ISO 42010) では方式設計を独立文書 (ADR + Architecture Description) にするため、L4 内で sub-doc を分離する (§4 Z1)。
>
> **重要 (2) — 機能設計 = 仕様設計 = 単体テストと同義圏 (PO grounding 2026-06-01)**: L6 機能設計は **各関数の「仕様」** を作る (= 仕様設計)。単体テストは **その関数を仕様に照らして検証する**もの。よって **機能設計 ↔ 単体テスト設計のペアは必然** (同じ「関数=仕様」粒度を、設計側と検証側から見ているだけ)。child 分割の粒度判定「L6 で単体テスト設計粒度に落とせるか」= 「**それを関数の仕様 (機能設計=仕様設計) として書けるか**」= 「単体テスト可能な関数粒度になっているか」の 3 つは同義。設計を粗く束ねてよい上限は L4 (システム=L9 総合テスト)、そこから L5 (module 結合=L8) → L6 (関数仕様=L7 単体) へ段階的に仕様の粒度を細かくする。
>
> **重要 (3) — 未確定項目の placeholder + back-fill 許可 (PO 2026-06-01)**: テスト設計は仕様が決まって初めて書ける。L4 等の上位段階で下位仕様 (L5/L6 確定分) 未確定により対のテスト設計が書けない項目は、**黙って飛ばさず「どの層で何が確定したら書けるか」を placeholder + 依存条件として残す**。そして **L6 機能設計 (=仕様設計) で仕様が確定した時点で、その L6 を起点に対応テスト設計 (L7 単体、必要に応じ遡って L8/L9) を作りに戻ってよい (back-fill)**。V-model は厳密な一方向の滝でなく、**仕様が固まった層からペア (設計⇔テスト設計) を後追い完成させる back-fill を正規運用**とする。
>
> **重要 (4) — back-fill の整合は DB(state) 側で機械保証 (PO 確定 2026-06-01)**: back-fill は放置許可ではなく、**最終的に全ペアが揃った V-model 状態 (孤児 0) へ必ず収束する**ことが目的。保証は人手に依存しない。`.ut-tdd/` state (V-model 正本 DB) が「入るべき設計⇔テスト設計ペア」を `pair_artifact` + `trace.edges` (physical-data §2.2) として持ち、**未充足 (placeholder 未解消 / pair edge 欠落 / 逆ピラミッド) を `ut-tdd doctor` / vmodel lint / G6-G7 が fail-close で検知** (physical-data §7)。「入るべきところが入っていなければ DB 側からも検知できる仕組み」(PO)。これは漏れをなくすための運用そのもの (FR-L1-49 drift lint / IMP-033 rule engine と同機構)。

> **重要 (5) — 右腕 = データ実在性エスカレーション (正規式 V-model、PLAN-RECOVERY-02 2026-06-04 PO 確定、非破壊)**: 右腕の検証本質は使うデータ・環境の実在性が段階的に上がる: 合成/テストデータ (L6 単体 / L5 結合→L8 / L4 総合→L9) → 本番実データ (**L2 実データ検証=画面→L10** が先、**L3 本番受入=要件→L12** が後。右腕工程順) → L1 運用→L14 (実データ×時間) → L0 価値 (実成果)。**L0 企画にも検証ペア (価値検証 = L14→L0 feedback) を与え V の頂点を閉じる** (従来 L0 はペア無しだった穴埋め)。**L2 画面 = L1 のフェーズ分離** (画面要求→要求/要件、画面詳細→L5)。番号・既存ペアは据え置き (追加・明確化のみ)。

## §1 工程 × 成果物 × 標準 マスター表 (L0-L14)

> **ゲート (G_N) の設計・台帳・自動追加型クロスチェック機構は [gate-design.md](./gate-design.md) を正本**とする (各ゲートの判定 4 軸 / サインオフ / fail routing / ルールエンジン)。

| UT-TDD 層 | 日本 SI 工程 | 主成果物 (① 必須) | 国際標準 | V-pair (テスト設計) |
|---|---|---|---|---|
| **L0** 企画 | 企画 (システム化構想) | 企画書 (kind=charter) / ユビキタス言語 §Glossary | ISO 29148 BRS / PMBOK Charter | ↔ 価値検証 (L14→L0 feedback、事業価値の実現) |
| **L1** 要求定義 | 要求定義 | 業務要求 BR-*/NFR-* (5 sub-doc) | ISO 29148 **StRS** / IPA NFR グレード 2018 / DDD | ↔ L14 運用テスト設計 |
| **L2** 画面設計 | 基本設計(画面)前段 | ワイヤーモック (画面一覧/遷移/WF/UI 要素) | arc42 §8 / C4 Container(UI) / ISO 9241 | ↔ L10 (モック自体がペア) |
| **L3** 要件定義 | 要件定義 | 機能要件 FR-*/AC-* (3 sub-doc) | ISO 29148 **SyRS** / **BDD Given-When-Then** | ↔ L12 受入テスト設計 |
| **L4** 基本設計 | **基本設計(外部設計) + 方式設計** | 方式設計/ADR + 外部 IF 設計 + データ設計(ドメインモデル) + 画面設計確定 + 帳票/バッチ/通知/コード値設計 (標準成果物カタログ、§1b) | ISO 42010 / **arc42 §4-§5/§9** / C4 Container / IEEE 1016 / DDD | ↔ L9 総合テスト設計 |
| **L5** 詳細設計 | **詳細設計(内部設計)** | D-API / D-DB / D-CONTRACT (内部処理/モジュール/物理DB/IF詳細) | **IEEE 1016 SDD** / UML / **DbC (pre/post)** | ↔ L8 結合テスト設計 |
| **L6** 機能設計 | (詳細設計末端、関数 level) | 関数 schema / クラス設計 / エッジケース / WBS | **IEEE 1016 §5.7 Pseudocode** / UML method | ↔ L7 単体テスト設計 |
| **L7** 実装 | 製造 | ② 実装コード + ④ テストコード (TDD Red→Green→3点R) | ISO 12207 §7.1 / CMMI SP1.4 | (G7 4-artifact trace freeze) |
| **L8** 結合テスト | 結合テスト | 結合テスト実施/報告 | ISO 29119-3 TDS | (L5 と対) |
| **L9** 総合テスト | 総合テスト | 総合テスト実施/報告 | ISO 29119-3 TDS | (L4 と対) |
| **L10** UX 磨き | (日本 SI に独立工程なし) | FE デザイン確定 / UX 検証 (**impl 後**: 実装済 UI を磨き WCAG 検証。再利用 FE 設計標準=部品/色は impl 前の L4 `ui-standard`、§1b) | **WCAG 2.2 / ISO 9241-110** | (L2 と対) |
| **L11** 総合レビュー+UAT | 受入テスト前段 | BR↔実装突合 / PO UAT | ISO 29119-3 Acceptance | (L3 と対) |
| **L12** デプロイ+受入 | 受入テスト | リリース手順 / 受入チェックリスト (AC 全件) | IEEE 829 / ISO 25010 | (L3 と対) |
| **L13** デプロイ後検証 | 運用引渡し | 自動監視 / SLA 確認 | **ISO 29119-2 Test Evaluation** / SRE SLO/SLI | — (post-deploy) |
| **L14** 運用検証+改善 | 運用テスト・保守 | 運用テスト設計 (L1 でペア) / 改善 FB | ISO 12207 §7.4-§7.5 | (L1 と対、最長ペア) |

### §1b 外部設計 標準成果物カタログ (L4 sub_doc、IPA 共通フレーム grounding)

§0 のとおり **基本設計 = 外部設計 = ユーザーから見える側の振る舞い**。IPA 共通フレーム 2013 の外部設計成果物は「**画面 / 帳票 / IF / データ / 業務処理**」。UT-TDD では画面を L2 (画面専用層) に分離し、残る標準成果物を L4 sub_doc として持つ。これが SI 標準成果物カタログであり、`src/schema/index.ts` の `VALID_SUB_DOCS[L4]` が正本 (要件 §1.10.G.1 が mirror)。

| 標準成果物 | L4 sub_doc slug | 区分 (§4 G.13) | 国際/業界標準 | 備考 |
|---|---|---|---|---|
| 画面 | (L2 へ分離: screen-list/flow/ui-element/wireframe) | ① 必須 (UI 有時) | ISO 9241 / arc42 §8 | L2 画面設計層が担う (画面の棚卸し) |
| **UI 設計標準** | `ui-standard` | **② プロダクト選択 (UI 有時)** | Nablarch UI標準/部品カタログ / ISO 9241-110 | **再利用 FE 設計標準** (UI 設計標準 + UI 部品カタログ + design tokens=色)。`data` (DB 設計標準) の FE 対応物。L2 (画面棚卸し) と別物で、impl **前**に要る方式設計/開発標準。PLAN-L4-14 |
| 業務処理 (機能) | `function` | ① 必須 | DDD / arc42 §5 | 機能の外部振る舞い |
| 外部 IF | `external-if` | ② プロダクト選択 | C4 Container / DDD | 外部接続がある製品 |
| データ (ドメインモデル) | `data` | ① 必須 | DDD (Evans) | 集約/値オブジェクト |
| **帳票** | `report` | **② プロダクト選択** | IPA 外部設計 (帳票設計) | 帳票出力がある製品 |
| **バッチ** | `batch` | **② プロダクト選択** | IPA 外部設計 (バッチ設計) | バッチ処理がある製品 |
| **メール/通知** | `notification` | **② プロダクト選択** | IPA 外部設計 (通知設計) | 通知/メール送信がある製品 |
| **コード値一覧** | `code-value` | **② プロダクト選択** | IPA 外部設計 (コード設計) | 区分値マスタを持つ製品 |

> **② プロダクト選択** = 当該成果物を産出する製品のみ起票し、不産出製品 (例: この CLI harness は帳票/バッチ/メール/コード値を持たない) は `skip_sub_doc[].reason` で省略する (要件 §1.10.G.3 drive × sub_doc 整合)。カタログの要否は **土台のミッション (= 別 SI 製品開発、帳票/バッチ/メール/コード値を普遍的に持つ)** で測り、harness 自身の形状 (CLI で帳票なし) で測らない ([[ut-tdd-agent-harness-concept_v3.1]] §自己適用境界、PO 2026-06-22)。

> **必須 § 構造 (外部設計内容)**: 4 型 (`report`/`batch`/`notification`/`code-value`) 各々の必須 § は
> 要件 [§1.10.G.6.1](./ut-tdd-agent-harness-requirements_v1.2.md) で IPA 共通フレーム外部設計に grounding して
> 確定し、`ut-tdd plan lint` (`sub-doc-section-structure` gate) が design PLAN に対し fail-close 検証する。
> 例: 帳票 = §1 帳票一覧 / §2 レイアウト / §3 出力項目定義 / §4 出力条件・タイミング / §5 関連 doc。

## §1c 各 L の FE/UI 設計ドキュメント定義 (フロント設計 doc coverage、PLAN-L4-14)

> **本節の目的 (PO 指摘 2026-06-24「各 L におけるフロント/UI の設計ドキュメントを先に定義しろ」)**:
> V-model 各層 (L0-L14) に **どの FE/UI 設計ドキュメントが降りるか**を定義する。これまで設計左腕は
> L1 画面要求 → L2 画面設計で止まり、**L3-L6 が BE 中心で「画面/UI の機能要件・詳細設計・per-screen 設計・
> 部品/色がどの層に降りるか」が未定義** だった (= フロント設計 doc のカバレッジ未定義の穴)。本節がそれを
> 層ごとに定義する。**これは設計左腕 (FE 設計降下) の定義であり、検証右腕 (frontend-design →
> L7/L8/L9/L12/L14) は [proposal-document-coverage-routing](../test-design/harness/proposal-document-coverage-routing.md)
> §2 が別途持つ**。業界標準 (IPA 共通フレーム外部設計 / Nablarch 画面設計・UI標準(画面)・UI部品カタログ・
> システム機能設計書(画面)・画面モックアップ作成ガイド・単体テスト仕様書(画面)) を grounding とする。

> **位置づけ**: 本節は「定義 (どの層に何の FE doc が要るか)」。各 doc の **実体作成は本定義の下流** (定義 →
> 不足 doc の起票/作成 → 実装、段階順)。「画面 mock をいきなり作る」前に、まず本節で per-layer の
> FE/UI 設計 doc 集合を確定する。

| L 層 | FE/UI 設計ドキュメント (定義) | 役割 | 業界標準対応 | harness 現状 |
|---|---|---|---|---|
| **L0** 企画 | (FE 固有 doc 無し) | UI を持つ製品か否かの方針は L0 概念で言及 | — | N/A |
| **L1** 要求定義 | 画面要求 (`screen-requirements`) | 画面一覧 (初期) + 各画面の役割 + UX 横断原則 | ISO 29148 StRS / 画面一覧(初期) | ✓ `L1-requirements/screen-requirements.md` |
| **L2** 画面設計 | 画面一覧 (`screen-list`) / 画面遷移 (`screen-flow`) / UI 要素 (`ui-element`) / ワイヤーモック (`wireframe`) | 画面の棚卸し + 遷移 + 部品契約 + Low-Fi mock | arc42 §8 / ISO 9241 / 画面設計 + 画面モックアップ作成ガイド | ✓ `L2-screen/*` (G2 freeze 済) |
| **L3** 要件定義 | **画面/UI の機能要件 + 画面 AC** (`screen-functional`) | 画面の振る舞い・入出力・状態遷移を SyRS/AC として確定 | ISO 29148 SyRS + BDD GWT | **body 起票済**: `docs/design/harness/L3-functional/screen-functional.md` (confirmed, PLAN-L3-06) |
| **L4** 基本設計 | **UI 設計標準 + UI 部品カタログ + design tokens** (`ui-standard`) | 再利用 FE 設計標準 = `data` (DB 設計標準) の FE 対応物 (§1b) | Nablarch UI標準(画面)/UI部品カタログ/共通コンポーネント設計標準 | ✓ `L4-basic-design/ui-standard.md` + `tokens.yaml` (confirmed) |
| **L5** 詳細設計 | **FE 内部設計** (`ui-detail`): コンポーネント分割 / 状態管理 / ルーティング / 画面内部処理 | 画面の内部構造を IEEE 1016 SDD 相当で詳細化 | IEEE 1016 SDD / UML | **body 起票済**: `docs/design/harness/L5-detailed-design/ui-detail.md` (confirmed, PLAN-L5-09) |
| **L6** 機能設計 | **per-screen 機能設計** (`screen-spec`): 画面ごとの項目定義 / イベント / バリデーション / 画面内遷移 | 画面 1 枚を関数仕様粒度で確定 (= L7 単体テスト設計の対) | Nablarch システム機能設計書(画面) | **body 起票済**: `docs/design/harness/L6-function-design/screen-spec.md` (confirmed, PLAN-L6-36) |
| **L7** 実装 | `src/web` 実装コード + FE テストコード | component-derived 実装 (TDD) | ISO 12207 製造 | (L7-141 で未着手) |
| **L8** 結合テスト | FE 結合テスト設計/実施 (UI↔API/状態境界) | 単体テスト仕様書(画面) 相当 | ISO 29119-3 / 単体テスト仕様書(画面) | `test-design/L8-integration-test-design.md` (FE 観点は未充足) |
| **L9** 総合テスト | 画面横断 visual/a11y 一貫性の総合テスト | L4 ui-standard の対 (V-pair L4↔L9) | ISO 29119-3 | `test-design/L9-system-test-design.md` (FE 観点は未充足) |
| **L10** UX 磨き | FE デザイン確定 / UX 検証 (WCAG、impl 後) | 実装済 UI を磨き WCAG 実比検証 (L2 の右腕ペア) | WCAG 2.2 / ISO 9241-110 | placeholder `L10-ux/visual-design.md` |
| **L11** 総合レビュー+UAT | 画面 ↔ BR/画面要求 突合 / PO UAT | 画面が業務要求を満たすかの受入前確認 | ISO 29119-3 Acceptance | (未) |
| **L12** デプロイ+受入 | 画面 AC 受入チェックリスト | 全画面 AC の受入判定 | IEEE 829 / ISO 25010 | (未) |
| **L13** デプロイ後検証 | (FE 固有 doc 無し) | 画面可用性は SLO/監視に内包 | SRE SLO/SLI | N/A |
| **L14** 運用検証+改善 | 運用 UX feedback / 改善 | 実運用での UX 観測と次サイクル feedback | ISO 12207 運用 | (未) |

> **FE 設計 doc カタログ = 全層 slot 登録済 (定義 → slot 完了、2026-06-25 PLAN-L4-14 §4)**:
> 段階順 `定義 → slot → 起票 → 作成 → 実装` のうち **定義 + slot を完了**した。各 slot は schema 正本
> (`VALID_SUB_DOCS`) + 要件 §G.1 + 本 §1c の 3 点同期済で、`sub-doc-catalog-drift` gate が drift を fail-close。
>
> | 層 | slug | 区分 | slot | body (起票→作成) |
> |---|---|---|---|---|
> | L3 | `screen-functional` | ② プロダクト選択 (UI 有時) | ✓ `VALID_SUB_DOCS[L3]` | ✓ `docs/design/harness/L3-functional/screen-functional.md` |
> | L4 | `ui-standard` | ② プロダクト選択 (UI 有時) | ✓ `VALID_SUB_DOCS[L4]` | ✓ `ui-standard.md` (confirmed) |
> | L5 | `ui-detail` | ② プロダクト選択 (UI 有時) | ✓ `VALID_SUB_DOCS[L5]` | ✓ `docs/design/harness/L5-detailed-design/ui-detail.md` |
> | L6 | `screen-spec` | ② プロダクト選択 (UI 有時) | ✓ `VALID_SUB_DOCS[L6]` | ✓ `docs/design/harness/L6-function-design/screen-spec.md` |
>
> **2026-06-30 update (PLAN-L3-06 / PLAN-L5-09 / PLAN-L6-36)**: harness central UI の L3/L5/L6 FE bodies は現時点で存在する。`frontend-design-coverage` は body present 6 / pending 0 を報告し、上記の実 file path を検査する。
>
> **残り = body 起票→作成 (作成段階)**: L3 `screen-functional` / L5 `ui-detail` / L6 `screen-spec` の本文は
> per-layer design PLAN (`kind=design`) で起票し、起票時に各型の必須 § 構造を定義する (`report`/`batch` を
> vocabulary 先行登録した PLAN-L7-97 §4 と同方針 — speculative な § 定義を先にしない)。draft body を frozen
> 層 dir に置くと層完了ゲートが落ちるため、body は owning PLAN を confirmed にして起票する (L4 `ui-standard`
> が踏んだ手順)。L8/L9 の FE 観点充足は右腕 test-design 側。
>
> ⚠ **slot 登録は body 完成を意味しない (coverage ≠ substance)**。slug が `VALID_SUB_DOCS` にある = 起票に
> 使用可、という意味のみ。FE 設計の substance は body 起票時に確定する。本 §1c の左腕カバレッジは
> `frontend-design-coverage` gate (doctor) が schema↔§1c↔実ファイルの整合を fail-close で機械検証する。

> **descent 鎖 (FE、PLAN-L4-14 §3.3 と整合)**:
> `L1 画面要求 → L2 画面設計(G2) → L3 画面機能要件 → L4 UI 設計標準/部品カタログ → L5 FE 内部設計 →
> L6 per-screen 機能設計 → L7 src/web 実装 → L10 UX 磨き(impl後)`。各段を飛ばさない (L7-102 table-dumper
> 失敗 = L4 設計標準を飛ばした逆行の再発防止、[[feedback_central_ui_kouteihyou_mission_not_coverage]])。

## §2 国際標準クロスマップ (要点)

| UT-TDD 成果物 | 標準ドキュメント種別 | 主要§ |
|---|---|---|
| L1 業務要求 | ISO 29148 StRS | 利害関係者ニーズ / 運用概念 / 制約 |
| L3 機能要件 + AC | ISO 29148 SyRS + BDD Feature | FR + Given-When-Then + trace matrix |
| L4 方式設計/ADR | arc42 §4 Solution Strategy / §5 Building Block (L1) / §9 ADR / ISO 42010 | Viewpoint / View / Design Decision |
| L4 データ設計 | DDD (Evans) | 集約境界 / 値オブジェクト / 不変条件 |
| L5 詳細設計 | IEEE 1016 SDD / UML | Execution Architecture / クラス・シーケンス図 |
| L6 機能設計 | IEEE 1016 §5.7 | Design Entity + Pseudocode |
| 各テスト設計 | ISO 29119-3 TDS / IEEE 829 | テスト観点 / 条件 / カバレッジ基準 / 技法 (29119-4) |
| NFR | ISO 25010 SQuaRE × IPA NFR グレード | 8 品質特性 二軸タグ (concept §3.1.2.1 済) |
| 双方向 trace | NASA SE Handbook / DO-178C | traceability matrix (UT-TDD 6 方向 trace と同型) |

## §3 配線図 = Design by Contract (Bertrand Meyer)

コンポーネント間の「配線 (接続/契約)」は **Meyer の Design by Contract** で記述する。三要素と UT-TDD 成果物の対応:

| DbC 要素 | 定義 | 記述成果物 | UT-TDD 層 |
|---|---|---|---|
| **Precondition** (事前条件) | 呼出側 (client) が保証する入力条件 | API 入力仕様 / バリデーション規則 | L5 D-API 入力節 / L6 関数 signature |
| **Postcondition** (事後条件) | 呼出され側 (supplier) が保証する出力/状態 | API レスポンス / 副作用 / エラー応答規約 | L5 D-API 出力節 / L6 関数 signature |
| **Invariant** (不変条件) | 常に保持すべき状態条件 | ドメイン制約 / 集約整合性 / DB 整合性制約 | L4 データ設計 (不変条件) / L5 D-DB |

| UT-TDD 概念 | DbC 対応 |
|---|---|
| `D-CONTRACT` (コンポーネント契約書) | Precondition + Postcondition + Invariant の三点セット (L5) |
| `D-API` | Precondition (入力) + Postcondition (出力・エラー) 中心 (L5) |
| `D-DB` | Invariant (DB 整合性制約) (L5) |
| `contract_registry` | DbC 契約の機械検証可能な一覧 (L5→L6→L7 段階確定) |
| 配線 (signal→mode routing / drive×layer 注入、concept §2.6) | DbC の **Invariant / orchestration 契約**層 (「この layer で誰が何を保証するか」) |
| **G5 API/Schema Freeze** | Precondition/Postcondition の freeze = 変更禁止宣言 (DbC 的に最重要 freeze 点) |
| テスト設計ペア (③) の 1:1 対応義務 | DbC 契約から test oracle を導出 (L6 ↔ 単体テスト設計) |

> 出典: Meyer "Applying Design by Contract" (IEEE Computer, 1992)。

## §4 フロー改善 (ズレ/空白 Z1-Z6 + 追加推奨)

業界標準と現行 UT-TDD doc 体系の差分。**適用区分**: 🟢 本 doc で確定 / 🔵 L4 着手時に適用 (backlog 登録) / ⚪ 後続 carry。

| # | 改善 | 区分 | backlog |
|---|---|---|---|
| **Z1** | L4 を「方式設計 (arch/ADR、arc42 §4/§9)」と「外部設計 (外部 IF)」の sub-doc に明示分離 | 🔵 L4 | IMP-017 |
| **Z2** | L4 外部 IF (what/形状) ↔ L5 D-API (how/contract 詳細) の粒度境界を明確化、二重定義回避 | 🔵 L4/L5 | IMP-018 |
| **Z3** | L6 機能設計に **IEEE 1016 §5.7 (Pseudocode)** を grounding として §11 追記 | 🔵 L6 | IMP-019 |
| **Z4** | L10 UX 磨きに **WCAG 2.2 / ISO 9241-110** を受入基準 reference 追記 | ⚪ | IMP-020 |
| **Z5** | L13 デプロイ後検証を **ISO 29119-2 Test Evaluation** に接続 (SLO/SLI を test result 扱い) | ⚪ | IMP-021 |
| **Z6** | L3 AC を **BDD/Gherkin (Given-When-Then)** 記述形式候補として §11 追記、L12 受入と機械連携 | 🔵 L3/L12 | IMP-022 |
| **E1** | **ADR テンプレート (arc42 §9)** を L4 方式設計 sub-doc の必須 artifact 化 | 🔵 L4 | IMP-023 |
| **E2** | テスト設計観点一覧 (**ISO 29119-4** 技法: 境界値/同値/デシジョンテーブル) を各テスト設計に明記 | ⚪ | IMP-024 |
| **E3** | arc42 §5 (Building Block L1/L2) → L4/L5 sub-doc のビューマッピング表を追加 | 🔵 L4 | IMP-025 |

> 🟢 本 doc で確定済: §0 (基本設計=外部設計)、§1 (L0-L14 標準マップ)、§3 (配線図=DbC)。これらは concept §3 / §11 の grounding 正本となる。

## §5 参照標準

- IPA 共通フレーム 2013 (SLCP-JCF): https://www.ipa.go.jp/publish/secbooks20130304.html
- ISO/IEC/IEEE 29148:2018 (要件、StRS/SyRS): https://ieeexplore.ieee.org/document/8559686
- ISO/IEC/IEEE 42010:2022 (アーキ記述) ← arc42: https://quality.arc42.org/standards/iso-42010
- arc42 テンプレート (12 節) / C4 model 補完: https://faq.arc42.org/questions/B-17/
- IEEE 1016-2009 (SDD): https://standards.ieee.org/ieee/1016/4502/
- ISO/IEC/IEEE 29119-3:2021 (テスト設計): https://www.iso.org/standard/79429.html
- BDD / Gherkin (Given-When-Then): Cucumber 公式
- Bertrand Meyer「Design by Contract の適用」(1992): https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf
- ISO/IEC 25010:2011 SQuaRE (品質特性): concept §3.1.2.1 で IPA × ISO 25010 二軸タグ済
- NASA SW Engineering Handbook / DO-178C (V&V trace): 双方向 trace の概念根拠
