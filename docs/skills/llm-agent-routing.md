---
schema_version: skill.v1
name: llm-agent-routing
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Discovery
---

# llm agent routing

Design and implementation guidance for LLM calls, agent delegation, RAG, and
context injection inside UT-TDD-built features. Apply when a PLAN adds or
modifies an AI model call, an agent slot, or a context-injection path (FR-L1-09
agent guard, FR-L1-12 injection, FR-L1-38 model evaluation).

## When to load this skill

- A PLAN at L4–L7 adds an LLM call, an agent delegation, or a skill/context
  injection path.
- The feature routes work across multiple agents or model tiers.

## Routing through the harness, not around it

UT-TDD externalises provider calls into `ut-tdd claude --role <role>`,
`ut-tdd codex --role <role>`, and `ut-tdd team run --definition
.ut-tdd/teams/<team>.yaml`. Before adding a raw provider call to source:

1. If the call is an agent delegation declared in the PLAN `agent_slots`, route
   it through the wrappers so session lifecycle, handover warnings, and cost
   telemetry are captured.
2. The `PreToolUse(Agent)` guard (`.claude/hooks/agent-guard.ts`) blocks an
   agent call whose `subagent_type` is not allowlisted, or whose model does not
   match the agent frontmatter family — never hard-code a mismatched model.
3. Apply low-cost-first: use the lightest viable model for mechanical subtasks;
   reserve the frontier model for judgement gates and design decisions (see the
   `agent-cost-design` skill). Model choice and outcome are recorded in
   `model_runs` (`ut-tdd telemetry`).

## Context injection checklist (L4–L5 design gate)

Before pair-freeze, the design doc answers:

- [ ] What context is injected per call (skill pack paths, `.ut-tdd/` state,
      specific design docs)?
- [ ] Token budget per call and the overflow strategy (truncate / chunk).
- [ ] If retrieval is used: the retrieval unit and the relevance threshold below
      which chunks are dropped (do not silently pass empty context).
- [ ] No PII, credentials, or payload bodies in the injected context — all three
      are prohibited by the harness safety boundary; redact before injection.

## RAG / output-contract pattern (locked at L5)

Lock the chunking boundary, the similarity threshold, the no-match fallback
(never silently pass empty context), and a typed output schema (not free-form
prose) so L6 unit tests can assert against the contract.

## L7 implementation gates

- `bun run typecheck` clean — no `any` on model-call paths.
- Unit tests cover: normal response, API error / timeout, and context-overflow
  truncation.
- After implementation, `ut-tdd review --uncommitted`; capture the `model_runs`
  telemetry as review evidence.

## Failure modes to design against

| Failure | Guard |
|---|---|
| Silent empty context to the model | Throw before the call; unit-test the path |
| Cost spike from mis-routing | Log model + tokens to `model_runs`; cap in the slot |
| Agent slot model mismatch | `agent-guard.ts` blocks at PreToolUse |
| Credential in injected context | Redact before injection; assert absent in a test |
