---
schema_version: skill.v1
name: design-family-security-privacy
skill_type: design-contract
applies_to:
  layers:
    - L4
    - L5
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Recovery
    - Incident
decision_points:
  - when: "A product is at PoC/early-validation scale with no production personal data or payment processing yet."
    choose: "write only the security design document's authentication/authorization chapter and the secrets/key-management document's basic hygiene chapter, deferring privacy (DPIA/ROPA), supply-chain (SBOM/SCA/SLSA), and platform-specific (mobile/desktop) documents"
    over: "producing the full eight-document family before there is real user data or a release surface to threat-model"
    because: "a DPIA maps risk against actual personal-data processing activities and a supply-chain doc tracks a real dependency graph under continuous build — both require a stable system to describe; writing them against a PoC's throwaway surface produces documents that must be rewritten wholesale once the product's actual shape is known, without having reduced any real risk in the meantime."
  - when: "The product is regulated or enterprise-facing (handles PII under GDPR/SOC2-type obligations, or processes payments even via a third party like a payment processor)."
    choose: "keep the privacy design document (ROPA + DPIA) and the security design document's compliance-mapping chapter mandatory, even if the STRIDE threat-model chapter itself stays lightweight for a given feature"
    over: "treating the STRIDE/threat-model chapter as the priority and letting privacy documentation lag until an audit forces it"
    because: "STRIDE analysis is a design-time engineering technique that can be deepened incrementally per feature; a missing ROPA/DPIA is a compliance-obligation gap that exists the moment regulated personal data is processed, independent of how thorough any individual feature's threat model is — the two are not interchangeable priorities, and the compliance one is the one with a legal deadline attached."
  - when: "A new authorization role or permission scope is introduced."
    choose: "update the role-by-function permission matrix and the role-by-screen permission matrix together in the same change"
    over: "updating only the function-level matrix (or only the screen-level matrix) and treating the other as implied"
    because: "the security design document keeps these as two separate tables precisely because a role's allowed *operations* and a role's allowed *screens* can diverge — a role might gain API-level read access to a resource with no screen ever surfacing it, or a screen might expose an action the function matrix never granted; only checking one table hides the other's drift."
  - when: "A STRIDE threat entry lists a mitigation/control for a given threat category."
    choose: "map that control to a concrete external compliance clause (e.g. an SOC2 trust-service-criteria control family, a specific GDPR article) in addition to any internal non-functional-requirement ID"
    over: "leaving the mitigation mapped only to an internal NF-requirement reference"
    because: "the security design document's own stated practice is to map STRIDE-derived controls to compliance frameworks so an auditor or the security-test-plan document can verify coverage against an external standard; a mitigation traceable only to an internal ID is unverifiable by anyone auditing against the actual regulatory obligation."
  - when: "A new tenant needs its own data-at-rest encryption key in a multi-tenant system."
    choose: "provision a per-tenant data-encryption key (DEK) at tenant creation and define an explicit crypto-erase/key-destruction step at tenant offboarding"
    over: "encrypting all tenants' data under one shared platform-wide key and treating logical deletion as sufficient at offboarding"
    because: "the secrets/key-management document's blast-radius principle exists specifically to bound the exposure of one compromised or subpoenaed tenant's data to that tenant; a shared key defeats that bound entirely, and skipping the offboarding destroy step leaves a 'crypto-erase' claim unfulfilled — the data is still technically recoverable from encrypted backups."
  - when: "A new runtime dependency is being added to the project."
    choose: "check the dependency's age and maintenance activity at ingestion time and require explicit review if it is newer than the project's defined freshness threshold (e.g. published under 30 days ago) or shows no active maintainer"
    over: "trusting that the package exists on a known registry (npm, PyPI) as sufficient vetting, and relying solely on a build-time CVE scan to catch problems later"
    because: "the supply-chain security document's SCA phase table gates ingestion-time specifically on provenance/age/maintainer signals, separately from the build-time known-CVE scan — a brand-new or abandoned package can carry zero known CVEs today precisely because it hasn't existed long enough to be scrutinized, which a CVE-only gate cannot catch."
  - when: "A new state-changing (non-idempotent) API endpoint is added to a browser-facing surface that already sets `SameSite` on its session cookie."
    choose: "still require an explicit CSRF defense (anti-CSRF token or double-submit cookie) on that endpoint"
    over: "treating the `SameSite` cookie attribute alone as sufficient CSRF protection and skipping a token-based defense"
    because: "the web session/CSRF/CORS design document lists SameSite under the CSRF chapter as one listed mitigation alongside token-based defenses, not as a replacement for them — browsers and proxies with inconsistent SameSite enforcement, and same-site attack vectors that SameSite doesn't cover, are exactly why the token-based defense remains the primary listed control."
  - when: "A security test/vulnerability-diagnosis pass discovers that a feature is actually protected by a control that was never written into the security design document (an undocumented defense found during testing)."
    choose: "route the finding back to the security design document as a documentation gap and add the control to the STRIDE/permission-matrix chapter before marking the diagnosis item resolved"
    over: "closing the diagnosis finding directly in the test-plan/diagnosis document on the grounds that the system is, in practice, already protected"
    because: "the security test plan document's own stated policy is that diagnosis is a compliance check against the security design document as source of truth, and a defense discovered ad hoc during testing that was never in the design 'does not count as passing' until it flows back into the design — an undocumented working control today is a control nobody can verify still exists after the next refactor."
---

# design family: security and privacy

The set of design documents that together specify a product's security and
privacy posture across trust boundaries, personal-data handling, the software
supply chain, secrets/keys, session-layer web risk, platform-specific device
risk, and the diagnosis plan that verifies all of the above. Eight documents
form this family; each owns a distinct concern and none substitutes for
another. Load this skill when authoring or reviewing any of them, or when a
PLAN's security-relevant change touches more than one.

## When to load this skill

- An L4/L5 PLAN introduces or modifies an authentication, authorization,
  session, encryption, or dependency-ingestion surface.
- A design review needs to check whether a security/privacy obligation is
  documented in its correct owning document rather than scattered across
  several.
- A Recovery or Incident PLAN must show that the exploited or at-risk surface
  is now represented in the design-document family, not just patched.
- A security test/diagnosis pass (L10) finds a gap or an undocumented control
  and needs to know which design document owns the fix.
- Deciding how much of the family a PLAN actually needs (see decision points
  above) before writing any of it.

## The eight documents and what each must contain

### 1. Security design document (threats / authn / authz / permission matrix)
**Role:** the primary security source of truth — who may do what, how
identity is established, and what STRIDE-categorized threats are mitigated by
which controls, mapped to compliance obligations. Every other document in
this family, and the security test plan, treats this document as canonical.

**Must contain:**
- A role-by-function permission matrix (CRUD per role per function), scoped
  explicitly to the isolation boundary (e.g. every operation implicitly
  tenant-scoped).
- A role-by-screen permission matrix, kept as a separate table from the
  function matrix (see decision points above) because the two can diverge.
- An authorization-design chapter: identity federation/session mechanism for
  human users, a separate mechanism (API key/OAuth client credentials) for
  machine/API consumers, and a statement of where authorization is enforced
  (middleware, repository-layer auto-scoping, or both — "both" being the
  intended defense-in-depth answer, not an either/or).
- A STRIDE threat table: one row per threat category, the specific threat
  scenario, the control(s) that mitigate it, and — required, not optional —
  a mapping from that control to an external compliance clause, not only an
  internal requirement ID.
- A data-classification table (public / internal / confidential / PII) with
  the handling rule (encryption / storage / access restriction) attached to
  each classification, feeding the privacy document's data mapping.
- An application-security chapter covering the standard web vulnerability
  classes (XSS, CSRF, injection, clickjacking, session fixation, IDOR/
  authorization bypass, excessive data exposure, brute-force/abuse) each
  with its specific control — this is the chapter the security test plan
  checks fields against line-by-line.

**Characteristic omission that later breaks things:** the permission matrices
define normal-path RBAC exhaustively but omit any row for emergency/
break-glass access (e.g. on-call support needing temporary elevated access
outside the normal role set). When that access is inevitably needed, it gets
improvised as an unreviewed, undocumented bypass path — precisely the kind of
elevation-of-privilege risk the STRIDE chapter is supposed to have already
enumerated and controlled.

### 2. Privacy design document (data classification, consent, retention)
**Role:** the privacy-by-design record — what personal data is processed for
what purpose, the risk that processing creates, how data-subject rights are
fulfilled, and how data is minimized and eventually deleted. Distinct from the
security document's data-classification table: this document covers *why*
personal data is processed and *what happens to it over its lifecycle*, not
how it's technically protected at rest.

**Must contain:**
- A Record of Processing Activities (ROPA): each category of personal data,
  its processing purpose, its legal basis, and where/how long it is stored —
  covering every personal-data category the system actually handles, not a
  representative sample.
- A Data Protection Impact Assessment (DPIA): for each processing activity
  with meaningful privacy risk, the specific risk and the mitigation, derived
  from the ROPA's actual inventory.
- A data-subject-rights fulfillment flow for each right (access, correction,
  erasure/"right to be forgotten," portability, restriction/objection), each
  with a concrete process, not a policy statement alone.
- Consent and purpose-limitation rules: how consent is captured, recorded,
  and revocable, and what happens to processing when consent is withdrawn.
- Cross-border transfer and processor/sub-processor handling: which
  processors receive personal data, under what legal transfer mechanism, and
  data-residency commitments.
- Minimization, retention, and deletion: defined retention periods per data
  category and the automated deletion mechanism that enforces them once the
  period elapses, linked to the operational data-lifecycle procedure that
  actually executes deletion requests.

**Characteristic omission that later breaks things:** the ROPA table's
personal-data inventory stays a small illustrative set (name/email, audit
logs, payment data) rather than growing to cover every category the product
actually collects (invitation-flow email content, IP addresses captured in
logs, notification preferences, usage analytics tied to a user). Because the
DPIA's risk assessment is derived directly from the ROPA, an incomplete ROPA
means the DPIA never assesses risk for the categories it was never told
about — the gap is invisible precisely where a privacy review would look for
completeness.

### 3. Supply-chain security document (dependency / SBOM / EOL)
**Role:** the software-supply-chain integrity record — what is inside every
build (SBOM), whether known dependency vulnerabilities are being tracked and
gated (SCA), whether the build itself is tamper-evident (SLSA provenance),
and whether OSS license obligations are being met.

**Must contain:**
- SBOM generation policy: what artifact types get an SBOM (application
  build, container image, resolved dependency tree), in what format
  (SPDX/CycloneDX), at what point in the pipeline, and where it's retained.
- SCA (software composition analysis) gating by phase: an ingestion-time
  check (new dependency provenance, age, maintainer activity — see decision
  points above), a build-time check (known-CVE blocking on critical/high
  severity), and a runtime/ongoing check (reachability/exploitability
  triage via VEX or equivalent, not just presence of a CVE).
- Build provenance/signing (SLSA or equivalent maturity model): the level
  the project targets (provenance metadata only, vs. signed provenance from
  a hosted builder, vs. fully isolated tamper-resistant builds) and the
  concrete mechanism used to reach it.
- OSS license compliance: a classification of license categories (permissive
  / weak-copyleft / strong-copyleft) with an explicit policy per category,
  especially for strong-copyleft in a SaaS-distributed product.
- Regulatory context and evidence retention: what external regulatory driver
  applies (procurement requirements, executive-order-style mandates) and,
  critically, a concrete list of the artifacts kept on hand to satisfy an
  audit — not just an acknowledgment that regulation exists.

**Characteristic omission that later breaks things:** the regulatory chapter
stays at the level of naming which regulations apply, without the security
test plan's discipline of a concrete exit-criteria checklist ("here is
exactly what evidence we hand an auditor, and here is what a missing item
means for release"). When an actual audit or customer security questionnaire
arrives, there is no pre-assembled evidence list — someone has to reconstruct
"what SBOMs and provenance records do we actually retain" from scratch under
time pressure.

### 4. Secrets / key management document (never in docs/code/commits, rotation)
**Role:** the key hierarchy, tenant-scoped encryption strategy, secrets
storage/distribution, and certificate lifecycle — the document that answers
"where does a credential or key live, and how does it get rotated or
revoked."

**Must contain:**
- A key hierarchy: master/key-encryption-key (KEK) held in a KMS, data-
  encryption keys (DEKs) used for actual data, and signing keys — each with
  its storage location and rotation cadence stated explicitly (not "as
  needed").
- Tenant-scoped key strategy for multi-tenant systems: per-tenant DEK
  assignment at provisioning, and an explicit crypto-erase/key-destruction
  procedure at tenant offboarding (see decision points above) — plus the
  status of any higher-tier customer-managed-key (BYOK/CMK) commitment,
  stated as either committed-with-a-date or explicitly out of scope, not left
  as an open "under consideration" item with no owner.
- Secrets management: which categories of secret exist (DB/external API
  credentials, webhook signing keys, CI/CD credentials), where each is
  stored (a secrets manager, never source control), and how each is
  distributed to running code (runtime injection, not baked into images).
- Certificate lifecycle: automated issuance/renewal with expiry monitoring,
  and an explicit revocation/rotation procedure for compromise scenarios.
- An explicit statement that no plaintext key or secret is ever placed in an
  application code path, config file, or commit — enforced mechanically (see
  Boundaries: `security-and-hardening.md` owns the CI-side scanning that
  checks this).

**Characteristic omission that later breaks things:** leaving a
customer-tier commitment like BYOK/CMK recorded as "under consideration" in
the tenant-key chapter with no decision owner or target date. This reads as
harmless scoping language until an enterprise sales cycle requires a
committed answer on short notice — at which point the key-hierarchy and
tenant-isolation architecture may need retrofitting under deadline pressure
instead of having been decided as a design choice.

### 5. Web session / CSRF / CORS design document
**Role:** the browser-origin trust-boundary document — session/cookie
handling, cross-site request forgery defense, and cross-origin resource
sharing policy, scoped specifically to browser-initiated risk (distinct from
the security document's broader authorization design).

**Must contain:**
- Session/cookie attribute policy: HttpOnly, Secure, and a stated minimum
  SameSite level, plus a two-tier expiry model (idle timeout and absolute
  timeout) and explicit invalidation triggers (logout, permission change).
- CSRF defense per state-changing surface: a token-based or double-submit-
  cookie mechanism as the primary control, with SameSite named explicitly as
  a secondary/defense-in-depth layer, never as the sole control (see
  decision points above).
- CORS policy as an explicit allow-list by origin category (first-party
  frontend with credentials, public-API consumers under a managed allow-list,
  everything else denied by default) — not an open or wildcard policy.
- A trace section linking this document to the authentication/SSO design it
  assumes and to the broader security document's non-functional security
  requirement it satisfies.

**Characteristic omission that later breaks things:** the CORS allow-list
chapter defines which origins are permitted but never states what happens to
already-issued sessions or API tokens when an origin is later removed from
the allow-list (a partner integration is revoked, a compromised origin is
pulled). Without an explicit session/token invalidation trigger tied to
allow-list changes, revoking an origin in configuration doesn't actually
revoke the access already granted through it.

### 6. Mobile security design document (platform-specific: keychain/pinning/obfuscation)
**Role:** device-side risk for mobile clients — credential storage,
transport protection, and anti-tamper/anti-reverse-engineering posture,
layered on top of (not replacing) the core security and session documents.

**Must contain:**
- Credential/token storage: use of the OS-provided secure storage (Keychain
  on iOS, Keystore on Android), and how biometric/device authentication
  gates access to it.
- Transport protection: minimum TLS version and certificate pinning for API
  communication, plus a stated policy on minimizing what sensitive data is
  ever sent from the device at all.
- Tamper/reverse-engineering countermeasures: code obfuscation/string
  protection, root/jailbreak detection, and debugger/emulator detection
  where warranted — each paired with an explicit response action (see
  characteristic omission below), not left as detection-only.
- A trace section linking to the core security document's non-functional
  security requirement and to the tenant-isolation requirement as it applies
  to on-device data.

**Characteristic omission that later breaks things:** the tamper-detection
chapter lists detection mechanisms (root/jailbreak detection, debugger
detection) as bullet items without specifying the response each one triggers
— block the app entirely, degrade to read-only, or merely log and report.
Detection without a defined response is functionally inert: the mechanism
fires, and then nothing product-specified happens, because the response was
never a design decision, just an implied one.

### 7. Desktop security / local-data design document
**Role:** device-side risk for desktop clients — process sandboxing, local
data protection, and offline/sync behavior, mirroring the mobile document's
concerns for a different runtime (typically an Electron-style or native
desktop shell).

**Must contain:**
- Sandbox and privilege policy: renderer process sandboxing, disabling
  direct OS/Node access from untrusted renderer code, and an explicit
  allow-list of IPC commands exposed across the sandbox boundary (with input
  validation on each) — not an open IPC surface.
- Local data protection: OS-provided credential storage for auth tokens
  (Keychain/DPAPI-equivalent), encryption at rest for local caches, and
  masking of sensitive values in local logs.
- Offline/sync behavior: how offline-created data is held locally and
  reconciled on reconnect, with a concrete conflict-resolution policy (not a
  placeholder), and an explicit remote-revocation path for a lost or stolen
  device (committed, not left as "to consider").
- A trace section linking to the core security and tenant-isolation
  requirements as they apply to locally cached data.

**Characteristic omission that later breaks things:** both the
conflict-resolution policy and the lost-device remote-revocation capability
are recorded as bullet-point intentions ("define a conflict resolution
policy," "consider remote revocation on device loss") rather than committed,
specified behavior. This is the same TBD-as-bullet pattern as the secrets
document's BYOK gap: a real decision is deferred by being phrased as already
addressed, so it never surfaces as an open item requiring a decision date
until a device is actually lost or a real sync conflict occurs in production.

### 8. Security test plan / vulnerability diagnosis document
**Role:** the verification pass that checks whether the security design
document's stated controls actually hold, structured as a compliance check
against that design (not an independent search for problems), with a defined
severity/SLA model and diagnostic independence requirement.

**Must contain:**
- A phased testing approach (SAST in CI on every push, SCA in CI plus a
  periodic sweep, DAST against a deployed staging environment, manual
  diagnosis before release/after major change, and periodic penetration
  testing by an independent party) with each phase's cadence and tooling
  stated.
- A diagnostic-independence rule: whoever performs manual diagnosis or
  penetration testing must not be the implementer of the feature under test
  — stated as a requirement, mirroring adversarial-review discipline
  elsewhere in the product's verification approach.
- An OWASP-style checklist (or equivalent industry category list) where each
  row states a check specific and falsifiable enough that a third party can
  judge pass/fail from the stated confirmation text alone, each row linked
  to the specific design document(s) it verifies, and each row resolved to
  one of: passed / finding-filed / explicitly out-of-scope-with-reason
  (never left blank).
- A severity/SLA table (e.g. CVSS-banded Critical/High/Medium/Low) each with
  a remediation SLA and an explicit release-gating consequence (blocking vs.
  conditional-go vs. go) — severity triage happens before any finding is
  reported as resolved, not after.
- A platform-specific or technology-specific extension chapter (e.g. an
  LLM/AI-agent-specific check list) scoped explicitly to when it applies,
  with an equally explicit exemption/opt-out mechanism and a place that
  exemption reason is recorded when it doesn't apply.
- Exit criteria: every checklist row resolved (blank = undiagnosed = release-
  blocking), zero unresolved Critical/High findings, and every finding
  traceable to a tracked follow-up item.

**Characteristic omission that later breaks things:** an extension chapter
(such as an LLM/agent-specific check) is scoped as mandatory only when a
particular design document is "adopted," with its opt-out justification
required to live in a separate catalog document rather than in the test plan
itself. The exemption reasoning is never co-located with the check it
exempts, so a reviewer looking only at the test plan cannot tell whether the
LLM chapter was skipped-and-justified or skipped-and-forgotten — the record
that would answer that question is filed somewhere else entirely.

## Boundaries with other skills

- `skills/security.md` owns UT-TDD's own runtime escalation boundaries,
  agent-guard architecture, and hook fail-close behavior — the harness's own
  operational security posture. This skill's security design document owns
  *what a product's own security design documentation must contain* as
  content for the product being built with the harness; it does not describe
  the harness's own guard rails.
- `skills/threat-model.md` owns the STRIDE-lite *procedure* (how to run a
  threat-modeling pass, the trust-surface inventory, where to record the
  output as `docs/design/L3/<plan-id>-threat-model.md`). This skill's
  security design document is the artifact a completed threat-model pass
  feeds into as its permanent home — `threat-model.md` is the technique,
  this document family is the durable specification the technique populates
  and that the security test plan later verifies against.
- `skills/security-and-hardening.md` owns the *systematic hardening sweep*
  applied at L7+ before accept (dependency audit commands, Biome
  security-lint, guardrail secret scanning, redaction audit). This skill's
  supply-chain and secrets/key-management documents own *what must be true
  by design* (SBOM policy, key hierarchy, rotation cadence); the hardening
  skill owns the *mechanical, repeatable check* that confirms the design's
  commitments are being met on every commit. Both must pass; neither
  substitutes for the other.

## Product-pattern conditioning summary

- **PoC / no production personal data or payments yet:** write the security
  design document's authn/authz chapter and the secrets document's basic
  storage/rotation hygiene chapter only; defer privacy (ROPA/DPIA),
  supply-chain, and platform-specific (mobile/desktop) documents until there
  is a real system and real data to describe.
- **Enterprise/regulated (SOC2/GDPR-type obligations, multi-tenant, or
  processes payments):** the privacy document (ROPA/DPIA) and the security
  document's compliance-mapping chapter are mandatory regardless of how
  lightweight the per-feature STRIDE analysis is — the compliance obligation
  exists the moment regulated data is processed, independent of feature-level
  threat-modeling depth.
