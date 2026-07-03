<!-- UT-TDD:managed:start -->
# Claude Runtime Adapter

Claude Code sessions should route harness lifecycle work through `ut-tdd`.
Consumer-owned Claude instructions can be added outside this managed block.

- Session evidence: `ut-tdd status` and `ut-tdd handover`
- Health check: `ut-tdd doctor`
- Review separation: use another runtime/model family when feasible

## Claude subagent defaults

- Always pass an explicit `model` when spawning subagents; it must match the
  agent frontmatter family (opus / sonnet / haiku).
- Opus (`claude-opus-4-8`) = judgement and final review; Sonnet (`claude-sonnet-5`) =
  docs/design/structured review; Haiku (`claude-haiku-4-5`) = scouting and triage.
- Claude-family reasoning effort defaults to `high`; use `xhigh` only for
  high-judgement review or UI/UX work.
- Give the full task specification up front; report findings with file and
  command evidence before summaries.

<!-- UT-TDD:managed:end -->
