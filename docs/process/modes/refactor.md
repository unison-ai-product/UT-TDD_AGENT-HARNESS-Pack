---
canonical: true
process_doc: mode
mode: Refactor
kind: refactor
layer: L7
status: confirmed
updated: 2026-06-23
---

# Refactor Mode

Refactor mode is the behaviour-invariant brush-up workflow for existing code.
It removes structural debt without adding functional scope, changing public
contracts, or changing persisted state semantics.

Sources of truth:

- concept v3.1 section 2.5 and 2.6
- requirements v1.2 section 1.3, 1.6, 1.8, 6.8.9
- FR-L1-25
- `docs/skills/refactoring.md`
- `src/workflow/contracts.ts#assertRefactorInvariant`

## 1. Entry Contract

| Field | Value |
| --- | --- |
| kind | `refactor` |
| drive | `be` / `fe` / `fullstack` / `db` / `agent` |
| layer | `L7` |
| workflow_phase | forbidden |
| owner roles | `se` + `tl` |
| branch prefix | `refactor/*` |
| signals | `debt_degradation` / `code_smell` / `structural` |

Refactor is not a feature path. If the work adds a new observable function,
changes a public CLI/API contract, changes `.ut-tdd/` state schema, changes
`harness.db` schema, or changes expected user behaviour, stop Refactor and route
to Add-feature, Retrofit, Troubleshoot, or Incident.

## 2. TDD Brush-up Loop

Refactor uses a TDD-like loop, but its Red is a structural smell or dependency
risk, not a new functional requirement.

| State | Meaning | Required evidence |
| --- | --- | --- |
| Red | The target has unresolved structural debt, missing dependency check, failed regression, or behavior drift. | finding, graph impact row, failed test, or open feedback event |
| Yellow | Refactor target is registered and protected by an identified regression fence, but the brush-up step is not complete. | PLAN plus changed artifact list and intended test IDs |
| Green | Behaviour is unchanged and every changed artifact is covered by linked regression test IDs. | green command evidence, `test_ids`, relation impact closed, review after tests |

The cycle is:

1. Register target: name the code smell, affected files, observable boundary,
   and expected dependency impact.
2. Establish regression fence: run or add characterization coverage before the
   structural change. The green state must name the test IDs.
3. Make one structural change: rename, extract, split, deduplicate, or remove
   dead code in a small step.
4. Verify: run targeted tests, typecheck/lint when relevant, and `ut-tdd doctor`.
5. Review after green: qualitative review only happens after quantitative green
   command evidence exists.
6. Repeat or close: repeat from step 3 until the registered debt is closed.

## 3. Database-triggered Refactor

Refactor can be fired from `harness.db`; it does not need to rely on a human
remembering that cleanup is due.

Allowed trigger sources:

- `findings`: structural lint, dead code, naming drift, dependency direction
  violation, or stale generated artifact.
- `quality_signals`: repeated warning/failure on the same artifact or oracle.
- `feedback_events`: unresolved improvement/debt signal selected during
  handover or takeover.
- `graph_nodes` / `dependency_edges` / `impact_results`: relation-graph impact
  showing missing sibling tests, missing design contract review, or stale
  upstream/downstream dependency.
- `artifact_progress`: red/yellow artifacts whose reason is structural debt,
  missing dependency check, or missing linked test ID.

The database is a projection, not an authoring source. A DB trigger creates a
Refactor candidate or PLAN input; the PLAN document and source artifacts remain
the canonical authored state.

Detector-driven candidates must be triaged before they are treated as Refactor
Red/Yellow work:

- Review a representative candidate sample and record obvious false-positive
  classes before closing the detector or acting on the queue.
- Keep lower-confidence candidates in `quality_signals` for audit visibility;
  do not automatically promote them to `feedback_events`.
- Promote only high-confidence, ranked candidates to open feedback, and cap the
  promoted set so handover is actionable.
- When a real brush-up is executed from a detector hit, review whether the hit
  selected a useful boundary and update the detector/process if the actual
  refactor exposes a better precision rule.

`refactor-scout` is the advisory subagent for this triage. It may inspect code,
classify candidates, propose PLAN inputs, and name verification fences, but it
must not implement changes. Implementation remains with SE/TL Refactor work.

`externalize-policy` is a first-class Refactor candidate when stage/phase,
route, approval, model tier, profile, skill, subagent, or injection rules are
embedded as code branches instead of a catalog, config file, or dedicated policy
module. Stage-based subagent or skill injection rules are included in this
category.

## 4. Dependency and Impact Rule

Before Green, changed files must be checked through the relation graph when the
projection is available.

Required impact closure:

- Source change has sibling test or explicit characterization-test evidence.
- Source change reviews the L6 behavioural contract when a
  `behavioral-contract` edge exists.
- Design/test-design changes update the paired artifact or record a no-change
  reason.
- DB table or projection changes are not Refactor unless state semantics remain
  unchanged; otherwise route to Retrofit or Add-feature.
- Any relation-graph finding that blocks behavior confidence keeps the target
  Red.

## 5. Exit Conditions

A Refactor PLAN can be closed only when all of these hold:

- `assertRefactorInvariant` passes with unchanged before/after behaviour.
- Regression evidence has at least one linked `test_id`.
- Required green commands have `exit_code=0` and evidence paths.
- Relation impact has no open action that affects the changed files.
- Review evidence is recorded after the green commands.
- No new functional scope, public contract, or persistence schema was added.
- If module structure changed, L5/L6 design docs are updated or a concrete
  no-backprop decision is recorded.

## 6. Mode Switching

| Observed change | Route |
| --- | --- |
| New behavior or new public surface | Add-feature |
| Broken existing behavior during brush-up | Troubleshoot or Recovery |
| Dependency/runtime upgrade | Retrofit |
| Production regression | Incident |
| Contract or requirements drift discovered | Reverse |

Refactor is complete only when it returns to Forward/G7 with behavior invariant
and test-ID-linked green evidence.
