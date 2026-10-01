---
title: "PLAN-L7-676 PR-T1 port index: checked ZIP テンプレート 57 本の分類"
status: draft
plan: docs/plans/PLAN-L7-676-release-consumer-dev-start.md
---

# port index: checked ZIP テンプレートの移植先

`Vモデル設計ドキュメント_checked.zip` (repo root、gitignore 対象、PO 承認済み公開移植: issue #676) の `templates/NN_*.yaml` 57 本 (01〜53、96、102、108、109) を、本書で「slot source」か「optional」のどちらか一方だけに分類する (PLAN-L7-676 §3.5.3、CANDIDATE-U-RCDEV-021)。分類の根拠は `docs/governance/vmodel-document-disposition-catalog.md` の `target` 列であり、L2 (直接 source 無し) と L6 (既存テンプレートを正とする例外) は PLAN §3.5.3 の構成元記載に従う。

## 1. slot source (required 21 slot、`docs/templates/vmodel/` 直下)

| slot (`doc_type_id`) | テンプレート file | zip source (ZIP-DOC-NNN) |
| --- | --- | --- |
| `DOC-L0-CHARTER` | `L0-charter.md` | ZIP-DOC-001 |
| `DOC-L1-REQUIREMENTS` | `L1-requirements.md` | ZIP-DOC-002 |
| `DOC-L2-SCREEN` | `L2-screen-list.md` | ZIP-DOC-004 |
| `DOC-L3-FUNCTIONAL` | `L3-functional-requirements.md` | ZIP-DOC-003、ZIP-DOC-029、ZIP-DOC-043 |
| `DOC-L4-DATA` | `L4-data.md` | ZIP-DOC-027 |
| `DOC-L4-ARCHITECTURE` | `L4-architecture.md` | ZIP-DOC-018、ZIP-DOC-032、ZIP-DOC-040 |
| `DOC-L4-EXTERNAL-IF` | `L4-external-if.md` | ZIP-DOC-023、ZIP-DOC-042 |
| `DOC-L4-FUNCTION` | `L4-function.md` | ZIP-DOC-004 |
| `DOC-L4-UI-STANDARD` | `L4-ui-standard.md` | ZIP-DOC-037、ZIP-DOC-041 |
| `DOC-L4-SECURITY` | `L4-security.md` | ZIP-DOC-010 |
| `DOC-L5-PHYSICAL-DATA` | `L5-physical-data.md` | ZIP-DOC-022、ZIP-DOC-039 |
| `DOC-L5-MODULE` | `L5-module-decomposition.md` | ZIP-DOC-005、ZIP-DOC-031 |
| `DOC-L6-FUNCTION-SPEC` | `L6-function-spec.md` | ZIP-DOC-024 |
| `DOC-L7-UNIT-TEST-DESIGN` | `L7-unit-test-design.md` | ZIP-DOC-006 |
| `DOC-L8-INTEGRATION-TEST-DESIGN` | `L8-integration-test-design.md` | ZIP-DOC-007 |
| `DOC-L9-SYSTEM-TEST-DESIGN` | `L9-system-test-design.md` | ZIP-DOC-008、ZIP-DOC-102 |
| `DOC-L10-UX-VALIDATION` | `L10-ux-validation.md` | ZIP-DOC-051 |
| `DOC-L11-TRACE-UAT` | `L11-trace-uat.md` | ZIP-DOC-028 |
| `DOC-L12-ACCEPTANCE` | `L12-acceptance-test-design.md` | ZIP-DOC-009 |
| `DOC-L13-PRODUCTION-OBSERVATION` | `L13-production-observation.md` | ZIP-DOC-011、ZIP-DOC-021 |
| `DOC-L14-OPERATIONAL-TEST` | `L14-operational-test-design.md` | ZIP-DOC-011、ZIP-DOC-034 |

21 slot の全てに、frontmatter の `doc_type_id` が一致するテンプレートが exactly 1 本ある (CANDIDATE-U-RCDEV-019)。`DOC-L2-SCREEN` は 04 基本設計書の画面節と `diagrams.yaml` の 画面遷移図 (semantic item catalog `d_screen`) から構成 (直接 source 無し)。`DOC-L6-FUNCTION-SPEC` の正本は既存 `docs/templates/design/L6-function-spec-template.md` であり、`L6-function-spec.md` は ZIP-DOC-024 の補足のみを持つ (PLAN §3.5.3)。

## 2. optional (27 本、`docs/templates/vmodel/optional/`)

| zip 番号 | zip entry (decoded) | sha256 | disposition (根拠: disposition catalog) | テンプレート |
| --- | --- | --- | --- | --- |
| 012 | `12_テスト計画書.yaml` | `sha256:c3d359c68b5af9270ec6aadd095e8efe188cd817f8a7bf0a3bd6d58e14ed74d7` | adopt → `docs/process/vmodel-contract.yaml` | `optional/012-test-plan.md` |
| 013 | `13_移行設計・計画書.yaml` | `sha256:e8f3b1f7cd8f575635d5b81e804705a0100b8d3dc18c140747263275fa48aa3b` | merge → `docs/process/gates.md` | `optional/013-migration-plan.md` |
| 014 | `14_課題・リスク・意思決定管理.yaml` | `sha256:99c71a7e398c83b9e6f6a5e7ee9c6e7a25ed7c61dfc3671e92a7bdd06da619f1` | merge → `docs/adr/` | `optional/014-issue-risk-decision-log.md` |
| 015 | `15_開発標準・規約書.yaml` | `sha256:3633280fbdad6e3b2a3e342bd5ef35e5feb7a0944acb2be05d9cda269ddeb6fa` | merge → `docs/governance/coding-rules.md` | `optional/015-development-standards.md` |
| 016 | `16_バッチ設計書.yaml` | `sha256:8e7bc864992462a62faa58441af33ac23329db2c71933e5f516b551d2c7847d1` | reference → `DOC-L4-BATCH` | `optional/016-batch-design.md` |
| 017 | `17_設計一覧・定義集.yaml` | `sha256:392f8d8ab23996fbdf82a80654a25528b5d2b5816882b88ab3c478d4b191090c` | merge → `docs/governance/vmodel-document-catalog.md` | `optional/017-design-index-definitions.md` |
| 019 | `19_ワークフロー定義.yaml` | `sha256:e8fc16c4c839ef019528ae2d0c8615461082ed10bc706203f5fc7496ac6319b2` | merge → `docs/process/forward/overview.md` | `optional/019-workflow-definition.md` |
| 020 | `20_計測・KPI設計書.yaml` | `sha256:1f9d9548ed85001b387be1c8212462ebc7a68e110c88799c8655cd6840f295b2` | merge → `docs/design/harness/L1-requirements/business-requirements.md` | `optional/020-metrics-kpi-design.md` |
| 025 | `25_ネットワーク設計書.yaml` | `sha256:cba5f5a01f8b785e245a44d4e6ff9f2c37ce0307bc3da303a14f77cc2f369b0c` | reference → `docs/governance/vmodel-document-catalog.md` | `optional/025-network-design.md` |
| 026 | `26_サーバー・インフラ設計書.yaml` | `sha256:74b48a407693bb09ae41d5c4d005eb69d9f033f82abf57dc2abbc48624603f2d` | reference → `docs/governance/vmodel-document-catalog.md` | `optional/026-server-infrastructure-design.md` |
| 030 | `30_用語集・データディクショナリ.yaml` | `sha256:42327c7fbd5710ef468ed21cc3b48795377da4f30db4612fcf301c9968b98613` | adopt → `docs/governance/document-system-map.md` | `optional/030-glossary-data-dictionary.md` |
| 033 | `33_トレーサビリティ・ID体系・紐づけ規約.yaml` | `sha256:239ad79c91ac88bf7d72fa778e3f47d260b4c9b921f58a79852a9c17a316e653` | merge → `docs/process/plan-asset-v2.md` | `optional/033-traceability-id-conventions.md` |
| 035 | `35_信頼性・DR・BCP設計書.yaml` | `sha256:e26b584c423e9c8d172268fb7e89b89b3cb9c4bd680faed5bdf8bc7755dd855f` | reference → `docs/governance/vmodel-document-catalog.md` | `optional/035-reliability-dr-bcp-design.md` |
| 036 | `36_プライバシー設計書.yaml` | `sha256:925a90f9ea7db642b19a42c7d760e8c6a8e54d397037af4981c507ea5229c0de` | reference → `docs/design/harness/L4-basic-design/security.md` | `optional/036-privacy-design.md` |
| 038 | `38_CI・CDパイプライン設計書.yaml` | `sha256:6e129caf87cc0bf5f46e54d9a589e0f7ac8145baf0b1cff0f8ff3c618ab93a85` | merge → `docs/process/gates.md` | `optional/038-ci-cd-pipeline-design.md` |
| 044 | `44_成果物インデックス・マップ.yaml` | `sha256:704cc381dd241ce111cfa5b8cf2f8de9ed93bd28e757c10908ebae60c7d18679` | merge → `docs/governance/document-system-map.md` | `optional/044-deliverable-index-map.md` |
| 045 | `45_ディレクトリ構成・プロジェクト構造設計.yaml` | `sha256:dfff2d6e4a7cd321152ef77ec14f8cb96e3ac5ed7e25c8709ad61022376d9127` | merge → `AGENTS.md` | `optional/045-directory-structure-design.md` |
| 046 | `46_SEO・公開ページ設計.yaml` | `sha256:33b7789a147fc71718f55dd584221d5683b78ab71236a29fa820d0e2c1b5b3a2` | reference → `DOC-L4-UI-STANDARD` | `optional/046-seo-public-page-design.md` |
| 047 | `47_サポート・問い合わせ・エスカレーション設計.yaml` | `sha256:4fa78b9e59abb895cc36573d682ca6061f2ea284e54897fd431d7ffb84e7f22e` | merge → `docs/process/gates.md` | `optional/047-support-escalation-design.md` |
| 048 | `48_ユーザードキュメント設計.yaml` | `sha256:8615ce09ed2cdab899f49c132bc59de74b0c6a8c21da0652dbb4bc4831a387e6` | merge → `docs/governance/document-system-map.md` | `optional/048-user-documentation-design.md` |
| 049 | `49_AI成果物検証設計.yaml` | `sha256:526706f2fe6185a179ebf289982ee4059491339a0684a5ad7b53cacc6fa11fcf` | merge → `docs/process/vmodel-contract.yaml` | `optional/049-ai-output-verification-design.md` |
| 050 | `50_停止・再開・実行記録設計.yaml` | `sha256:00a1202e7dad0b7f2efc90a5235769f6a00c9a41786daae43cac77f577f92273` | merge → `docs/design/harness/L6-function-design/` | `optional/050-stop-resume-execution-log-design.md` |
| 052 | `52_文書化方針・テーラリング設計.yaml` | `sha256:293d16ebfca2edc86e29c5fd3821f6b89d95e6fdfd97ac20f70bc9ecb8c7f021` | merge → `docs/governance/vmodel-document-scale-profiles.md` | `optional/052-documentation-policy-tailoring.md` |
| 053 | `53_PoC検証設計書.yaml` | `sha256:c42b2e179d01218d9e67978b9f871bf008176d676d52daf220ac9d57288d541e` | merge → `docs/process/modes/` | `optional/053-poc-verification-design.md` |
| 096 | `96_設計原則(7つの柱)設計書.yaml` | `sha256:c507f01430124cf3f260001ae81203178678df34695b3e52a44006f2860bb1f1` | merge → `docs/governance/ut-tdd-agent-harness-concept_v3.1.md` | `optional/096-design-principles-seven-pillars.md` |
| 108 | `108_リファクタリング設計書.yaml` | `sha256:a3fabe03164f4cf994f03d78aacc3375da0bc29b70242e5b64814116aaf3f59c` | merge → `docs/process/modes/refactor.md` | `optional/108-refactoring-design.md` |
| 109 | `109_QA診断・品質チェックリスト.yaml` | `sha256:d8f006a5f82f7ff26469818a73c3d6414077b3836c5db6233333d77c4a78496a` | merge → `docs/process/gates.md` | `optional/109-qa-quality-checklist.md` |

optional テンプレートの実体は `docs/templates/vmodel/optional/NNN-<slug>.md` である (PR-T2 で移植)。ファイル名は zip 番号と英語の slug で作る。optional テンプレートは V-model の layer に束ねないため、frontmatter に `layer` / `doc_type_id` を持たず、`template_kind: optional` と provenance (`source_id`、zip entry、sha256) と disposition を持つ。

## 3. 同梱しないもの (ADR-001)

zip `tools/*.py` (27 entry) と `requirements.txt` は同梱しない。検査の意味は PLAN §3.6-4 の共通述語 (S/I/T/E/F/A) として TypeScript gate に再実装する (CANDIDATE-U-RCDEV-024)。

## 4. 管理 yaml (第 2 の SSoT を作らない)

`profiles.yaml` / `catalog.yaml` / `diagrams.yaml` / `traceability.yaml` / `wbs.yaml` は 別ファイルとして出荷しない。既存正本 (`docs/governance/vmodel-document-scale-profiles.md` / `vmodel-document-catalog.md` / `vmodel-semantic-item-catalog.md`) へ merge する (PLAN §3.5.4)。この merge 作業は PR-T2 が所有する (CANDIDATE-U-RCDEV-025)。

