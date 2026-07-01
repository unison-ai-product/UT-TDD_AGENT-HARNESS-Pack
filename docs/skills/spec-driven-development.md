---
schema_version: skill.v1
name: spec-driven-development
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L3
    - L5
    - L6
    - L8
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
---

# spec driven development

Specification-driven development: the design document at each V-model layer is
the contract that test design (at the paired layer) is written against. This
skill enforces FR-L1-50 (strict TDD/DDD: spec exists and is readable before
tests; tests exist and are Green before implementation merges) and the GWT
integration test discipline at L8.

## When to load this skill

- Authoring a new L5 detailed design or L6 unit-test design doc before
  implementation starts.
- A PLAN is at pair-freeze and the design doc does not yet exist or is not
  readable.
- Discovery or Scrum S2 PoC needs a lightweight spec that a test can be
  written against before coding begins.
- An L8 integration test scenario is being designed and the L5 spec needs a
  GWT section.

## Spec-first contract: layers and pairing

Every implementation unit must trace to a spec at L5 (detailed design) or
above, and to a test design at L6 (unit) or L8 (integration):

```
L3 functional spec  <-->  L9 system-test design
L5 detailed design  <-->  L6 unit-test design
L5 detailed design  <-->  L8 integration-test design (GWT)
L6 unit-test design --> L7 implementation (tests must be Red-first)
```

A PLAN cannot cross pair-freeze until the paired design doc and test design
doc both exist and pass the readability check (Objective, Scope, no mojibake).
`ut-tdd plan lint` will reject a PLAN whose `requires` points to a non-existent
design doc.

## Authoring a usable spec (L5)

A spec is usable when a test author can derive assertions from it without
asking a clarifying question. Required sections:

1. **Objective** — one sentence stating the feature's purpose.
2. **Inputs / Preconditions** — typed names of all inputs, including edge cases.
3. **Outputs / Postconditions** — exact shapes (TypeScript types or JSON schema)
   of all outputs and side effects (files written, DB rows, exit codes).
4. **Error conditions** — what the function does on each invalid input.
5. **Out of scope** — what this spec intentionally does not decide.

Avoid prose descriptions of behaviour that could be interpreted two ways. If
a word is ambiguous, add it to the L0 glossary (`docs/design/L0-glossary.md`).

## GWT integration tests at L8

Given-When-Then format for L8 integration scenarios:

- **Given**: the state of `.ut-tdd/`, `harness.db`, and input fixtures.
- **When**: the `ut-tdd` command or function under test is invoked with
  specified arguments.
- **Then**: the exact output artefacts, exit code, DB state, or file changes
  that must be present.

Each GWT block must be traceable to a line in the L5 spec's
Outputs/Postconditions section. A GWT block with no L5 line reference is a
design gap, not a test.

## Spec-freeze checklist (before pair-freeze)

- [ ] L5 spec exists at `docs/design/L5-<module>.md` with all five sections.
- [ ] L6 unit-test design exists at `docs/test-design/L6-<module>.md` with at
  least one test case per L5 output/error condition.
- [ ] L8 integration-test design exists (if this PLAN touches inter-module
  boundaries) with GWT blocks referencing L5 postconditions.
- [ ] `ut-tdd plan lint` exits 0 (PLAN `requires` links resolve).
- [ ] `ut-tdd doctor` exits 0 (no orphaned design doc, no broken pair).
- [ ] No new terms used in the spec without a glossary entry.

## Discovery / Scrum lightweight path

For Discovery (S2 PoC) or Scrum spikes, a minimal spec is still required:

- A single **Objective** sentence.
- A **Spike question** — the binary decision the PoC must answer.
- A **Done condition** — the observable evidence that the question is answered.

Write the done condition as a failing assertion in a scratch test file before
writing any PoC code. Delete or promote the scratch test at S4 decide.

## Anti-patterns

- Writing a spec after the implementation to retroactively justify what was
  built — this defeats the design signal purpose of spec-first.
- A spec section labelled "TBD" at pair-freeze — this is an unresolved
  dependency and must be treated as a PLAN blocker.
- Using `ut-tdd doctor` green as evidence that the spec is complete — doctor
  checks structural governance (link existence, schema), not spec substance.
