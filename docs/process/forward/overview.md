> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Forward ワークフロー概要 (V-model L0-L14)

出典: concept v3.1 §2.3 / §3.1 / requirements v1.2 §1.4

---

## 1. Forward とは

Forward は「要件・設計・契約が確定した状態」から **L0 企画 → L14 運用検証** を V 字で進む、UT-TDD の中核経路。
他のすべての mode (Scrum / Reverse / Discovery / Recovery / Refactor / Retrofit / Add-feature) は最終的に Forward に合流する。

---

## 2. V 字構造の 3 区画

```
左腕 (設計降下)        谷         右腕 (検証上昇)
L0 企画
L1 要求定義                        L14 運用検証
L2 画面設計                        L10 UX 磨き
L3 要件定義                        L12 デプロイ+受入
L4 基本設計                        L9 総合テスト
L5 詳細設計                        L8 結合テスト
L6 機能設計
                    L7 実装
```

| 区画 | レイヤー | 役割 |
|------|---------|------|
| 左腕 | L0-L6 | ① 設計 + ③ テスト設計 を同層でペア凍結 |
| 谷 | L7 | ② 実装コード + ④ テストコード (TDD Red 先行) |
| 右腕 | L8-L14 | 左腕ペアの ③ テスト設計を ④ テストコードとして実施 |

---

## 3. TDD-first 原則

- 左腕の各層で **① 設計 ⇔ ③ テスト設計** を同時に起票・凍結する (Pair freeze、G1-G6)。
- 谷 L7 に入る前に L6 単体テスト設計に対応する **④ テストコードを先行作成 (TDD Red)** し、その状態で実装を開始する。
- テスト設計 doc なしの「テストも書いた」は **逆ピラミッド**として G6/G7 で fail-close する (AP-8)。

---

## 4. V-pair ペア表 (左腕 ⇔ 右腕、正規式モデル PLAN-RECOVERY-02)

各 V-pair は対応する **検証本質** (環境・データ実在性) を持つ。番号・既存ペアは据え置き (非破壊の追加・明確化)。

| 左腕 (設計層) | ③ テスト設計 (左で作成・凍結) | V-pair (右腕・実施工程) | 検証本質 (データ実在性) |
|--------------|------------------------------|-------------------------|-------------------------|
| **L0 企画** | (価値検証 = L14→L0 feedback) | (L14 内で実現を検証) | **価値**: 事業目的・価値の実現 (実成果) |
| L1 要求定義 | 運用テスト設計 | L14 運用検証 | **運用**: 実データ × 時間 |
| L2 画面設計 | ワイヤーモック自体がペア | L10 UX 磨き | **実データ検証**: 本番実データで画面が成立 |
| L3 要件定義 | 受入テスト設計 | L12 デプロイ+受入 | **本番受入**: 本番で要件が満たせるか |
| L4 基本設計 | 総合テスト設計 | L9 総合テスト | **総合**: テスト環境・全体 |
| L5 詳細設計 | 結合テスト設計 | L8 結合テスト | **結合**: テスト環境・モジュール |
| L6 機能設計 | 単体テスト設計 | L7 谷 (3 点合算) | **単体**: テスト環境・関数 |

出典: concept v3.1 §2.3 V-model 表 (正規式) / requirements v1.2 §1.4 VALID_LAYERS / gate-design G0.5

> **正規式モデルの要点 (PLAN-RECOVERY-02、2026-06-04 PO 確定)**:
> - **L0 企画 ⇔ 価値検証**: 従来ペア無しだった穴を埋める。G0.5 + L14→L0 feedback で企画目的の価値実現を検証。
> - **谷 = 3 点合算 (L6→単体テスト→L7、最小単位)**: L7 実装は L6 設計 ① + 単体テスト設計 ③ を見て、単体テストを先に具体化 (TDD red) → コード ② を実装。単体テストの居場所は谷 (L6⇔L7、表記 `layer:L6/executed_at:L7`)。
> - **右腕 = データ実在性エスカレーション** (右腕工程順 L8→L14): 合成/テストデータ (単体→結合 L8→総合 L9) → 本番実データ (**実データ検証=画面 L10** が先 → **本番受入=要件 L12** が後) → 運用 L14 (実データ×時間) → 価値 (実成果)。
> - **L2 = L1 のフェーズ分離**: 画面要求→要求/要件 (L1→L3)、画面詳細→L5。L2⇔L10 の右腕は「ワイヤーモック自体」で独立 test-design doc は作らない (mock が ③ を兼ねる、欠落でなく設計意図)。
> - **L7 (谷) / L13 デプロイ後検証**: L7 は谷 (①③ を受け 3 点合算で ②④ を作る)、L13 は L12 の続き (実環境 smoke、直接の左腕ペアなし)。

---

## 5. 4 artifact と別置き原則

| Artifact | 種別 | 配置 |
|----------|------|------|
| ① 設計 | 文書 | `docs/design/` |
| ② 実装コード | コード | `src/` |
| ③ テスト設計 | 文書 | `docs/test-design/` |
| ④ テストコード | コード | `tests/` |

① と ③ を同一文書に混在させない (AP-1/AP-2)。
③ と ④ も同一ファイルに混在させない (AP-3)。

出典: concept v3.1 §2.3 4 artifact / requirements v1.2 §2.1

---

## 6. 3 段階 freeze

| Freeze 段階 | タイミング | 凍結対象 | ゲート |
|------------|-----------|----------|--------|
| **A: Pair freeze** | L7 着手前 (各設計層) | ① + ③ ペア | G1-G6 |
| **A2: TDD Red freeze** | L7 最初のステップ | ③ + ④ 単体テスト先行 | L7 entry |
| **B: 4 artifact trace freeze** | L7 完了後 | ① + ② + ③ + ④ の 8 directed edge | G7 |

出典: concept v3.1 §2.3 3 段階 freeze

---

## 7. gate 体系 (概念)

| gate | タイミング | 確認対象 (概念) |
|------|-----------|----------------|
| G0.5 | L0 → L1 | 企画書が L1 業務要求へ trace できるか |
| G1 | L1 完了 | 5 sub-doc 揃い + L1↔L14 OT ペア + 業務⇔画面⇔機能 trace |
| G2 | L2 完了 | ワイヤーモック (or 画面要求) 凍結 |
| G3 | L3 完了 | FR+AC ⇔ 受入テスト設計 ペア凍結 |
| G4 | L4 完了 | アーキ/ADR ⇔ 総合テスト設計 ペア凍結 |
| G5 | L5 完了 | D-API/D-DB/D-CONTRACT ⇔ 結合テスト設計 凍結 (API/Schema Freeze) |
| G6 | L6 完了 | 関数 signature + WBS ⇔ 単体テスト設計 凍結 |
| G7 | L7 完了 | 4 artifact trace (必須 8 directed edge + coverage ≥ 80%) |
| G8-G9 | L8/L9 完了 | 結合・総合テスト品質 |
| G10-G14 | L10-L14 完了 | UX / UAT / デプロイ / 運用品質 |

詳細な fail-close 条件は requirements v1.2 §2.2。

---

## 7.1 工程表 (roadmap) と PLAN の二層 (human/AI plane)

Forward 降下は **二層**で回す (定義正本 = concept §10.2、PLAN-RECOVERY-04)。

- **工程表 (roadmap) = 人間向け全プログラム進行台帳**: 機能群 (feature-group) を**結合テスト粒度**で並べた進行順序。**全プログラム (forward 全バンド L0-L3 / L4-L6 / L7 / L8-L14 + cutover) を被覆**し、**人間が見て「ここ担当する」と自己割当**する。中央 UI (フロント) へ harness.db projection 経由で返す。master-hub PLAN の `roadmap:` block (gate+span) として機械登録し、`ut-tdd doctor` の `program-coverage` が未登録バンド = 残り frontier を surface する。
- **PLAN (区間 / span) = AI 開発のオーケストレーション**: 工程表の 1 区間 = 1 機能群のスプリント。依存洗い出し → 難易度分類 → agent 割当 → 並列/直列 (§工程表 Step の `[並列]/[直列]` + 直列化3条件)。leaf = 機能設計 ⇔ 単体テスト仕様書 (単体 V-pair) → 実装 + テストコード。

> 人間が「何を・誰が」(工程表)、AI が「どう作るか」(PLAN) を担う。「実装どこまで?」は工程表 (doctor program-coverage) から機械的に answer する。

---

## 8. このドキュメントの位置付けと残作業

この forward 定義は **正本化済** (PLAN-REVERSE-01、2026-06-04)。以下は carry として今後の PLAN で扱う。

- 各 mode (Scrum / Reverse / Discovery / Recovery / Add-feature) の詳細 → `docs/process/modes/`
- gate の機械検証条件 → `docs/process/gates.md`
- drive 別 (be/fe/db/fullstack/agent) の挙動差異 → concept v3.1 §3.7 を参照

詳細メカニクスは carry として残す (内容は消さない)。

## MCP-VERIFICATION-PROFILE-WORKFLOW

Forward work can recommend external MCP servers, plugins, and test foundations only through profile rules. They are verification aids, not authoring sources.

- Relation graph impact expansion runs first and identifies impacted artifacts, tests, DB projection tables, and diagrams.
- `ut-tdd verify recommend --changed <path>` maps changed-file signals to verification profiles and can emit JSON or Mermaid graph evidence. Full DB-backed relation graph expansion remains later scope.
- `ut-tdd mcp profile list/probe` must be used before adding or activating an external MCP/test foundation profile. Probe checks are evidence only; they do not install packages.
- `ut-tdd mcp inspect <name> --method tools/list` is the MCP Inspector readiness gate. It refuses by default and requires explicit external allow-list before real MCP inspection.
- `ut-tdd verify run --profile <name>` runs built-in profiles by default. External profiles require explicit allow-list review (`--allow-external`) plus satisfied package/auth/Docker checks.
- `--save-evidence` stores normalized profile evidence under `.ut-tdd/evidence/verification-profiles/` so DB collector work can ingest the same shape later.
- Browser/UI signals recommend Playwright MCP for exploratory browser inspection and Vitest Browser Mode with the Playwright provider for deterministic browser tests.
- DB/service-contract signals recommend Testcontainers for Node.js when Docker is available.
- API mock gaps and flaky external API signals recommend MSW.
- GitHub issue/PR/CI/backlog signals recommend a read-only or narrow-toolset GitHub MCP profile first.
- Any MCP profile added or changed requires MCP Inspector smoke evidence before accept.
- Unavailable profiles are findings, not silent passes. G7/accept may fail-close only after the profile rule is enabled for that gate.
- Raw MCP/tool output remains evidence; gates consume normalized DB rows.

## CANONICAL-DOCUMENT-EXPORT-WORKFLOW

Forward work can convert canonical UT-TDD documents to spreadsheet / Excel / PPTX outputs only as derived artifacts. The source of truth remains the Markdown/source document and DB projection rows.

- Requirements / concept / detailed design / PLAN / ADR / test-design exports use `document_export_*` projection rows.
- Pair-freeze or gate-review milestones may recommend `doc-csv-matrix` or `doc-markdown-summary` for human review without external packages.
- XLSX and PPTX exports require renderer readiness evidence for ExcelJS / SheetJS / PptxGenJS / D2 before use.
- Export datasets must preserve source path, section ID, FR/AC/AT/PLAN/ADR IDs, status, trace, and evidence links.
- Generated spreadsheets/decks are stale when their source snapshot hash no longer matches the canonical document set.
- Human decisions made from exported files must be recorded separately as review/gate/handover evidence; editing the export file does not update canonical docs.

## TOOL-ADAPTER-WORKFLOW

Forward work can use dependency-cruiser, Knip, Madge, Graphviz, Mermaid, and D2 only as optional graph/diagram adapters.

- Core relation graph collection remains TypeScript/Bun and DB projection based.
- `catalogToolAdapters` defines adapter metadata and trigger signals.
- `probeToolAdapter` checks package/executable/config/workspace readiness without installing packages.
- Raw adapter output is bounded evidence; gates consume normalized `tool_runs`, `dependency_edges`, `diagram_artifacts`, and findings.
- Missing adapters are findings, not unrelated check failures.
- Auto-fix/delete behavior from adapters is out of scope unless a future human-approved PLAN adds rollback evidence.

## LOWER-L-REVERSE-BACKPROP

Forward の下位 L (L4-L14) で追加機能・改善起票・受入条件変更・DB projection・guardrail・workflow rule を発見した場合、局所 carry のまま完了扱いしない。全体一貫性の原則として、該当発見は requirements v1.2 §6.8.8 の `backprop_decision` に分類する。

- `local_impl_only`: 上位要求・設計・受入条件を変えない局所補正。理由を audit に残す。
- `requires_design_normalization`: L4-L6 / test-design の整合補正が必要。Reverse `normalization` / `design` で戻す。
- `requires_requirement_backprop`: FR / AC / 機能一覧 / 運用ポリシーの意味が増える。Reverse `fullback` / `design` で L1/L3 へ戻す。
- `requires_concept_policy`: 企画価値・本番影響・認証/PII/ライセンス等を変える。人間判断後に concept / requirements へ戻す。

G7 / accept 時点で `requires_*` が未処理なら、Forward は完了ではなく back-prop 未了である。先行実装を許す場合も `add-design` / `add-impl` と `reverse/*` の pairing を evidence に残す。
