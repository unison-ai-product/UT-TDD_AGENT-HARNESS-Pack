---
schema_version: skill.v1
name: visual-state-verification
skill_type: verification
applies_to:
  layers:
    - L2
    - L7
    - L8
    - L10
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Refactor
decision_points:
  - when: "Verifying a screen for visual/UX correctness."
    choose: "enumerate the 9-state matrix (empty / one item / many / long-text / loading / error / no-permission / partial-loss / offline) and check each"
    over: "judging only the ideal-data mock state the designer produced"
    because: "most screen bugs are not broken functionality but layout collapse in a state the mock never depicted; the mock is one of dozens of real states, and the states absent from the mock are the ones most likely to break."
  - when: "A visual-regression-test (VRT) diff appears."
    choose: "classify the diff first — (a) intended-change ripple, (b) environment noise (font rendering, anti-aliasing, dynamic data), or (c) true regression — before deciding pass/fail"
    over: "judging severity by the size of the pixel-diff percentage"
    because: "pixel-diff magnitude is unrelated to the classification; a 1px border disappearing is (c) and severe, while a whole-screen colour shift from renderer differences is (b) and harmless — sizing decisions off the wrong axis misses both false positives and false negatives."
  - when: "A VRT diff is classified as environment noise (b) — font rendering, anti-aliasing, dynamic data such as dates or random IDs."
    choose: "mask the dynamic regions and pin fonts/renderer in the test environment to remove the noise source"
    over: "raising the diff tolerance threshold to absorb it"
    because: "raising tolerance discards detection power for category (c) regressions equally — it does not selectively suppress noise, it blinds the test to real regressions of the same magnitude."
  - when: "A VRT baseline needs to be updated after a diff."
    choose: "require a diff review plus a linked PR/ticket as evidence before accepting the new baseline"
    over: "auto-accepting the new screenshot because a diff simply appeared"
    because: "unreviewed baseline updates launder regressions into the new baseline one at a time, and without an evidence trail there is no way to later distinguish an intentional baseline change from a silently absorbed bug."
  - when: "Designing the no-permission / restricted-visibility state of a screen."
    choose: "hide the element entirely (existence secrecy)"
    over: "rendering the element in a disabled/greyed-out state"
    because: "a disabled control still leaks that the feature exists and roughly what it does to a user who should not know; existence itself can be the sensitive fact, not just the ability to click."
  - when: "An AI agent is self-judging a screenshot for a 1-2px alignment gap, a subtle colour difference, font-rendering variance, or animation quality."
    choose: "switch to DOM/computed-style measurement (or hand off to a human) instead of trusting visual perception of the image"
    over: "declaring pass/fail purely from how the screenshot looks"
    because: "these are explicitly named as the class of defect where AI image judgement is unreliable — the skill's own self-awareness section separates what image inspection can trust (missing elements, gross overflow, layout breaks) from what it cannot (sub-pixel and subtle-tone differences)."
  - when: "Reporting 'no problem found' after visual verification of a screen."
    choose: "explicitly state which of the 9 states were checked and which were not"
    over: "issuing an unqualified 'looks fine' verdict covering the whole screen"
    because: "silently letting unchecked states fall inside an implicit 'no problem' is the same confirmation-bias failure the harness names elsewhere as the 'confirmation-test trap' — an unstated state is not a verified state."
  - when: "Writing or reviewing an E2E test for a screen-facing PLAN."
    choose: "select elements by semantic identity (data-testid or accessible role+label) and wait on explicit state conditions"
    over: "selecting by CSS class/DOM-hierarchy path and waiting on a fixed sleep"
    because: "class/hierarchy selectors break on any styling change unrelated to behaviour, and fixed sleeps either fail under slow environments or waste time under fast ones — both are named root causes of E2E flakiness that erode trust in the suite."
---

# visual state verification

Judgement layer for visual and UX quality: which states to look at, how to
verbalize a felt "something's off" into a specific, defensible defect, how to
classify a visual-regression diff, and how to run the three accessibility
self-experiences before reaching for automated metrics.

## Boundary with existing skills

[[browser-testing-and-screen-verification]] owns the **mechanics** of running
live verification at the L10 gate: readiness checks, the baseline →
DOM/network → visual-regression procedure, the security boundary for
untrusted page content, and evidence storage under `.ut-tdd/audit/`. Load that
skill to know **how to execute** a browser verification pass.

This skill owns the **judgement** exercised during that pass, and during
earlier design-time review of prototypes, mocks, or screenshots (L2, L7, L8,
L12): **which states to check, how to describe visual wrongness in
falsifiable terms, how to classify a diff instead of reacting to its size,
and where AI self-assessment of an image should defer to measurement or a
human.** Use both skills together at L10: browser-testing-and-screen-
verification drives the run, visual-state-verification drives what you
actually look for and how you write it up.

## 0. Starting attitude

Most screen bugs are not "the feature doesn't work" — they are "the layout
collapses in a state nobody anticipated." A designer's mock is always one
state with ideal data; a real screen has dozens of states. The first job of
visual verification is therefore not aesthetic judgement but **state
coverage**. The second job is verbalizing the wrongness felt in each state
that was actually covered.

A second attitude: **"looks fine to me" is not a verdict.** Your viewing
conditions (large screen, good vision, fast connection, native-language UI,
mouse input) are not the median user's. Verification means deliberately
looking through conditions that are not your own.

## 1. The 9-state matrix — check every screen against all nine

Verifying one screen means checking, at minimum, these nine states. States
absent from the mock are the ones most likely to be the real bug.

| State | What to check | Typical breakdown |
|---|---|---|
| Empty (0 items) | Is there empty-state guidance? Does it point to a next action? | A blank void; a table with only a header |
| One item | Does singular content stretch the layout awkwardly? | Unnatural copy like "Select all 1 item" |
| Many (upper bound / 10x real usage) | Pagination / virtual scroll; does an aggregate row overflow its digits? | Freezes at 10,000 rows; a total renders as `1e+7` |
| Long text | Longest realistic value (long compound words, a long email, unbroken alphanumerics) — does it wrap or truncate correctly? | Overflow; an ellipsis eats the end of an ID, making it unidentifiable |
| Loading | Skeleton/spinner present; are actions blocked while loading? | A flash of blank screen; a double-click causes a duplicate submit |
| Error | Is what happened and what to do next legible? Is internal detail leaked? | Just "An error occurred"; a stack trace exposed to the user |
| No permission | Are elements the user must not see **hidden**, not merely disabled (existence secrecy)? | A greyed-out button still leaks that the feature exists |
| Partial loss | Broken image, missing optional field, no-avatar fallback | A broken-image icon; a literal `null` rendered |
| Offline / low bandwidth | Does the operation order stay coherent on a slow link? Is reconnect state consistent? | Optimistic update silently rolls back with no explanation |

Cross this with **cross-cutting axes**: viewport width (320px / 768px /
1920px), OS font-size scaling (up to 200%), i18n (target-language string
expansion — e.g. German runs ~1.5x longer than English — and RTL layout for
languages like Arabic), and dark/light theme. The full 9-states × axes cross
product is not realistic to cover exhaustively, so prioritize the
intersections most likely to break: long text × 320px, error × i18n.

## 2. Verbalizing wrongness — turn "something's off" into spec language

A visual critique gets dismissed not because it is subjective but because
**the verbalization stayed subjective**. When something feels wrong, identify
which of these it is before reporting:

- **Alignment** — edges that should align do not. Which element is off the
  grid? "Off by 2px" is a measurement, not an opinion.
- **Proximity** — related items are far apart, unrelated items are close. A
  label that momentarily reads as ambiguous which field it belongs to is a
  proximity failure.
- **Hierarchy** — where does the eye land first? Does decoration outweigh the
  most important action? Do non-equivalent things (a primary button and a
  secondary button) share the same visual weight?
- **Consistency** — is the same meaning expressed the same way? A red button
  for delete on one screen and a plain link on another is not an aesthetic
  quibble — it is a **learned-behaviour bug**. Wording drift (e.g. "save" /
  "register" / "confirm" used interchangeably) should be checked against the
  glossary.
- **Rhythm** — is spacing systematic, or ad hoc? A stray 13px value mixed into
  a spacing scale built on multiples of 4/8/16 is a rhythm break.
- **Feedback** — does the response to an action land in the right latency
  band: 0.1s (feels instant), 1s (keeps flow), 10s (needs a progress
  indicator)? A button with no press feedback is functionally broken even if
  the click handler works.

**Report template**: "In (state), (element) violates (principle above).
Evidence: (measured value / spec reference / concrete confusion
experienced). User impact: (mis-operation / undiscoverable / trust loss)." A
critique that cannot be written in this template has not been observed
closely enough yet.

## 3. Judging visual-regression diffs — the threshold is not a substitute for thinking

When a screenshot-comparison diff appears, follow this order:

1. **Classify the diff before judging it**: (a) an intended change rippling
   outward, (b) environment noise (font rendering, anti-aliasing, dynamic
   data such as dates or random IDs), or (c) a true regression. Pixel-diff
   size is unrelated to this classification — a single vanished 1px border
   can be (c) and severe, while a whole-screen colour shift from renderer
   drift can be (b) and harmless.
2. **Do not absorb (b) by raising the tolerance threshold.** Loosening
   tolerance discards detection power for category (c) equally — it does not
   selectively filter noise, it blinds the check to real regressions of the
   same magnitude. Fix noise at its source instead: mask dynamic regions,
   pin fonts/renderer in the test environment.
3. **Only update a baseline paired with a diff review and linked evidence**
   (PR/ticket). Approving "a diff appeared, so update the baseline" without
   review turns regressions into the new normal one diff at a time.
4. **A zero-diff result is also information.** If a screen was intentionally
   changed and the diff shows zero, suspect the test is not actually looking
   at that screen — a test-suite failure, not a clean pass.

## 4. Accessibility — three lived experiences before checklists

Before running the automated a11y checklist, change your own viewing
conditions and interact with the screen. Experience surfaces concerns that a
checklist alone does not:

1. **Remove the mouse** — can every action be completed with Tab alone? Is
   current focus always visibly indicated (removing the focus ring for
   visual tidiness is a functional break, not polish)? If Tab escapes a modal
   into the page behind it, focus trapping has failed.
2. **Remove colour** — in grayscale, can error / success / selected states
   still be distinguished? "Required fields are marked in red" fails both for
   colour-vision variation (~5% of men) and black-and-white print — the rule
   is dual-encoding: colour plus shape or text, never colour alone.
3. **Close your eyes** — using a screen reader, can you navigate
   heading → landmark → form in order? Check image alt text, labels on
   icon-only buttons, and the field/error association (`aria-describedby`).

Only after these three, apply machine-measurable metrics: contrast ratio
(body text 4.5:1, large text 3:1), touch targets (at least 44×44px), and no
horizontal scroll at 200% zoom. **Let machines measure what machines can
measure (wire axe or an equivalent into CI); reserve human and AI judgement
for what machines cannot measure — natural reading order, whether alt text is
actually substantive rather than perfunctory.**

## 5. E2E/UI test fragility

The single largest reason a UI test suite loses trust is flakiness. Design
behaviour rules to prevent it:

- **Select by semantic identity.** Appearance-derived selectors (CSS class,
  XPath hierarchy) break on any unrelated styling change. Use a test
  attribute (`data-testid`) or accessible name (`role` + label) — the latter
  doubles as an accessibility check.
- **Wait on state, not time.** A fixed sleep is doubly wrong: it fails on
  slow environments and wastes time on fast ones. Wait on an explicit
  condition ("until X is visible") instead.
- **Keep E2E thin.** Full state-matrix coverage (Section 1) belongs at the
  component/snapshot layer. E2E is reserved for a handful of golden paths,
  the same reasoning as a smoke test. If an E2E suite starts accumulating
  boundary-value test cases, the test pyramid has inverted.
- When flakiness is detected, apply the same principle used elsewhere in this
  harness for unreliable signals: do not mask it with retries — identify
  whether the cause is concurrency, waiting, or test-data isolation, and fix
  that cause.

## 6. AI self-awareness when "looking at" a screenshot

Honest limits for an agent performing its own visual judgement:

- **Trustworthy from image inspection alone**: presence/absence of elements,
  obvious overflow or overlap, text content, large layout differences.
- **Less trustworthy**: 1-2px misalignment, subtle colour differences, font-
  rendering variance, animation feel. Switch to measurement (DOM coordinates,
  computed style values) or hand off to a human for these.
- When reporting "no problem found," **state explicitly which of the 9
  states (Section 1) were checked and which were not.** Letting an unchecked
  state fall silently inside an implicit "no problem" verdict is the same
  failure named elsewhere in this harness as the confirmation-test trap.
- When asked for an aesthetic judgement ("does this look polished"), decompose
  the answer into the principle vocabulary from Section 2, and explicitly
  hand off whatever residue does not decompose to taste/preference for a
  human decision.

## External corroboration

- WCAG 2.2 SC 1.4.3 Contrast (Minimum) — https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html (4.5:1 normal text, 3:1 large text, AA)
- Percy, visual regression practice — https://percy.io/blog/open-source-visual-regression-testing-tools (structural + perceptual filtering before human triage; fail builds only on critical diffs)

