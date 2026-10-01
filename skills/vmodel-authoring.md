---
schema_version: skill.v1
name: vmodel-authoring
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
triggers: "vmodel-docgen の docs/*.yaml を書く・編集するときの書式規約。設計書YAMLのブロック(sec/sub/para/bullets/kv/table/note/gap)、一覧表、ID命名、spec.defines によるトレース宣言、meta/history/toc の書き方を定める。docs/ 配下のYAMLを1行でも変更する前に必ず参照する。"
---

# vmodel-authoring

> 移植元: zip `.claude/skills/vmodel-authoring/SKILL.md` (Apache-2.0、PLAN-L7-676 PR-T3)。
> 原文の意味は書き換えていない (docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.5)。
> 移植元の `docs/*.yaml` は `vmodel-docgen` (別ツール) の正本形式であり、本ハーネスの
> `docs/design/` Markdown 形式とは別物。ID 命名・トレース宣言の**考え方**を読むための参照であり、
> 本ハーネスでの実行対象は `ut-tdd vmodel template` / `vmodel lint` である。
>
> 注記 (PLAN-L7-676 PR-T3): 本文中の `python tools/build.py ...` は移植元 `vmodel-docgen` (別ツール) のコマンドであり、`tools/*.py` 自体は本リポジトリへ同梱しない (ADR-001)。UT-TDD harness では実行対象ではなく、検査の意味は各 gate (G8〜G14、docs/plans/PLAN-L7-676-release-consumer-dev-start.md §3.6) で TypeScript として再実装する。


# docs/*.yaml 執筆規約

## 文書の骨格（schema/doc.schema.json 準拠・additionalProperties: false）

```yaml
file: 03_要件定義書          # 拡張子なしのファイル名と一致させる
title: <製品名> / 要件定義書
label: 要件定義
meta:                        # [キー, 値] の配列
- [プロダクト名, TeamFlow]
- [文書番号, TF-010001]
history:                     # [版, 日付, 更新者, 対象, 内容]
- [1, '2025-12-20', 山田, '', 新規作成]
toc:                         # [章, タイトル, シート番号]
- [第1章, プロダクト要件, 1]
chapters:
- sheet: 1.要件              # シート名は31文字以内
  num: 第1章
  title: プロダクト要件
  ncols: 8                   # このシートの基準列数(2〜20)
  blocks: [...]
spec:                        # トレース宣言（任意だが、ID定義文書では必須運用）
  defines: [...]
```

日付は必ずクォートする（`'2026-01-15'`。裸だとYAMLがdate型に解釈しExcel出力が崩れる）。

## agentメタデータ（文書ローカルの契約。**編集前に必ず読む**）

各文書末尾の `agent:` ブロックが、その文書での作業契約を宣言している:
```yaml
agent:
  defines: [F-, IF-, NF-]   # この文書で定義してよいID接頭辞（これ以外の新IDをここで定義しない）
  read_first: [02_要求定義書, 43_要求・要件一覧(管理台帳)]  # 書く前に読む上流文書
  done_when: ...             # この文書の完了基準
```
- `defines` に無い接頭辞のIDが必要になったら、この文書に書かず**定義元の文書**（read_firstや catalog で特定）に定義する。
- `defines` は許可リスト。未記入の接頭辞が残っていても正常だが、**許可外の接頭辞を定義すると agent ゲートが赤**になる。新しい接頭辞が正当に必要なら `python tools/agent_meta.py apply` で契約を同期する（手書きで広げない）。
- ブロックに `hint:` キーを付けられる（記入時の注意書き。出力には影響しない）。

## ブロック8種（t は enum。これ以外のキーは schema 違反）

| t | 用途 | 主なキー |
|---|---|---|
| sec | 節見出し | num, title |
| sub | 小見出し | title |
| para | 段落 | text, span(横結合数) |
| bullets | 箇条書き | items: [文字列, ...] |
| kv | 定義リスト | rows: [[キー, 値], ...], label_w(ラベル側の**列結合数**。既定2。ncols超は不可) |
| table | 表 | cols: [見出し...], rows: [[...], ...] |
| note | 補足 | text |
| gap | 空行 | min |

**table の各 row の要素数は cols と一致させる。** ncols を超える幅の表は書けない。空欄は `''` で埋める（要素を省略しない）。

## ID命名規約（既定の接頭辞）

要求: R-xxx（画面要求 SR-, 非機能要求 NR- 等は台帳準拠）/ 機能要件: F- / 非機能要件: NF- /
画面: SC- / API: API- / テーブル: T- / バッチ: BT- / 共通部品: CMN- / 外部IF: EIF- /
テスト: UT-(単体) IT-(結合) ST-(総合) AT-(受入)。
連番は3桁ゼロ埋め（F-004）。枝番は英小文字サフィックス（UT-004b）。
正確な体系は `docs/33_トレーサビリティ・ID体系・紐づけ規約.yaml` が正で、矛盾したらそちらに従う。

**IDの定義場所**: 各文書の「一覧」系 table（機能一覧・画面一覧・API設計・テーブル一覧・要求一覧など）の**先頭列**。validate はここを定義とみなす。本文中に新IDを書いても定義にはならない。

## トレース宣言（spec.defines）

ID を定義したら、文書末尾の `spec.defines` に宣言を追加する:

```yaml
spec:
  defines:
  - id: F-004
    kind: 機能要件            # spec_types が内容と突合する。実体と一致させる
    traces_from: [R-003]      # 上流ID（V字で前工程）のみ。後工程を書くと「逆流」で赤
    tests: [UT-004, ST-002]   # 要件系のみ。対応テストID
  - id: UT-004
    kind: 単体テスト
    traces_from: [F-004]      # ★双方向対称: 要件の tests と互いに一致させること
```

- **双方向対称が必須**: `F-xxx.tests` に UT-yyy を書いたら、`UT-yyy.traces_from` に F-xxx を書く（spec_trace --strict のゲート対象）。
- **要求・要件(R-/F-/NF-系)を新設したら、`docs/43_要求・要件一覧(管理台帳).yaml` の該当一覧（要求一覧/要件一覧）にも同じIDの行を追加する。** 台帳未登録は mesh ゲートで赤になる（列: 要件ID/区分/要件名/トレース元/対応設計/対応テスト/状態）。台帳の トレース元・対応テスト は spec 宣言と同じ集合にする（食い違うと trace の台帳不一致で検出される）。
- `traces_from` に書けるのは定義済みID（またはこれから同時に定義するID）のみ。宙吊りは赤。
- kind の綴りは既存宣言と同じ日本語（機能要件/非機能要件/画面/API/テーブル/バッチ/ユースケース/外部インターフェース/単体テスト/結合テスト/総合テスト/受入テスト 等）。schema_check が綴りを検査する。

## 編集の作法

- 既存の章構成・列構成は原則維持し、行の追加で対応する。列の増減が必要なら ncols とすべての row を同時に直す。
- サンプル(TeamFlow)の値を自案件に流用しない。プロダクト名・文書番号は `docs/product.yaml` と meta に従う。
- 変更したら history に1行追加する（版番号+1、対象章、変更内容）。
- ADR が必要な決定（アーキテクチャ選択・技術選定・トレードオフ）は `docs/adr/ADR-xxxx-<slug>.md` を `templates/adr/ADR-0000-template.md` から起こし、14_課題・リスク・意思決定管理の表にも1行追加する。

## 書き終えたら
vmodel-workflow スキルのゲート手順（`python tools/build.py detect` → 赤なら自修正）を必ず実行する。
