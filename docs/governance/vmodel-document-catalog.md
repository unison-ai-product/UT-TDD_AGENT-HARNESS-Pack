---
title: "Vモデル document catalog 正本"
status: confirmed
owner: PO / TL
updated: 2026-07-10
typed_spec_phase_owner: L4
---

# Vモデル document catalog 正本

## 0. 役割

本書は HARNESS が保守する **target document slot** の authoring source である。checked ZIPの109 source documentは
`vmodel-document-disposition-catalog.md`、163 semantic itemは後続semantic item catalogで管理し、本書の行数と一致させない。
`document-system-map.md` は工程・業界標準・設計思想、本書はHARNESS targetの文書種別・採用粒度・projection先を定義する。

`harness.db` は正本ではなく、本書から `document_catalog_entries` へ rebuild される projection である。
検出系は `document_catalog_entries` と `activation_entries` / `schedule_entries` を参照し、設計側の採用・skip・粒度を後追いする。

## 1. 文書カタログ

| `doc_type_id` | `layer` | `sub_doc` | `category` | `requirement_class` | `applicability` | `default_status` | `source_doc_family` | `authoring_source_path` | `projection_table` | `profile_controlled` | `skip_reason_required` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `DOC-L0-CHARTER` | `L0` | `charter` | `planning` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/plans/PLAN-L0-01-vmodel-harness-upgrade-charter.md` | `plan_registry` | `false` | `false` |
| `DOC-L1-REQUIREMENTS` | `L1` | `functional-requirements` | `requirements` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L1-requirements/functional-requirements.md` | `spec_defs` | `false` | `false` |
| `DOC-L1-VMODEL-ENGINE-SWAP-DELTA` | `L1` | `technical` | `upgrade-delta` | `core` | `in_scope` | `required` | `vmodel-upgrade` | `docs/design/harness/L1-requirements/vmodel-engine-swap-requirements-delta.md` | `spec_defs` | `false` | `false` |
| `DOC-L2-SCREEN` | `L2` | `screen-list` | `screen` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L2-screen/screen-list.md` | `spec_defs` | `false` | `false` |
| `DOC-L3-FUNCTIONAL` | `L3` | `functional-requirements` | `requirements` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L3-functional/functional-requirements.md` | `spec_defs` | `false` | `false` |
| `DOC-L4-DATA` | `L4` | `data` | `basic-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L4-basic-design/data.md` | `spec_defs` | `false` | `false` |
| `DOC-L4-ARCHITECTURE` | `L4` | `architecture` | `basic-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L4-basic-design/architecture.md` | `spec_defs` | `false` | `false` |
| `DOC-L4-EXTERNAL-IF` | `L4` | `external-if` | `basic-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L4-basic-design/external-if.md` | `spec_defs` | `false` | `false` |
| `DOC-L4-FUNCTION` | `L4` | `function` | `basic-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L4-basic-design/function.md` | `spec_defs` | `false` | `false` |
| `DOC-L4-UI-STANDARD` | `L4` | `ui-standard` | `frontend-design` | `product-select` | `in_scope` | `required` | `vmodel-ui` | `docs/design/harness/L4-basic-design/ui-standard.md` | `spec_defs` | `true` | `true` |
| `DOC-L4-REPORT` | `L4` | `report` | `deliverable` | `product-select` | `profile_controlled` | `skipped` | `vmodel-product-select` | `docs/governance/document-system-map.md#1b` | `document_catalog_entries` | `true` | `true` |
| `DOC-L4-BATCH` | `L4` | `batch` | `deliverable` | `product-select` | `profile_controlled` | `skipped` | `vmodel-product-select` | `docs/governance/document-system-map.md#1b` | `document_catalog_entries` | `true` | `true` |
| `DOC-L4-NOTIFICATION` | `L4` | `notification` | `deliverable` | `product-select` | `profile_controlled` | `skipped` | `vmodel-product-select` | `docs/governance/document-system-map.md#1b` | `document_catalog_entries` | `true` | `true` |
| `DOC-L4-CODE-VALUE` | `L4` | `code-value` | `deliverable` | `product-select` | `profile_controlled` | `skipped` | `vmodel-product-select` | `docs/governance/document-system-map.md#1b` | `document_catalog_entries` | `true` | `true` |
| `DOC-L4-SECURITY` | `L4` | `security` | `security` | `core` | `in_scope` | `required` | `vmodel-security` | `docs/design/harness/L4-basic-design/security.md` | `spec_defs` | `false` | `false` |
| `DOC-L5-PHYSICAL-DATA` | `L5` | `physical-data` | `detailed-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L5-detailed-design/physical-data.md` | `spec_defs` | `false` | `false` |
| `DOC-L5-MODULE` | `L5` | `module-decomposition` | `detailed-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L5-detailed-design/module-decomposition.md` | `spec_defs` | `false` | `false` |
| `DOC-L6-FUNCTION-SPEC` | `L6` | `function-spec` | `function-design` | `core` | `in_scope` | `required` | `vmodel-core` | `docs/design/harness/L6-function-design/function-spec.md` | `spec_defs` | `false` | `false` |
| `DOC-L7-UNIT-TEST-DESIGN` | `L7` | `unit-test-design` | `test-design` | `core` | `in_scope` | `required` | `vmodel-test` | `docs/test-design/harness/L7-unit-test-design.md` | `spec_defs` | `false` | `false` |
| `DOC-L8-INTEGRATION-TEST-DESIGN` | `L8` | `integration-test-design` | `test-design` | `core` | `in_scope` | `required` | `vmodel-test` | `docs/test-design/harness/L8-integration-test-design.md` | `spec_defs` | `false` | `false` |
| `DOC-L9-SYSTEM-TEST-DESIGN` | `L9` | `system-test-design` | `test-design` | `core` | `in_scope` | `required` | `vmodel-test` | `docs/test-design/harness/L9-system-test-design.md` | `spec_defs` | `false` | `false` |
| `DOC-L10-UX-VALIDATION` | `L10` | `ux-validation` | `test-design` | `product-select` | `profile_controlled` | `required` | `vmodel-test` | `docs/test-design/harness/L10-ux-validation-test-design.md` | `spec_defs` | `true` | `true` |
| `DOC-L11-TRACE-UAT` | `L11` | `trace-uat` | `process-evidence` | `core` | `in_scope` | `required` | `vmodel-verification` | `docs/process/evidence/g11-uat-review-design.md` | `evidence_records` | `false` | `false` |
| `DOC-L12-ACCEPTANCE` | `L12` | `acceptance-test-design` | `test-design` | `core` | `in_scope` | `required` | `vmodel-test` | `docs/test-design/harness/L12-acceptance-test-design.md` | `spec_defs` | `false` | `false` |
| `DOC-L13-PRODUCTION-OBSERVATION` | `L13` | `production-observation` | `process-evidence` | `core` | `in_scope` | `required` | `vmodel-verification` | `docs/process/evidence/g13-post-deploy-verification-design.md` | `evidence_records` | `false` | `false` |
| `DOC-L14-OPERATIONAL-TEST` | `L14` | `operational-test-design` | `test-design` | `core` | `in_scope` | `required` | `vmodel-test` | `docs/test-design/harness/L14-operational-test-design.md` | `spec_defs` | `false` | `false` |
| `DOC-L14-VMODEL-ENGINE-SWAP-OT` | `L14` | `operational-test-design` | `upgrade-delta` | `core` | `in_scope` | `required` | `vmodel-upgrade` | `docs/test-design/harness/L14-vmodel-engine-swap-operational-test-design.md` | `spec_defs` | `false` | `false` |

## 2. 不変条件

- `default_status=skipped|draft` かつ `profile_controlled=true` の行は、適用判断を profile / PLAN / skip reason のいずれかで説明できる必要がある。
- `document-system-map.md` は本書の意味定義の上流正本であり、本書は同じ意味を機械可読の行へ落とす。
- `document_catalog_entries` は検索・検出用 read-model であり、authoring source を上書きしない。
- source 109件のinventory完了やsemantic item 163件のcoverageを、本書のtarget slot件数で代替しない。
- target slotはdispositionから0件以上のsource document/semantic itemを受け、逆にsource/item側のorphanはfail-closeする。
