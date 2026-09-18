---
schema_version: skill.v1
name: api-contract
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
  drive_models:
    - Forward
    - Reverse
    - Add-feature
    - Retrofit
decision_points:
  - when: "a Reverse R1 pass finds a field with existing consumers but no contract entry"
    choose: "treat it as a blocking finding in ut-tdd review --uncommitted"
    over: "leaving the undocumented-but-used field out of the extracted L4 contract doc"
    because: "a field with consumers but no contract entry is an explicit blocking condition, since it marks undocumented deletion risk"
  - when: "a contract's compatibility class is stable and a field needs removal or renaming"
    choose: "record a deprecation period with a sunset date in the L4 doc before removing it"
    over: "removing or renaming the field immediately once the replacement is ready"
    because: "stable contracts require a deprecation period — this is the compatibility-class guarantee callers depend on"
  - when: "a breaking change must be made to a stable contract"
    choose: "bump the version in the PLAN's generates list and update every consumer reference before pair-freeze"
    over: "shipping the breaking change and updating consumers in a follow-up PLAN"
    because: "breaking changes to a stable contract must have all consumers updated in the same PLAN, not deferred"
  - when: "choosing a compatibility class for a new contract (stable/beta/internal)"
    choose: "pick the class based on the actual change-without-notice policy the provider commits to"
    over: "defaulting every new contract to stable regardless of consumer guarantees"
    because: "each class carries a different change-without-notice policy, and stable is the most restrictive — over-declaring it creates false obligations"
  - when: "extracting a contract from existing code in Reverse R1"
    choose: "enumerate every exported field/status code from source, then grep consumer call sites for actual field access before writing the doc"
    over: "writing the contract doc from the provider's intended/documented shape alone"
    because: "the extraction order (source enumeration, then consumer grep, then doc) is required to annotate deletion risk accurately"
---

# api contract

Contract definition between an API provider and its consumers: schema ownership,
compatibility guarantees, consumer-driven contract obligations, and how they are
enforced in UT-TDD gates. Distinct from endpoint design (see `api.md`) — this
skill governs the *binding agreement*, not the shape of individual routes.

## When to load this skill

- A PLAN changes a shared API surface consumed by more than one module or agent.
- A Reverse R1 pass must formalise an implicit contract into a machine-checkable
  schema.
- A Retrofit PLAN must assess backward-compatibility risk before modifying an
  existing contract.
- An L5 detailed-design doc defines serialisation, auth, or error-code guarantees
  that downstream callers depend on.

## Contract definition obligations by layer

**L3 (functional):** identify provider and consumer roles; state the invariant
that must hold across versions ("consumer must never receive a null `id` field").

**L4 (basic):** produce a contract document at
`docs/design/<product>/L4-basic/<resource>-contract.md` containing:
- Provider: module path and version.
- Consumer list: every known caller and their assumed schema version.
- Schema: field names, types, required/optional, enum values.
- Error contract: status codes and when each fires.
- Compatibility class: `stable`, `beta`, or `internal` — with different
  change-without-notice policies per class.

**L5 (detailed):** add serialisation format (JSON, MessagePack, etc.),
auth-token shape, and idempotency guarantees.

## Reverse R1: extracting a contract from existing code

1. Read the provider source and enumerate every exported field and status code.
2. Grep consumer call sites for assumed field access (`ut-tdd find` or `grep`).
3. Write the L4 contract doc from step 1; annotate each field with the consumer
   count from step 2 to mark deletion risk.
4. Run `ut-tdd review --uncommitted` — any field with consumers but no contract
   entry is a blocking finding.

## Compatibility gate rules

- **Stable contracts** require a deprecation period (record sunset date in the L4
  doc) before removing or renaming fields.
- **Breaking changes** to a stable contract must bump the version in the PLAN
  `generates` list and update every consumer reference before pair-freeze.
- `ut-tdd doctor` must exit 0 after contract changes — governance checks that
  artifact_registry entries for the old and new contract versions are consistent.

## Pair-freeze checklist for a contract PLAN

- [ ] L4 contract doc exists with provider, consumer list, schema, error codes,
      and compatibility class.
- [ ] All known consumers are listed; breaking changes are confirmed non-breaking
      or consumers are updated in the same PLAN.
- [ ] `ut-tdd plan lint` exits 0 (`generates` references the contract doc).
- [ ] `ut-tdd doctor` exits 0.
- [ ] L6 unit-test design covers at least one invalid-input and one
      schema-mismatch error path.
