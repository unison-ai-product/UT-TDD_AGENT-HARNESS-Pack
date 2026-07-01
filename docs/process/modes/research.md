> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# Research 駆動モデル

出典: requirements v1.2 §1.3 VALID_KINDS (`research`) / §1.6 kind×drive matrix / §6.1 branch prefix (`research/*`) / concept v3.1 §2.5 備考 (9-mode 外、kind/branch として正本)

---

## 1. 概要

技術選定・方式比較など、**PoC を作らずに机上調査と意思決定で完結**させる前段調査 mode。成果は ADR (Architecture Decision Record) として Forward に接続する。concept §2.5 の 9-mode 本体には含まれないが、§1.3 VALID_KINDS に `research` として正式登録されている。

| 項目 | 値 |
|------|-----|
| kind | `research` |
| drive | `be` / `fe` / `fullstack` / `db` / `agent` |
| layer | `L1`-`L4` |
| workflow_phase | **禁止** (phase なし) |
| owner | `tl` |
| 承認者 | — (人間サインオフ不要) |
| branch prefix | `research/*` (§6.1) |

> **layer 値の確定 (IMP-046)**: 早見表の `L1`-`L4` は適用範囲の表記。実 PLAN 起票時の `layer` は **合流先 1 値**を設定する (ADR が L4 基本設計の判断材料なら `layer=L4`、要求影響なら `layer=L1`。VALID_LAYERS は単一値、§1.4 のため範囲値は schema 無効)。`docs/research/` の canonical tree 登録は §6 tree gap 注記のとおり Reverse 正本化時に repository-structure へ反映する。

---

## 2. phase / フロー構成

```
調査課題定義 → 候補調査 → 比較評価 → ADR (意思決定) → research-memo
```

| Step | 内容 | 成果物 |
|------|------|--------|
| 1. 調査課題定義 | 何を決めるための調査か、判断基準を明確にする | 課題定義メモ |
| 2. 候補調査 | 選択肢・先行事例・制約・公式ドキュメントを収集 | 調査ノート |
| 3. 比較評価 | 基準を立てて候補を比較 (表形式推奨) | 比較表 |
| 4. ADR 記録 | 意思決定と理由を `docs/adr/ADR-NNN-<slug>.md` に記録 | ADR |
| 5. research-memo | 調査内容の要約を `docs/research/<slug>-research-memo.md` に記録 | research-memo |

---

## 3. exit 条件

| 条件 | 検証方法 |
|------|---------|
| ADR 記録完了 | `docs/adr/ADR-NNN-*.md` の存在と内容確認 |
| Forward 接続先確定 | ADR に「接続先 (L1/L4)」と「次アクション」が記載されていること |
| research-memo 完了 | `docs/research/` に保存済 |

---

## 4. Forward 合流点

| 成果物 | 合流先 |
|--------|--------|
| ADR (技術選定) | **L4** 基本設計の判断材料 |
| ADR (要求影響あり) | **L1** 要求定義の判断材料 |
| branch | `research/*` → `main` へ merge (設計 PR として扱う) |

---

## 5. 必須 role / 承認者

| role | 責務 |
|------|------|
| `tl` | 調査主体・ADR 作成・技術判断 (frontier-reviewer class) |

---

## 6. 他 mode との連鎖 / 注意

| 状況 | 遷移先 |
|------|--------|
| 「作れるか不明」になった | **Discovery** へ切替 (PoC 検証が必要) |
| 「既存実装を調べる必要がある」 | **Reverse** へ切替 (R0-R4 で実装遡及) |
| 技術選定が要件に影響する | ADR を L1 に接続し **Add-feature** / Forward L1 追補へ |

注: Research は "机上で調べて決める" mode。"作って試す" は Discovery (kind=poc)。両者を混同しないこと。research-memo は調査記録であり、設計成果物 (①) ではない — docs/design/ ではなく docs/research/ に置く。

> **⚠ tree gap (S3 verify 所見)**: `docs/research/` は **canonical tree (repository-structure.md) に未登録**であり実体ディレクトリも不在。scaffold-dirs-upfront 原則 (構成確定なら先行実体化) に照らすと、research-memo 配置先を canonical tree に追加するか別ディレクトリ (docs/adr/ のみ) に寄せるかの決定が要る。PLAN-DISCOVERY-04 §S2-S3 V2 が申し送り正本。正本化 (Reverse) 時に repository-structure へ反映。
