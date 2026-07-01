<!-- UT-TDD:managed:start -->
# UT-TDD Agent Harness Shared Context

Use repository-local UT-TDD commands for harness state and delegation.

- GitHub 配布先: `https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack`
- `ut-tdd status` reports the local runtime mode.
- `ut-tdd doctor` runs repository health checks.
- `ut-tdd handover` reads and writes cross-runtime handover state.
- `ut-tdd codex --role <role> --task "..."` delegates to Codex.
- `ut-tdd claude --role <role> --task "..."` delegates to Claude.

クロスレビュー原則:

- 設計判断、実装完了、release/UAT 判定は、作業者と reviewer を分ける。
- 標準運用は Claude と Codex の 2 runtime が入っている前提とし、片方で作業したらもう片方で review する。
- 片方の runtime しか使えない場合は例外扱いとし、`review_evidence` に `intra_runtime_subagent` と理由を記録する。

Do not put secrets, tokens, or machine-local absolute paths in adapter docs.
<!-- UT-TDD:managed:end -->
