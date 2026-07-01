<!-- UT-TDD:managed:start -->
# UT-TDD Agent Harness Adapter

This project uses UT-TDD Agent Harness commands as the local orchestration surface.

- GitHub 配布先: `https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack`
- Status: `ut-tdd status`
- Doctor: `ut-tdd doctor`
- Handover: `ut-tdd handover`
- Codex delegation: `ut-tdd codex --role <role> --task "..."`
- Claude delegation: `ut-tdd claude --role <role> --task "..."`
- Team run: `ut-tdd team run --definition .ut-tdd/teams/<team>.yaml`

クロスレビュー原則:

- 設計判断、実装完了、release/UAT 判定は、作業者と reviewer を分ける。
- 標準運用は Claude と Codex の 2 runtime が入っている前提とし、片方で作業したらもう片方で review する。
- 片方の runtime しか使えない場合は例外扱いとし、`review_evidence` に `intra_runtime_subagent` と理由を記録する。

Project-owned instructions outside this managed block remain consumer-owned.
<!-- UT-TDD:managed:end -->
