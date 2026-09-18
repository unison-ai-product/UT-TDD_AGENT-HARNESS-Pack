---
schema_version: skill.v1
name: design-family-web-frontend
skill_type: design-contract
applies_to:
  layers:
    - L2
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Discovery
decision_points:
  - when: "The platform profile for the product has no web client (API-only or native-only product)."
    choose: "mark the entire web-frontend design family out-of-scope (structurally absent) in the L2/L4 doc index and skip authoring 72/73/74/75/46/37/41"
    over: "writing thin placeholder docs for each of the seven documents so the doc-family checklist looks complete"
    because: "a placeholder doc with no real content creates false design coverage that later reviewers read as a decided policy; absence must be visible as absence, not disguised as a stub."
  - when: "Authoring 72 (frontend design) and the state-management section only names a library (e.g. 'Redux' or 'Zustand')."
    choose: "require the section to also state the split between server state, UI-local state, and shared/global state, plus the design-system token set (including the spacing scale) the components draw from"
    over: "accepting a library name alone as the state-management design"
    because: "a library name is a tech-selection decision, not a design decision; without the state-category split and token scale, two engineers building adjacent components will invent incompatible local conventions."
  - when: "Authoring 73 (browser/responsive) and only a prose sentence like '主要ブラウザ最新2版' (latest 2 versions of major browsers) is given."
    choose: "require an explicit support matrix (browser x version x support-level table) plus a breakpoint table with numeric widths, not prose alone"
    over: "leaving browser support as a single policy sentence with breakpoints implied by the component library defaults"
    because: "a QA test-design author needs enumerable rows to write a browser test matrix; 'latest 2 versions' without a table is not enumerable and pushes the enumeration decision downstream to test design, which is a design gap."
  - when: "Authoring 74 (web performance) and the doc lists Core Web Vitals target numbers but no budget-enforcement mechanism."
    choose: "add a measurement section stating where the metric is enforced (CI Lighthouse gate, RUM alert threshold) and link it to the incident/observability design"
    over: "treating a target number in a table as sufficient without stating how regression is caught"
    because: "a target with no enforcement point is aspirational, not a design; the file's own pattern links CWV targets to CI ('LighthouseなどのCI計測') and to alerting (NF-007) — a doc missing that link has stated a goal without a mechanism."
  - when: "Authoring 75 (session/CSRF/CORS) and the draft says 'follow framework defaults' for cookie attributes or CORS origins."
    choose: "require explicit policy values — cookie attributes (HttpOnly/Secure/SameSite level), session expiry (idle + absolute), CSRF mechanism (token or double-submit), and an explicit CORS allow-list with an explicit default-deny — written into the doc"
    over: "deferring to the web framework's default CORS/cookie/CSRF behavior without stating the chosen values"
    because: "framework defaults vary by version and are not a spec a security reviewer or test author can pin against; explicit policy values are what NF-004 (security) traces to, and the source doc treats '既定拒否' (default-deny) as a stated policy line, not an assumption."
  - when: "Choosing whether SEO/public-page design (46) applies to a given screen."
    choose: "classify each screen as public-indexable (SSR/SSG, sitemap-included) or authenticated-app (noindex, excluded from sitemap) and write both classifications into the doc, even if the product currently has few public pages"
    over: "writing 46 only for the marketing site and treating authenticated screens as silently out of scope"
    because: "the source pattern explicitly separates '対象' (in-scope, public) from '対象外' (out-of-scope, noindex) rows in the same table; omitting the out-of-scope classification lets a public-page crawler accidentally index authenticated routes."
  - when: "Authoring 37 (i18n/a11y) for a product currently shipping only one locale."
    choose: "still write the locale-growth path (how a second locale is added: key externalization, fallback-to-default behavior, translation workflow) and a concrete WCAG conformance target (e.g. WCAG 2.2 AA), even if RTL is marked not-yet-applicable"
    over: "writing a single-locale-only doc with a vague 'accessibility will be considered' statement and no numeric WCAG target"
    because: "a single-locale doc with no growth path forces a redesign when locale 2 ships instead of an extension; a non-numeric a11y statement gives QA no pass/fail criterion, which the source doc avoids by naming WCAG 2.2 AA and a 4.5:1 contrast ratio explicitly."
  - when: "A new function, enum value, or event is added to the product and needs a user-facing string."
    choose: "add the display name to the single translation catalog (41) with its i18n key, and reference the catalog key from the frontend/backend code instead of writing the literal string inline"
    over: "hardcoding the Japanese or English literal string directly in component code or backend event-formatting code, planning to centralize it later"
    because: "the source doc states the catalog is the sole source of truth (SSOT) for display names and that a mismatch between catalog and code should be caught in review; in-code literals bypass that check point and create silent drift between catalog and shipped UI text."
---

# design family: web frontend

Design-document contract for the web-client design family: what each of the
seven documents in this family must contain before it is usable as a spec for
downstream test design and implementation. This skill governs document
*content completeness*, not verification mechanics.

## When to load this skill

- Authoring or reviewing any of: frontend design (72), browser/responsive
  design (73), web performance design (74), session/CSRF/CORS design (75),
  SEO/public-page design (46), i18n/accessibility design (37), or the
  display-name/translation catalog (41).
- Deciding whether the web-frontend design family applies to a product at all
  (platform-profile check).
- A PLAN's pair-freeze needs one of these docs and it is missing or thin.

## Platform-profile conditioning (read first)

These seven documents exist because the product has a web client. Before
authoring any of them, check the product's platform profile:

- **Product has a web client** (SPA, SSR site, or hybrid): the family is
  in-scope. Author all seven documents at a depth proportional to what the
  product actually exposes (a product with no public marketing pages can
  keep 46 minimal but must still state that classification explicitly).
- **Product has no web client** (native-mobile-only, desktop-only, or
  API-only backend): mark the family out-of-scope as a structural-absence
  note in the L2/L4 doc index, not as seven empty stub files. A missing
  family entry that is explicitly marked "no web client, family N/A" is
  correct design signal; a stub file with unfilled tables is false coverage
  that a later reviewer will misread as "decided and thin" rather than
  "does not apply."

## The seven documents and their MUST-contain items

### 72 — Frontend design (component architecture / state / rendering)

- Rendering-strategy decision per screen class (SPA / SSR / SSG), not a
  single blanket choice — public pages and authenticated app screens
  typically diverge.
- Component architecture: how components are split and reused (composition
  boundary), not just "we use component X".
- State management split into three explicit categories: **server state**
  (fetched/cached data), **UI-local state** (component-local), and
  **shared/global state** (minimal, named store) — a library name alone is
  not a state-management design.
- Design-system tokens, including the **spacing scale** (not just color/
  typography tokens) — spacing-scale omission is the most common thin spot
  in this document family.
- API-consumption pattern: how typed clients call backend APIs (API-xxx) and
  how loading/error states are unified across screens.
- Trace table linking screens (SC-xxx) and functions (F-xxx) to this design.

### 73 — Browser & responsive design

- Explicit **support matrix**: browser x version x support-level, as a
  table, not prose ("latest 2 versions" alone is not enumerable by a test
  author).
- Explicit **breakpoint table** with numeric widths (e.g. <640px / 640–1024px
  / >1024px) and the layout behavior at each breakpoint.
- Per-screen responsive behavior (what collapses, reorders, or simplifies on
  mobile) for each screen this family covers.
- Accessibility cross-reference to the i18n/a11y doc (37) rather than
  restating WCAG targets here.

### 74 — Web performance design

- Core Web Vitals targets as numeric thresholds (LCP / INP / CLS) with a
  "good" bound stated per metric, not a vague "must be fast" goal.
- Optimization measures broken out by area: JS (code-split/lazy-load),
  images, delivery (CDN/cache), and render (critical-CSS/font strategy).
- Measurement mechanism: field measurement (RUM) plus lab measurement (CI
  Lighthouse or equivalent gate) — a target with no stated enforcement point
  is aspirational, not a design.
- Link from performance targets to alerting/observability so regression is
  caught, not just measured.

### 75 — Session / CSRF / CORS design

- Explicit session-cookie policy: attributes (HttpOnly / Secure / SameSite
  level), and an explicit two-tier expiry (idle timeout + absolute timeout).
- Explicit CSRF mechanism named (token-based or double-submit-cookie),
  scoped to state-changing endpoints.
- Explicit CORS allow-list by origin category (own frontend with
  credentials, named external API consumers, and default-deny for
  everything else) — "use framework defaults" is not an acceptable
  substitute for stated values, because defaults vary by framework version
  and are not a pinnable spec.
- Trace to the security non-functional requirement and to auth/SSO design.

### 46 — SEO & public-page design

- Explicit per-page-class classification: **public/indexable** (SSR/SSG,
  included in sitemap) vs. **authenticated/excluded** (noindex, excluded
  from sitemap) — both classifications must appear, even for products with
  few public pages, so the exclusion of authenticated routes is an explicit
  design decision rather than an accident.
- Meta/OGP policy (title/description uniqueness, canonical URL handling).
- Structured-data (JSON-LD schema.org types) mapped per page type, where
  applicable.
- Sitemap/robots policy, including how the public/private split above is
  enforced mechanically (robots.txt Disallow for app routes).
- URL design and multi-language URL policy (hreflang) if the product is
  multi-locale.

### 37 — Internationalization / accessibility design

- Locale scope stated explicitly (current locales + the **growth path** for
  adding a new locale: key externalization mechanism, fallback-to-default
  behavior, translation workflow) — required even for single-locale
  products, so a second locale is an extension rather than a redesign.
- RTL applicability stated explicitly (even if "not yet applicable" — this
  must be a decision, not a silent gap).
- Date/time/currency/number formatting policy: storage in UTC/canonical
  units vs. locale-formatted display, and timezone-resolution rule.
- Numeric, testable **WCAG conformance target** (e.g. WCAG 2.2 AA), not a
  vague "accessibility will be considered" statement — a target QA cannot
  turn into pass/fail criteria is not a design.
- POUR-structured requirements (Perceivable / Operable / Understandable /
  Robust) with concrete examples (e.g. contrast ratio ≥ 4.5:1, keyboard-only
  operability, ARIA/semantics).
- Verification approach named (automated a11y lint/CI + manual/screen-reader
  check), cross-referenced to test design rather than re-specified here.

### 41 — Display-name / translation catalog

- Declared as the **single source of truth** for user-facing display names
  — internal identifiers (function names, enum values, event names) must
  never appear directly in the UI; they are always translated through this
  catalog.
- Coverage across: function/action display names, enum/status display
  values (with associated badge colors where applicable), activity/event
  templated messages, user-facing error messages (mapped from internal
  error codes, without leaking internal detail), and field-name-to-label
  mapping.
- An explicit review-time enforcement statement: new functions/enums/events
  must add a catalog entry, and code must reference the i18n key rather than
  hardcoding the literal string — literals bypass the catalog's single-
  source-of-truth guarantee and drift silently from what the catalog says
  should be shown.
- Fallback-to-default-locale behavior for untranslated keys.

## Characteristic omission per document (what reviewers most often miss)

| Doc | Most common omission |
|---|---|
| 72 Frontend design | Spacing scale dropped from "design-system tokens" (color/type kept, spacing forgotten) |
| 73 Browser/responsive | Support stated as prose ("latest 2 versions") with no enumerable table, breakpoints left as component-library defaults |
| 74 Web performance | Target numbers present but no CI/RUM enforcement mechanism named — goal without a gate |
| 75 Session/CSRF/CORS | "Framework defaults" substituted for explicit cookie/CORS policy values |
| 46 SEO/public pages | Authenticated-route noindex/exclusion never stated explicitly (only the public-page policy is written) |
| 37 i18n/a11y | WCAG target left as vague prose instead of a numeric conformance level; locale-growth path omitted for single-locale products |
| 41 Translation catalog | Catalog treated as documentation only, with no stated code-level enforcement against hardcoded literals |

## Boundary: this skill vs. verification skills

This skill defines what the **design documents** in the web-frontend family
must contain as a written spec. It does not cover:

- How to mechanically verify rendered screen state, layout, or visual
  regression — see `visual-state-verification`.
- How to drive and assert against a running browser during test execution
  (browser automation mechanics, screenshot diffing, test harness setup) —
  see `browser-testing-and-screen-verification`.

If a decision point is about *what the spec must say*, it belongs here. If
it is about *how to check the running product against that spec*, route to
the verification skills above.
