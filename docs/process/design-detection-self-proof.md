---
title: "設計由来detectorの自己証明契約"
status: draft
owner: PO / TL / QA
updated: 2026-07-10
---

# 設計由来detectorの自己証明契約

## 1. 統制成立条件

統制は、設計が存在するだけでもdetectorがgreenを返すだけでも成立しない。次の5点が同じrevision/commitへ結合した場合だけ成立する。

1. authored design contractが完全である。
2. deterministic compilerがrule registryを生成する。
3. runtime detectorが全surfaceへ配線される。
4. independent meta-verifierがmapping/digest/実発火を検証する。
5. mutation/negative controlと正常controlのreceiptが保存される。

## 2. 禁止する自己証明

- detector本体の判定関数をtest oracleとして呼び、同じ誤りを共有する。
- source hashを見ずにgenerated registryの存在だけでgreenにする。
- doctorへの登録だけを確認し、違反fixtureでのfinding/exitを実行しない。
- DB projectionが欠落設計を補完し、その補完値を正しさの証拠にする。
- 1件の代表rule成功をG8-G14全ruleの証明に拡張する。

## 3. 独立検証面

| 面 | 独立検証 |
|---|---|
| 完全性 | contract rule/gateとregistry entryの集合差 |
| freshness | authored source hashとgenerated source digest |
| 配線 | CLI/hook/doctor/CI surface別detector ID |
| 発火 | 違反fixtureのexpected finding code/subject/exit |
| 非過検出 | 正常fixtureでfinding 0 |
| mutation | rule削除、mapping交換、例外握り潰し、stale生成、projection補完 |
| 再現性 | clean DB rebuild前後のreceipt/finding同値 |
| review | workerと別provider/model familyのverdict |

## 4. receipt最小項目

`rule_id`、`contract_revision`、`source_hash`、`generated_hash`、`detector_id`、`surface`、`fixture_id`、
`expected_finding`、`actual_finding`、`expected_exit`、`actual_exit`、`test_run_id`、`source_commit`、`verifier_version`を必須にする。

## 5. gate

- receiptなし、stale digest、未配線surface、mutation survivor、false-positiveはhard failureである。
- 設計上deferしたruleは期限/PLAN/理由を持ち、実装済みcoverageへ数えない。
- meta-verifier failureをdetector successで上書きしない。
