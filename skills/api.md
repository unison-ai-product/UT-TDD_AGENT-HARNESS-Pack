---
schema_version: skill.v1
name: api
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
    - L7
    - L8
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
decision_points:
  - when: "an API change removes a field, changes a type, or changes a status code"
    choose: "treat it as breaking and mint a new version"
    over: "shipping it as a patch to the existing version"
    because: "field removal, type change, and status-code change are explicitly classified as breaking changes"
  - when: "an API change adds an optional field or a new endpoint"
    choose: "treat it as non-breaking and keep the existing version"
    over: "bumping the version out of caution"
    because: "additive changes (optional field, new endpoint) are explicitly classified as non-breaking"
  - when: "the L7 implementation needs to diverge from what the L4 doc specifies"
    choose: "update the L4 doc and go through a new pair-freeze before merging"
    over: "implementing the deviation and updating the L4 doc afterward"
    because: "code must match the L4 contract exactly — any deviation requires the doc update and pair-freeze first, not as cleanup"
  - when: "recording a versioning decision for an API surface"
    choose: "write it explicitly under an ## API Versioning heading in the L4 doc"
    over: "leaving the versioning rationale implicit in code comments"
    because: "the versioning decision must not be left implicit in code comments — it is a documented design decision"
  - when: "deprecating an API version"
    choose: "add a sunset date to the L4 doc and a Deprecation response header"
    over: "removing the version once a replacement ships without a transition signal"
    because: "deprecated versions must carry both a documented sunset date and a runtime Deprecation header — doc-only is insufficient"
  - when: "extracting an existing API in a Reverse pass"
    choose: "produce the L4 contract doc from code inspection first, then write tests against it"
    over: "writing tests directly against observed behaviour without an intermediate L4 doc"
    because: "the R1 output (contract doc) becomes the SSoT for subsequent Forward/Add-feature work — skipping it leaves no SSoT"
---

# api

REST/RPC endpoint design, versioning strategy, and the UT-TDD V-model obligations
that accompany a new or changed API surface. Apply when a PLAN introduces,
modifies, or removes an API endpoint.

## When to load this skill

- Authoring an L4 basic-design doc that defines a new REST or RPC surface.
- A PLAN with `kind=add-impl` or `kind=add-design` touches `src/` routes or CLI
  command dispatch.
- A Reverse R1 pass must extract the existing HTTP surface into a contract doc.
- An L8 integration-test design must specify the API contract under test.

## V-model obligations for an API surface

**L3 (functional design):** name each endpoint; state its trigger, actor, and
observable outcome. No implementation detail — only "what the caller sees."

**L4 (basic design):** specify method, path, request shape, response shape,
error codes, and versioning strategy. Write the L4 doc under
`docs/design/<product>/L4-basic/`. Pair this with an L8 integration-test design
doc under `docs/test-design/` before pair-freeze.

**L5 (detailed design):** serialisation format, auth scheme, rate-limit policy,
pagination model. Pair with L6 unit-test design (error-path coverage,
boundary values).

**L7 (implementation):** code must match the L4 contract exactly. Any deviation
requires an L4 doc update and a new pair-freeze before merging.

## Versioning rules

- Prefix all public routes with `/v<N>/` at the path level.
- Breaking changes (field removal, type change, status-code change) require a
  new version; additive changes (optional field, new endpoint) are non-breaking.
- Record the versioning decision in the L4 doc under an `## API Versioning`
  heading; do not leave it implicit in code comments.
- Deprecated versions must carry a sunset date in the L4 doc and a response
  header (`Deprecation: <date>`).

## Pair-freeze checklist for an API PLAN

- [ ] L4 doc exists at `docs/design/.../L4-basic/` with method, path, shapes,
      errors, and versioning section.
- [ ] L8 integration-test design doc exists at `docs/test-design/` and references
      the L4 doc by path.
- [ ] `ut-tdd plan lint` exits 0 (PLAN `generates` lists both L4 and L8 docs).
- [ ] `ut-tdd doctor` exits 0.
- [ ] No endpoint name conflicts with existing routes (`ut-tdd graph export
      --format mermaid` for a dependency view if wiring crosses modules).
- [ ] L0 glossary updated with any new resource or domain term.

## Reverse pass (extracting an existing API)

When Reverse drive starts from existing `src/` code, produce the L4 contract doc
from code inspection before writing tests. Use `ut-tdd review --uncommitted` to
confirm the extracted doc covers every handler path. The R1 output (contract doc)
becomes the SSoT for any subsequent Forward or Add-feature work on that surface.
