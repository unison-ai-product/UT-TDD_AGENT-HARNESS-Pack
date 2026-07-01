<!-- UT-TDD:managed:start -->
# UT-TDD Agent Harness Shared Context

Use repository-local UT-TDD commands for harness state and delegation.

- `ut-tdd status` reports the local runtime mode.
- `ut-tdd doctor` runs repository health checks.
- `ut-tdd handover` reads and writes cross-runtime handover state.
- `ut-tdd codex --role <role> --task "..."` delegates to Codex.
- `ut-tdd claude --role <role> --task "..."` delegates to Claude.

Do not put secrets, tokens, or machine-local absolute paths in adapter docs.
<!-- UT-TDD:managed:end -->

