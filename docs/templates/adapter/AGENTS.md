<!-- UT-TDD:managed:start -->
# UT-TDD Agent Harness Adapter

This project uses UT-TDD Agent Harness commands as the local orchestration surface.

- Status: `ut-tdd status`
- Setup doctor: `ut-tdd doctor --profile consumer-setup-smoke` (troubleshooting: https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/blob/main/docs/reference/setup-guide.md)
- Toolchain doctor: `ut-tdd doctor --profile consumer-toolchain`
- Full doctor: `ut-tdd doctor` (source/governance repositories only)
- Handover: `ut-tdd handover`
- Codex delegation: `ut-tdd codex --role <role> --task "..."`
- Claude delegation: `ut-tdd claude --role <role> --task "..."`
- Team run: `ut-tdd team run --definition .ut-tdd/teams/<team>.yaml`
- Claude lane に宛てた共有 memory (返事・review 依頼・引き継ぎ) を書くときは、`node .ut-tdd/bin/ut-tdd.mjs memory add --notify-claude ...` を使う。動いている Claude セッションの受信箱へ知らせが届く。Claude lane に宛てない memory には付けない。

## GPT / Codex runtime defaults

- Implementation lanes default to worker-class models (`gpt-6-luna`); lightweight parallel lanes use spark-class (`gpt-6-luna`) with no closing authority.
- Frontier judgement (`gpt-6.1-sol`) is gated: use it only for final review or high-risk decisions with explicit authorization.
- Codex worker reasoning effort defaults to `high`; frontier effort follows its model ladder, and `xhigh` is reserved for review or critical judgement.
- State the full task, intent, and constraints up front in one turn; avoid drip-fed instructions.

## Discipline

- Separate creation from judgement: review with a different runtime/model family than the author when feasible.
- No completion claim without tests or explicit verification evidence.
- Stage explicit files only; never rewrite or discard another runtime's commits.

Project-owned instructions outside this managed block remain consumer-owned.
<!-- UT-TDD:managed:end -->
