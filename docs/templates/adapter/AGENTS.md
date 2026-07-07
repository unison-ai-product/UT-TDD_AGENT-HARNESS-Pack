<!-- UT-TDD:managed:start -->
# UT-TDD Agent Harness Adapter

This project uses UT-TDD Agent Harness commands as the local orchestration surface.

- Status: `ut-tdd status`
- Setup doctor: `ut-tdd doctor --profile consumer-setup-smoke`
- Toolchain doctor: `ut-tdd doctor --profile consumer-toolchain`
- Full doctor: `ut-tdd doctor` (source/governance repositories only)
- Handover: `ut-tdd handover`
- Codex delegation: `ut-tdd codex --role <role> --task "..."`
- Claude delegation: `ut-tdd claude --role <role> --task "..."`
- Team run: `ut-tdd team run --definition .ut-tdd/teams/<team>.yaml`

## GPT / Codex runtime defaults

- Implementation lanes default to worker-class models (`gpt-5.4`); lightweight parallel lanes use spark-class (`gpt-5.3-codex-spark`) with no closing authority.
- Frontier judgement (`gpt-5.5`) is gated: use it only for final review or high-risk decisions with explicit authorization.
- Default reasoning effort is `middle`; raise to `high`/`xhigh` only for review or critical judgement.
- State the full task, intent, and constraints up front in one turn; avoid drip-fed instructions.

## Discipline

- Separate creation from judgement: review with a different runtime/model family than the author when feasible.
- No completion claim without tests or explicit verification evidence.
- Stage explicit files only; never rewrite or discard another runtime's commits.

Project-owned instructions outside this managed block remain consumer-owned.
<!-- UT-TDD:managed:end -->
