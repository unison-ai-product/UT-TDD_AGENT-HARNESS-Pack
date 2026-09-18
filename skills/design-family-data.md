---
schema_version: skill.v1
name: design-family-data
skill_type: design-contract
applies_to:
  layers:
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
    - Refactor
decision_points:
  - when: "A product is at PoC/early-validation scale and a full data design-document family is proposed before any user-facing schema is stable."
    choose: "write only the DB design doc (tables/keys/indexes) and the data dictionary, deferring the persistence-mapping doc, JSON/schema-contract doc, I/O design doc, and code-list catalog"
    over: "producing the full six-document family before the schema has settled"
    because: "at PoC scale the schema itself is the unknown being tested; a persistence-mapping doc, a versioned wire-contract doc, and a code-list catalog all assume a stable shape to map against, so writing them early is process cost spent documenting something about to change, not a missing safety property yet."
  - when: "The product is multi-tenant SaaS handling billing or regulated personal data (the target profile TeamFlow represents: RLS-based tenant isolation, subscription billing, SSO)."
    choose: "keep the full family, and specifically do not drop the DB design doc's RLS/constraint chapter or the data dictionary's tenant-scoping row even under time pressure"
    over: "trimming the family down to just an ER diagram and calling the DB design doc complete"
    because: "tenant_id-based RLS is the isolation boundary the rest of the design assumes (application-layer enforcement is stated as a second, non-primary layer of defense); omitting the RLS/constraint chapter removes the one place that boundary is specified for review, not just an optional detail."
  - when: "A field's type, precision, or constraint appears to differ between the DB design doc and the data dictionary."
    choose: "treat the data dictionary as the single authoritative definition and fix the DB design doc's column table to match it, then re-run the doc consistency check"
    over: "editing whichever doc a reviewer happened to be reading, or maintaining both as independently 'correct'"
    because: "the DB design doc itself declares that physical columns are owned by the detailed table definition and the dictionary, not restated authoritatively in the DB design doc's own dictionary chapter — the dictionary chapter in the DB doc is explicitly a pointer, not a second source."
  - when: "A new field must cross a wire boundary (API request/response, event payload) and also needs a TypeScript type, a Python type, and a DB column."
    choose: "define the field once in the canonical schema (OpenAPI/JSON Schema) and derive the TS type, Python type, and DB column type from the type-rosetta mapping"
    over: "hand-writing the TS interface, the Python model, and the DB column definition independently and trusting them to stay in sync"
    because: "the JSON/schema design doc's entire structure is a single-source-of-truth rosetta table precisely because independently authored representations drift; the doc's own gate gives each boundary (wire, app, DB) a distinct validation mechanism specifically so a canonical source can be checked against each derived form."
  - when: "A domain invariant (e.g. an amount must be non-negative, an email must be unique per tenant) is already enforced by a value-object constructor at the application layer."
    choose: "also encode the invariant as a DB constraint (CHECK, UNIQUE, NOT NULL) in the persistence-mapping doc's invariant-to-constraint table"
    over: "relying on the value-object validation alone and treating the DB as a dumb store"
    because: "the persistence-mapping doc's own policy is to double-encode invariants at the DB layer without leaking ORM concerns into the domain; a value object only protects writes made through that code path, not rows touched by migrations, admin tooling, or a future second write path."
  - when: "A domain invariant is cross-aggregate or cross-cutting (e.g. a seat-count ceiling that spans multiple rows) and cannot be expressed as a single-table DB constraint."
    choose: "explicitly name the invariant in the persistence-mapping doc's constraint table with its enforcement point marked as application-side/cross-cutting, rather than leaving it out of the table"
    over: "omitting the invariant from the constraint table because it doesn't map to a CHECK/UNIQUE/FK"
    because: "an invariant that is silently absent from the table looks unenforced-and-unnoticed; an invariant that is present with 'enforcement: application-side' is unenforced-and-tracked, which is the difference between a known gap and a blind spot discovered during an incident."
  - when: "Loading a domain object back from the database versus constructing one from external/untrusted input."
    choose: "use a reconstruct() path that trusts DB-sourced data and skips redundant full validation, reserving the create() path's full validation for untrusted input"
    over: "running full value-object validation on every DB row load, identical to validation on untrusted input"
    because: "the persistence-mapping doc draws this exact boundary (create = untrusted, fully validated; reconstruct = trusted restore from DB) specifically so ORM mapping code isn't forced to either violate the value object's constructor contract or pay full validation cost on every read."
  - when: "A new enum-like value (a status, a role, a plan tier) needs to be recognized by the DB CHECK constraint, an API validator, and a screen dropdown."
    choose: "add it once to the code-list/definition catalog under a stable code ID and have the DB constraint, API validation, and screen reference that ID"
    over: "adding the new value inline and separately in the DB migration, the API validation logic, and the screen's option list"
    because: "the code-list catalog exists so DB, API, and screen consume one enumerated source; inlining the value three times means the three places can silently diverge (e.g. a status accepted by the API but not present in the DB CHECK constraint) with no single place to check them against."
---

# design family: data

The set of design documents that together specify how data is shaped, stored,
validated, and named across a product. Six documents form this family, each
owning a distinct concern; none of them substitutes for another. Load this
skill when authoring or reviewing any of them, or when a PLAN's schema/contract
change touches more than one.

## When to load this skill

- An L4/L5 PLAN adds, changes, or removes a persisted table, a wire-boundary
  schema, or a domain-to-column mapping.
- A design review needs to check whether a field is defined in exactly one
  authoritative place.
- A Reverse pass must extract an undocumented schema, contract, or dictionary
  entry from existing code into this document family.
- Deciding how much of the family a PLAN actually needs (see decision points
  above) before writing any of it.

## The six documents and what each must contain

### 1. Database design document
**Role:** the physical/logical shape of persisted state — entities, keys,
relationships, indexing, partitioning, RLS/constraint policy, and
performance/backup posture.

**Must contain:**
- Logical design: every entity with its primary key, its relationships to
  other entities, and its top-level constraints (uniqueness, required fields,
  enum membership) — stated per entity, not left implicit in an ER diagram
  alone.
- Physical design: the actual index list per table, each index's type
  (composite/unique) and its purpose (which query pattern it serves).
- Partition/scale posture: whether and how large tables are partitioned or
  sharded, even if the answer at current scale is "not yet, revisit at X."
- Constraints and row-level isolation: PK/FK/UNIQUE/CHECK enumerated, plus the
  row-level isolation policy (e.g. RLS keyed on a tenant column) and whether
  it is the sole enforcement layer or doubled at the application layer.
- Migration notes: an explicit, ordered record of schema change history with
  reversibility notes — not merely a backup/recovery posture. Backup/PITR
  covers data loss; migration notes cover schema-evolution traceability, and
  the two are not substitutes for each other.

**Characteristic omission that later breaks things:** treating backup/PITR
policy as if it satisfies "migration is documented." A DB design doc can fully
describe indexes, RLS, and disaster recovery while never keeping a running
record of *schema* changes (added/dropped columns, constraint changes) and
their rollback path. When the next schema change arrives, there is no
documented DDL history to diff against or reverse out of — only a backup to
restore from, which is the wrong tool for "undo this one migration."

### 2. JSON type / schema design document (typed contract shapes)
**Role:** the canonical, versioned shape of every value that crosses a
boundary (wire payload, generated application type, stored column), plus the
mapping between how that shape is expressed in each representation.

**Must contain:**
- A declared single source of truth (canonical schema: OpenAPI / event schema
  / a designated doc.schema) that all other representations are generated or
  checked against, not authored independently.
- A per-boundary validation-gate table: what validates the shape on receipt
  (wire — JSON Schema/runtime validator), on construction (application —
  fully-validated constructor/value object), and at rest (DB — column
  constraints). Each boundary gets its own enforcement mechanism.
- A type-rosetta table mapping each logical type (constrained string, non-
  negative integer, money, enum, ID) to its JSON Schema shape, its
  TypeScript type, its backend-language type, and its DB column type —
  side by side, so a reviewer can see all four representations of one
  logical type at once.
- Versioning: how a breaking change to the canonical schema is declared and
  propagated to consumers (this is the join point with `api-contract.md`,
  see Boundaries below).
- A trace table linking the schema to the domain value-object policy it
  double-checks and to the API contract(s) it governs.

**Characteristic omission that later breaks things:** rosetta-table coverage
that stops at "the common cases" (string, integer, enum, ID) without covering
every type that actually appears on the wire — precision-bearing money types,
timezone-aware timestamps, or nested object shapes are frequently left for
"later" by omission rather than by decision. Because the doc's whole premise
is single-source-derivation, a type left out of the rosetta table has no
canonical mapping at all — each layer ends up inventing its own
representation for exactly the type that most needs one.

### 3. Persistence mapping design document (domain object ↔ table mapping)
**Role:** the bridge between domain value objects/invariants and their
storage representation, kept separate from the domain model itself so ORM
concerns never leak into domain code.

**Must contain:**
- A value-object-to-column table: every value object mapped to its storage
  column(s), including composite value objects mapped to multiple columns.
- An invariant-to-DB-constraint table: every domain invariant paired with the
  DB mechanism that re-checks it (or explicitly marked as application-side/
  cross-cutting when no single-table DB mechanism applies — see decision
  points above). This is where invariants get re-checked, distinct from where
  they are first enforced in the domain layer.
- The create-vs-reconstruct boundary: which path performs full validation
  (untrusted input) and which path trusts and restores from already-validated
  DB state, plus how ORM constructor requirements (no-arg constructors,
  mutable setters) are absorbed by a mapper rather than imposed on the domain
  object.
- Aggregate boundaries: repositories are defined per aggregate, not per table,
  so a persistence operation matches the domain's actual consistency boundary.
- Language/ORM-fit guidance: which ORM style suits the mapping approach chosen
  (query-builder style for explicit VO/column control vs. active-record style,
  which tends to fight a fully-validated-constructor domain model).

**Characteristic omission that later breaks things:** listing a cross-cutting
invariant (one that spans aggregates or tables) in prose but leaving it out of
the invariant-to-constraint table entirely, rather than including it with an
explicit "application-side" enforcement marker. An invariant absent from the
table cannot be told apart from an invariant nobody thought of — both look
like silence. Marking it present-but-application-enforced is what keeps it a
tracked, reviewable gap instead of a blind spot found during an incident.

### 4. Data dictionary / glossary (single authoritative field source)
**Role:** the single source of truth for what a term or field *means*,
distinct from where it is physically stored (that's the DB design doc) or
what code values it takes (that's the code-list catalog). Every other design
document should reference the dictionary's definition, never restate or
redefine it.

**Must contain:**
- Business/domain terminology: each term with its definition and its
  canonical machine-usable key (i18n key or identifier), kept in sync with
  the domain model's ubiquitous language.
- Abbreviation and notation rules: approved expansions and explicitly
  prohibited alternate spellings/synonyms (a "detect drift" list, not just an
  approved list) — so a linting pass has something concrete to flag.
- The data-item dictionary itself: logical name, physical name, type/size, and
  code-list reference for every field that appears in more than one design
  document (DB, API, screen). This chapter's coverage should track the
  system's actual field count, not a representative sample.
- A traceability statement: terms flow from requirements through design, test
  scenarios, and code identifiers consistently, and review is expected to
  catch spelling/naming drift against this dictionary.

**Characteristic omission that later breaks things:** letting the data-item
dictionary chapter stay a small illustrative subset instead of growing to
cover the system's real field inventory. When the dictionary only documents a
handful of representative fields, every consuming document (DB design, API
I/O design, screen spec) ends up defining most of its own fields locally
"because the dictionary doesn't have it yet" — which is exactly the
duplicate-definition failure mode the dictionary exists to prevent, just
arrived at through incompleteness instead of through a conflicting edit.

### 5. I/O design document (file/interface layouts with validation)
**Role:** the cross-cutting inventory of every input/output surface — screen,
report/export, file, API, message — described uniformly so validation
coverage can be checked without hunting through separate per-surface specs.

**Must contain:**
- Per-surface input/output summaries (screen: inputs/outputs; report: output
  fields and trigger; file: fields, format, encoding; API: input/output/error
  codes; message: message-ID scheme and localization).
- An explicit split between server-side and client-side validation, with
  server-side validation stated as mandatory and client-side as auxiliary
  only — never the reverse.
- A field-level input-check standard (required / format / range-length /
  cross-field correlation / code-list membership) as a reusable taxonomy that
  every surface's fields are checked against.
- A per-field link from each surface's field list back to which check(s) in
  the input-check standard actually apply to it — not just "server-side
  validation exists somewhere," but which check category covers which field.

**Characteristic omission that later breaks things:** stopping at the
surface-level summary tables (which fields exist, which endpoint takes what)
without threading the field-level input-check-standard chapter back through
each surface's field list. The check taxonomy and the per-surface field
tables end up as two disconnected chapters; a reviewer can confirm "a
validation standard exists" and separately confirm "an API has input fields"
without ever confirming that a *specific* field on a *specific* surface has a
*specific* check assigned to it.

### 6. Design list / definition catalog (code lists, views, files, external IFs)
**Role:** the shared enumeration source for everything that must stay
identical across DB, API, and UI — label names, enum/code values, generated
DB views, file layouts, report layouts, and external interface specs — kept
as one authoritative list per concern rather than repeated per consumer.

**Must contain:**
- A label/i18n-key table mapping each screen field to its display label and
  its localization key, so label text has one owner even when it appears on
  multiple screens.
- A code list (enum) table: each code-list ID, its enumerated values, and
  their display names — referenced by ID from the DB design (CHECK
  constraints), the data dictionary, and screen specs, not re-enumerated in
  each.
- Definitions for every generated artifact this catalog owns: system emails
  (trigger, recipient, and template with named variables), DB views (purpose,
  grain, source tables, output columns), files (format, encoding, per-field
  layout), reports (format, trigger, header/body/footer layout), and external
  interface specs (endpoint/protocol, auth method, data/error shape) — each
  with both a "list" chapter (what exists) and a "definition" chapter (full
  spec of at least the representative/critical entries).
- A pointer note directing readers to the correct owning document for
  anything this catalog does not itself define (e.g. physical DB columns
  live in the DB design doc, not here).

**Characteristic omission that later breaks things:** defining the code-list
table (values and IDs) without a stated change-control rule for adding a new
value to an existing code list. The data dictionary's own glossary chapter
has an explicit history-driven change log for terms; the code-list chapter
frequently does not carry the same discipline. A new enum value then gets
added to the DB CHECK constraint, the API validator, and the screen dropdown
on three different schedules by three different people, because there was
never a single place that said "here is the process for adding CD-0N."

## Boundaries with other skills

- `skills/db.md` owns the *engineering* technique for schema changes
  (migration file numbering, `harness.db` projection rules, pair-freeze
  checklist for a schema PLAN). This skill owns *what the DB design document
  must contain* as content; `db.md` owns how that content becomes a tracked
  migration in this repository's harness.
- `skills/data-migration.md` owns ETL/strangler-fig *process* for moving data
  between shapes or stores. This skill owns the *target-state documents*
  (DB design, persistence mapping) that a migration's "after" state must
  match — it does not itself define migration phasing or rollback triggers.
- `skills/api-contract.md` owns the *compatibility and consumer-obligation*
  layer of a wire contract (compatibility class, deprecation periods, consumer
  list). This skill's JSON/schema-design document owns the *type shape and
  cross-representation derivation* (rosetta mapping, per-boundary validation)
  that a contract's schema field refers to — the two documents describe the
  same contract from different angles and should cross-reference, not
  duplicate, each other's content.

## Product-pattern conditioning summary

- **PoC / pre-product-market-fit:** write the DB design doc and the data
  dictionary only; defer the other four documents until the schema is stable
  enough to be worth mapping and contracting formally.
- **Multi-tenant SaaS with billing or regulated data:** keep the full family;
  do not thin the DB design doc's RLS/constraint chapter or let the data
  dictionary's field coverage lag behind the schema's real size — these are
  the two documents an isolation or compliance review will actually open.
