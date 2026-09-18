---
process_layer: L13
status: draft
related_l0: docs/plans/PLAN-L0-01-vmodel-harness-upgrade-charter.md
owning_plan: docs/plans/PLAN-L13-01-engine-swap-post-deploy-verification.md
---

# G13 post-deploy / SLI-SLO evidence design

## G13-WORKFLOW

test_strategy: install/update直後のsmoke、runtime health、detector品質、rollback readinessを検証する。
test_plan: G12 pass後、SMOKE-ENGINE-01〜03とSLI-ENGINE-01をmandatoryで実施する。
test_conditions: environment/version、SLI/SLO threshold、sample window、rollback triggerを事前固定する。
coverage_items: install/update、doctor/status、DB rebuild、workflow transition、detector latency/error、rollbackを対象にする。
test_procedures: clean Pack install、`ut-tdd doctor`、`ut-tdd db rebuild`、workflow smoke、rollback rehearsalを実行する。
execution_evidence: command/exit、metric、alert、decision、artifact digestを`.ut-tdd/evidence/g13-post-deploy/engine-swap.json`へ記録する。
exit_criteria: mandatory 4/4 pass、SLO内、critical finding 0、rollback不要または成功。
defect_routing: production defectはIncident/Recovery、threshold設計はNFR Reverse、runtimeはL7へ戻す。
verification_design: environment/version、sample window 30分以上、p95、error rate、rollback decisionを固定する。

| case ID | 観測 | 閾値 |
|---|---|---|
| `SMOKE-ENGINE-01` | clean install後のstatus/doctor | exit 0、hard finding 0 |
| `SMOKE-ENGINE-02` | DB全削除/rebuild | identity diff 0、失敗0 |
| `SMOKE-ENGINE-03` | illegal/valid workflow transition | 誤accept 0、期待finding一致 |
| `SLI-ENGINE-01` | doctor/rebuild/detector execution | 30分窓でerror rate 0%、p95はbaseline+20%以内 |
