# ガバナンス文書

このディレクトリは UT-TDD Agent Harness の現行ガバナンス文書を収める。
過去の source snapshot、migration notes、local runtime state は参照資料に限る。

## 現行の正本

Claude Code、Codex、人間レビュアーは通常作業で以下を読む:

1. `ut-tdd-agent-harness-concept_v3.1.md`
2. `ut-tdd-agent-harness-requirements_v1.2.md`
3. `ut-tdd-agent-harness-extraction-plan_v0.1.md`
4. `../adr/ADR-001-ut-tdd-harness-redesign-and-language.md`
5. `repository-structure.md`

V-model 機構の正本 (中核 5 点への追加読み。repository-structure.md §1 の中核定義
には含まれないが、V-model 作業時は正本として読む):

6. `vmodel-upgrade-schedule.md`
7. `vmodel-activation-profiles.md`
8. `vmodel-document-catalog.md`
9. `vmodel-typed-spec-definitions.md`

> 本リストと root `CLAUDE.md` の Read Order は集合として同期する (裁定 =
> `repository-structure.md` §1、PLAN-L7-459 H1)。CLAUDE.md 側は起動時の最小読み順、
> 本リストは文書体系の完全な正本索引。

> **ADR-001 境界**: 実装は UT-TDD 所有の TypeScript/Bun である。migration
> docs と source snapshots は porting audit と regression idea の参照資料に限る。
> これらは現行の正本でも実行経路でもない。

## 参照のみ

以下の文書は背景、チーム運用、上位計画を補助する。上記の現行正本を上書きしない:

> **「正本」の 2 用法 (PLAN-L7-459 M2)**: 本 README の「現行の正本」= リポジトリ全体の
> 必読 canonical 集合。一方、下記の各文書 (gate-design.md / coding-rules.md 等) が自己宣言
> する「正本/SSoT」= その文書のドメイン内での単一情報源。両者は両立し、後者は前者を
> 上書きしない (ドメイン内 SSoT であることと、全体必読集合の会員であることは別)。

- `ai-dev-team-concept_v1.1.md` (Pack 配布対象外、source repo のみ)
- `ai-dev-team-operations_v1.1.md` (Pack 配布対象外、source repo のみ)
- `audit-framework.md`
- `coding-rules.md`
- `ddd-tdd-rules.md`
- `document-system-map.md`
- `gate-design.md`
- `github-issue-hierarchy.md` (GitHub Issue 階層運用のドメイン内 SSoT)
- `recovery-workflow.md`

## アーカイブまたは vendor 資料

archived documents、source snapshots、migration inventories、local legacy の資料群
checkouts は過去証跡に限る。UT-TDD runtime state、実行経路、現行 command path
として使ってはいけない。現行 runtime command は
`ut-tdd`.
