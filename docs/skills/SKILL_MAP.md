---
schema_version: skill.v1
name: SKILL_MAP
skill_type: skill-map
applies_to:
  layers:
    - L1
  drive_models:
    - Forward
---

# SKILL_MAP

Catalog index for `docs/skills/`. This is an index, not a skill body — read an
individual pack only when its trigger is active. Do not load every pack at once;
each costs context.

## How recommendation works

`ut-tdd skill suggest --plan <path>` scores every pack against the plan's `layer`
and drive model (the recommender reads each pack's `applies_to.layers` /
`applies_to.drive_models` frontmatter, not its body). Load only the top-scoring
packs for the current task.

## Discovery protocol (session start / task arrival)

1. `ut-tdd status` — current layer, drive model, active PLAN.
2. `ut-tdd skill suggest --plan <active-plan-path>` — ranked packs.
3. Read the top-scoring pack(s) before starting work.
4. With no PLAN yet (Discovery S0 / cold start), pick from the trigger table.
5. Skip packs that do not match the current layer/drive — they only cost context.

## Trigger table

| Task / signal | Pack |
|---|---|
| Design doc / ADR authoring, freeze readability | documentation-and-adrs |
| Architecture / data / sequence diagrams | design-doc |
| API endpoint design / contract / IA boundary | api, api-contract, api-and-interface-design |
| DB schema / migration / projection | db, data-migration |
| Dependency / impact analysis | dependency-map |
| Sizing, two-stage (W-model) design | system-design-sizing |
| Tech evaluation → ADR | tech-selection, research |
| TDD implementation (Red-first) | test-driven-development, incremental-implementation |
| Test strategy / levels / fixtures | testing, spec-driven-development |
| Code review at trace-freeze / accept | code-review, code-review-and-quality |
| Adversarial / judgement-gate review | adversarial-review, verification |
| Security / threat / hardening | security, threat-model, security-and-hardening |
| Refactor (behaviour-invariant) | refactoring |
| Debugging / error fix / recovery | debugging-and-error-recovery, error-fix |
| Reverse R0–R4 / RGC | reverse-analysis, reverse-r0 … reverse-r4, reverse-rgc |
| PLAN authoring / WBS / schedule steps | planning-and-task-breakdown, gate-planning |
| Program / portfolio view, milestones | project-management |
| Estimation / effort | estimation |
| Discovery / PoC | poc |
| Tech-debt ledger | debt-register |
| Subagent / team design | agent-design, agent-teams |
| Cost-aware delegation | agent-cost-design |
| LLM call / RAG / agent routing in a feature | llm-agent-routing |
| Context injection / budget | context-engineering |
| Handover / session continuity | context-memory, requirements-handover |
| CI gate design / deploy / rollback | ci-gate-design, ci-deploy-and-rollback |
| Telemetry / harness.db observability | harness-observability |
| Incident / runbook | incident-runbook |
| Deprecation / cutover | deprecation-cutover |
| Browser / screen (L10) verification | browser-testing-and-screen-verification |
| Git / Conventional Commits / CI | git |
| Doc maintenance (README / runbook prose) | documentation |

## Domain / project skills (indexed by category + metadata)

Most packs above are **workflow skills**: bound to a V-model layer and/or drive model,
scored by `applies_to.layers` / `applies_to.drive_models`. A second class is indexed by
`category` + metadata instead of layer/drive (skill-index.md §1):

- **domain** — transferable discipline knowledge pulled by situation, not by layer/drive
  (e.g. `technical-writing`: writing/clarity). Tagged `category: domain` + `domain_tags`.
- **project** — case/industry conventions. Tagged `category: project` + `industry`. These are
  **not shipped here**; a consuming project authors them in its own skills root (ADR-005).

Scaffold a new pack with `ut-tdd skill new --name <slug> --category <workflow|domain|project> ...`;
the generator self-lints that the result is indexable-by-something before writing.

| Task / signal | Pack |
|---|---|
| Writing quality / clarity / prose editing (any layer) | technical-writing (domain) |

## Core operating rules (apply to every pack)

- Surface assumptions before non-trivial work; stop on a PLAN↔doc↔code
  inconsistency rather than guessing.
- Verify, do not assume completion: `ut-tdd doctor` exits 0, `ut-tdd review
  --uncommitted` has no blocking findings, tests are green.
- Stay within the active PLAN scope; do not refactor adjacent code as a
  side-effect.
- Record handover/evidence in `.ut-tdd/handover/` or `.ut-tdd/audit/` when a task
  crosses a session or runtime boundary.

Packs not listed here are not registered in the catalog and will not be scored.
Update the individual pack files; the scored registry is maintained by
`ut-tdd skill suggest`.
