---
layer: L6
sub_doc: <slug>
status: draft
pair_artifact: docs/test-design/harness/L7-unit-test-design.md
related_l0: docs/governance/ut-tdd-agent-harness-concept_v3.1.md
plan: docs/plans/PLAN-<id>.md
---

<!--
L6 機能設計テンプレート (S 粒度 = Sonnet 級実装即応、正本: docs/governance/design-doc-implementation-readiness.md §2)
7 必須要素: ①配置 ②IF 契約 ③事前/事後条件 ④失敗モード ⑤データ形 ⑥エッジケース表 ⑦検証接続。
各節の HOW-TO コメントは執筆後に削除してよい。要素を満たせない場合は「なぜ不要か」を 1 行で明記する (無言の欠落にしない)。
-->

# UT-TDD Agent Harness — L6 機能設計: <機能名>

## §1 概要と配置 <!-- 要素① -->

- 目的: <この機能が保証すること 1-2 文>
- 実装先: `src/<module>/<file>.ts` <!-- 新規/既存を明記。テストは tests/<name>.test.ts -->
- 呼び出し元: <CLI コマンド / hook / doctor など発火点>

## §2 IF 契約 <!-- 要素② -->

```ts
// export する公開面のみ (内部 helper は書かない — 実装が正本)
export function <name>(input: <InputType>): <ResultType>;

export interface <InputType> { /* 各フィールドに 1 行コメント */ }
export interface <ResultType> { /* 同上。エラーは throw か Result 型かを明記 */ }
```

## §3 事前/事後条件・不変条件 <!-- 要素③ -->

| 関数 | 事前条件 | 事後条件 | 不変条件 |
|---|---|---|---|
| `<name>` | <入力に要求する状態> | <返り値/副作用が保証する状態> | <常に成り立つこと> |

## §4 失敗モード <!-- 要素④ -->

- 方針: **fail-open / fail-close** のどちらか + 理由 1 行。
- 入力異常時の挙動:

| 異常 | 挙動 | 根拠 |
|---|---|---|
| <欠損/型不一致/IO 失敗/…> | <warn して skip / block / 既定値> | <なぜその側に倒すか> |

## §5 データ形 (具体例) <!-- 要素⑤ -->

<!-- 型定義でなく実データ。この例がそのまま単体テストの fixture / oracle の種になる -->

```json
// 入力例 (代表 1 件 + 特徴的な 1 件)
{ "...": "..." }
```

```json
// 上に対応する期待出力
{ "...": "..." }
```

## §6 エッジケース表 <!-- 要素⑥: 各行 = L7 単体テスト 1 件 (設計粒度 = テスト設計粒度) -->

| # | ケース | 入力の特徴 | 期待挙動 | oracle |
|---|---|---|---|---|
| 1 | <境界: 空入力> | | | U-<ID> (起票時に採番) |
| 2 | <異常: …> | | | U-<ID> |
| 3 | <正常系の代表> | | | U-<ID> |

## §7 検証接続 <!-- 要素⑦ -->

- pair: frontmatter `pair_artifact` (L7 unit-test-design)。§6 の oracle 列が対応表。
- 回帰 fence: `bun run test` full green + <対象 doctor check 名> green。

## §8 carry / 非スコープ <!-- 任意 -->

- <この doc が扱わないこと・将来増分>
