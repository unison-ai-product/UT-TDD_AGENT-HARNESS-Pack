> **正本化済** (PLAN-REVERSE-01 で DISCOVERY-04 dogfood 実績から正本化、2026-06-04)。docs/process は forward/modes/gates の運用正本。規範変更は concept/requirements (上位正本) 先行 → 本 dir へ反映する。

# 駆動モデル (mode) 定義 — index + 正本台帳

出典: concept v3.1 §2.5 (9-mode ecosystem) / §2.6 (signal→mode 配線) / requirements v1.2 §1.3 VALID_KINDS / §1.5 workflow_phase / §1.6 VALID_DRIVES / §1.8 VALID_ROLES

---

## 1. mode とは

mode (駆動モデル) は **「入口条件」と「文脈遷移 (昇華)」だけを規定**し、**出口は必ず Forward L0-L14 (`../forward/`) に合流**する (concept §2.5)。入口を散らさず工程を一本化するための分類であり、完了先 (設計・実装・検証・運用の同一接続) を分断しない。

Forward (本体) は `../forward/` に定義する。本 dir は **Forward 以外の駆動モデル** を 1 ファイル 1 モードで定義する。

---

## 2. 正本台帳 (mode ↔ kind / drive / phase / Forward 合流)

> **4 軸 (kind / layer / drive / workflow_phase) の意味**は [../README.md §1](../README.md) を参照 (drive = 「どの技術軸で作るか」等)。本台帳の列はこの 4 軸 + owner/承認者/Forward 合流。
>
> **重要 (なぞらず翻案)**: source process reference の workflow ファイル名と UT-TDD の `kind` (§1.3 12 種) は **1:1 でない**。Incident / Add-feature は独立 kind を持たず複数 kind を内包し、Discovery / Scrum は同一 `kind=poc` だが **mode (入口) が異なる** (drive ではなく mode で区別。drive は両者とも対象 work の専門職)。本台帳が mode と frontmatter taxonomy の対応の正本。
>
> **drive 列について (V7 再設計済、§1.6)**: drive = 専門職 5 種 (be/fe/fullstack/db/agent) のみ。横断駆動 (Discovery/Scrum/Reverse/Recovery/Incident) は **対象 work の専門職を継承**する (旧 `poc/scrum/reverse/troubleshoot` を drive にする運用は廃止 = V7)。

| mode | file | kind (§1.3) | drive (§1.6、専門職) | layer | workflow_phase (§1.5) | owner (§2.5) | 承認者 (§2.6.3) | Forward 合流点 |
|------|------|-------------|--------------|-------|----------------------|--------------|------------------|----------------|
| **Discovery** | [discovery.md](discovery.md) | `poc` | 専門職継承 (be/fe/fullstack/db/agent) | `cross` | **S0-S4** | po + tl | — | confirmed → L1 (要求) / L3-L6 設計 (終点で Reverse 昇華) |
| **Scrum** | [scrum.md](scrum.md) | `poc` | 専門職継承 | `cross` | **S0-S4** | po + aim | — | S4 decide → L1 (increment は Reverse fullback で昇華) |
| **Reverse** | [reverse.md](reverse.md) | `reverse` | 専門職継承 (逆引き対象) | `cross` | **R0-R4** | tl | po (R3 Intent 検証、§1.8 fail-close) | R4 `forward_routing` → L1/L3/L4/L5/gap-only (schema enum) |
| **Recovery** | [recovery.md](recovery.md) | `recovery` | 専門職継承 (復旧対象、例 fullstack) | `cross` | **禁止** (phase なし) | tl + po | tl (再開点) + po (スコープ) | 収束後 → 中断工程 / 再発防止 → L14 |
| **Incident** | [incident.md](incident.md) | `troubleshoot` + `recovery` (内包) | 専門職継承 (障害対象) | `L7` (troubleshoot) / `cross` (recovery) | 禁止 | オンコール + tl + pm | オンコール + tl + pm の三者 | 収束後 → L12/L13 / 恒久対策 → L1-L6 / postmortem → L14 |
| **Refactor** | [refactor.md](refactor.md) | `refactor` | `be/fe/fullstack/db/agent` | `L7` | 禁止 | se + tl | — | L7 内部改善のみ (L8/L9 を保護網に流用) |
| **Retrofit** | [retrofit.md](retrofit.md) | `retrofit` | `be/fe/fullstack/db/agent` | `L7` | 禁止 | se + tl | config_drift は tl 単独 | upgrade 後 → L4 / 影響範囲 L4-L7 / 要件変更 → L1/L3 |
| **Add-feature** | [add-feature.md](add-feature.md) | `add-design` + `add-impl` (内包) | 親 PLAN と一致 | `L3-L7` | 禁止 | aim + tl | — | 既存維持 + L3/L7 差分 (影響範囲へ直接接続) |
| **version-up** | [version-up.md](version-up.md) | 親 kind 維持 + `version_target` (新 kind なし) | 対象 work 継承 | 対象実 layer | 禁止 | aim + tl + po | po (将来版活性化) | 将来版活性化時 → add-feature で L2/L3→L7 合流 |
| **Research** | [research.md](research.md) | `research` | `be/fe/fullstack/db/agent` | `L1-L4` | 禁止 | tl | — | ADR が L1 要求 / L4 基本設計の判断材料 |

> **multi-kind セルの読み方 (§1.10 排他制約と整合)**: Incident の `L7 (troubleshoot) / cross (recovery)` や Add-feature の `add-design + add-impl` のように 2 kind を内包する mode は、**1 PLAN = 1 kind = 1 layer** が原則 (§1.10 排他: 横断駆動 kind→layer=cross / それ以外→単一実 layer)。Incident は **troubleshoot として起票するなら layer=L7、recovery として起票するなら layer=cross** であり、両者を 1 PLAN に同居させない (障害対応の中で復旧が必要なら recovery PLAN を別途起こす)。表の「/」は OR (kind に応じた択一) であって 1 PLAN への両載せではない。

---

## 3. 9-mode ecosystem との対応 (concept §2.5)

concept §2.5 の **9-mode** は **Forward + 上表 8 mode (Research を除く)**。本 dir の 9 ファイルは「Forward を除き Research を加えた」構成 (Forward は `../forward/`、Research は §1.3 VALID_KIND / `research/*` ブランチとして mode 化)。

| 区分 | mode |
|------|------|
| 本体 | Forward (`../forward/`) |
| 経路 2 系 | Reverse / Discovery / Scrum |
| 経路 3 系 | Add-feature |
| 補助 1 系 | Recovery / Incident |
| v3.1 新規 | Refactor / Retrofit |
| 前段調査 | Research (§2.5 9-mode 外。kind/branch として正本) |
| **工程専門** (mode でない) | screen-design (Forward L2 内) / frontend-design (Forward L10 内) — concept §2.5、独立経路にせず Forward 設計文脈の工程専門として運用 |

---

## 4. signal → mode 自動 routing (concept §2.6.1、機械化目標)

| signal | mode |
|--------|------|
| `drift` (schema/contract) | Reverse (normalization) |
| `debt_degradation` / `code_smell` / `structural` | Refactor |
| `dependency_outdated` / `upgrade` / `config_drift` | Retrofit |
| `agent_runaway` / `context_exhaustion` / `regression_dev` / `runaway` | Recovery (承認必須) |
| `production_incident` / `hotfix_required` / `regression_prod` (env=prod) | Incident (承認必須) |
| `feature_addition` / `scope_extension` | Add-feature |
| `version_deferral` (将来版へ保全) | version-up |
| `user_feedback_iteration` / `requirement_continuous_refinement` | Scrum |
| 要件未確定 / 実現性不透明 | Discovery |

`env=prod` / regression 系は優先的に Incident / Recovery に倒す。本番→Incident・開発中→Recovery で分岐 (§2.6.5)。

---

## 5. 共通原則 (全 mode 共通)

- **出口 = Forward 合流**: どの mode も最終的に L0-L14 へ戻る。mode 固有で設計・テスト・検証を完結させない。
- **承認境界**: Recovery / prod Incident / config_drift Retrofit は人間サインオフ必須 (§2.6.3、承認者は本台帳列)。
- **execution mode 参照**: cross-agent review が self-review に化けないよう判断ゲートは `ut-tdd status` の execution mode を参照する (§2.6.4 / §2.1.2.1)。
- **mode 連鎖**: Discovery 終点 → Reverse 昇華 / Scrum increment → Reverse fullback / Incident・Add-feature の前段に Discovery (要件未確定時) or Reverse (既存逆引き時) / Retrofit の影響評価前段に Reverse (`upgrade`) / Research で「作れるか不明」→ Discovery 切替 / **Add-feature (最頻) の bottom-up build (L6/L7) → 後段 Reverse fullback で L3 要件 back-fill (常態、add-feature.md §1.1 経路 B)**。

---

## 6. git ライフサイクル (Issue 起点スパイン、利用者チーム向け仕様)

> **正本 = requirements §6.8 / §6.9**。本節はその mode 別要約。**harness 利用者チームに課す製品仕様**であり、harness 開発者 (solo/main 直) の手順ではない (Phase 0-A では緩和、Phase 0-B で有効化、§6.5)。

全 mode は **問題/signal 起点 → Issue → PLAN → branch → PR+CI → merge+close** の一本道に乗る (§6.8.1)。Forward も「発注元 Issue (要件)」起点。

| mode | 起点 (Issue 化する signal) | branch prefix (§6.1) | merge/CI 単位 (§6.9) | close |
|------|---------------------------|----------------------|----------------------|-------|
| Forward (design) | 発注元要件 Issue | `design/*` | 設計 PLAN/hub 完了 PR で vmodel-lint CI | hub merge |
| Forward (impl) | 同上 | `feature/*` | **G7 trace freeze で全量 CI (本命アンカー)** | G7 merge |
| Discovery / Scrum | requirement_undefined / user_feedback | `poc/*` | **CI 回さない** (使い捨て)。confirmed→Reverse→`feature/*` | Reverse 合流時 |
| Reverse | drift / fullback | `reverse/*` | R4 routing 先 `feature/*` の G7 | Forward 合流時 |
| Incident / Recovery | regression_prod / regression_dev | `hotfix/*` | 緊急 harness-check サブセット | hotfix merge + 恒久対策は別 Issue |
| Add-feature | feature_addition | `add/*` | 親 PLAN と同 PR | merge → **最頻は後段 `reverse/*` で L3 要件 back-fill** (§1.1 経路 B) |
| Refactor / Retrofit | debt_degradation / dependency_outdated **or improvement-backlog** | `refactor/*` | L7 内 G7 | merge |

**右腕 (L8-L14) は post-merge/scheduled CI** で、失敗時は §6.8.4 に従い **Issue を自動起票 → Recovery/Incident/Add-feature で差し戻し**。poc/* は merge せず CI 分を浪費しない (§6.4)。粒度は **1 Issue = 1 PLAN/hub = 1 branch** (§6.8.2)、PLAN frontmatter `github_issue_id` で close 漏れ機械検知。

## 7. このドキュメントの位置付け

本台帳および各 mode 定義は **正本化済** (PLAN-REVERSE-01、2026-06-04)。gate の機械検証条件は [../gates.md](../gates.md)、git ライフサイクルの正本は requirements §6.8/§6.9。

## MCP-VERIFICATION-PROFILE-WORKFLOW

All modes inherit the MCP / external verification profile rule from requirements §6.8.10.

- Modes may recommend MCP servers or external test foundations only by emitting workflow signals and profile recommendations.
- Add-feature / Refactor / Retrofit discoveries that add a profile, plugin, MCP server, or test foundation must classify the change with `backprop_decision`.
- Recovery and Incident may use MCP/browser/GitHub profiles for diagnosis, but credentialed write actions require human approval.
- Discovery and Scrum can use profiles as PoC evidence, but confirmed outcomes still need Forward or Reverse back-fill.
- Profile availability is environment state. Missing Docker, browser, auth, or MCP server installation creates a finding; it does not invalidate unrelated local checks.
- Accept/close requires normalized evidence when a profile rule is enabled for that mode or gate.

## CANONICAL-DOCUMENT-EXPORT-WORKFLOW

All modes inherit the canonical document export rule from requirements §6.8.11.

- Concept, requirements, detailed design, PLAN, ADR, and test-design documents may be converted to CSV/Markdown/XLSX/PPTX only as derived artifacts.
- Add-feature / Reverse / Recovery / Retrofit discoveries that require new export surfaces must classify the change with `backprop_decision`.
- CSV and Markdown summary exports are built-in document conversion outputs.
- XLSX/PPTX exports require renderer readiness evidence and must not install ExcelJS / SheetJS / PptxGenJS / D2 implicitly.
- Exported spreadsheets/decks must preserve source document paths, section IDs, FR/AC/AT/PLAN/ADR IDs, status, trace, and evidence links.
- Generated files are stale when source document digests change, and they cannot be used as current evidence until refreshed.
- Human decisions made from exported files must be recorded as normal review/gate/handover evidence before accept/close.

## TOOL-ADAPTER-WORKFLOW

All modes inherit the optional tool adapter rule from requirements §6.8.9.

- Dependency-cruiser, Knip, Madge, Graphviz, Mermaid, and D2 are optional adapters, not source-of-truth systems.
- Modes may recommend adapters only through workflow signals and readiness probes.
- Missing package/executable/config readiness creates a finding and must not trigger implicit installation.
- Adapter raw output remains bounded evidence; normalized DB rows are the only gate-consumable output.
- Auto-fix/delete behavior remains out of scope without a human-approved PLAN and rollback evidence.

## LOWER-L-REVERSE-BACKPROP

All modes inherit the whole-system consistency rule from requirements v1.2 §6.8.8. If a lower-layer task (L4-L14) creates or discovers an addition, ticket, acceptance change, DB projection, guardrail, workflow rule, or automation rule, the mode must classify it with `backprop_decision`.

- `local_impl_only`: close locally only when upstream requirements/design/acceptance are unchanged and the audit records why.
- `requires_design_normalization`: route to Reverse `normalization` / `design` and back-fill L4-L6 or test-design.
- `requires_requirement_backprop`: route to Reverse `fullback` / `design` and back-merge L1/L3 FR/AC/AT/registry before Forward completion.
- `requires_concept_policy`: stop for human policy judgment, then update concept / requirements before Forward resumes.

This applies to Add-feature bottom-up work, Recovery/Incident regressions, Retrofit impact findings, Refactor discoveries, right-arm verification failures, and improvement-backlog items. A mode cannot claim accept/close while a `requires_*` back-prop decision is open.

## CODING-RULE-WORKFLOW

All modes use the coding-rule SSoT as a workflow artifact.

- SSoT: `docs/governance/coding-rules.md`.
- Issue -> PLAN -> branch -> PR+CI must preserve coding-rule impact: `unchanged`, `updated`, or `not_applicable`.
- Any mode that changes TypeScript/Bun implementation style, lint tooling, naming, typing, error-handling, or generated-code boundaries updates the SSoT before implementation freeze.
- Machine gate: `ut-tdd doctor` runs `checkCodingRules`; missing workflow placement or missing SSoT reference is a hard failure.
## DDD-TDD-WORKFLOW

- SSoT: `docs/governance/ddd-tdd-rules.md`
- Mode-specific changes still inherit domain-boundary, invariant trace, Red-first evidence, oracle-strength, and integration GWT checks.
- Quantitative checks and qualitative review are separate steps, but freeze-significant decisions require both.
## TDD-STYLE-DRIVE-FIRING

The drive models do not all use the same Red/Green shape, but several can be
managed as TDD-style loops. The common rule is:

- Red: a test, design, dependency, DB projection, or evidence gap is observed.
- Yellow: a PLAN/target exists, but the regression/design/dependency fence is
  not closed.
- Green: the paired evidence IDs exist, required commands pass, relation impact
  is closed, and review happens after Green evidence.

| Target | Fit | Red trigger sources |
| --- | --- | --- |
| Forward design / `kind=design` | strong | `descent_obligation_missing`, `pair_artifact_missing`, `test_design_missing` |
| Add-feature | strong | `feature_addition`, `scope_extension`, `acceptance_gap` |
| Refactor | strong | `code_smell`, `structural`, `debt_degradation`, `artifact_progress_red` |
| Reverse | strong | `drift`, `schema_contract_gap`, `as_is_test_design_missing` |
| Retrofit | strong | `dependency_outdated`, `upgrade`, `config_drift`, stale `dependency_edges` |
| Recovery / Incident | strong | `regression_dev`, `regression_prod`, `forced_stop`, failing `quality_signals` |
| screen-design | strong | `screen_requirement_gap`, `wireframe_missing`, `screen_impl_pair_gap` |
| frontend-design | strong | `a11y_regression`, `visual_regression`, `token_drift`, UX feedback |
| Discovery / Scrum | partial | uncertainty or user feedback converted to hypothesis/increment verification |
| Research | weak | decision evidence and ADR readiness, not a normal Red-Green loop |

DB firing sources are `findings`, `quality_signals`, `feedback_events`,
`graph_nodes`, `dependency_edges`, `impact_results`, and `artifact_progress`.
They create workflow signals or PLAN inputs only; they do not directly rewrite
authored PLAN/docs/source. The machine-readable contract is
`classifyDriveTddFits` in `src/workflow/contracts.ts`.
