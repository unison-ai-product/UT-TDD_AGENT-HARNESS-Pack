---
schema_version: skill.v1
name: vmodel-workflow
skill_type: process
applies_to:
  layers:
    - L1
    - L2
    - L3
    - L4
    - L5
    - L6
    - L7
    - L8
    - L9
  drive_models:
    - Forward
    - Add-feature
    - Reverse
triggers: "Vモデル・ドキュメントジェネレータ(vmodel-docgen)での作業手順。このリポジトリで設計書の新規作成・追記・修正、要件やテストの追加、ビルド、納品物生成を頼まれたら必ずこのスキルに従う。docs/*.yaml、build/、tools/build.py、テンプレート、トレーサビリティ、カバレッジ、工程表に言及されたときも使用する。既存コードから設計書を起こす(リバース)場合も対象。"
---

# vmodel-workflow

> 移植元: zip `.claude/skills/vmodel-workflow/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> これは移植元 `vmodel-docgen` (別ツール) 自身の作業手順であり、本ハーネスの Forward/Reverse
> workflow (`docs/plans/`、`ut-tdd plan lint`、gate G1〜G14) を置き換えるものではない。
> 同種の判断 (正本はどこか・ゲートを通す・生成物を直接編集しない) の**考え方**を読むための参照。
> 本ハーネスでの対応する手順は [[vmodel-stage-upstream]] 〜 [[vmodel-stage-integration-acceptance-ops]]
> の V-model stage skill 群、および `ut-tdd vmodel template` / `ut-tdd doctor` / `ut-tdd plan lint` である。
>
> 注記 (PLAN-L7-676 PR-T3): 本文中の `python tools/build.py ...` は移植元 `vmodel-docgen` (別ツール) のコマンドであり、`tools/*.py` 自体は本リポジトリへ同梱しない (ADR-001)。UT-TDD harness では実行対象ではなく、対応する判断は `ut-tdd vmodel template` / `vmodel lint` / gate (G1〜G14) が担う。


# Vモデル・ドキュメントジェネレータ 作業ワークフロー

## 大原則（これだけは崩さない）

1. **正本は `docs/*.yaml` のみ。** `build/` は生成物であり、直接編集しない。Excelやmdを直したくなったら、必ず対応する `docs/*.yaml` を直して再生成する。
2. **変更したら必ずゲートを通す。** 編集のたびに最低限 `python tools/build.py detect` を実行し、赤が出たら**ユーザーに報告する前に自分で修正して緑にする**。緑にできない場合のみ、検出内容と試した修正を添えて報告する。
3. **`tools/` は触らない。** エンジンの改修を明示的に依頼された場合を除き、tools/ 配下の変更は禁止。

## シナリオ別の進め方

### A. 新規プロジェクトを始める
```
python tools/build.py init "<プロジェクト名>"   # docs/ に53文書の雛形を生成
python tools/build.py profile <PoC|Standard|Enterprise>  # 規模で採用/粒度を自動セット
```
- profile の選択はユーザーに確認する。目安: 検証・小規模=PoC(13文書)、一般案件=Standard、大規模/監査あり=Enterprise。
- init 後は `docs/catalog.yaml` の status(done/todo/na)が管理台帳になる。書かない文書は削除せず `na` にする。

### B. 既存の設計内容を追記・修正する（最頻出）
1. 対象文書を特定する。番号↔内容の対応は `docs/catalog.yaml` を読む。
   文書を開いたら、まず末尾の `agent:` ブロック（defines/read_first/done_when）を確認し、read_first の文書に目を通す。
2. `docs/NN_*.yaml` を編集する。書式ルールは **vmodel-authoring スキル**に従う。
   テスト設計(06-09/28)・診断書(102/109)の中身は **vmodel-test-thinking**、画面検証(51)は **vmodel-visual-review** の思考法に従う（型を埋めるだけの記入は敵対検証の攻撃対象になる）。
3. ID（要件・画面・API・テスト等）を追加・変更した場合はトレース宣言も更新する（vmodel-authoring 参照）。
4. ゲート実行 → 緑を確認:
```
python tools/build.py detect          # スコープ内の全検出器を一括実行
python tools/spec_trace.py --strict   # トレース閉包を全種ハードゲートで確認
```
5. 生成が必要なら `python tools/build.py build`（xlsx/md）、図が変わるなら `diagrams`。

### C. 既存コードから設計書を起こす（リバース/brownfield）
1. まず A の手順で init し、profile を設定する。
2. コードベースを読み、**上流から順に**埋める: 03_要件定義書（機能を F-xxx として列挙）→ 04_基本設計（画面 SC-xxx / API-xxx / テーブル T-xxx）→ 05_詳細設計 → 06〜09 テスト設計。
3. 各IDに `spec.defines` で traces_from を宣言し、要求が不明なものは 02_要求定義書に R-xxx を補って接続する。
4. 1文書埋めるごとにゲートを回す（まとめて書いてから直すと赤の原因特定が難しくなる）。

### 変更時の見直し規約（上下・左右をどこまで辿るか）
何かを変更したら、感覚でなく `python tools/build.py impact --id <ID>`（文書単位は `--doc NN`）で見直し範囲を列挙する:
- **上(↑)** traces_from の根まで: 変更が上流の意図と整合しているかを**読む**（直すのではなく読む。直したくなったら上流の変更として別途起こす）
- **下(↓)** 子孫と宣言テスト: 波及先の記述を見直し、必要なら修正
- **横(⇔)** 宣言テストと assign 台帳: done/pass 済みのタスクは**再実行対象**（impact が「再実行が必要」と表示する）
- **本文参照**: IDが登場する文書は記述の食い違いが出やすい。差分は最後に `diff --base` でも確認できる
手順: 上流を読む → 対象と下流を修正 → detect → 横のテストを再実行し台帳更新 → signals → schedule --live

### D. 実装・検証を実行する（左翼が緑になってから）
```
python tools/build.py assign          # 左翼の宣言からID単位の実行割当台帳(docs/assign.yaml)を生成/マージ
python tools/build.py agentdocs       # 実装持込用ダイジェスト(architecture/coding/test/design.md)を生成
```
実装リポジトリでは build/agent/ のダイジェストを文脈として読む。コードを書く前に **vmodel-code-minimalism** の7段の問いを回し、どこで止まったかを作業記録に残す。これは生成ビューであり、直したいことが出たら docs/*.yaml を直して再生成する（build/agent/ を手編集しない）。
1. `docs/assign.yaml` の実装タスク（対応設計・完了条件テスト付き）から着手対象を選ぶ。V字対の着手可は `schedule` で確認。
2. 実装/テストを実行したら、台帳の該当行の **status / date / evidence を更新**する（実装: todo→doing→done、行き詰まりは blocked。検証: todo→pass/fail）。
   - done/pass/fail に **証跡(evidence) が必須**で、URL / チケット番号(#123, JIRA-123) / ファイルパス / PR番号 のいずれか**検証可能なアンカーを最低1つ含める**こと（「確認しました」だけの証跡は signals が exit 1 で拒否）。
   - 実行していない作業を pass/done と書くことは禁止。
3. 記録を工程表へ還流する:
```
python tools/build.py signals         # 台帳 → build/signals.json（証跡検査つき）
python tools/build.py schedule --live # テスト失敗→対応要件が赤、blocked→黄、申告と実態の乖離を検出
```
4. assign の再実行は冪等（status/evidence等は温存、新IDを追加、宣言から消えたIDの記録は archived 節へ退避=監査証跡）。宣言を変えたら再実行して台帳を同期する。

### E. 納品物を作る
```
python tools/build.py build       # 全文書 xlsx（記入済み＋空テンプレ）+ md
python tools/build.py diagrams    # 図面PNG + 00_図面集
python tools/build.py coverage    # 00_ドキュメントカバレッジ
python tools/build.py schedule    # 00_工程表連携
```
- 出力サフィックス: 同梱サンプルは「_見本」、init した自案件は「_現況」、空スケルトンは「_テンプレート」。
- 納品一式は `build/` をそのまま渡せる。

## ゲートが赤になったときの直し方

| 検出 | 典型原因 | 修正 |
|---|---|---|
| validate: 未定義の参照 | 本文やtraceが存在しないIDを指す | 参照先IDを定義する（定義元文書の一覧表の先頭列に追加）か、参照を正しいIDに直す |
| validate: 未参照定義 | 定義したIDがどこからも使われていない | 下流文書から参照を張る。本当に不要なら定義を削除 |
| schema: 未知キー/型違い | ブロックのキー名ミス、ncols不一致 | schema/doc.schema.json に適合させる（vmodel-authoring 参照） |
| trace: 宙吊り/逆流 | traces_from が未定義ID/後工程を指す | 上流の正しいIDへ付け替える |
| trace: 双方向不一致 | 要件の tests とテストの traces_from が非対称 | 両側を揃える（要件 F-xxx の tests に UT-xxx、UT-xxx の traces_from に F-xxx） |
| mesh: 台帳の要件一覧に未登録 | 新IDを定義したが43_管理台帳に行を足していない | 43の要求/要件一覧に同IDの行を追加（vmodel-authoring 参照） |
| mesh: 赤/黄 | 要求→要件→設計→テストの鎖が切れている | 切れている段のIDと宣言を補う |
| signals: 証跡が空/アンカー無し | evidence 未記入か、URL・チケット#・パス等の検証可能な参照が無い | 実行の証跡（コマンド＋結果＋参照先）を記入。実行していないなら status を戻す |
| schedule --live: テスト失敗/未実装 | 台帳の fail/blocked が要件RAGに反映された | 原因を修正して再実行し、台帳を更新して signals を再導出 |
| agent: defines不一致/未付与 | ID定義を増減したのにメタデータ未同期 | `python tools/agent_meta.py apply` を実行 |
| schedule: 矛盾 | wbs.yaml の先行/日付/進捗の不整合 | wbs.yaml を修正 |

## やってはいけないこと
- build/ 配下のファイルを直接編集する
- ゲートを通さずに「完了しました」と報告する
- 一覧表（機能一覧・画面一覧・API設計・テーブル一覧等）の**先頭列以外にIDを置く**（先頭列が定義IDとして抽出される）
- 検出を黙らせる目的で catalog の status を na にする、trace 宣言を削除する
