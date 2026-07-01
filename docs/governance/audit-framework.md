# UT-TDD GitHub / GHA audit framework（PO 宣言）

> **status**: PO declared 2026-05-28。L1 業務要求の入力として `../plans/PLAN-L1-01-business-requirements.md §3.7` で扱う。下流で BR-13〜19 + NFR-11 等として L1 正本に分解する。
> **役割**: PR/merge 時点の CI 検問 (7-Gate pipeline) の運用要件。V-model のフェーズ進捗ゲート (G0.5〜G14) とは別軸 (PR ごとに発火) で、両者は補完関係。
> **正本性**: 本 doc は PO 提示の operational vision の faithful record。「legacy source」naming は本 framework 内の方法論名として保持する (vendor `vendor/legacy-source-source/` 由来素材とは別概念)。
> **既知の整合課題 (L1 確定前に PO 確認)**:
> - 既存 `docs/` 構造 (governance/design/test-design/plans/adr/migration) vs framework の `docs/` (product.md/requirements.md/architecture.md/coding-rules.md/risk-policy.yaml/features/) — migration timing
> - feature ID `F-NNN` と既存 BR-NN の関係
> - `.ut-tdd/audit/reports/` (framework report) vs `.ut-tdd/` runtime state のパス名前空間
> - 「legacy source」naming を UT-TDD context に normalize するか

---

## 1. 基本思想

legacy sourceは、AI時代の開発を安全に進めるための開発統治フレームワークである。

基本構造は以下とする。

```txt
全体方針：ドキュメント駆動
ドキュメント監査：ドメイン駆動
実装：テスト駆動
コード品質：コーディングルール駆動
マージ判断：GitHub Actionsによる検問
```

legacy sourceでは、AIにコードを書かせること自体を目的にしない。

目的は、以下を統制することである。

* 何を作るか
* なぜ作るか
* どの機能に属するか
* 業務概念として正しいか
* テストで保証されているか
* コーディングルールに従っているか
* mainに入れてよい変更か

## 2. 全体構造

legacy sourceの開発・監査・マージ判断は、以下の流れで行う。

```txt
要求
↓
Document Gate
↓
Domain Gate
↓
Test Gate
↓
Implementation Gate
↓
Coding Rule Gate
↓
PR Gate
↓
Merge Gate
```

各Gateの役割は以下。

| Gate                | 役割                                      |
| ------------------- | --------------------------------------- |
| Document Gate       | 必要なドキュメントが揃っているか確認する                    |
| Domain Gate         | 業務概念・責務・用語・境界が正しいか監査する                  |
| Test Gate           | 仕様に対応するテストが存在するか確認する                    |
| Implementation Gate | 実装がテストと仕様を満たしているか確認する                   |
| Coding Rule Gate    | コードがプロジェクトの規約に従っているか確認する                |
| PR Gate             | docs / code / tests の三点一致を確認する          |
| Merge Gate          | safe / caution / danger / unknown を判定する |

## 3. ドキュメント駆動

legacy sourceでは、開発対象をドキュメントで定義する。

Issueは補助的に使うが、開発の正本はドキュメントとする。

基本ドキュメント構成は以下。

```txt
docs/
├─ product.md
├─ requirements.md
├─ architecture.md
├─ coding-rules.md
├─ risk-policy.yaml
└─ features/
   ├─ F-001-auth.md
   ├─ F-002-applicants.md
   └─ F-003-csv-export.md
```

各機能は `docs/features/` 配下に1機能1ファイルで管理する。

機能ドキュメントは、frontmatterと本文で構成する。

```md
---
feature_id: F-003
name: 応募者CSV出力
version: 1.2.0
status: active
risk: caution
auto_merge: false

layers:
  frontend:
    risk: safe
    related_paths:
      - app/applicants/**
      - src/features/applicants/components/**

  service:
    risk: caution
    related_paths:
      - src/features/applicants/export/**
      - app/api/applicants/export/**

  database:
    risk: danger
    related_paths:
      - prisma/schema.prisma
      - migrations/**
    related_tables:
      - applicants
      - applications
      - export_logs

required_tests:
  frontend:
    - CSV出力ボタンが表示される
    - 出力中ローディングが表示される

  service:
    - フィルター条件通りにCSVが生成される
    - 権限がない場合は出力できない

  database:
    - export_logs に出力履歴が保存される
---

# F-003 応募者CSV出力

(本文: 概要 / 目的 / フロント仕様 / サービス仕様 / データ仕様 / 非対象 / 更新履歴)
```

## 4. Document Gate（ドキュメント gate）

Document Gateでは、必要なドキュメントが存在するかを確認する。

主な確認項目:

* `product.md` 存在
* `requirements.md` 存在
* `architecture.md` 存在
* 該当機能の `docs/features/*.md` 存在
* 機能ID 付与
* 機能バージョン 付与
* 関連パス定義
* 必須テスト定義
* risk / auto_merge 定義

機能変更PRで該当 feature md が更新されていない場合はブロック。

```txt
機能変更あり → 該当feature md更新なし → PRブロック
```

## 5. ドメイン駆動監査

Domain Gateでは、ドキュメントの中身を業務概念・責務・境界の観点から監査する (存在チェックだけでは通さない)。

### 5.1 用語監査

* 同じ概念に複数の名前を使っていないか
* 別概念を同じ名前で扱っていないか
* 業務上の呼称とシステム上の名称がズレていないか
* 機能名が曖昧すぎないか

例: 「応募者 / 求職者 / 候補者 / ユーザー」が同じか別意味かを定義する。

### 5.2 責務監査

* 1 機能に複数責務が混ざっていないか
* UI都合で業務責務を歪めていないか
* サービス層に置くべき処理がフロントに漏れていないか
* DB都合で業務概念を壊していないか

### 5.3 境界監査

* 機能の境界が明確か
* 他機能との依存関係が定義されているか
* 外部連携との境界が明確か
* 認証・権限との境界が明確か

### 5.4 データ監査

* エンティティが業務実態に合っているか
* テーブルと機能の関係が明確か
* 保存すべき状態と表示だけの状態が混ざっていないか
* 履歴・ログ・現在値の扱いが明確か

### 5.5 出力

`.ut-tdd/audit/reports/domain-audit.md` を出力。例:

```md
# Domain Audit Report
## Result: caution
## Matched Features: F-003 応募者CSV出力
## Findings
### 用語: 「応募者」と「候補者」が混在
### 責務: CSV整形処理がフロントに漏れている可能性
### 境界: 権限管理機能 F-005 への依存を明記する必要あり
## 決定: TLレビュー必須
```

## 6. テスト駆動実装

機能ドキュメントの `required_tests` に基づいてテスト観点を定義してから実装する (テストファースト)。

```txt
機能仕様確認 → required_tests確認 → テスト作成 → 失敗確認 → 実装 → テスト通過 → リファクタ
```

テストは機能IDに紐づける:

```txt
tests/
└─ features/
   └─ F-003-csv-export/
      ├─ frontend.test.ts
      ├─ service.test.ts
      └─ database.test.ts
```

テストファイルに `feature_id` / `target` を明記:

```ts
/**
 * feature_id: F-003
 * target: service
 */
```

Test Gate 確認項目:
* 該当機能の必須テストが存在
* テストが feature_id に紐づく
* required_tests とテスト内容が対応
* テスト pass
* 失敗テスト無視なし

## 7. Implementation Gate（実装 gate）

実装が仕様とテストを満たしているかを確認。

* 実装ファイルが該当機能の `related_paths` 内に収まっているか
* 想定外のファイルを変更していないか
* 実装がテストを満たしているか
* 仕様外の挙動を追加していないか
* フロント / サービス / DB の責務分離
* 一時的な実装・仮実装の残存なし
* TODO/FIXME に理由明記

出力: `.ut-tdd/audit/reports/implementation-audit.md`

## 8. コーディングルール駆動

`docs/coding-rules.md` で以下を定義:

* ディレクトリ構成
* 命名規則
* importルール
* 関数分割ルール
* エラーハンドリング
* ログ出力
* 型定義
* UIコンポーネント分割
* API設計
* DBアクセス方針
* テスト配置
* 禁止事項

## 9. coding-rules.md (例)

```md
# Coding Rules

## 1. 基本方針
- 読みやすさ優先 / 暗黙知非依存 / 責務分離 / 仕様外実装禁止 / 一時対応は理由をコメント

## 2. ディレクトリ構成
src/{features, components, services, lib, types, utils}/

## 3. 命名規則
- 関数名は動詞から / boolean は is/has/can/should / DB由来型とUI表示型を混ぜない / 汎用すぎる名前 (data/item/value/handle/process/manager) を避ける

## 4. importルール
- 深すぎる相対パス避ける / feature間直接依存禁止 / shared層への依存OK / circular dependency禁止

## 5. フロントルール
- UI に業務ロジック置かない / API は専用 hook/service 経由 / 表示状態と保存状態を混ぜない / エラー表示省略禁止

## 6. サービスルール
- 業務ロジックは service 層 / 権限チェック省略禁止 / 外部 API は adapter 経由 / 例外を握りつぶさない

## 7. データベースルール
- schema 変更は docs 更新を伴う / migration 自動マージ不可 / 削除系は人間レビュー必須 / 履歴必要データはログ設計明記

## 8. テストルール
- 機能変更にテスト追加 / feature_id に紐づける / 重要機能は正常系異常系両方 / テストを通すためだけの実装禁止

## 9. 禁止事項
- main直接push / 仕様外のついで修正 / .env コミット / secrets/credentials 変更 / 認証・権限の無断変更 / DB migration の自動マージ / GHA 設定の無断変更
```

## 10. Coding Rule Gate（コーディングルール gate）

Coding Rule Gate で `docs/coding-rules.md` 遵守を確認:
- 命名規則 / レイヤー責務 / import / エラーハンドリング / 型定義 / テスト配置 / 禁止事項

機械的検査は Lint/Typecheck/静的解析、AI 判断は legacy source 監査レポートで。

出力: `.ut-tdd/audit/reports/coding-rule-audit.md`

## 11. docs / code / tests 三点一致

| 状態                  | 判定              |
| ------------------- | --------------- |
| codeだけ変更            | ブロック            |
| code + tests        | docs不足でブロック     |
| code + docs         | tests不足でブロック    |
| docs + tests        | 実装不足として確認       |
| docs + code + tests | 通過候補            |
| docsのみ              | ドキュメント更新として通過候補 |
| testsのみ             | テスト追加として通過候補    |

機能変更PRは原則三点セット必須。

## 12. PR Gate

PRに以下のレポートを含める:

```txt
.ut-tdd/audit/reports/
├─ document-audit.md
├─ domain-audit.md
├─ test-result.json
├─ implementation-audit.md
├─ coding-rule-audit.md
├─ changed-files.json
├─ feature-risk.json
├─ review-summary.md
├─ execution-log.md
└─ rollback-plan.md
```

PR Gate 確認:
- 各 Gate が pass (Domain は許容範囲含む)
- docs / code / tests が揃う
- rollback-plan 存在
- 未解決リスクなし

## 13. Merge Gate（マージ gate）

| 判定      | 処理           |
| ------- | ------------ |
| safe    | Auto-merge候補 |
| caution | TLレビュー       |
| danger  | 人間レビュー       |
| unknown | 自動マージ禁止      |

### safe 条件
- Document/Domain/Test/Implementation/Coding-Rule Gate 全 pass
- docs/code/tests の必要条件
- 該当機能 safe
- database 変更なし
- auth/permissions 変更なし
- deploy 設定変更なし
- unknown ファイルなし
- rollback-plan 存在
- PR サイズ基準内

### ブロック条件
- 上記 Gate のいずれか fail
- Domain Gate danger
- 機能変更なのに docs / tests 更新なし
- database / auth / permissions / deploy / GHA / secrets 変更あり
- unknown ファイルあり
- rollback-plan なし

## 14. GitHub Actions の役割

GHA は legacy source の監査結果を読み、マージ可否を判定する**検問装置**。

GHA が行うこと:
- PR の変更ファイル取得
- `docs/features/*.md` の frontmatter 読み込み
- `related_paths` と変更ファイルの照合
- `risk` / `auto_merge` 取得
- `.ut-tdd/audit/reports/` の監査結果確認
- safe/caution/danger/unknown 判定
- safe のみ Auto-merge 候補

役割分離: **legacy source = 開発・監査 / GitHub Actions = 検問・執行**

### 14.1 発火単位 = feature & 3 点漏れ巻取り (PO declared 2026-05-28)

GHA の発火単位は **機能 (feature)**。PR ごとに以下のフローで発火する:

1. PR の変更ファイル一覧を取得
2. `docs/features/*.md` 全件の frontmatter `layers.*.related_paths` と changed-files を照合
3. **match した feature 一覧 = 当該 PR の affected features**
4. 各 affected feature について 3 点 (doc / code / tests) の変更有無を集計
5. **3 点漏れ (= 機能変更だが doc / test / code のいずれかが未更新)** を検知して PR Gate でブロック (§11 状態判定に従う)
6. 全 affected feature が全 Gate pass なら Merge Gate へ → 4-tier 判定 → safe なら auto-merge

```
PR 変更ファイル
   ↓
related_paths 照合 → affected features を特定
   ↓
各 feature の 3 点 (doc / code / tests) 変更を集計
   ↓
漏れ検知 (機能変更だが 3 点のいずれか不足) → block + report
   ↓
全 feature pass → Merge Gate → 4-tier 判定 → safe なら auto-merge
```

- **多 feature affect** (1 PR ↔ N features) は許容するが、各 feature について個別に 3 点一致を検証する
- **機能一覧 (feature inventory) の存在が GHA 発火の前提**: `docs/features/` が空 = GHA 発火対象なし = どんな PR も unknown 扱いで block
- **unknown ファイル** (どの feature の related_paths にも match しない変更) は §13 ブロック条件「unknown ファイルあり」で block (= 機能未登録の変更を許さない)

## 15. Revert方針

基本: revert ではなく **PR ブロックを優先**。

```txt
PR段階の不一致 → ブロックして修正
main混入後の不一致 → revert候補
```

revert 検討条件 (main 混入後):
- docs と実装が矛盾
- tests 不足
- danger 変更が自動マージされていた
- unknown 変更が main 混入
- 権限・認証・DB に想定外変更
- コーディングルール違反が重大

## 16. 最終定義

```txt
ドキュメント駆動 → ドメイン駆動監査 → テスト駆動実装 → コーディングルール監査 → GitHub Actions検問
```

思想:
- 何を作るかは**ドキュメント**で決める
- ドキュメントの正しさは**ドメイン**で監査する
- 実装の正しさは**テスト**で保証する
- コード品質は**ルール**で監査する
- main 投入は **GitHub Actions** で検問する

これにより AI 開発でも以下を実現:
- 仕様にない実装を防ぐ
- 業務概念のズレを防ぐ
- 責務の混在を防ぐ
- テストされていない実装を防ぐ
- コーディングルール違反を防ぐ
- 危険変更の自動マージを防ぐ
- 人間が見るべき PR だけを人間に回す
- safe な PR だけを自動で流す

## 17. 自動化 + AI レビュー の補完機構 (PO declared 2026-05-28)

各 Gate は **自動化 (機械処理)** と **AI レビュー (文脈判断)** の 2 層で実装する。両者は補完関係: 機械可能なものは自動化に倒し、文脈判断が必須なものは AI review に振り分ける。

### 17.1 Gate 別 machine / AI 分解

| Gate | 機械処理 (automation) | AI レビュー (文脈判断) |
| --- | --- | --- |
| **Document** | frontmatter 必須項目存在 (feature_id / version / risk / auto_merge / layers / related_paths / required_tests) / product.md・requirements.md・architecture.md 存在 / 機能変更 PR で該当 feature md 更新存在 | (基本不要、機械で十分) |
| **Domain** | 用語登録 (glossary) との一致 / feature 間依存宣言の整合 | 用語 / 責務 / 境界 / データの業務概念整合 (§5.1-5.4 すべて AI 主) |
| **Test** | feature_id 紐づけ / required_tests とテスト名対応 / pass-fail / skipped 検出 | テストカバレッジの適切性 / 重要パス網羅判断 |
| **Implementation** | related_paths 内収束 / TODO/FIXME に理由コメント (正規表現) / 想定外ファイル変更 (paths diff) | 仕様外挙動 / 責務分離の質的判断 / 一時実装の検出 |
| **Coding Rule** | Lint / Typecheck / 静的解析 / 命名パターン / import 構造 / 禁止パターン (secrets / .env / GHA 設定 等) | レイヤー責務の質的判断 / エラーハンドリング適切性 / 型設計の妥当性 |
| **PR** | 必須レポート存在 / 3 点セット集合判定 (changed-files scope) / rollback-plan 存在 | レポート内容の妥当性総合判断 |
| **Merge** | risk + change scope + gate 結果のロジックで safe / caution / danger / unknown 機械分類 | caution / danger ケースの review 判断 (TL / 人間) |

### 17.2 運用原則

- **機械処理は fail-close** で出力 (exit code + structured report)
- **AI レビューは structured report** に「判定 + 根拠 + 推奨アクション」を残す
- **GHA は両方を読み**、最終 merge 判定を行う
- **AI が判定不能 (= unknown) なら fail-close** (人間レビューへ降ろす)
- **machine だけで safe 判定できる PR は AI レビューをスキップ可能** (cost 最適化、cache 利用)
- machine / AI の分担は Gate 設計時に確定し、`docs/coding-rules.md` や `risk-policy.yaml` で外部化する (調整可能)

### 17.3 dev-local + CI 二重実行 (editor return loop)

同じ check 論理を 2 箇所で実行する (single source of truth、dev/CI 同一バイナリ)。

| 実行場所 | 役割 | trigger |
| --- | --- | --- |
| **dev-local** (editor / CLI) | advisory + 早期検出 | エディタ内 hook (PostToolUse on Edit/Write/MultiEdit) / `git pre-commit` / `git pre-push` / `ut-tdd audit` 明示呼び出し |
| **CI (GHA)** | guardrail (executory) | PR open / sync / required status checks → safe なら GitHub native auto-merge |

運用原則:
- **single source of truth**: check 論理は `src/` (TypeScript core) に 1 本実装、CLI (`ut-tdd audit`) で呼び出す。dev-local も CI も同じバイナリ/モジュールを実行 (= NFR-09 rule parity の本体)。
- **dev-local = advisory**: 警告は出すが基本ブロックしない (commit-msg 等の例外を除く)。executory は CI 側で。
- **fail-fast loop**: CI で fail なら GHA は PR を blocked にし、**同一 report** (artifact + PR comment) を提示 → エディタ (Claude Code / 開発者) が同じ report を読んで修正 → 再 push の高速ループ。
- **同一 report 形式**: dev-local 出力と CI artifact が 1:1 (フィールド名 / status / severity)。エディタ AI agent は report を構造化解釈して self-修正できる。
- **scope-aware**: dev-local は速度優先で changed-files の影響 feature だけ check 可能、CI は全量。
- AI レビュー層 (§17.1) も二重実行する: dev-local は subagent (pmo-sonnet / code-reviewer 等) を `Agent` tool で呼び、CI は同じ判定ロジックを GHA 上で実行 (将来は workflow から Anthropic API 直叩き等)。AI 出力も report 統一。

### 17.4 human-as-residue (人間判断負荷の最小化、PO declared 2026-05-28)

Gate / 判定 / incident 分類はすべて **machine → AI → human の優先順位**で escalate。各層で closed なら次層を呼ばない。**人間に届くのは前 2 層で判定不能な residue のみ**。

| 層 | 役割 | 次層へ escalate する条件 |
| --- | --- | --- |
| **machine** | deterministic 判定 | unknown (規則で判定不能) / AI レビュー必須と分類 |
| **AI review** | contextual 判定 | unknown (文脈で判定不能) / danger tier (人間必須) |
| **human** | residue 処理 | machine + AI で判定できなかったもの + 4-tier の danger |

運用原則:
- **default は machine + AI で closed**。人間に届くのは judgment residue のみ。
- 4-tier 分類で **safe → auto-merge** (人間負荷ゼロ) / **caution → TL/AI review** (1 layer) / **danger → human** (residue) / **unknown → fail-close** (machine 拒否、原因調査は人間)。
- **incident severity 自動分類** (rule-based) を組み込み、severity 判定を machine 一次処理 → ambiguous のみ human escalate。
- **danger 判定の機械厳密化** (false positive 抑制) で不要な人間負荷を防ぐ (誤って danger 化された PR が人間に流れない)。
- **escalate 量を計測** し、過度な escalate が出る Gate は machine / AI 側を強化する feedback loop を回す (cost-of-human-review メトリクス)。
- 人間 escalate が必要な場合も、**「何を判断してほしいか / 根拠 / 推奨アクション」を structured report で提示** し、判断時間を最小化する。
