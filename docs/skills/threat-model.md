---
schema_version: skill.v1
name: threat-model
skill_type: verification
applies_to:
  layers:
    - L2
    - L3
    - L4
    - L5
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Recovery
---

# threat model

Threat modeling procedure for UT-TDD agent-facing surfaces, applied at L2
(screen/IA design) and L3 (functional design) before implementation begins.
Supports FR-L1-09 (safety design) by surfacing adversarial agent inputs,
privilege escalation paths, and trust boundary violations before they reach L7
code.

## When to load this skill

- A PLAN introduces or modifies an agent-callable surface (tool, hook, subagent
  slot, MCP endpoint).
- An L2 or L3 design doc adds a new trust boundary (runtime -> OS, agent ->
  harness DB, external API -> harness).
- `ut-tdd guardrail` reports an unresolved finding.
- A Recovery PLAN must demonstrate the threat that caused the incident is
  modelled and mitigated.

## Threat surface inventory for UT-TDD

The harness has four primary threat surfaces:

1. **Agent tool invocations.** Any `ut-tdd` command callable from within a
   subagent. Threat: prompt injection causing a destructive command (e.g. a
   crafted task string that resolves to `db rebuild --force`).
2. **Hook entry points.** `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`,
   `SubagentStop` hooks read stdin JSON. Threat: malformed or adversarial JSON
   causing fail-open behaviour instead of fail-close.
3. **Agent allowlist.** The subagent type allowlist in `.claude/settings.json`.
   Threat: an unlisted agent type bypassing the guard without `UT_TDD_ALLOW_RAW_AGENT=1`.
4. **State files.** `.ut-tdd/` YAML/JSON files read by doctor and projection
   writers. Threat: crafted state that makes a broken system report green.

## STRIDE-lite per surface

For each surface in a PLAN, document at L3:

| Threat category | Question to answer |
|-----------------|-------------------|
| Spoofing | Can an agent claim a role or identity it does not have? |
| Tampering | Can an agent write to `.ut-tdd/` state in a way that evades doctor? |
| Repudiation | Is every significant agent action recorded in `.ut-tdd/audit/`? |
| Information disclosure | Does a hook or tool leak credentials, PII, or session tokens? |
| Denial of service | Can a malformed input loop or starve the harness? |
| Elevation of privilege | Can a subagent call a command that requires guard bypass without evidence? |

Unanswered questions are open threats. Document them in the L3 design doc and
link to a mitigation PLAN before pair-freeze.

## Mitigation requirements

- **Agent guard fail-close.** The `agent-guard.ts` hook must exit non-zero for
  any unknown `subagent_type` or missing model field. Fail-open is not acceptable.
- **No credentials in state.** `.ut-tdd/`, `docs/`, audit evidence, and handover
  files must not contain API keys, passwords, or session tokens. Run
  `ut-tdd guardrail` before accepting any PLAN that touches these paths.
- **Audit trail.** Every guard bypass (via `UT_TDD_ALLOW_RAW_AGENT=1`) must
  write an evidence record to `.ut-tdd/audit/`. No bypass without a trace.
- **Input validation.** Hook stdin JSON must be validated against a schema; an
  invalid payload must fail closed, not be silently ignored.

## Threat model record

Write a threat model summary at `docs/design/L3/<plan-id>-threat-model.md`:

```
## Trust boundary: <name>
- Surfaces: <list>
- STRIDE findings:
  - <threat category>: <description> -> <mitigated by X | OPEN>
- Residual risks: <list or "none">
- Reviewed by: <agent-slug or "intra_runtime_subagent">
- Date: <ISO-8601>
```

Link this doc from the PLAN `review_evidence` field before pair-freeze.

## Anti-patterns

- Skipping threat modelling for "internal-only" surfaces — the agent guard
  catches external bypass attempts; internal surfaces are equally exploitable
  via prompt injection.
- Writing threat model output directly into handover files — use
  `docs/design/L3/` so the artifact is versioned and `ut-tdd doctor` can find
  it.
- Treating `ut-tdd guardrail` green as a complete threat model — guardrail
  checks secrets and known patterns; novel attack surfaces must be enumerated
  manually.
