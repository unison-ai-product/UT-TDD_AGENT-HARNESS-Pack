---
schema_version: skill.v1
name: design-family-cli-api-platform
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
decision_points:
  - when: "Defining the CLI subcommand taxonomy for a management/automation CLI."
    choose: "a noun-verb subcommand structure (e.g. `task create`, `tenant list`) documented as the naming convention"
    over: "a flat or verb-first command list assembled ad hoc as commands are added"
    because: "automation scripts and shell completion both rely on predictable noun grouping; a verb-first or inconsistent scheme forces every consumer to memorize exceptions instead of a pattern."
  - when: "Writing the CLI command-system design document (exit codes chapter)."
    choose: "an explicit exit-code table (0=success, 1=general error, 2=usage/input error, 4=auth/permission, etc.) with the output channel for each code (stdout vs stderr)"
    over: "describing exit behaviour only as prose ('the command exits non-zero on failure')"
    because: "CI pipelines branch on the numeric exit code, not on stdout text; an undocumented exit-code table is the single most common CLI design gap and forces every caller to reverse-engineer behaviour by trial."
  - when: "Deciding the CLI's default and alternate output modes."
    choose: "a machine-readable output mode (`--output json`, `--quiet`) as a first-class, explicitly documented mode alongside the human-readable table default"
    over: "shipping only a human-formatted table and letting automation scrape stdout text"
    because: "CI/automation consumers need a stable, parseable contract; scraping table output breaks on any cosmetic formatting change."
  - when: "Documenting where CLI configuration values are read from (env var, flag, config file)."
    choose: "an explicit precedence order (env > flag > file, or the product's chosen order) stated as a rule, with the config file location and format named"
    over: "leaving precedence implicit or letting each contributor assume their own order"
    because: "CI environments commonly inject credentials via env vars while local dev uses a config file; undocumented precedence causes silent misconfiguration when both are present at once."
  - when: "Specifying how CLI credentials (API keys, OAuth tokens, SSO session) are stored at rest."
    choose: "documenting the storage mechanism, permissions, and rotation path (e.g. `~/.<product>/config` with restricted file mode, or OS keychain) explicitly in the design doc"
    over: "leaving credential storage unspecified and treating it as an implementation detail"
    because: "CLI credential files are a common local exfiltration vector; an undocumented storage mechanism means no reviewer can check whether it is safe."
  - when: "The product has no external (third-party) API consumers — API is internal-only or CLI-only, called by the product's own frontend or scripts."
    choose: "scope the API-governance/versioning-and-deprecation-policy doc (91) and the API-portal/SDK doc (92) as out-of-scope, and note the decision in the design index"
    over: "writing a full URI-versioning, deprecation-header, and SDK-generation design ahead of any external consumer"
    because: "a deprecation policy with dates and a migration guide only pays for itself once an external party can break when you change the API; writing full governance ceremony for zero consumers is process cost without an audience — track it as deferred, not silently absent."
  - when: "The product does have external API consumers (public REST API, third-party integrations, or webhook subscribers) and the API-governance doc exists."
    choose: "a deprecation policy with concrete stages (announce, deprecate with a machine-readable `Deprecation` header, and a grace period with a stated duration such as 6 months, then sunset) and a per-version compatibility promise"
    over: "an undated statement such as 'we will manage compatibility informally' or 'breaking changes go in a new major version' with no grace-period duration"
    because: "external consumers cannot plan a migration against an undated policy; shipping a breaking change without a stated grace period is the difference between a manageable migration and an outage for every consumer at once."
  - when: "Designing webhook or async event delivery (retry policy)."
    choose: "document idempotency-key-based deduplication as a stated receiver-side requirement in the same section as retry/backoff, not merely retry/backoff alone"
    over: "specifying retry-with-exponential-backoff and treating delivery as done"
    because: "retries without a stated idempotency contract cause double-processing at the receiver (e.g. a billing webhook charged twice); this is the most common defect pattern in webhook designs that only address the sender side."
---

# design family: CLI / API / platform

This is a **family skill**: it defines what the CLI/API/platform-layer design
documents must contain, not how to design a specific CLI command or API
endpoint (that is owned by [[api]], [[api-contract]],
[[api-and-interface-design]], and [[contract-envelope-design]] — see
Boundary below). Load this skill when authoring or reviewing the design-doc
set that governs how a product is operated, integrated, and consumed as a
platform: CLI, public API governance, developer experience, and
event/webhook delivery.

## When to load this skill

- Authoring or reviewing a CLI architecture/command-system design doc.
- Authoring or reviewing CLI config/auth/output or CLI
  distribution/shell-completion design docs.
- Authoring or reviewing API governance/versioning/deprecation, API
  portal/SDK, or webhook/event-delivery design docs.
- Authoring or reviewing external-integration or event/message-schema design
  docs that feed the CLI/API/webhook surface.
- A PLAN adds a new external integration, a new CLI subcommand family, or a
  new webhook event type, and the paired design doc is missing one of the
  MUST-contain items below.

## Document set and role

| # | Document | Role |
|---|---|---|
| 88 | CLI architecture / command taxonomy | Defines the subcommand structure, argument/option conventions, and exit-code contract for the operator/CI-facing CLI. |
| 89 | CLI config / auth / output | Defines where CLI configuration and credentials live, the precedence order between them, and the machine vs human output modes. |
| 90 | CLI distribution / shell completion | Defines how the CLI is packaged, installed, self-updated, and how shell completion is generated per shell. |
| 91 | API governance / versioning | Defines the compatibility contract for the public API: versioning scheme, deprecation stages, and backward-compatibility rules. |
| 92 | API portal / SDK | Defines the developer-experience layer built on top of the governed API: reference docs, sandbox, generated SDKs, self-service key issuance. |
| 93 | Webhook / event delivery | Defines outbound event delivery to subscribers: signing, idempotency, retry/backoff, ordering, and dead-letter handling. |
| 42 | External integration | Defines each external system integration's protocol, data mapping, failure mode, and compensation/reconciliation strategy. |
| 39 | Event / message schema | Defines the versioned envelope and per-event payload schema shared by webhooks and internal messaging, plus schema-evolution rules. |

## MUST-contain items per document

**88 CLI architecture / command taxonomy**
- Noun-verb (or explicitly stated alternative) subcommand naming convention,
  applied consistently across all subcommands.
- Global argument/option conventions (e.g. `--profile`, `--output`,
  `--quiet`) and the confirmation convention for destructive operations
  (e.g. `--yes` to suppress an interactive prompt).
- An explicit exit-code table: code, meaning, and which stream (stdout/stderr)
  carries the result — not prose alone.
- Idempotency expectations for re-runnable commands (safe-to-retry flag
  design).

**89 CLI config / auth / output**
- Config source precedence stated as an explicit order (env var > CLI flag >
  config file, or the product's chosen order) with the config file location.
- Every supported auth method (API key, OAuth device flow, SSO/IdP
  federation) mapped to its use case (CI/automation vs interactive login vs
  organization-wide federation).
- At least one machine-readable output mode (`json`) alongside the
  human-readable default, plus a minimal/scripting mode (`--quiet`).

**90 CLI distribution / shell completion**
- Distribution channels per OS/package manager (Homebrew, apt/rpm,
  scoop/winget, raw binary/container for CI).
- Version/update mechanism: `--version` build info and a self-update path,
  plus the minimum-compatible-server-version check.
- Shell completion coverage stated per shell (bash/zsh, fish, PowerShell) —
  not "completion supported" as an undifferentiated claim.

**91 API governance / versioning**
- Versioning mechanism (e.g. explicit `/v1`, `/v2` URI segments) and the
  backward-compatibility scope for minor changes.
- A deprecation policy with **named stages and dates/durations**: announce
  (changelog/header), deprecate (`Deprecation` header, stated grace-period
  duration), and sunset (error response after the grace period) — a policy
  without a stated duration is not a policy, it is an intention.
- Backward-compatible vs breaking change classification rules (e.g. field
  addition is backward-compatible, field removal/type change requires a new
  version) and a migration-guide + sunset-date requirement for every
  breaking change.

**92 API portal / SDK**
- OpenAPI (or equivalent) declared as the single source of truth that
  generates reference docs and SDKs — not maintained by hand in parallel.
- A sandbox/trial mechanism using test credentials.
- SDK language coverage and the statement that SDK versions track API
  versions (not an independent release cadence).
- Self-service API key issuance flow with scope/permission and rate-limit
  visibility at issuance time.

**93 Webhook / event delivery**
- Signature scheme (e.g. HMAC signature header) and timestamp-based replay
  protection.
- Idempotency: event ID used by the **receiver** to deduplicate — stated as
  a receiver-side contract, not only a sender-side retry policy.
- Retry policy with backoff shape and an explicit retry limit, plus the
  dead-letter/failure-notification path once the limit is exceeded.
- Ordering guarantee stated per subscription (best-effort vs strictly
  ordered) — silence on ordering is a defect, not a neutral default.

**42 External integration**
- Per-integration failure mode and compensation strategy: timeout +
  circuit-breaker for sync calls, idempotency-key + retry + DLQ for async
  calls, reconciliation (count/amount matching) for batch/file transfer.
- Bulkhead isolation statement: an external outage degrades only the
  dependent feature, not the whole system.
- Security baseline per integration: signature verification for inbound
  webhooks, IP allowlist/mTLS where applicable, secret rotation for API
  keys/certificates, and audit logging of all integration operations.

**39 Event / message schema**
- A common envelope schema (id, type, version, tenant/scope identifier,
  occurrence timestamp, payload) applied to every event.
- Per-event payload schema with required/optional fields marked explicitly.
- Schema-evolution rule: backward-compatible changes (field addition,
  making a field optional) are minor; breaking changes require a new major
  version; consumers must ignore unknown fields (forward compatibility).
- A stated consumer-compatibility mechanism (schema registry, contract
  tests / consumer-driven contracts) that catches a breaking change before
  it reaches a consumer, not after.

## Characteristic omissions (what weak docs in this family typically miss)

- **88**: exit codes described only as "success or failure" prose, with no
  code-to-meaning table — automation cannot branch on prose.
- **89**: auth methods listed without a stated precedence order between
  config sources, so env-var-injected CI credentials silently lose to a
  stale local config file (or vice versa) with no documented resolution.
- **90**: "shell completion supported" as a single undifferentiated claim,
  with no per-shell breakdown, so a shell that was never actually
  implemented is assumed covered.
- **91**: a deprecation policy stated as a process ("we announce, then
  deprecate, then remove") with no **duration** attached to any stage —
  consumers cannot plan a migration against an undated promise.
- **92**: SDKs documented as available without stating that SDK versions
  track API versions, leading to silent SDK/API version drift.
- **93**: retry/backoff documented on the sender side with no receiver-side
  idempotency requirement stated — this is the textbook cause of
  double-processing (e.g. a billing event applied twice) when a retry
  arrives after the original request actually succeeded but the response
  was lost.
- **42**: failure modes named without a compensation/reconciliation
  mechanism — "retry on failure" without a reconciliation step leaves
  partial-success states (e.g. a payment captured but the local record not
  updated) undetected.
- **39**: schema versioning declared without a stated consumer-compatibility
  gate (contract test or registry check), so a breaking payload change ships
  and is discovered only when a consumer breaks in production.

## Boundary

This family skill defines **what** the CLI/API/platform design documents
must contain as chapters and MUST-have items. It does not define **how** to
design an individual endpoint's request/response contract, error envelope,
or resource model — that is owned by:

- [[api]] — endpoint-level REST/API design conventions.
- [[api-contract]] — contract definition and consumer-facing guarantees for
  a specific API surface.
- [[api-and-interface-design]] — general interface design principles
  (not CLI/webhook-specific).
- [[contract-envelope-design]] — request/response/error envelope shape for
  a single contract.

If a PLAN is adding or reviewing one of the eight documents above, load this
skill. If a PLAN is designing a single endpoint's request/response shape,
load the endpoint-level skills instead.

## Product-pattern conditioning

The presence of this document set is conditional on the product's exposure
surface, not a fixed checklist to complete regardless of context:

- **No external API consumers** (internal-only API, CLI-only product): scope
  91 (API governance) and 92 (API portal/SDK) as out-of-scope and record the
  decision — do not author ceremonial versioning/deprecation/SDK docs for an
  API nobody outside the team calls.
- **Any external API consumer or public webhook subscriber**: 91 and 93
  become mandatory, and the deprecation-policy-with-dates requirement in 91
  is non-negotiable — an external consumer that cannot plan a migration will
  be broken by the next release regardless of internal intent.
- **CLI as the only distribution surface** (no GUI): 88/89/90 are mandatory
  even at small scale, because the CLI *is* the product surface and its
  exit-code/output contract is the only integration point automation has.
