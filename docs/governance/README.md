# ガバナンス文書

このディレクトリは UT-TDD Agent Harness の現行ガバナンス文書を収める。
過去の source snapshot、migration notes、local runtime state は参照資料に限る。

## 現行の正本

Claude Code、Codex、人間レビュアーは通常作業で以下を読む:

1. `ut-tdd-agent-harness-concept_v3.1.md`
2. `ut-tdd-agent-harness-requirements_v1.2.md`
3. `../adr/ADR-001-ut-tdd-harness-redesign-and-language.md`
4. `repository-structure.md`

> **ADR-001 境界**: 実装は UT-TDD 所有の TypeScript/Bun である。migration
> docs と source snapshots は porting audit と regression idea の参照資料に限る。
> これらは現行の正本でも実行経路でもない。

## 参照のみ

以下の文書は背景、チーム運用、上位計画を補助する。上記の現行正本を上書きしない:

- `ai-dev-team-concept_v1.1.md`
- `ai-dev-team-operations_v1.1.md`
- `audit-framework.md`
- `coding-rules.md`
- `ddd-tdd-rules.md`
- `document-system-map.md`
- `gate-design.md`
- `recovery-workflow.md`

## アーカイブまたは vendor 資料

archived documents、source snapshots、migration inventories、local legacy の資料群
checkouts は過去証跡に限る。UT-TDD runtime state、実行経路、現行 command path
として使ってはいけない。現行 runtime command は
`ut-tdd`.
