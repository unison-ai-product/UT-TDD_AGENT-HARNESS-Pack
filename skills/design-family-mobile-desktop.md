---
schema_version: skill.v1
name: design-family-mobile-desktop
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
  - when: "The platform profile for the product has no mobile client and/or no desktop client."
    choose: "mark the mobile design sub-family (76/77/78/79/81) and/or the desktop design sub-family (82/83/84/85/86) as out-of-scope (structurally absent) in the L2/L4 doc index for whichever client the product does not ship"
    over: "writing thin placeholder docs for the missing client so the doc-family checklist looks complete"
    because: "a product with no mobile client has no offline-sync, push-permission, or store-review decisions to make; a stub doc invents a policy for a client that does not exist and misleads a later reviewer into thinking a real decision was made."
  - when: "Authoring 77 (offline/sync) and the draft states 'optimistic updates with background sync' without naming a conflict-resolution rule."
    choose: "require an explicit conflict policy per data category (e.g. last-write-wins vs. field-level merge) plus the conflict-detection mechanism (server version/ETag) and the escalation path when conflicts cannot be auto-resolved"
    over: "leaving conflict handling as an implied 'sync will work it out' statement"
    because: "the source doc treats conflict resolution as a per-object-type decision ('対象別に定義'), not a blanket policy; an implementation without a named rule per data type will resolve conflicts inconsistently across data types, and a QA test-design author has no scenario to test against without a named rule."
  - when: "Authoring 78 (push notification/device permissions) and the draft requests notification/camera/location permission at app launch."
    choose: "require permission requests to be tied to the specific in-context action that needs them (ask-in-context), with a per-permission-type opt-in/opt-out control and a fallback path (e.g. in-app notification) when the OS permission is denied"
    over: "requesting all device permissions up-front at first launch for simplicity"
    because: "the source doc states permission timing is '文脈が生じた時点' (at the point context arises), not at launch; up-front bulk requests both fail store-review guidelines that require justified, contextual permission requests and produce worse opt-in rates, and the design must also state what happens when a user denies (fallback channel), not just the happy path."
  - when: "Authoring 79 (app distribution/signing/store review) and the release plan assumes the app can ship the same week engineering finishes it."
    choose: "require the design to state the staged-rollout distribution path (internal test -> closed -> open -> production) and name the store review lead time as a scheduling input, cross-referenced to the forced-update policy in 81"
    over: "treating store submission as a same-day publish step with no lead-time buffer"
    because: "the source doc names a four-stage rollout distribution path explicitly and links forced-update policy to device-compat design (81); omitting store review lead time from the design causes release-schedule slippage to be discovered at ship time instead of design time."
  - when: "Authoring 81 (device compat/versioning/battery) and the minimum supported OS version is left undefined."
    choose: "require an explicit minimum-OS-version table per platform (iOS/Android) plus an explicit forced-update policy (below minimum -> blocked and redirected to update) distinct from a soft recommended-update banner"
    over: "leaving OS support as 'we support recent versions' without a numeric floor or a stated forced-update mechanism"
    because: "without a numeric floor, engineering cannot decide which APIs are safe to use, and QA cannot select verification devices; the source doc separates soft recommendation (banner) from hard block (forced update) as two distinct policies, and collapsing them into one vague statement loses that distinction."
  - when: "Authoring 82 (desktop architecture) and choosing between Electron, Tauri, or a fully native toolkit."
    choose: "state the choice against the specific product constraint (web-asset reuse, footprint, or deep OS integration need) and, whichever is chosen, still require the main/renderer process-separation and minimal-privilege IPC boundary to be named explicitly"
    over: "picking a toolkit without documenting the process-separation and IPC-privilege boundary, on the assumption the framework 'handles that'"
    because: "the source doc treats main/renderer separation and least-privilege IPC as a security boundary ('最小権限の橋渡し/検証'), not a framework default; skipping this in the design leaves the IPC surface unreviewed until an implementation-time security finding."
  - when: "Authoring 84 (auto-update) and the update mechanism downloads and applies updates without a rollback path."
    choose: "require the design to state: staged/percentage rollout, signature verification before applying an update (cross-referenced to 85), and an explicit rollback-to-previous-version path on failure or corruption detection"
    over: "designing auto-update as a one-way apply-and-restart flow with no rollback or staged-rollout containment"
    because: "the source doc explicitly separates update download, signature-verified apply, and failure rollback as three distinct required behaviors ('失敗時は現行バージョンを維持' / '破損検知で前版へロールバック'); an update path with no rollback turns a single bad build into a fleet-wide outage with no recovery path."
  - when: "Authoring 85 (code signing/notarization) for a desktop app targeting macOS."
    choose: "require the design to state Apple notarization as a mandatory step (not just Developer ID signing) and name where the signing key is held (KMS/HSM) and how key compromise is handled (revocation/re-signing procedure)"
    over: "treating Developer ID code signing alone as sufficient for macOS distribution"
    because: "the source doc marks Apple notarization as '必須' (mandatory) distinct from signing itself — an app that is signed but not notarized is blocked or warned by macOS Gatekeeper at first launch; the design must also state key-compromise handling, since a signing key is a supply-chain trust root."
---

# design family: mobile & desktop clients

Design-document contract for the native-client design families (mobile:
76/77/78/79/81; desktop: 82/83/84/85/86): what each document must contain
before it is usable as a spec for downstream test design and implementation.
This skill governs document *content completeness*, not verification
mechanics.

## When to load this skill

- Authoring or reviewing any mobile design doc (mobile architecture,
  offline/sync, push/device permissions, app distribution/store review,
  device compat/versioning/battery) or desktop design doc (desktop
  architecture, packaging/installer, auto-update, code signing/notarization,
  OS integration).
- Deciding whether the mobile and/or desktop design sub-family applies to a
  product at all (platform-profile check).
- A PLAN's pair-freeze needs one of these docs and it is missing or thin.

## Platform-profile conditioning (read first)

Each sub-family exists only because the product ships that client type.
Check the platform profile before authoring:

- **Product has a mobile client**: the mobile sub-family (76/77/78/79/81) is
  in-scope.
- **Product has a desktop client**: the desktop sub-family (82/83/84/85/86)
  is in-scope.
- **Product has neither** (web-only or API-only): mark both sub-families
  out-of-scope as a structural-absence note in the L2/L4 doc index. Do not
  write placeholder docs for a client the product does not ship — a stub
  offline-sync doc for a product with no mobile app invents conflict-
  resolution policy for data flows that do not exist, and a later reviewer
  cannot distinguish "decided, thin" from "does not apply."
- A product may ship one client type without the other (e.g. desktop but no
  mobile) — apply this conditioning per sub-family independently, not as a
  single all-or-nothing gate.

## Mobile sub-family: MUST-contain items

### 76 — Mobile app architecture (MVVM / navigation)

- Explicit architecture layering (Presentation/ViewModel, Domain, Data) with
  the responsibility of each layer stated, not just "we use MVVM."
- Native vs. cross-platform framework choice tied to a stated product
  constraint.
- Navigation/screen-transition map per major screen.
- State-restoration behavior across rotation/process-death, and dependency
  injection strategy for testability.

### 77 — Offline / sync / local persistence

- Local persistence choice per data category (embedded DB for business data,
  key-value for settings/flags, secure storage for tokens/credentials) — not
  a single blanket storage mechanism.
- Sync mechanism per data category (change-queue + push/pull merge for
  business data, push-plus-delta-fetch for notifications, etc.).
- **Explicit conflict-resolution policy**: named per data category (e.g.
  last-write-wins vs. field-level merge), an explicit conflict-detection
  mechanism (server version/ETag), and an escalation path (user
  confirmation) for conflicts that cannot be auto-resolved — a generic
  "sync handles it" statement is not a decision.

### 78 — Push notification / device permissions

- Notification channel and trigger mapping per event type.
- **Ask-in-context permission timing**: each permission request tied to the
  specific action that needs it, not requested in bulk at launch.
- Per-permission-type opt-in/opt-out control, and a stated fallback (e.g.
  in-app notification list) for when the OS permission is denied.
- How opt-out is propagated to the server-side delivery configuration.

### 79 — App distribution / signing / store review

- Signing/provisioning elements named per platform (iOS certificate +
  provisioning profile; Android upload key / Play signing).
- Store-review considerations per store (in-app-purchase applicability,
  permission-usage justification text, privacy label/data-safety
  disclosure) — named explicitly per store, since App Store and Google Play
  requirements diverge.
- **Staged rollout path** stated explicitly (internal test -> closed ->
  open -> production), with store review lead time treated as a scheduling
  input, cross-referenced to the forced-update policy (81).

### 81 — Device compatibility / versioning / battery

- Explicit minimum-OS-version table per platform (iOS/Android), plus
  supported screen-size/resolution range.
- Two distinct update policies: soft **recommended update** (banner) vs.
  hard **forced update** (below-minimum versions blocked and redirected) —
  these must not be collapsed into one vague "keep users updated" statement.
- Battery/network optimization measures per area (background
  processing/sync limits, batching/compression/retry policy for network,
  minimal use of location/sensors).
- Crash-reporting and stability-monitoring mechanism, with a stated
  escalation path to incident response for severe crash-rate regressions.

## Desktop sub-family: MUST-contain items

### 82 — Desktop app architecture

- Framework choice (Electron / Tauri / fully native) justified against a
  named product constraint (web-asset reuse, resource footprint, depth of
  OS integration needed) — not chosen by default.
- **Main/renderer process separation and IPC boundary named explicitly**,
  including that IPC exposes the minimum privilege surface and validates
  input — this is a security boundary, not something left implicit because
  "the framework handles it."
- Screen/feature mapping for the desktop client's primary screens.

### 83 — Packaging / installer design

- Platform-specific installer artifact format named per OS (e.g. MSI/MSIX
  for Windows, DMG/pkg for macOS, AppImage/deb/rpm for Linux), with the
  macOS artifact cross-referenced to the notarization requirement (85).
- Install location policy (per-user vs. system-wide) and explicit
  uninstall-data-handling policy (retain vs. delete user data).
- Runtime bundling and per-architecture (x64/arm64) build strategy.

### 84 — Auto-update design

- Update-delivery mechanism (background download, differential/delta
  update where applicable) and channel model (e.g. stable/beta).
- **Staged/percentage rollout** for update delivery, to contain the blast
  radius of a bad build.
- **Signature verification before applying an update**, cross-referenced to
  85 — an update must not be applied unless its signature validates.
- **Explicit rollback path**: current version is retained on update failure,
  and corruption detection triggers rollback to the previous version — an
  update design with no rollback path is a one-way failure mode.

### 85 — Code signing / notarization

- Platform-specific signing mechanism named (e.g. Authenticode with
  EV/OV certificate for Windows, Developer ID signing for macOS, GPG/
  repository-key signing for Linux).
- **Apple notarization treated as a mandatory step distinct from signing**
  for macOS — signed-but-not-notarized apps are blocked/warned by
  Gatekeeper, so notarization must be a named required step, not assumed
  to be covered by signing alone.
- Key/certificate custody stated explicitly (KMS/HSM-backed, accessed from
  CI) plus a stated **key-compromise procedure** (revocation and
  re-signing), since the signing key is a supply-chain trust root.
- Verification-on-consumption: distributed artifacts and update packages
  (84) have their signatures checked before execution/application, with
  tamper detection blocking execution.

### 86 — OS integration design

- OS-native UI integration points named (menu/shortcuts, tray/menu-bar
  presence, notification surface) and their intended use.
- **Auto-launch left under explicit user control** (opt-in at login), not
  silently enabled by default.
- File-association and custom-protocol-handler registration named
  explicitly (e.g. `product://` deep links), with the target screen for
  each handled link stated.
- Notification behavior respects OS focus/do-not-disturb state, and
  clicking a notification routes to a named in-app screen.

## Characteristic omission per document (what reviewers most often miss)

| Doc | Most common omission |
|---|---|
| 76 Mobile architecture | Layer responsibilities stated as a label only ("MVVM") with no per-layer responsibility breakdown |
| 77 Offline/sync | Conflict-resolution policy implied ("sync will work it out") rather than named per data category |
| 78 Push/device permissions | Permissions requested in bulk at launch instead of ask-in-context; no denied-permission fallback stated |
| 79 App distribution/store review | Store review lead time absent from the release schedule; staged rollout path skipped |
| 81 Device compat/versioning | No numeric minimum-OS floor; soft recommendation and hard forced-update collapsed into one policy |
| 82 Desktop architecture | Main/renderer + IPC privilege boundary left implicit, assumed to be "handled by the framework" |
| 83 Packaging/installer | Uninstall data-handling policy (retain vs. delete) left unstated |
| 84 Auto-update | Rollback path missing — update flow designed as one-way apply with no failure recovery |
| 85 Code signing/notarization | macOS notarization omitted or conflated with signing; key-compromise procedure absent |
| 86 OS integration | Auto-launch defaulted to on instead of explicit opt-in |

## Boundary: this skill vs. verification skills

This skill defines what the **design documents** in the mobile/desktop
client families must contain as a written spec. It does not cover:

- How to mechanically verify rendered UI state, layout, or visual regression
  on device/emulator — see `visual-state-verification`.
- How to drive and assert against a running app/browser during test
  execution (automation mechanics, screenshot diffing, harness setup) — see
  `browser-testing-and-screen-verification`.

If a decision point is about *what the spec must say* (e.g. what conflict
policy or update-rollback behavior the design commits to), it belongs here.
If it is about *how to check the running product against that spec*, route
to the verification skills above.
