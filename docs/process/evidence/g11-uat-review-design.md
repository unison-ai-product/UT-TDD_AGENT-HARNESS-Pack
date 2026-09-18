---
process_layer: L11
status: draft
related_l0: docs/plans/PLAN-L0-01-vmodel-harness-upgrade-charter.md
owning_plan: docs/plans/PLAN-L11-01-engine-swap-uat-review.md
---

# G11 UAT / stakeholder review evidence design

## G11-WORKFLOW

test_strategy: PO scenarioで要求、意味適合、再利用性、運用可視性を検収する。
test_plan: G10 pass後、UAT-ENGINE-01〜03を全件mandatoryとして実施する。
test_conditions: scenario、AC、fixture、reviewer、revision、期待decisionを事前固定する。
coverage_items: L1-07、L4-22〜28、163 item、全docs ledger、G8-G10 evidenceを対象にする。
test_procedures: `ut-tdd status`、`ut-tdd doctor`、workflow/plan/docs audit CLIの実行結果をPO scenarioへ提示する。
execution_evidence: approval scope、decision、open defect、defect routeを`.ut-tdd/evidence/g11-uat/engine-swap.json`へ記録する。
exit_criteria: mandatory scenario pass 3/3、未承認scope 0、open blocker 0、PO decision記録済み。
defect_routing: requirementはL1/L3、designはReverse、implementationはL7、verificationはL8-L10へ戻す。
verification_design: reviewer、commit、contract revision、scenario input、期待/実decision、evidence digestを固定する。

| UAT ID | scenario | 定量閾値 |
|---|---|---|
| `UAT-ENGINE-01` | source→item→target、全docs判断、163 item verdictをPOが追跡する | orphan/pending/未route gap 0 |
| `UAT-ENGINE-02` | PLAN revise→Forward transition→evidence→accept拒否/許可を説明する | hidden state 0、誤accept 0 |
| `UAT-ENGINE-03` | G8-G14 frontier、blocked reason、次action、PO decisionを確認する | 未登録層0、未承認scope 0 |
