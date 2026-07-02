# UT-TDD-agent-harness 構想書

- **Version**: 3.1
- **位置付け**: 構想書 (L1 概念層) / 要件定義書は別ファイル
- **対応構想書**: AI駆動開発チーム構想書 v1.1
- **対応運用ルール書**: AI駆動開発チーム運用ルール書 v1.1
- **工程層体系**: v3.1 で **V2 source snapshot reference の L0-L14 + V-model を base に採用** (source snapshot は翻案元 reference)
- **想定実装エージェント**: Claude Code (複雑タスク・設計判断) / Codex (自律実行・並列処理)
- **対象 OS**:
  - Windows / macOS / Linux: ネイティブ動作を第一級対応
  - Windows: PowerShell entrypoint を提供し、Git Bash 依存を局所化する
  - macOS / Linux: POSIX shell entrypoint を提供する
  - WSL2: 任意の互換実行環境。必須条件にはしない
  - CI: `ubuntu-latest` を基準にしつつ、Windows smoke を追加する
- **対象リポジトリ言語**: 言語非依存 (`ut-tdd` の test adapter / repository-local test command で吸収)

## 本書の位置付け

本書は **構想書 (concept document)** として、**WHY / WHAT / どう繋がるか** のみを定義する。**HOW** は別ファイル `ut-tdd-agent-harness-requirements_v1.2.md` (要件定義書) で定義し、さらに各 enum・スクリプト・workflow YAML の **詳細実装** は L5 詳細設計 PLAN で詰める。

| ファイル | 役割 | 抽象レベル |
|---------|------|------------|
| 本書 (構想書 v3.1) | 概念 / モード / 経路 / 配線 / 補助軸 / 役割 | L1 概念 |
| 要件定義書 v1.2 | 受入条件 / enum / fail-close 条件 / Phase 0 受入条件 | L1-L3 要件 |
| 個別 PLAN-XXX (将来) | validator 実装 / workflow YAML / hook script | L5 詳細設計 |

## v3.0 の主旨 (v2.1 からの分離 + TL Round 3 Critical 反映)

v2.1 (2215 行) を構想書 v3.0 と要件定義に分離し、現行要件は v1.1 を正本とする。Round 3 で TL から指摘された **概念レベルの Critical 5 件** を本書で fix:

| # | 元 Critical | v3.0 での fix |
|---|-------------|---------------|
| C1 | Pair freeze 工程曖昧 | §2.3 / §3 で **L4 前 = ①⇔③ペア freeze (G2/G3)** と **L4 後 = ②⇔④含む 4 artifact trace freeze (G4)** を明示分離 |
| C4 | R1 skip 判定が scrum_type 固定 | §4.4 で「R1 skip 判定は解決済み reverse_type を主キーに」と概念明記 (詳細は要件定義書 §3) |
| C6 | Required Status Checks の OR/skip 前提誤り | §7.2 で「共通 required check 1 本に集約し内部で branch type 分岐」と方針確定 |
| C7 | failure_log の git 管理矛盾 | §8.5 で「failure_log は local 個人作業ログ。チーム共有 audit は別経路」と明記 |
| C8 | escalation level +1 漸進設計 | §8.3 で「level は閾値を満たす最大値を冪等に算出 (差分 +1 ではない)」と明示 |
| I22 | 用語集「4 文書」誤り | §10 で「4 artifact (2 文書 + 2 コード成果物)」へ修正 |

## v3.1 の主旨 (V2 工程・モード・配線の取り込み)

v3.1 は、参照 snapshot V2 (source snapshot reference) の **開発工程・開発モード・配線 (routing/injection)** を UT-TDD のチーム開発向けに翻案して取り込む。コード/state DB は取り込まず、**工程・フロー・仕組み**を概念層に統合する。

| # | 取り込み | v3.1 での反映 |
|---|----------|---------------|
| V1 | **L0-L14 + V-model** 工程体系 | §3 を V2 の 15 工程 + 左右対 (L1↔L14 / L2↔L10 / L3↔L12 / L4↔L9 / L5↔L8 / L6↔L7) に作り替え。旧 L0-L11+小数層は廃止し L0-L14 へ remap (要件定義書 §1.4 VALID_LAYERS 連動) |
| V2 | **9-mode ecosystem** | §2.5 新設。入口を 9 mode + 2 工程専門に分け、出口は必ず Forward L0-L14 へ合流。Discovery / Refactor / Retrofit / screen-design / frontend-design を新規追加し、旧「経路 2/補助 1」を mode へ格上げ |
| V3 | **配線 (signal→mode→command + layer-context 注入 + 横断検出)** | §2.6 新設。検出 signal からの mode 自動 routing、推奨コマンドの機械契約 (safety フラグ)、drive×layer の `orchestration_mode` 注入、横断検出器を概念化 |
| V4 | **orchestration_mode** | §2.6 で drive×layer 別の「誰が判断し誰が実装するか」を 5 値 (pm_lead / claude_judge / claude_judge_codex_impl / codex_impl_qa_verify / claude_design_impl) で定義。実行モード (§2.1.1) より細粒度 |
| V5 | **工程別アンチパターン** | §3.5 新設。AI 実装が踏みがちな V-model 違反を概念列挙 |

**チーム翻案の原則** (V2 の個人前提 → UT-TDD のチーム前提):

- V2 の legacy runtime command・個人絶対パス・legacy DB 依存は持ち込まず、`ut-tdd *` 相当・`.ut-tdd/` state・package-local に読み替える (要件定義書 §7 で機械化)。
- V2 の「PM=AI / PO=本人」固定を、**PM/TL/PO が別々の人間**になる前提へ翻案。各ゲートは人間サインオフ点、`safety.requires_human_approval` は「誰の承認か」を具体化する (§2.6 / §9)。
- cross-agent review は「人を跨ぐレビュー」へ拡張 (§9、要件定義書 §6 CODEOWNERS)。
- `vendor source snapshot` は read-only。V2 文言は概念参照のみで、UT-TDD 正本は本書と要件定義書に再記述する。

---

# §1 Why — なぜ UT-TDD-agent-harness か

## 1.1 チーム開発で起こる 4 問題

構想書 v1.1 / 運用ルール書 v1.1 + AI 駆動開発の現実観察から、以下 4 問題が常態化している:

| # | 問題 | 具体的影響 |
|---|------|------------|
| **P1** | 設計・実装・テストの乖離 | AI が「テストも書いた」と言うが設計 doc とテストコードが対応しない、逆ピラミッド化 |
| **P2** | 役割境界が曖昧 | TL/QA/AI実装・保守/UI/UX/発注元 の責任が PR ごとに食い違う、CODEOWNERS 未整備 |
| **P3** | PoC が独り歩き | 仮説検証で書いた PoC コードが本実装で再実装される、知見が文書化されない |
| **P4** | 既存実装への破壊的追加 | AI が「より良い形」と称して既存設計を改変、既存テストを書き換えて回帰検知不能 |

`UT-TDD-agent-harness` はこの 4 問題に **3 つの実装経路 + 4 つの補助軸** で構造的に対処する。

## 1.2 名前の意味

| 部分 | 意味 |
|---|---|
| **UT**(Unit Test) | 機能設計 ① + 単体テスト設計 ③ + 単体テストコード ④ の triple freeze。設計とテストの 1:1 対応を機能粒度で強制 |
| **TDD**(Test-Driven Development) | 設計 ① ↔ テスト設計 ③ pair freeze。テスト設計 doc が無ければ実装段階に進めない |
| **agent** | AI 実装 (② コード) が ① 設計と ④ テストコードに挟まれる構造で、AI を「設計とテストの間の自動化層」として位置付ける |
| **harness** | 上記を YAML / hook / GitHub Actions で **機械強制** する土台 (構想書 v1.1 用語集「AI エージェントを安全に動かす土台」) |

## 1.3 既存 2 構想書との関係

本書は以下 2 文書を **前提とした実装層** であり、置換するものではない:

| 文書 | 役割 | 本書との関係 |
|---|---|---|
| 構想書 v1.1 | チーム構造・理念・5 段階セキュリティ | 本書 §2-§9 でこれを実装層に落とす |
| 運用ルール書 v1.1 | 日常フロー・PR/ブランチ規約・インシデント | 本書 §6-§7 + §9 でこれを CI / ハーネス層に組み込む |

3 文書は `docs/governance/` 配下に共存する:

```
docs/governance/
├── ai-dev-team-concept_v1.1.md
├── ai-dev-team-operations_v1.1.md
├── ut-tdd-agent-harness-concept_v3.1.md
└── ut-tdd-agent-harness-requirements_v1.2.md
```

## 1.4 失敗を仕組みに変換する原則

UT-TDD Agent Harness は、失敗事例を隠すための管理ツールではない。AI 開発で実際に起きる失敗を観測し、次回以降の実行品質を上げるための **再利用可能な制御構造** に変換するための harness である。

失敗は以下のように扱う。

| 失敗の種類 | 変換先 | 目的 |
|---|---|---|
| 設計・実装・テストのずれ | `vmodel_lint` / trace freeze / 追加 PLAN | 同じ不整合を次の PR で再発させない |
| レビュー指摘・テスト不足 | L6 QA 追加テスト設計 / regression test / `test-pack` | 指摘を一回限りのコメントで終わらせない |
| session 断絶・認識ずれ | `handover` / `recovery` PLAN / failure log | 次の AI session が同じ前提誤読から始まらない |
| PoC の独り歩き | Reverse R0-R4 / `promotion_strategy` | 検証成果を契約化してから Forward に合流させる |
| 繰り返し失敗 | escalation L0-L3 / postmortem / debt register | 閾値を超えた時点で人間判断へ戻す |
| AI 判断の過信 | cross-agent review / `frontier-reviewer` | 同一 AI / 同一モデルによる自己承認を避ける |

このため、UT-TDD では「失敗をログに残す」だけでは不十分とする。失敗は、可能な限り **gate、validator、test、skill pack、handover、postmortem、orchestration policy** のいずれかに還元する。

チーム共有の失敗 corpus はローカル作業ログではなく、GitHub を正本にする。PR / GitHub Actions / Checks / job summary / artifact / label / review comment から失敗 event を pull し、同種失敗の反復、失敗種別、再発防止の有無を集計する。ローカル `failure_log.jsonl` は個人 advisory に留め、組織としての学習・escalation・regression 化は GitHub 上の証跡から行う。

---

# §2 ハーネスの設計骨格

## 2.1 3 経路 + 4 補助軸

UT-TDD-agent-harness は **チーム開発で発生する全実装パターン** を 3 つの経路で網羅し、4 つの補助軸で支える。

### 2.1.0 2 つのマスト原則 (runtime 非依存性)

実行主体 (Claude Code / Codex) が変わってもハーネスが破綻しないために、以下 2 点を **MUST** とする。これが満たされない実装・運用は受入不可。

1. **ルール同一性 (rule parity)** — Claude Code と Codex は **同じルールで動く**。gate / V-model / checklist / enum / route / 配線 の **正本は `ut-tdd` core + 本 governance docs に単一定義**し、`.claude/CLAUDE.md` (Claude) と `AGENTS.md` (Codex) は **それを指す薄い runtime adapter** に限る (ルールを再定義・分岐・上書きしない)。同一入力 (PLAN / diff) に対し、runtime や mode によらず **同一判定・同一 exit code** を返す。ルールが runtime ごとに枝分かれした時点でゲートは信頼できなくなる。

2. **hybrid の機能分散 (distributed by role)** — 両 runtime が揃う `hybrid` では、**機能を分けて分散動作する**ことを必須とする。判断系 (`frontier-reviewer`) と実行系 (`worker`) を **別 runtime に割り当て**、同一作業を二重実行しない。cross-agent review (§2.1.2.1) と orchestration_mode の `*_codex_impl` 系 (§2.6.4) は、この役割分散の上でのみ成立する。「両方ある」だけで分散していない hybrid は、cross-agent review が形骸化する。

> 補足: 「同じルール」と「単体時のレビュー縮退 (§2.1.2.1)」は両立する。**ルール (どのゲートで何を要求するか) は runtime によらず同一**で、その **満たし方 (① cross-agent / ② 専門サブエージェント / 人間)** が利用可能な agent 数で決まるだけである。ルール自体は分岐しない。

## 2.1.1 実行モード (単体 / 連携)

本ハーネスは Claude Code と Codex の連携を必須にしない。`ut-tdd` CLI と workflow / hook は、現在利用できる実行主体を検出し、以下 4 mode のいずれでも同じ状態モデルを扱う。

| mode | 利用主体 | 目的 | 必須条件 |
|------|----------|------|----------|
| `claude-only` | Claude Code + `.claude/` hook | 対話 UI と hook による設計・実装・停止時検証 | `ut-tdd` CLI + Claude Code project context |
| `codex-only` | Codex CLI + `AGENTS.md` | Codex 単体での TL 駆動実装・レビュー・検証 | `ut-tdd` CLI + Codex project rules |
| `hybrid` | Claude Code + Codex CLI | 役割分担、handover、review、team run | `claude-only` と `codex-only` の両方 |
| `standalone` | `ut-tdd` CLI のみ | setup / doctor / lint / gate のローカル検証 | Claude Code / Codex なし |

`ut-tdd status` / `ut-tdd doctor` は mode、検出済み runtime、欠落 runtime、推奨 next action を表示する。`hybrid` 専用の委譲コマンドは、片方しか無い環境では fail ではなく明示的な `not-available` と fallback 手順を返す。

Cursor / Google Antigravity / GitHub Copilot などの周辺 AI IDE は、必須 runtime ではなく **optional adapter** として扱う。検出できた場合は `ut-tdd status` に表示し、CLI 経由で安全に呼べる範囲だけ `ut-tdd adapter <name> ...` に公開する。公開 CLI や automation API が不安定な adapter は、状態検出と手順提示までに留める。

Antigravity のように内部から Claude Code を呼べる可能性がある IDE は、Claude Code 本体とは分けて **adapter-hosted runtime** として扱う。つまり `claude-only` / `hybrid` の判定に直結させず、`optional_adapters[].hosted_runtimes` として「Antigravity 経由で Claude Code 相当が使える」ことを表示する。

## 2.1.2 複数 AI orchestration 原則

複数 runtime / adapter が使える場合、UT-TDD は「判断」と「実行」を分離して割り当てる。

- 設計判断、要件分解、R4 合流判定、**判断ゲート (G0.5 企画突合 / G2 / G4-G7 設計・実装凍結) のレビュー**は **現在作業している AI とは別系統の最上位モデルクラス** (`frontier-reviewer`) に依頼する。
- 実装、機械的修正、テスト追加、ドキュメント整形は **実行向けモデルクラス** (`worker`) に依頼する。
- 軽量 lint、要約、差分分類、コマンド生成補助は **低コスト高速モデルクラス** (`fast-checker`) に寄せる。
- 同一 AI / 同一モデルが作った設計を同一モデルだけで承認しない。`hybrid` mode では cross-agent review を原則とし、単体 mode では **専門サブエージェント review を必須**とする (§2.1.2.1。naive self-review を判断ゲートの通過根拠にしない)。

モデルの実名は変動するため構想書には固定しない。`.ut-tdd/teams/*.yaml` で provider / command / model / role / budget を宣言し、`ut-tdd status` が利用可否を表示する。これにより「Claude Code が中核」「Codex が実装/並列」「optional adapter が補助」という現在の構成を保ちつつ、将来のモデル更新に追従できる。

### 2.1.2.1 実行モードによるレビューゲート切り分け (gate 崩壊防止)

cross-agent review は **別 runtime / 別モデルのレビュアー**を前提とする。単一エージェント環境 (claude-only / codex-only) ではこれが物理的に不可能なため、execution mode (§2.1.1) を参照せず判断ゲートを「レビュー済み」で通すと、**self-review が cross-agent review に化けてゲートが崩れる**。`ut-tdd gate` は必ず `ut-tdd status` の mode を参照する。

#### レビュー強度の 3 ティア

| ティア | 実体 | 強度 |
|---|---|---|
| **① cross-agent review** | 別 runtime / 別 model のレビュアー (hybrid) | full。cross-provider 要件を満たす |
| **② 専門サブエージェント review** | 同一 runtime 内・別 context/persona・adversarial・**明文化 checklist 駆動** の専用レビュアー (例 claude-only の `.claude/agents/code-reviewer`、codex-only の reviewer-role 呼び出し) | 中間。self より強いが cross-provider は満たさない |
| **③ naive self-review** | 実装者が自分の出力を読み直す | 最弱。判断ゲートの通過根拠として **不可** |

②は同一モデルである事実を必ず記録し (`review_kind: intra_runtime_subagent`)、cross-provider 要件には数えない。

#### execution mode 別の判断ゲート挙動

| execution mode | cross-agent review | 判断ゲート (G0.5 / G2 / G4-G7 / R4) の扱い |
|---|---|---|
| `hybrid` | 可能 (worker ≠ frontier-reviewer) | full enforce。worker と reviewer の (provider, model) 同一なら承認無効化し exit |
| `claude-only` / `codex-only` | 不可 | **② 専門サブエージェント review を必須化** (hard)。明文化 checklist の逐条実行記録が無ければ gate を **exit 1** で止める。実行時は `review_kind: intra_runtime_subagent` + `cross_agent_review: unavailable` を記録 |
| `standalone` | 不可 (AI なし) | サブエージェントも起動不可 → 機械 lint のみ pass し、判断ゲートは **人間レビュー必須** を `next_action` に出す (自動 pass 不可) |

#### 核心ルール

1. **self-review (③) を判断ゲートの通過根拠にしない**。単一エージェント時は ② 専門サブエージェント review を hard 要件とし、未実行なら exit 1 (silent pass 禁止)。
2. ② は同一モデルのため **cross-provider 要件を満たさない**。`same_model_approval: forbidden` を実行時強制し、worker と reviewer の (provider, model) 一致時は承認を無効化して gate を止める (hybrid でも同一モデル割当を弾く)。**機械着地 (IMP-076)**: review_evidence entry に `worker_model` / `reviewer_model` を記録し、doctor `checkReviewEvidence` が cross_agent entry の同一/欠落を `crossReviewViolations` として fail-close 検出する (単体 runtime は相異 model を供給できず `cross_agent` を僭称できない = 核心ルール 1 の静的担保)。PLAN-L6-13/L7-14/REVERSE-13。
3. ② のレビュー観点は曖昧にせず **明文化された checklist を逐条評価** し、各項目に pass/fail/n-a + 根拠を記録する (checklist 正本は要件定義書 §7.8.7)。
4. `orchestration_mode` (§2.6.4) が要求する agent が execution mode で不在なら、silent fallback せず **縮退規則**で別 mode に落とすか人間に委ねる (不在を明示記録)。例: `claude_judge_codex_impl` は hybrid のみ完全実体化。claude-only では実装も Claude が担い review は ② に縮退、codex-only では Codex 主導 + ②。
5. **escalation 境界 (本番影響 / 認証 / 認可 / 決済 / PII / ライセンス / destructive) は execution mode を問わず人間サインオフ必須** (② でも代替不可。hard-block。§8 エスカレーションと整合)。
6. **定量テスト → 定性レビュー順序 (全駆動モデル普遍、IMP-077)**: 品質保証は定量テスト (vitest/doctor/lint) × 定性レビュー (review tier) の二軸 (柱6)。**定量検証が green になってから定性レビューを行う** (未検証成果物をレビューしない)。9 駆動モデルすべての workflow に普遍 (各 mode の verify step が review/サインオフ step の前。Discovery=S3 verify→S4 / Refactor=テスト緑→commit / Incident=収束確認→postmortem 等)。機械着地 = review_evidence の `tests_green_at ≤ reviewed_at` を doctor `checkReviewEvidence` が fail-close 検出。PLAN-L6-14/L7-15/REVERSE-14。

機械検証要件と checklist 正本は要件定義書 §7.8.7。

## 2.1.3 タスク判定 / 見積もり / skill 推挙

UT-TDD は PLAN 起票前後に、タスクの難易度・エフォート・適用 skill を機械的に仮判定する。これは実装を止める gate ではなく、経路選択、orchestration、レビュー強度、必要 skill pack を決めるための事前分類である。

- `ut-tdd task classify`: 入力文または PLAN から kind / drive / size / complexity / split_required を判定する。
- `ut-tdd task estimate`: 三点見積もりとリスク係数で effort_hours / story_points / buffer を出す。
- `ut-tdd skill suggest`: PLAN の kind / layer / drive / touched files から `docs/skills/*.md` の候補を推挙する。

基本は rule-based で動作し、AI runtime が無い `standalone` でも利用できる。複数 AI がある場合は軽量分類を `fast-checker`、曖昧な L/XL 判定や本番影響を含む見積もりレビューを `frontier-reviewer` に回す。

### 3 つの実装経路

| # | 経路 | トリガー | 主な kind |
|---|------|----------|-----------|
| **経路 1** | V-model Forward | 発注元 Issue (要件確定) | `design` + `impl` |
| **経路 2** | Scrum × Reverse 自動 routing | 仮説 (要件未確定) | `poc` + `reverse` |
| **経路 3** | add-design / add-impl | 既存 PLAN への拡張要求 | `add-design` + `add-impl` |

### 4 つの補助軸

| # | 補助軸 | 内容 |
|---|--------|------|
| **補助 1** | 緊急経路 (recovery) | hotfix template / session 終了前 fail-close / postmortem 強制 |
| **補助 2** | GitHub 統制 | ブランチ / workflows / PR / CODEOWNERS / commitlint / Protected Branch |
| **補助 3** | 3 層抽象化 (設計仕様書) | スキル / ワークフロー / ハーネスの YAML を **設計仕様書** として参照、interpreter は導入しない |
| **補助 4** | チーム責任二極化 | TL 上流 / QA 下流 / AI実装・保守 / UI/UX / 発注元 の 5 役割マトリクス |

> **v3.1 注記**: この「3 実装経路 + 4 補助軸」は v3.1 で **9-mode ecosystem (§2.5)** に再編した。経路 1=Forward、経路 2=Reverse / Scrum / Discovery、経路 3=Add-feature、補助 1=Recovery / Incident に対応し、さらに Refactor / Retrofit / screen-design / frontend-design を追加する。入口 (mode) は状況で分岐するが、出口は必ず Forward L0-L14 (§3) に合流する。mode の自動判定と委譲の配線は §2.6。

## 2.2 全体像

```
                       ┌──────────────────────────────────────┐
                       │       発注元 (プロダクトオーナー)      │
                       │   WHY / WHAT / 受入基準 / R3 検証     │
                       └────────────────┬─────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
   [要件確定]                       [仮説]                           [既存拡張]
        │                               │                               │
        ▼                               ▼                               ▼
  ┌──────────┐                  ┌──────────────┐               ┌──────────────┐
  │ 経路 1   │                  │   経路 2     │               │   経路 3      │
  │ V-model  │                  │ Scrum×Reverse│               │  add-* 差分    │
  │ Forward  │                  │ 自動 routing │               │     実装      │
  └────┬─────┘                  └──────┬───────┘               └──────┬───────┘
       │                               │                               │
       │ 設計⇔テスト設計の Pair freeze  │ S4 decide → matrix lookup    │ 既存テスト維持
       │ → L7 実装 → 4 artifact trace  │ → R0-R4 → R4 で Forward 合流  │ + 回帰確認
       │                               │                               │
       └───────────────┬───────────────┴───────────────┬───────────────┘
                       │                               │
                       ▼                               ▼
              ┌──────────────────────────────────────────────┐
              │  補助 2: GitHub 統制 (全経路の共通基盤)        │
              │   ブランチ × workflows × CODEOWNERS           │
              └──────────────────────┬───────────────────────┘
                                     │
                       ┌─────────────┴─────────────┐
                       │                           │
                       ▼                           ▼
              ┌────────────────┐         ┌────────────────┐
              │ 補助 3: 3 層    │         │ 補助 4: チーム  │
              │ 抽象化 (設計   │         │ 責任二極化      │
              │ 仕様書) +      │         │ + 4 段レビュー  │
              │ エスカレーション│         │                │
              └────────────────┘         └────────────────┘

              ┌──────────────────────────────────────────────┐
              │ 補助 1: 緊急経路 (P0/P1 インシデント発生時)   │
              │   hotfix template + session 終了前チェック    │
              │   + postmortem doc 強制                       │
              └──────────────────────────────────────────────┘
```

## 2.3 V-model 4 artifact と 3 段階 freeze (中核)

ソフトウェア工学 V-model の原則に従い、本ハーネスは **4 つの artifact を別文書/別成果物として独立** させ、双方向 reference で trace する。

```
   ① 設計 (文書)         ←対応関係→        ③ テスト設計 (文書)
   docs/design/                            docs/test-design/
        │                                        │
        ▼ 実装                                   ▼ 実装
   ② 実装コード         ←対応関係→        ④ テストコード
   src/                                    tests/
```

| Artifact | 種別 | 担当 layer (L0-L14) | 主成果物例 |
|---|---|---|---|
| ① 設計 | 文書 | L0-L6 (企画/要求/画面/要件/基本/詳細/機能) | 企画書 / 業務要求 / 画面設計 / 要件 (FR+AC) / ADR / D-API / 関数 schema |
| ② 実装コード | コード成果物 | L7 (実装) | `src/*` |
| ③ テスト設計 | 文書 | L1/L3/L4/L5/L6 (① と同層、V-model 左) | 運用/受入/総合/結合/単体テスト設計 doc |
| ④ テストコード | コード成果物 | L7 先行作成、L7-L14 で実施 (② と同系) | `tests/*` |

### V-model: 左 (設計) ↔ 右 (検証) の対 (v3.1 で L0-L14 化、正規式モデル 2026-06-04 PO 確定)

V2 の L0-L14 は左右が対になる V-model を成す。左側で書いた設計には、同層で **③ テスト設計** を対にして凍結し、右側の対応工程で **④ テストコード** として実施する。**各ペアの検証本質は「その設計が効いているかを、対応する環境・データ実在性で検証する」**(下表「検証本質」列)。番号・既存ペアは据え置き、**正規式モデルでは L0 企画にも検証ペアを与え (従来は穴)、谷を 3 点合算として明示**する (非破壊の追加・明確化)。

| 左 (設計層) | ③ テスト設計 (左で作成) | 右 (実施工程) | 検証本質 (環境・データ実在性) |
|---|---|---|---|
| **L0 企画** | (価値検証 = L14→L0 feedback) | (L14 内で企画目的の実現を検証) | **価値検証**: 事業目的・価値が実現したか (実成果) |
| L1 要求定義 | 運用テスト設計 | L14 運用検証 | **運用**: 実データ × 継続運用 (時間) で要求が満たせるか |
| L2 画面設計 | (実データ検証 = mock / 本 UX) | L10 UX 磨き | **実データ検証**: 本番の実データで画面/表示が成立するか |
| L3 要件定義 (FR+AC) | 受入テスト設計 | L12 デプロイ+受入 | **本番受入**: 本番環境で要件 (FR+AC) が満たせるか |
| L4 基本設計 | 総合テスト設計 | L9 総合テスト | **総合**: テスト環境・全体で方式が成立するか |
| L5 詳細設計 | 結合テスト設計 | L8 結合テスト | **結合**: テスト環境・モジュール間契約が成立するか |
| L6 機能設計 | 単体テスト設計 | L7 谷 (3 点合算) | **単体**: テスト環境・関数単体で仕様が成立するか |

> **谷 = 3 点合算 (L6 → 単体テスト → L7、最小単位)**: V の底 L7 (実装) は、**L6 機能設計 (① 設計) と単体テスト設計 (③)** の 2 点を見て、**単体テストを先に具体化 (TDD red) → コード (②) を実装**する。設計・テスト・コードの 3 点で実装を三角測量する最小単位。単体テストの居場所はこの谷 (L6⇔L7) であり、独立した層ではない (`layer:L6 / executed_at:L7` の表記はこの 3 点合算の正しい表現)。

> **右腕 = データ実在性のエスカレーション**: 検証は使うデータ・環境がだんだん実在に近づく。**テスト環境/合成データ (単体→結合→総合) → 本番実データ (本番受入=要件 / 実データ検証=画面) → 運用 (実データ×時間) → 価値 (実成果)**。下の設計層ほど狭く速く合成データで、上ほど広く遅く実データ・実成果で検証する。各設計層は「対応する実在性レベルで効いているか」で検証される。

> **L2 画面は L1 のフェーズ分離**: 画面設計の本質は L1 (要求) に内包される (画面要求 = 的確な要求/要件を引き出す道具)。フェーズが大きいため L2 として分離しているだけで、内容は分配される — **画面要求 → 要求/要件 (L1→L3 の上流)**、**画面の詳細設計 → L5 詳細設計**。よって L2 は純粋独立ペアでなく、その検証本質は実データ検証 (本番の実データで画面が成立するか)。

### UT-TDD W (2段V、AI エージェントシステム時のみ)

> **用語確定**: 上記 **L0-L14 の左右ペア = V-model**。**W-model (UT-TDD W) はこれとは別概念**で、**V で確定した仕様 (一般システム = 外殻) を土台に、AI エージェントを構築するための設計** = **V を 2 回通す** (1 回目 = 仕様確定 / 2 回目 = エージェント構築) ため V が 2 つ重なって W 字になる (`docs/design/harness/L1-requirements/functional-requirements.md` FR-L1-28 / two-stage-agent-design)。

| | 構造 | 適用 |
|---|---|---|
| **V-model** | L0-L14 を 1 回。左 (設計+テスト設計凍結) ↔ 右 (検証) | 通常開発 (一般システム) |
| **UT-TDD W (2段V)** | L0 (全体 1 回) → **Phase 1: L1-L9 (一般システム、drive=be/fe/db)** + **Phase 2: L1-L9 (エージェント昇華、drive=agent)** → **Phase 3: L10-L14 で合流** | **AI エージェントシステムを作る場合のみ** |

**1 回目の V** で一般システム (外殻) の仕様を L9 まで確定し、**2 回目の V** でその**確定仕様から AI エージェントを構築**する (エージェント昇華 = AI が外殻のツールを使って動く内部機構)。**2 段 = 2 回の V** (仕様確定 → エージェント構築)。合流は L10。

#### 本 harness への適用 (PO 確定 2026-05-29、A-74)

**UT-TDD harness 自身は UT-TDD W を適用しない (単一 V で進める)**。理由 (PO):
- harness は **VSCode 内 (Claude Code) にシステムを作っている**ため、**一般システム = 外殻 (VSCode / Claude Code) は既存** ＝ Phase 1 (V1) は終了している前提に近い。
- その外殻の中で、エージェントが外殻のツールを使って動く仕組み = **内部整備**を作るのが harness の仕事。これは UT-TDD W の **2 段目の V (内部整備 / AI が使いやすい仕組み)** に位置づく。
- **内部整備のみ**なので **片方の V (単一 V) だけでよい**。よって L4/L5 等を単一 V で設計したのは正しい。

> UT-TDD W は **harness が対象リポジトリへ提供する機能** (FR-L1-28、対象が agent システムの時に使う) であり、harness 自身の開発プロセスではない。

### 3 段階 freeze (v3.0 で明示分離 — 元 Critical C1 fix。v3.1 で L0-L14 へ remap)

v2.1 では「4 artifact pair freeze」が実装前後を跨いで曖昧だった。工程順に応じて **3 段階の freeze 概念** に分離する:

| Freeze 段階 | 発火タイミング | 凍結対象 | 担当ゲート |
|------------|---------------|----------|-----------|
| **段階 A: Pair freeze (設計⇔テスト設計)** | L7 実装着手前 | ① + ③ の文書ペア (V-model 左各層) | G1 (L1) / G2 (L2 mock) / G3 (L3) / G4 (L4) / G5 (L5) / G6 (L6) |
| **段階 A2: TDD Red freeze** | ② 実装コード作成前 | ③ + ④ の単体テスト設計/先行テストコード | L7 entry (G6 通過直後) |
| **段階 B: 4 artifact trace freeze** | L7 実装完了時 | ① + ② + ③ + ④ の双方向 trace 6 方向 | G7 |

→ L7 実装前に ② 実装コードを freeze することは概念上ありえない。段階 A は **文書ペアの揃い**、段階 A2 は **受入を先行テストコードで固定する red state**、段階 B は **実装コードを含む 4 artifact の trace 揃い** と理解する。

### 双方向 trace の 6 方向

4 artifact は無向 6 pair = **双方向 12 edge** で結ばれる。本書では慣用的に「6 方向 trace」と呼ぶが、これは「6 pair それぞれを双方向 reference で結ぶ」の意味であり、実装上は 12 edge を個別検証する。

| Pair | From → To 方向 | To → From 方向 |
|------|---------------|---------------|
| ①⇔② | 設計 → 実装ファイル指定 | 実装 docstring → 設計参照 |
| ①⇔③ | 設計 → テスト設計指定 | テスト設計 → 設計参照 |
| ①⇔④ | (派生的) | (派生的) |
| ②⇔③ | (派生的) | (派生的) |
| ②⇔④ | 実装 → テストコード対応 | テストコード → 実装対応 |
| ③⇔④ | テスト設計 → テストコード対応 | テストコード → テスト設計対応 |

実装上の**必須 8 directed edge** (4 artifact の 6 pair 双方向 = 12 edge のうち必須分) は要件定義書 §2.4 で確定する。

### 逆ピラミッド検出 (P0 severity)

「① + ② が存在するが ③ + ④ が無い」状態を **逆ピラミッド** と呼び、G6 (機能設計凍結) / G7 (実装凍結) で fail-close する。AI 実装が「テストも書いた」と称しつつ ③ テスト設計 doc を欠く典型パターン。

## 2.4 5 段階セキュリティとの統合 (構想書 v1.1 §3 準拠)

構想書 §3.3 の多層防御を、本ハーネスの各補助軸に分散統合:

| セキュリティ段階 | 統合先 | 具体 tool |
|---|---|---|
| Develop | Forward G4 基本設計ゲート (threat model 確認) | (人間判断) |
| Commit | pre-commit hook + commitlint | gitleaks / commitlint による検査 |
| Build | workflows の SAST / SCA / Secret Scan | trivy (SCA) / codeql (SAST) — Phase 2 で追加 |
| Deploy | Incident mode の incident-log + Protected Branch (L12 デプロイ) | `gh` CLI |
| Operate | escalation L0-L3 で異常検知 + L13/L14 (デプロイ後検証・運用検証) フェーズで Sentry/Uptime Robot/Dependabot アラートをチーム共有 audit へ記録。個人 `failure_log.jsonl` は local advisory に限定 | Sentry / Uptime Robot / Dependabot |

## 2.5 開発モード・エコシステム (9-mode、V2 由来)

入口の状況に応じて **9 mode + 2 工程専門 workflow** を使い分け、**出口は必ず Forward L0-L14 (§3) に合流** させる。mode は「入口条件」と「文脈遷移 (昇華)」を明示するだけで、完了先 (設計・実装・検証・運用の同一接続) を分断しない。これにより入口を散らさず工程を一本化する。

> **IMP-069 reconcile (PO 2026-06-05「Forward=spine」確定、operational 正本 = L4 function §3)**: 本表は legacy framing として **Forward を 9 mode の 1 行に算入**しているが、出口が必ず Forward へ合流する以上 **Forward は駆動モデルと並ぶ入口 mode でなく合流先 (spine)** である。operational には **Forward spine + 9 駆動モデル (entry mode、= `docs/process/modes/` の 9 = 上表 8 + Research) + 2 工程専門** で数える。Research は本表に未掲載だが `kind=research` / `research/*` branch として駆動モデルの 1 つ (modes/README §3 が両 framing の橋渡し正本)。L5 以降の mode カウントは operational 正本に従う。

| mode | 入口条件 (要約) | 対応する旧 v3.0 経路 | チーム owner | Forward 合流点 |
|------|----------------|---------------------|--------------|----------------|
| **Forward** | 要件・設計・契約が明確 | 経路 1 | 全工程 (§3) | — (本体) |
| **Reverse** | 既存資産に逆向き事実 (drift / 未知設計) | 経路 2 (の Reverse) | tl | R4 後 → L3/L4 |
| **Discovery** | 要件・成功条件 未確定 / 実現性 不透明 / **確証なき設計** (紙上で確定できない設計) | (新規) | po + tl | 確定後 → L1 (要求) / L3-L6 (設計確証時) |
| **design-bottomup** (9-mode 後の追加) | backend 実装事実から FE / 画面要件を後付け導出する | (v3.1 後新規) | aim + uiux | Discovery 合成後 → L1 screen / L2 画面設計 |
| **Refactor** | 振る舞い維持の構造改善 | (新規) | se + tl | 完了後 → 回帰確認 |
| **Retrofit** | 依存・基盤・設定の移行/更新 | (新規) | se + tl | upgrade 後 → L4 |
| **Recovery** | AI の逸脱・暴走・再開不能の収束 | 補助 1 | tl + po (承認必須) | 収束後 → 中断工程 |
| **Scrum** | 要件を反復で固める | 経路 2 (の Scrum) | po + aim | S4 decide → L1 |
| **Incident** | 本番稼働中の障害・hotfix 直行 | 補助 1 | オンコール + tl + pm (承認必須) | 収束後 → L12/L13 |
| **Add-feature** | 既存基盤への機能差分追加 | 経路 3 (add-*) | aim + tl | 既存維持 + L3/L7 差分 |
| **version-up** (9-mode 後の追加) | capability を将来版へ保全 (今は入れないが将来入れる) | (v3.1 後新規) | aim + tl + po | 将来版活性化時 → add-feature で L2/L3→L7 合流 |
| screen-design | L2 画面設計 (UI/wireframe) 専門 | — | uiux | Forward L2 内 |
| frontend-design | L10 前後 UX/ビジュアル/表現品質 専門 | — | uiux / fe | Forward L10 内 |

- 旧「3 経路 + 4 補助軸」(§2.1) は本 9-mode に再編した。**Discovery / Refactor / Retrofit / screen-design / frontend-design が v3.1 新規追加**。
- **Discovery の適用拡張 (PLAN-DISCOVERY-01 S4 confirmed 2026-06-04、promotion_strategy=reuse-with-hardening)**: Discovery は「要件未確定」だけでなく **確証が持てない『設計』にも適用**する。設計が紙上で確定できない (実現性・妥当性が不透明な) 場合、確証を装って Forward 凍結し後で大手戻りするのでなく、Discovery として起票し **設計→仮実装→検証→設計確定** のサイクルで確定させる。合流点は要求確定なら L1、設計確証なら L3-L6 (workflow メタモデル PoC の dogfood 実績に基づく正規反映)。
- screen-design / frontend-design は独立経路ではなく **Forward の設計文脈内の工程専門** (L2 / L10) として運用する。
- **design-bottomup (9-mode 後の追加、PLAN-DISCOVERY-07 / PLAN-RECOVERY-07)**: backend/API/データ/ロジックが先行し、FE/画面要件が後付けになる場合の入口。実装事実から FE 要件候補を導出し、Discovery 合成で妥当性を確認してから L1 screen / L2 画面設計へ back-merge する。新 kind は作らず `kind=poc` と `route_mode=design-bottomup` で識別する。
- **version-up (9-mode 後の追加、PLAN-DISCOVERY-09)**: 「9-mode」は v3.1 コア集合。version-up は capability を将来版へ**保全 (preserve)** する入口 = deferred-but-committed-future。新 kind を作らず既存 kind + `status=draft` + `version_target` marker (status=draft 限定) で表す。**archived (破棄) でも plain draft (WIP) でも Add-feature (今追加) でもない第 4 の状態**。`version_target` 付き未集約は forward-convergence の正当な deferred 種別 (要件定義書 §6.8.8.1、`version_deferral` signal §7.8.1)。第一ケース = 中央UI (L7-141/146) を将来版へ保全。
- 各 mode の入口判定・推奨コマンド・委譲は §2.6 の配線で機械化する。

## 2.6 配線 (signal → mode → command / layer-context 注入 / 横断検出)

mode と工程を「絵」で終わらせず自動で繋ぐ仕組み。V2 の routing/injection を UT-TDD のチーム前提に翻案する (legacy runtime command → ut-tdd、legacy DB → `.ut-tdd/` state、個人パス排除)。

### 2.6.1 signal → mode 自動 routing

検出 signal から mode を機械判定する (V2 `SIGNAL_TO_MODE` / `DRIFT_TYPE_TO_ROUTE` 相当を `ut-tdd` config に再定義)。例:

| signal | mode | 備考 |
|--------|------|------|
| `drift` (drift_type=schema/contract) | Reverse | normalization 経路 |
| `debt_degradation` / `code_smell` / `structural` | Refactor | |
| `dependency_outdated` / `upgrade` / `config_drift` | Retrofit | upgrade は preflight 要 |
| `agent_runaway` / `context_exhaustion` / `regression_dev` / `runaway` / `forced_stop` | Recovery | 承認必須。`forced_stop` = ユーザー強制停止 (ESC/Ctrl+C/Stop) = 高 severity 負シグナル (罵倒・強否定・同論点での連続停止を含む。罵倒のみが基準ではない)。専用 hook 不在のため dangling-turn 推定で検出 (PLAN-L6-04/L7-02)。提示まで自動・起票は人間 yes |
| `production_incident` / `hotfix_required` / `regression_prod` | Incident | env=prod、承認必須 |
| `feature_addition` / `scope_extension` | Add-feature | |
| `version_deferral` | version-up | capability を将来版へ保全 (今スコープ外・破棄しない、§2.5)。詳細は要件定義書 §7.8.1 |
| `screen_addition_to_backend` / `design_bottomup` / `backend_derived_screen` / `add_ui_to_backend` | design-bottomup | backend 先行から FE / 画面要件を導出し、Discovery 合成後に L1 screen / L2 へ合流 (§2.5) |
| `user_feedback_iteration` / `requirement_continuous_refinement` | Scrum | |
| `requirement_undefined` / `feasibility_unknown` / `success_condition_unclear` / `design_uncertain` (要件未確定 / 実現性不透明 / 確証なき設計) | Discovery | 4 象限 P2、上流委譲。`design_uncertain` = 紙上で確定できない設計 (§2.5、PLAN-DISCOVERY-01 S4 confirmed) |
| `tech_decision_required` / `option_comparison_needed` / `adr_required` | Research | 机上調査 (PoC 不要) |
| `interrupt` (subtype=design_gap/new_requirement/constraint/po_change) | 分岐 (§2.6.5) | 重大・暴走→Recovery / 要件未確定→Discovery / 軽微追加→Add-feature / 設計ギャップ→Forward 該当 layer |

`env=prod` や regression 系は優先的に Incident/Recovery に倒す。`runaway` は `agent_runaway` の alias。詳細な機械契約は要件定義書 §7.8.1。

### 2.6.2 4 象限 priority/action (uncertainty × impact)

| | impact 低 | impact 高 |
|---|---|---|
| **uncertainty 低** | P3 / suggest_only | P1 / 即 PLAN 起票 |
| **uncertainty 高** | P2 / Discovery 先行 | P0 / 緊急 routing |

### 2.6.3 mode → command の機械契約 (RecommendedCommandV1)

route 結果は **人間向け表示 (`suggest_command`)** と **機械契約 (`recommended_command`)** を分離する。機械契約は JSON で、`schema_version / command / args / safety` を持つ。`safety` の 3 フラグ:

- `auto_apply`: agent が確認なしに即実行してよいか (default: false)
- `requires_human_approval`: **人間承認必須** (Recovery / prod Incident / config_drift Retrofit で true)
- `requires_preflight`: 前段 preflight 必須 (upgrade 高リスク時)

**チーム翻案 (最重要)**: V2 の `requires_human_approval: true` は「止まるシステム」しか示さない。UT-TDD では **「誰がサインオフするか」** を定義しないと形骸化する。

| 引き金 | 承認者 (人間サインオフ) |
|--------|------------------------|
| Recovery 起動 | tl がリオープンポイント確認 + po がスコープ承認 |
| prod Incident | オンコール担当 + tl + pm の三者確認 |
| config_drift Retrofit | tl 単独承認 (環境影響限定) |

この承認者定義は `.ut-tdd/` policy または `.claude/CLAUDE.md` Guard Rules に置き、`requires_human_approval` が立ったとき自動参照する (要件定義書 §7)。`command` の値は legacy runtime command ではなく `ut-tdd *` 相当に置換する。

### 2.6.4 layer-context 注入 (drive × layer) と orchestration_mode

各 drive × layer に **owner_role / mandatory_agents / recommended_skills / recommended_commands / orchestration_mode** を注入する (V2 `vmodel-semantics.yaml` 相当)。`orchestration_mode` が、あなたの言う「開発のモード」= **工程ごとに誰が判断し誰が実装するか** を 5 値で表す。実行モード (§2.1.1 standalone/hybrid) より細粒度。

| orchestration_mode | 意味 |
|--------------------|------|
| `pm_lead` | PM 単独主導 (planning 層)。AI 委譲なし |
| `claude_judge` | Claude (PM/PMO) が判断主体 (requirement 層) |
| `claude_judge_codex_impl` | Claude が設計・判断、Codex (worker) が実装 (architecture/detailed 層) |
| `codex_impl_qa_verify` | Codex が実装、QA が検証 (functional 層) |
| `claude_design_impl` | Claude が設計+実装 (FE の mock 駆動 architecture/detailed) |

drive で owner_role / orchestration_mode が変わる (例: architecture 層は be→tl / fe→fe role + `claude_design_impl` / db→dba 相当)。値の enum は要件定義書 §1 / §7 で確定する。

**execution mode との結合 (重要)**: `orchestration_mode` は両エージェント存在を前提とする値 (`claude_judge_codex_impl` / `codex_impl_qa_verify`) を含む。これらは `hybrid` でのみ完全実体化し、単一エージェント (claude-only / codex-only) では §2.1.2.1 の縮退規則に従って別 mode へ落とす。**この縮退時に cross-agent review が self-review に化けないよう、判断ゲートは必ず execution mode を参照する** (§2.1.2.1)。orchestration_mode と execution mode を独立に扱うとレビューゲートが崩れる。

### 2.6.5 横断検出 (全工程・全 mode から発動)

| 機構 | 検出 | 接続先 mode |
|------|------|-------------|
| interrupt | 開発中の割り込み (design_gap / new_requirement / constraint / po_change) | 分岐: 重大・暴走 (agent_runaway 併発)→Recovery / 要件未確定昇格→Discovery / 軽微追加 (new_requirement・po_change)→Add-feature / 設計ギャップ (design_gap・constraint)→Forward 該当 layer で spot 修正 (§2.6.1 / §7.8.1) |
| debt | 技術負債台帳の蓄積 | Refactor |
| drift-check | D-API / D-CONTRACT / D-DB の乖離 | Reverse normalization |
| readiness | deferred finding (ゲート通過保留) | 後工程 PLAN へ carry (PM 承認要) |
| doctor: relation-graph / doc-drift / connection-deficiency / regression | 依存漏れ / 契約漏れ / 接続欠損 / 回帰 | Reverse / 本番→Incident・開発中→Recovery |
| **test-perspective-gate** | V-model 各ペアの **観点網羅** (抜け) + **レベル間非重複** (重複) | fail-close (`--static-only`) |

これら検出器は `.ut-tdd/` state を参照し、`ut-tdd doctor` / `ut-tdd plan lint` に束ねる (要件定義書 §7)。

---

# §3 Forward mode: V-model L0-L14 (要件確定時の通常開発)

## 3.1 概念 (V2 L0-L14 + V-model)

Forward は要件・設計・契約が確定した状態から **L0 → L14 を V-model (左=設計降下 / 右=検証上昇)** で進む中核経路。他の全 mode (§2.5) は最終的に本経路へ合流する。左側の各設計層では **同層で ③ テスト設計を対に凍結** し (V-model 左)、右側の対応工程で **④ テストコードを実施** する。

```
左 (設計降下)                              右 (検証上昇)
L0 企画         (po+tl)  企画書①                          L14 運用検証+改善 (pm+po)
  └ G0.5 企画突合 (frontier-reviewer adversarial check 必須)        ▲ G14
L1 要求定義     (po主体) 業務要求 BR-*/NFR-* ① + 運用テスト設計③ ──→ L14 で実施
  └ G1 (po+tl)                                                     ▲ G12
L2 画面設計     (uiux)   ワイヤーモック ① ─────(mock がペア)─────→ L10 UX 磨き (uiux) G10
  └ G2 (pm+uiux)
L3 要件定義     (tl主体) FR-*/AC-* ① (BR-* から trace) + 受入テスト設計③ ──→ L12 デプロイ+受入 (pm+po)
  └ G3 (po+tl)                                                     ▲ G9
L4 基本設計     (tl)     アーキ/ADR ① + 総合テスト設計③ ──────────→ L9 総合テスト (qa) G9
  └ G4 (tl+pm, tl-advisor 必須)                                    ▲ G8
L5 詳細設計     (tl+se)  D-API/D-DB/D-CONTRACT ① + 結合テスト設計③ ─→ L8 結合テスト (aim/qa) G8
  └ G5 API/Schema Freeze                                          ▲ (L7 内)
L6 機能設計     (tl+aim) 関数 schema/エッジケース+WBS ① + 単体テスト設計③ ─→ L7 実装内 単体テスト
  └ G6 関数 signature 確定 + WBS 完備
        │
        ▼
L7 実装スプリント (aim→se)  ② 実装コード / ④ テストコード
   TDD Red → 本体実装 → 3点レビュー → テストパターン追加 → 実施 → 修正
  └ G7 実装凍結 (4 artifact trace freeze、6 pair 双方向)
        │
        ▼
L8 結合 →G8→ L9 総合 →G9→ L10 UX磨き →G10→ L11 総合レビュー+UAT (pm+po) →G11
   → L12 デプロイ+受入 (pm+po) →G12→ L13 デプロイ後検証 (自動/pm) →G13
   → L14 運用検証+改善 (pm+po) →G14→ 次サイクル L0 へ feedback
```

各工程の owner / 人間サインオフ / mandatory subagent / orchestration_mode の配線は §2.6、要件定義書 §1.4 / §7 で機械化する。以下は v3.1 で V2 から取り込んだ工程概念の要点。

### 3.1.1 L0 企画工程の独立 (V2 由来)

L0 は「リポジトリ初期化」ではなく **企画工程**。企画書 PLAN は背景・目的・スコープ (高レベル方向性) を持つ **feed-forward 文書**であり、L1 へ渡すことが役割。**社内システム/開発基盤では ROI・KGI/KPI の定量化を企画書段階で強制しない** (定量指標・受入条件は L1 業務要求 / L3 で定義し、企画書との二重記述を避ける)。想定リスクは判明分のみ任意。企画書は `kind=charter` (layer=L0、`parent_design` 不要 = root) で起票し、必須 role は `po` (要件定義書 §1.8)。**G0.5 企画突合**は軽量ゲートで、高レベル方向性が L1 業務要求へ trace できるか + 整合性破綻がないかだけを軽く確認する (完全性は求めない。書きすぎ = L1/L3 相当の詳細は穴とせず L1 へ降ろす。軽い他者レビューを推奨するが hard 必須にしない。fail 条件は要件定義書 §2.1.1)。リポジトリ初期化・Branch Protection 等の基盤整備は Phase 0 (要件定義書 §10) として工程外で扱う。

### 3.1.2 L1 / L3 の二段分割 (業務要求 vs システム機能要件)

V2 は要件を二段に分ける。**L1 = 業務要求 (BR-* / NFR-*) のみ** (FR を書かない)、**L3 = システム機能要件 (FR-*) + 受入条件 (AC-*)** で、FR-* は L1 の BR-* から双方向 trace する。チーム: L1 は po 主体 (業務要求まで)、L3 は tl 主体 (FR+AC 確定)。G1 を業務要求ゲート、G3 を FR+AC ゲートとして人間サインオフを分離する。

### 3.1.2.1 L1 sub-doc 構造 (V2 source snapshot reference を UT-TDD 正本へ再定義、必須 § 含む)

V2 source snapshot reference の process doc / L1 requirements 実体 doc は **L1 を 1 doc にまとめず 5 sub-doc に分割**する。UT-TDD はこれを設計概念として参照し、各 sub-doc の **必須 § 構造**まで規定する:

| sub-doc (5 種) | 必須 § (source snapshot reference 実体 doc に準拠) | PLAN 命名 (UT-TDD) |
|----------------|------------------------------------------|--------------------|
| **業務要求** (business) | §1 目的・背景 (WHY/WHAT/WHO) / §2 対象業務一覧 / §3 業務フロー (Forward V-model 主線 + 9 mode 分岐 + cross-cutting 横断機構) / §4 ステークホルダー / §5 現状課題 → あるべき姿 / §6 業務スコープ外 (本 BR で扱わない: FR / 画面 / 技術 / NFR / 実装) / §7 L14 運用テスト pair 対応表 (BR-* ⇔ OT-* 1:1) / §8 関連 doc / §9 carry / 既知の不足 + §9.1 上流 baton carry 一覧 / **§10 業務 entity 列挙 (DDD 適用、要件レベル / 詳細は L4)** + §10.1 主要業務 entity 一覧 (L0 用語と 1:1 対応 / 業務的意味 / 対応 schema・CLI・file の 4 列 table) + §10.2 L4 carry (集約境界 / 値オブジェクト / entity ID 規約 / ライフサイクル / 不変条件 / 集約間整合性 / `ut-tdd doctor check_business_entity_coverage` 新設) + §10.3 SSoT 参照 (ユビキタス言語 / Bounded Context / 業界標準整合) | `PLAN-L1-01-business-requirements` |
| **機能要求** (functional) | §1 機能一覧 (**FR-L1 現行 47 件、P0: 19 / P1: 23 / P2: 5 で確定**、`docs/migration/v2-import-ledger.md §6` + FR-L1-50 DDD/TDD strictness 参照) / §2 利用シナリオ (ユースケース) / §3 操作とデータの流れ / §4 入出力 / §5 上流 baton 反映 (L0 企画書バトン項目と本 doc FR-L1-* の対応表 + carry 先) / §6 関連 doc | `PLAN-L1-02-functional-requirements` |
| **画面要求** (screen) | §1 画面一覧 / §2 画面遷移の要望 / §3 表示・操作への要望 / §4 関連 doc (具体的画面設計は L2、本 sub-doc は要求レベル) | `PLAN-L1-03-screen-requirements` |
| **技術要求** (technical) | §1 採用技術・技術制約 / §2 外部連携 + IF 要望 / §3 既存システム制約 / **§4 state schema 二層構造** (UT-TDD では `.ut-tdd/` 配下、core tables + audit/event tables + derived views + 補助 state、closure event 契約 = `idempotency_key = mode + plan_id + closure_event_id` + rollback + conflict resolution) / **§5 工程別 skill 注入機構** (`docs/skills/<L>-injection.yaml` 相当、`owner_role` / `mandatory_agents` / `recommended_agents` / `recommended_skills` / `recommended_commands` / `orchestration_mode` の 6 フィールド) / **§6 9 mode 共通基盤** (R0-R4 + RGC を Reverse 専用ではなく共通 closure language として再利用、Forward 接続 event の state 登録 + 補助 state への中間 state 保存 + discrepancy_log からの機械起動) / **§7 drift 解消方針** (detector の週次以上起動 + inventory schema による工程双方向 mapping + 新規 asset 工程未割当不許容 + Reverse normalization 接続 + 運用目標「新規 drift 0 件 / week」) / §8 関連 doc | `PLAN-L1-04-technical-requirements` |
| **非機能要求** (nfr) | §1 可用性 / §2 性能・拡張性 / §3 運用・保守性 (冒頭で carry 宣言 = 排泄系契約・上流 baton の段階 carry) / §4 移行性 / §5 セキュリティ / §6 システム環境 (**IPA 非機能要求グレード 2018 6 大項目に準拠**) / **§7 IPA × ISO 25010 二軸タグ表** (全 NFR-ID × IPA 大項目 × ISO 25010 特性 の 3 列 + 対象外特性の除外理由) / §8 関連 doc (carry 接続記述 = `pairs_test_design: []` の L1 許容 + L4 起票時追加 + L4↔L9+L13+L14 多層検証接続) | `PLAN-L1-05-nfr` |

> **L1 機能要求 ≠ L3 機能要件**: L1 機能要求 (FR-L1-*) は「ユーザー視点で何の機能を望むか」= **要求**、L3 機能要件 (FR-*) は「システムが満たすべき仕様 + AC」= **要件**。L1 の 5 sub-doc は L3 で確定される FR-*/AC-* の **入力**であり別物。
> **L1 = 1 PLAN にまとめる旧運用は誤り** (§3.5 AP-11)。
> L1 全 sub-doc ↔ L14 運用テスト設計 1 doc の pair (G1↔L14、V-model)。
> 5 sub-doc の **必須 § 機械検証**は要件定義書 §1.10.G.6 で fail-close 化する。

### 3.1.2.2 L0 → L1 → L4 ドメイン継承チェーン (DDD anti-corruption layer)

V2 source snapshot reference の業務要求 doc §10 を採用し、UT-TDD は L0 → L1 → L4 のドメイン継承チェーンを以下で固定する (DDD anti-corruption layer 原則):

```
[L0 企画書]                          ユビキタス言語 SSoT
  §Glossary (主要用語定義)             ↓ parent_doc reference
                                       ↓ (1:1 対応、L1 独自定義禁止)
[L1 業務要求 sub-doc §10]            業務 entity 列挙 (DDD、要件レベル)
  §10.1 主要業務 entity 一覧 (table)   ↓ L4 carry
                                       ↓ (集約境界 / 値オブジェクト 等で詳細化)
[L4 基本設計 - データ設計 sub-doc]   ドメインモデル詳細 (arc42 §5 Building Block View)
  + ut-tdd doctor check_business_entity_coverage で entity ↔ schema / CLI 整合検出
```

| chain step | 担当 doc | 規約 |
|---|---|---|
| **ユビキタス言語 SSoT** | L0 企画書 §Glossary (UT-TDD では `docs/governance/ut-tdd-agent-harness-concept_v3.1.md §10 用語集`) | L1 sub-doc は L0 用語を **parent_doc reference** とし、独自定義禁止 (anti-corruption layer) |
| **Bounded Context SSoT** | L0 企画書 §BC (UT-TDD では §2.5 9-mode ecosystem) | L1 の業務スコープ・mode 接続は L0 BC を参照 |
| **業界標準整合 SSoT** | L0 企画書 §業界標準 (UT-TDD では §11 参考文献) | L1 NFR の IPA × ISO 25010 二軸 / 業務 entity の DDD 適用 等は L0 で宣言された業界標準と整合 |
| **業務 entity 列挙** | L1 業務要求 §10 (要件レベル、L0 用語と 1:1) | UT-TDD ドメイン entity (例: plan / gate / artifact / pair / mode / drive / agent_slot / handover / sprint / phase / carry / trace) を業務側面で列挙、対応 `.ut-tdd/` state / CLI subcommand / file を併記 |
| **ドメインモデル詳細化** | L4 基本設計 (データ設計 sub-doc) で carry 確定 | 集約境界 / 値オブジェクト / entity ID 規約 / ライフサイクル / 不変条件 / 集約間整合性ルール を確定、`ut-tdd doctor check_business_entity_coverage` で機械検出 |

**anti-corruption layer 原則**: L1 で entity を独自定義することを禁止し、L0 用語との 1:1 対応を `ut-tdd plan lint` (sub_doc=business 時) で機械検証する。詳細は要件定義書 §1.10.G.7 (新)。

**living glossary 原則 (各工程で用語更新)**: ユビキタス言語は L0 §10 用語集を**単一 SSoT** とし、L0 で初期定義したうえで**各 V-model 工程 (L1-L6) で更新される living glossary** として扱う。各工程は語を独自定義せず、その工程で新規導入 / 精緻化したドメイン語・機構語を **L0 §10 へ back-merge** する。これにより「用語更新 (glossary delta)」は各設計層の **① 必須成果物の一部**となる (§3 driveモデルの ① 必須タスクに含む)。§10 用語集は各語に **導入層 / 更新層** を記録し、どの工程で生まれ・更新されたかを trace する。機械検証は要件定義書 §1.10.G.9 (新)。

**living FR registry 原則 (機能一覧の漏れ監査自動化)**: 機能一覧 (L1 機能要求 §1) も用語集と同型の living artifact とし、**FR registry の単一 SSoT** とする。各工程で発見 / 拡張した機能要求は独自管理せず §1 へ **back-merge** し (PLAN §7 機能要求更新 = ① 必須成果物)、登録完全性は `src/lint/fr-registry-audit.ts` が漏れ 5 型 (登録漏れ / 欠番 / 属性 / 件数整合 / 画面被覆) で自動監査する。手動 audit (A-51/52/54) はこの lint へ移行する。機械検証は要件定義書 §1.10.G.10 (新)。

**improvement backlog 原則 (作業ログ → 機能化)**: 作業中に発見した不備・改善は揮発させず `docs/improvement-backlog.md` に蓄積し、triage して lint / FR / policy / doc へ機能化する living backlog とする (FR-L1-19 Learning Engine 本実装までの手動橋渡し)。ledger (起きたことの決定台帳) と backlog (これからやる改善候補) を相互参照で分離し、`verified` 以外の改善候補は §2.5 ②駆動モデル (検証 / 改修駆動) の trigger 源とする。機械検証は要件定義書 §1.10.G.12 (新)。

### 3.1.2.3 L1 sub-doc 共通ヘッダー要素 (4 doc 共通)

5 sub-doc 全てに以下を冒頭 blockquote で必須化:

| 要素 | 内容 | 検証 |
|---|---|---|
| **SSoT 参照宣言ブロック** | `ユビキタス言語 = L0 §10 用語集 / 業界標準整合 = L0 §11 / Bounded Context = §2.5 9-mode。本 doc は L0 を parent_doc reference とし、用語独自定義は行わない (anti-corruption layer)` を明示 | `ut-tdd plan lint` (sub_doc 指定 PLAN 全件) |
| **件数確定宣言** | 当該 sub-doc が確定する要求の件数 (例: business なら BR-NN 件、functional なら FR-L1-NN 件) + 確定根拠 (TL/PMO レビュー record) | doctor で要求 ID の連番性 + 件数整合検証 |
| **L3 接続規約** | `next_pair_freeze:` フィールドが指す L3 doc + `dependencies.requires` で L3 PLAN が本 sub-doc 全件を列挙する接続条件 | L3 PLAN 起票時の機械検証 |
| **pair / parent / related フィールド** | frontmatter に `pair_artifact:` (L14 運用テスト設計 path) / `related_l0:` (L0 概念層 path) / `related_br:` (NFR/技術要求 sub-doc のみ、業務要求への参照) を必須 | requirements §1.10.G.2 拡張 |

### 3.1.3 設計の 3 段分割 (L4 基本 / L5 詳細 / L6 機能)

V2 は設計を **L4 基本設計 (外部設計: アーキ/ADR)** → **L5 詳細設計 (内部設計: D-API/D-DB/D-CONTRACT、API/Schema Freeze)** → **L6 機能設計 (関数 signature・エッジケース + WBS)** の 3 段に分け、それぞれ G4/G5/G6 で独立凍結する。旧 UT-TDD の L2 全体設計 / L3 詳細 / L3.5 機能はこの L4 / L5 / L6 に remap される。

### 3.1.3.1 L2-L6 sub-doc 構造 (V2 source snapshot reference)

各設計層も sub-doc 分割を取る (V2 source snapshot reference の各 process doc から UT-TDD 向けに再定義):

| layer | sub-doc 構造 (source snapshot reference 設計概念参照) | 数 |
|-------|------------------------------------|-----|
| **L2 画面設計** | 画面一覧 (画面 ID・各画面の役割) / 画面遷移 (遷移図・条件・イベント) / ワイヤーフレーム (各画面のレイアウト・情報配置) / UI 要素 (主要 UI コンポーネント・入力/表示/操作要素) | 4 |
| **L3 要件定義** | 業務要件 (業務フロー確定版・業務ルール・対象業務範囲) / 機能要件 (機能一覧確定版・機能仕様・入出力定義) / 非機能要件 (IPA 非機能要求グレードのグレード値で確定) | 3 |
| **L4 基本設計** | 方式設計 (システム構成・アーキ・技術スタック) / 機能設計 (機能構成・機能間連携) / 画面設計 (画面レイアウト確定・画面項目定義) / データ設計 (論理データモデル・テーブル概要・ER 図) / 外部 IF 設計 (外部システム連携・API 概要) | 5 |
| **L5 詳細設計** | 内部処理設計 (モジュール内部処理・処理フロー) / モジュール分割 (モジュール構成・責務分担) / 物理データ設計 (物理テーブル・インデックス戦略) / IF 詳細設計 (入出力詳細・エラー処理) | 4 |
| **L6 機能設計** | 関数仕様 (関数/メソッド仕様・引数・戻り値) / クラス設計 (クラス構成・責務) / エッジケース (境界値・例外・エラー処理パターン) | 3 |

各 sub-doc は単独 PLAN で起票 (PLAN 命名: `PLAN-L<N>-<NN>-<sub-doc-slug>`)。drive 不適合 sub-doc (例: be 駆動なら L2 画面設計の sub-doc 群を skip) は **skip 理由を PLAN frontmatter `skip_sub_doc:` に明記**することで省略可。drive 別の skip/必須は §3.7 駆動別 L2-L11 挙動表を正本とする。

### 3.1.4 L7 実装スプリントの 7 ステップ (3 点レビュー)

L7 は単なる「実装」ではなく、**TDD Red → 本体実装 → 3 点レビュー → テストパターン追加 → テスト実施 → 修正** の順序を持つ。3 点レビューは **① 設計 ⇔ ③ テスト設計 ⇔ ② 実装コード** の三位一体確認で、矛盾があれば設計工程 (L4/L5/L6) に差し戻す (チーム: aim セルフ + G7 時 frontier-reviewer、差し戻しは aim→tl エスカレーション)。実装 PLAN は `parent_design:` (L6 機能設計 doc への path) を必須とする (要件定義書 §1.1)。

**レビュー範囲は単一スコープに閉じない**。diff だけを見ると依存関係の誤りや重複実装を見逃す。レビューは少なくとも次の 3 スコープで行う:

- **関数単位**: 変更関数自体 (signature / 契約整合 / ロジック / 境界)。
- **機能単位**: 機能内の関数群の整合・**依存関係の正しさ** (呼び出し/import グラフの orphan・cycle・missing、レイヤリング違反) ・インターフェース断片化の有無。
- **横断 (repo)**: **重複実装 / 機能被り**の検出 — 同等機能が既存に無いか。L7 着手前に既存資産の流用候補を確認し (重複防止)、被りがあれば再実装せず Add-feature / Refactor mode へ回す。

依存・重複の機械検出は §2.6.5 の横断検出 (relation-graph / connection-deficiency) と code-index (`ut-tdd code find` / `dup` 相当) を用いる。具体チェック項目は要件定義書 §7.8.7.1 (DEP / DUP / MOD)。

### 3.1.5 右腕工程の差し戻しルール (L8-L14)

右側の検証工程で失敗した場合、差し戻し先を **V-pair (左腕設計層) を基準に**明示する:

- **L8 結合テスト失敗 → L5 詳細設計 または L7 実装**
- **L9 総合テスト失敗 → L4 基本設計**
- **L10 UX 不承認 → L2 画面設計** (ワイヤーモック再確認)
- **L11 UAT フィードバック → L3 要件は `add-design`、L1 業務要求は `kind=design layer=L1`** (`add-design` は L3-L6 限定のため L1 不可。既存 doc は不可変)
- **L12 受入テスト失敗 → L3 要件定義 または L7 実装**
- **L13 デプロイ後検証失敗 → 本番回帰 (`regression_prod`) は Incident mode、軽微な設定ミスは L12 再デプロイ**
- **L14 運用検証失敗 → 観点不足は次サイクル L1/L3 設計 feedback、重大 NFR 逸脱は Incident または L1 要求見直し**

差し戻し記録は PLAN の carry log に残す。**右側工程で「ペア凍結されていないテスト設計」を新規起票することは V-model 違反** (AP-7。テスト設計は必ず左側の対応層で凍結済みであること)。右腕 CI が post-merge / scheduled で失敗を検知した場合は **Issue を自動起票して上記差し戻しへ接続**する (要件定義書 §6.8.4)。

> **2026-06-02 改訂**: 旧版は L8/L9 のみ定義。PLAN-DISCOVERY-04 右腕監査 + PLAN-REVERSE-01 (R2-R4) で L10-L14 を本節 (正本) へ昇格した (元 spike = `docs/process/forward/L08-L14-verification-phase.md §右腕差し戻しルール`)。各差し戻し先は V-pair (L1↔L14 / L2↔L10 / L3↔L12 / L4↔L9 / L5↔L8 / L6↔L7) に対応する。

### 3.1.6 L11 総合レビュー + UAT (要件巻き取り)

L11 は **L1 業務要求 + L3 要件 ↔ 実装・テスト結果の全体突合** と **ユーザー検証 (Beta/UAT)**、および **フィードバックの L1/L3 巻き取り** を担う独立工程。チーム: pm+po が主体、UAT は po 主体で aim が補助、巻き取りは tl が L1/L3 doc を更新する。

## 3.2 Forward で使う kind

- 起点: `design` (L0-L6 で企画/要求/画面/要件/基本/詳細/機能の設計 doc を起票)
- 実装: `impl` (L7。`parent_design:` 必須)
- 補助: `research` (L1 前段の技術調査)

詳細 enum は要件定義書 §1 を参照。

## 3.3 ゲートの意味 (概念)

G0.5-G14 はそれぞれ「次工程に進むための足切り」。G0.5 企画突合 / G1-G6 は設計・テスト設計のペア品質、G7 は実装凍結 (4 artifact trace)、G8-G10 は検証品質、G11-G14 はレビュー・リリース・運用品質を判定する。各ゲートは **人間サインオフ点** であり、誰が承認するか (owner) は §2.6 / §9 で定義する。判定基準は要件定義書 §2 で機械検証可能な形に確定する。

## 3.3.1 G1 sub-gate 構造 (3 段判定、DD1=a / DD2=a PO 承認 2026-05-28)

G1 (L1 業務要求 pair freeze) は以下 3 sub-gate を **全件通過** で exit する。gate 番号体系は変えない (G1 は G1 のまま、内部を 3 段に細分化)。

```
G1 (L1 業務要求 pair freeze)
  ├─ G1-content : 5 sub-doc 全件起票完了 + 件数確定
  ├─ G1-pair   : L1↔L14 OT 量閉じ (孤児 0)
  └─ G1-trace  : 業務 ⇔ 画面 ⇔ 機能 双方向 trace 整合  ← NEW (DD1=a)
```

### G1 sub-gate 一覧

| sub-gate | 検証対象 | データソース | 通過条件 |
|----------|----------|-------------|----------|
| **G1-content** | 5 sub-doc 全件起票完了 + 件数確定 | business/functional/screen/technical/nfr 各 sub-doc | 全件 status=confirmed |
| **G1-pair** | L1↔L14 OT 量閉じ (孤児 0) | L14 operational-test-design | 全 BR/NFR が OT-* に 1:1 対応 |
| **G1-trace** | 業務 ⇔ 画面 ⇔ 機能 双方向 trace 整合 | screen sub-doc §5 trace マトリクス | R1/R2/R3 block なし |

### G1 entry / exit フロー

```
G1 entry
  ↓
G1-content (5 sub-doc 揃い確認)
  ↓ pass
G1-pair (L1↔L14 OT 量閉じ確認)
  ↓ pass
G1-trace (業務⇔画面⇔機能 双方向 trace 整合確認)
  ↓ pass
G1 exit → L2 画面設計 (G2) へ進行
```

各 sub-gate fail 時は当該 sub-gate に戻り修正。G1 exit は 3 sub-gate 全件通過まで block (fail-close)。

### G1-trace の機械検証ルール概要 (R1-R4)

詳細機械検証ルール: 要件定義書 §1.10.H 参照。

| ルール | 検証内容 | fail 動作 |
|--------|----------|-----------|
| **R1** | BR-01〜08 + UX-01〜03 + BR-21 + BR-22 (計 13 件) が最低 1 画面に紐付く | block |
| **R2** | 全 15 画面 (PM/HM/GD-NN) が最低 1 つの BR/UX/FR-L1 に紐付く | block |
| **R3** | FR-L1 P0 19 件のみ最低 1 画面に紐付く (P1/P2 は warn、DD2=a) | block (P0) / warn (P1-P2) |
| **R4** | screen 関連 PLAN `dependencies.requires` に business + functional を明示列挙 | warn |

SSoT: screen sub-doc §5 trace マトリクス (Step J で起票)。`ut-tdd plan lint --gate G1-trace` で machine 一次判定する。

## 3.4 QA 追加テストの分離 (V-model 補足)

L7 実装完了後に QA が追加する **regression / exploratory / edge-case** テストは、左側で凍結した結合テスト設計 (L5) や単体テスト設計 (L6) に **統合してはいけない**。L8/L9 の検証工程で発見した品質観点は独立の追加テスト設計 doc として正本化する。理由は V-model 原則で「設計時に書いたテスト」と「品質保証時に追加するテスト」を混ぜると追跡不能になるため。

実装後レビューで見つかった不足観点は、左側 (L5/L6) の frozen test design を直接書き換えず、QA 追加テストまたは `add-design` / `add-impl` (Add-feature mode、§2.5) の差分 PLAN として扱う。追加テストも、先に `docs/test-design/` の追加テスト設計 doc を正本化し、その doc に対応するテストコードだけを書く。

## 3.5 工程別アンチパターン (V-model 違反、AI 実装が踏みがち)

以下は AI 実装が踏みやすい V-model / V-model 違反。`ut-tdd plan lint` / `vmodel_validator` で機械検出し、`frontier-reviewer` の 3 点レビュー観点にも組み込む (要件定義書 §2 / §7)。

| # | アンチパターン | 違反内容 |
|---|----------------|----------|
| AP-1 | ① 設計と ② 実装コードを同一文書に書く | D-API 内にコード本体を埋め込む |
| AP-2 | ① 設計と ③ テスト設計を同一文書に書く | D-API 内に test case 列挙を埋め込む |
| AP-3 | ③ テスト設計と ④ テストコードを同一文書に書く | test ファイル先頭の長文 docstring に case 設計 |
| AP-4 | AC なしで G3 を通す | L3 要件に受入条件が無いまま実装着手 |
| AP-5 | `parent_design` 不在で L7 実装 PLAN 起票 | 機能設計 doc に紐づかない実装 |
| AP-6 | L1 に FR を書く | 業務要求工程にシステム機能要件が混入 |
| AP-7 | 右側工程でペア未凍結のテスト設計を新規起票 | L8/L9 でテスト設計を後付け (V-model 違反) |
| AP-8 | 逆ピラミッド (① + ② はあるが ③ + ④ が無い) | 「テストも書いた」と称し ③ テスト設計 doc を欠く |
| AP-9 | 重複実装 / 機能被り | 既存に同等機能があるのに再実装する (着手前の `ut-tdd code find` 流用確認を怠る。被りは Add-feature / Refactor へ回す) |
| AP-10 | 依存関係違反 | 呼び出し/import グラフに orphan・cycle・missing、またはレイヤリング違反を生む (機能単位レビューで検出) |
| AP-11 | L1 を 1 PLAN / 1 doc にまとめる | V2 source snapshot reference では L1 = 5 sub-doc (業務/機能/画面/技術/非機能、§3.1.2.1)。1 doc 統合は要求の関心混在で再番号化リスク |
| AP-12 | L2-L6 sub-doc 構造を持たない設計 PLAN | V2 source snapshot reference では L2=4 / L3=3 / L4=5 / L5=4 / L6=3 sub-doc (§3.1.3.1)。複数関心を 1 PLAN に混在させる起票は禁止 |
| AP-13 | PLAN に工程表 + 実装計画が内蔵されていない | V2 source snapshot reference では PLAN = 機能 (doc) 単位で工程表 + 実装計画を内蔵 (§3.6)。本文 0 行・成果物 declare のみの PLAN は無効 |

## 3.6 PLAN 内蔵物原則 (V2 source snapshot reference)

V2 source snapshot reference の設計概念に従い、**PLAN は機能 (=ドキュメント) 単位で起票し、以下 2 要素を内蔵する**:

| 内蔵要素 | 内容 |
|----------|------|
| **工程表 (作成手順 + 進捗)** | そのドキュメントを完成させる手順 (例: 参考調査 Web 検索 → 既存資料整理 → ドラフト → TL レビュー → 確定) と各手順の進捗 (`☐ / 🔄 / ✅`) |
| **実装計画** | 記載項目をどう埋めるかの計画 (情報源 / Web/TL 調査が必要か / 人間 PO ヒアリングが必要か / 自動生成可能か 等) |

PLAN 本文は「ヒアリング項目・メモ・調査結果」の **中間準備ドシエ**であり、**正本 doc (上記 sub-doc) とは別文書**。正本 doc は PLAN §0 の `generates` で declare する成果物。

工程表 Step には **review (self / pmo-sonnet / tl-advisor) を必ず固定 Step として組み込む** (self-review 前置原則と整合、`.claude/CLAUDE.md` Guard Rules)。

## 3.7 駆動別 L2-L14 挙動表 (source skill-map reference + V2 process L 番号 remap)

各 drive (be / fe / fullstack / db / agent) で L2-L14 の中身とゲート判定が変わる。本節の表を UT-TDD 正本とする。source skill-map reference と V2 process docs は翻案元 reference であり、現行判定は本書と要件定義書に従う:

| フェーズ | be | fe | db | fullstack | agent |
|---------|----|----|----|-----------|----|
| **L2 画面設計** | **画面要求必須** (画面一覧 + 遷移 + UI 要素)、モック (wireframe) は省略可。**BE-only (UI 完全不在) のみ全 skip 可** | **モック駆動設計** (方針 + token + `mock.html` + `state-events.md`) | (UI 不在で skip / 軽量) | BE 方針 + FE 方針 (**mock 含**) + 接続契約方針 (同時策定) | 会話 UI モック / プロンプト UI 設計 |
| **L3 要件定義** | API 契約 + DB + 工程表 | TL が `state-events.md` から **API 契約導出** + DB + 工程表 | マイグレーション + API 契約 + 工程表 | D-API + D-UI + D-CONTRACT + D-DB + D-STATE + **mock** + 工程表 | ツール契約 + 統合要件 + 工程表 |
| **L4 基本設計** | アーキ・API 方針・ADR | mock 凍結後のアーキ反映 + Contract | ER 図・スキーマ方針 | BE 方針 + FE 方針 + Contract 三点凍結 | ツール定義・オーケストレーション方針 |
| **L5 詳細設計** | D-API / D-DB / D-CONTRACT | mock→API 契約導出 + D-API/D-DB | D-DB 中心 + D-API | 全 D-* + mock | ツール契約詳細 + state-events |
| **L6 機能設計** | 関数 signature | コンポーネント仕様 + 関数 signature | CRUD 関数 + マイグレーション | 全領域 | ツール関数 + プロンプトテンプレ |
| **L7 実装順** | ロジック → API → FE | BE (契約 base) ∥ FE (**モック → 本実装昇格**) → 統合 | スキーマ → CRUD → API → FE | Phase A: BE Sprint ∥ FE Sprint (**mock 起点**) → Phase B: L5/L8 結合 | ツール → オーケストレーション → UI |
| **L10 UX 磨き** | 薄い (表示確認) | **厚い** (デザイン駆動) | 薄い (管理画面確認) | 標準 (結合後に Visual Refinement) | 会話 UI / デモ確認 |
| **L13 デプロイ後検証** | 標準 | 標準 | 薄い | 標準 | 薄い |
| **L14 運用検証** | 標準 | 標準 | 薄い | 標準 | 標準 |
| **G2 凍結** | **画面要求凍結必須** (一覧 + 遷移 + UI 要素)、モック凍結は省略可 (BE-only のみ全 skip 可) | **モック凍結** (UX 承認) | (UI なしなら skip 可) | 接続契約方針凍結 (BE + FE + Contract 三点セット) | 会話 UI モック凍結 |
| **G5 着手** (API/Schema Freeze) | API/Schema Freeze | **モック + API/Schema Freeze** | Migration Freeze | API/Schema/UI/Contract 全凍結 | Tool Contract Freeze |

### L10 (UX 磨き) 要否 (drive 別)

| drive | L10 必要条件 |
|-------|-------------|
| be | UI を持つ場合のみ (be 単独 BE-only なら skip) |
| fe | **常に必要** (FE 駆動の核心) |
| db | UI を持つ場合のみ |
| fullstack | **常に必要** (結合後の Visual Refinement) |
| agent | **常に必要** (会話 UI / デモ) |

### L2 sub-doc skip ルール (drive 別、2026-05-28 PO 指摘で修正)

| drive | L2 sub-doc 4 種 (画面一覧 / 遷移 / ワイヤー / UI 要素) の扱い |
|-------|-------------------------------------------------------|
| **be (BE-only、UI 完全不在)** | 全 skip 可 (frontmatter `skip_sub_doc: ["L2-*"]` + 理由 `"BE-only, no UI"`) |
| **be (UI を持つ、ダッシュボード等)** | **画面要求 3 sub-doc (画面一覧 / 遷移 / UI 要素) 必須**、wireframe (モック High-Fi) のみ省略可 (`skip_sub_doc: ["L2-wireframe"]` + 理由 `"Low-Fi で代替、High-Fi は L10 UX refinement"` または `"High-Fi モックは外部依頼 (Figma 等)"`、A-39/A-40 参照)。**High-Fi モックは ケース別判断** (harness 内保持 OR 外部依頼、外部依頼は許容オプションで必須ではない)。**外部依頼時は要件修正 back-propagation の可能性あり** (G1-trace 再検証必須) |
| fe | 全必須 |
| db (UI 無し) | 全 skip 可 |
| db (管理画面あり) | **画面要求 3 sub-doc 必須**、wireframe 省略可 |
| fullstack | 全必須 |
| agent | 全必須 (会話 UI を要素として扱う) |

L4 画面設計、L5 物理データ設計 等の sub-doc skip も同様に drive で判定 (PLAN frontmatter `skip_sub_doc:` で明示)。

> **2026-05-28 PO 指摘修正**: 旧版では「be (BE-only) = L2 全 skip 可」と一括判定していたが、ut-tdd 自身を含む「UI を持つ be」では画面要求 3 sub-doc は必須 (PO 指摘「L2 スキップすんな。モックは作らなくてもせめて画面要求は作れよ」)。skip 対象は wireframe (High-Fi モック) のみ。画面要求の機械検証義務は drive 非依存。

> 注: SKILL_MAP では L9-L11 が「デプロイ検証 / 観測 / 運用学習」だったが、UT-TDD は V2 process docs を正本として L9=総合テスト / L10=UX 磨き / L11=総合レビュー+UAT / L12=デプロイ+受入 / L13=デプロイ後検証 / L14=運用検証 を採用。本表は SKILL_MAP の挙動を V2 process L 番号に合わせて remap している。

---

# §4 経路 2: Scrum × Reverse 自動 routing (PoC → 文書化)

> **v3.1 mode 対応**: 本 §4 (経路 2) は 9-mode (§2.5) の **Scrum / Reverse / Discovery** に、§5 (経路 3) は **Add-feature** に、§6 (緊急経路) は **Recovery / Incident** に対応する。各 mode の入口判定・推奨コマンド・承認者は §2.6 の配線で決まる。Forward 合流先の層番号は L0-L14 (§3) を正とする (旧 L0-L11 表記が本節以降に残る場合は §3 に読み替える)。

## 4.1 概念

要件未確定 / 仮説検証フェーズの開発を、確定後に通常開発 (Forward mode) へ合流させる経路。Scrum モードで PoC を回し、決着 (S4 decide) 後に Reverse モードで「PoC コード → 設計 doc」を逆復元し、Forward に接続する。

## 4.2 Scrum モード (S0-S4)

仮説の性質に応じて **6 type** に分類:

- hypothesis-test (基本仮説検証)
- tech-spike (技術検証)
- design-spike (設計検証)
- perf-spike (性能検証)
- security-spike (セキュリティ検証)
- ux-spike (UX 検証)

各 type は S0 (Backlog) → S1 (Sprint Plan) → S2 (PoC 実装) → S3 (Verify) → S4 (Decide: confirmed / rejected / pivot) のフェーズを辿る。`agent_slots` の `aim` が PoC 実装を担当、`tl` が S4 decide を担当。

## 4.3 Reverse モード (R0-R4)

S4 で confirmed になった PoC を本実装に昇格させるため、PoC コードから設計 doc を逆復元する。**5 type** に分類:

- code (コードから設計復元 — 標準)
- design (デザイン資産から復元、R1 skip)
- upgrade (既存 system + 新版差分から)
- normalization (設計 drift 修正、R1 skip)
- fullback (実装完遂後の文書整合)

各 type は R0 (Evidence) → R1 (Observed Contracts、type により skip) → R2 (As-Is Design) → R3 (Intent 仮説、**po 検証**) → R4 (Gap & Forward Routing) を辿る。

## 4.4 30 cell matrix (Scrum 6 type × Reverse 5 type — 元 Critical C4 fix)

Scrum 6 type と Reverse 5 type の組み合わせで「どの routing を使うか」を機械判定する。

**R1 skip 判定の主キーは解決済み reverse_type を採用する**。v2.1 では `scrum_type` 固定で「tech-spike → R1 skip」のように決め打ちしていたが、Alternative reverse routing (例: tech-spike × upgrade) が許容されているため、scrum_type 単独では判定不能。**R1 実施/skip 列は 30 cell に明示的に持つ**。

30 cell の具体表は要件定義書 §3 に確定する。

## 4.5 経路 2 → 経路 1 合流

R4 で Gap を整理した後、UT-TDD Agent Harness の Forward 経路に接続。R4 outcome に応じて L1 (要求定義) / L3 (要件定義 FR+AC) / L4 (基本設計) / L5 (詳細設計) / gap-only (差分集約のみ、新規層なし) のどこに合流するかを決める (L0-L14 体系。旧 L2/L3 = 全体設計/詳細設計 は L4/L5 に remap。要件定義書 §3.4)。

このとき PoC / 検証成果を **そのまま機能として活かすか**、**再設計して導入するか** は `promotion_strategy` として別判定にする。`forward_routing` は合流レイヤー、`promotion_strategy` は成果物の扱いを表す。PoC コードをそのまま main に入れることは原則禁止で、reuse する場合も trace / test / security 条件を満たしたものだけに限定する。

---

# §5 経路 3: add-design / add-impl (追加実装対応)

## 5.1 概念

既存 PLAN が completed 後、機能拡張・追加実装が必要になったときの経路。問題 P4 (既存実装への破壊的追加) に対処する。

### 経路 3 の禁則 (3 原則)

| 原則 | 内容 |
|------|------|
| **既存設計を改変しない** | 既存 PLAN の ① 設計 doc は不可変。差分は新規 add-design doc に分離 |
| **既存テストを変更しない** | 既存 ④ テストコードは不可変 (回帰検知の生命線)。新規テストのみ追加 |
| **回帰確認必須** | add-impl の merge 前に既存テスト全 PASS を CI で確認 |

## 5.2 経路 3 で使う kind

- `add-design`: 既存 PLAN への設計追補
- `add-impl`: 既存 PLAN への実装追加

両者とも `dependencies.parent` で既存 PLAN を指定する。

## 5.3 経路 3 の流れ (概念)

```
既存 PLAN-NNN completed
   ↓
新規 PLAN-MMM-add-design 起票 (parent: PLAN-NNN)
   ↓ 既存設計を変更せず差分追加、③ 新規テスト設計も pair
   ↓ G3-G6 (差分の設計層のみ対象、V-model 左)
新規 PLAN-MMM-add-impl 起票 (parent: PLAN-MMM-add-design)
   ↓ 既存コードを変更せず、新規 src + 新規 tests のみ追加
   ↓ CI で既存テスト全 PASS 確認 (回帰確認)
   ↓ G7 (差分の 4 artifact trace + 回帰結果)
   ↓
merge → 既存 PLAN との双方向 reference 更新
```

---

# §6 補助 1: 緊急経路 (recovery / hotfix)

## 6.1 概念

P0/P1 インシデント発生時、または AI session 中の認識ずれ・session 断絶からの再開のために、通常経路を一時迂回する経路。

## 6.2 recovery kind の扱い

session 断絶・認識ずれからの再開を文書化するための kind。`agent_slots` に `aim` を必須化し、本文に **7 必須セクション** (事故記録 / 議論順序 / 認識訂正履歴 / 中間結論 / context 再構築 / 再開ポイント / 再発防止) を持つ。

## 6.3 hotfix ブランチ + ワークフロー

P0/P1 障害の即時修正用ブランチ。Branch Protection で hotfix postmortem doc の存在 + recovery PLAN 紐付けを必須化する。

## 6.4 session 終了前 fail-close (概念)

AI session が context 限界 / commit 直前で「やり残し」を残さないため、push 前に以下を必須チェックする (具体的 4 項目と判定方法は要件定義書 §5):

- 設計 ⇔ 実装 ⇔ テストの整合性
- 未 commit ファイルの取り残し
- 認識ずれの記録
- 次セッションへの引き継ぎメモ

---

# §7 補助 2: GitHub 統制 (全経路の共通基盤)

## 7.1 概念

3 経路を **GitHub Flow** 上で機械強制する基盤。Branch Protection / CODEOWNERS / commitlint / Required Status Checks を組み合わせる。

## 7.2 Required Status Checks の方針 (元 Critical C6 fix)

v2.1 では「branch type 別 workflow を OR 条件で扱う」「該当 workflow が走らない場合 GitHub が自動 skip 判定」と書いていたが、これは GitHub の実挙動と不整合。v3.0 では以下方針に確定する:

**方針: 共通 required check 1 本 (`harness-check`) に集約し、内部で branch type ごとに fail-close 分岐する**。

- 全 PR で `harness-check` のみを Required Status Checks に指定
- `harness-check` 内部で `feature/*` / `poc/*` / `hotfix/*` / `refactor/*` 等を識別し、branch type 固有のチェックを呼び分け
- branch type 固有チェック (poc-no-merge-guard 等) は `harness-check` の subjob として実装し、それ自体は Required Status Checks に登録しない

これにより GitHub の「pending で詰まる」問題と「branch type 固有 check が merge gate にならない」問題を同時に解決する。詳細は要件定義書 §6 / 個別 PLAN-XXX の workflow 詳細設計。

コストと開発体験のため、ローカル hook は harness 自身の小さな self-test / lint / 差分検査だけに限定する。PR 通過要件は GitHub Actions の `harness-check` に集約し、全量テスト・重い vmodel 検証・回帰確認は PR 上で実行する。

## 7.3 ブランチタイプと kind の対応

| ブランチ prefix | 対応 kind | 用途 |
|----------------|-----------|------|
| `feature/*` | `impl` | 通常実装 (経路 1) |
| `design/*` | `design` / `charter` | 設計 doc・L0 企画書起票 (経路 1 / 前段) |
| `research/*` | `research` | 技術調査 (経路 1 前段) |
| `poc/*` | `poc` | 仮説検証 (経路 2 Scrum) |
| `reverse/*` | `reverse` | 設計復元 (経路 2 Reverse) |
| `add/*` | `add-impl` / `add-design` | 既存拡張 (経路 3) |
| `hotfix/*` | `recovery` / `troubleshoot` | 緊急 (補助 1) |
| `refactor/*` | `refactor` / `retrofit` | 内部改善 |
| `docs/*` | (PLAN 不要、例外) | ドキュメントのみ修正 |
| `chore/*` | (PLAN 不要、例外) | 雑務 (依存更新 / CI 設定変更等) |

`branch-kind-check` が PR 起票時に prefix と PLAN kind の整合を機械検証する。**正本は要件定義書 §6.1** (本表はその要約。全 12 kind 網羅・例外 branch の扱いは §6.1 / §7.4)。

## 7.4 PoC → main 直 merge 禁止 (概念)

`poc/*` から main への直接 PR は **物理ブロック**。S4 decide で confirmed になった後、Reverse R0-R4 を経由して `feature/*` ブランチで再実装する経路を強制する。これにより問題 P3 (PoC が独り歩き) を構造的に防ぐ。

具体的な workflow event 設定は要件定義書 §6 で確定する (v2.1 の C5 指摘を fix)。

---

# §8 補助 3: 3 層抽象化 + エスカレーション

## 8.1 概念 (v3.0 重要)

`workflows/*.yaml` / `harness/*.yaml` は **人間と AI が参照する設計仕様書** として位置付け、**実行する interpreter は導入しない**。共有のエスカレーション判定は `scripts/check-escalation-level.sh` + GitHub Actions artifact / job summary で実現し、個人 `failure_log.jsonl` は local advisory に限定する。これにより外部依存 (Temporal / Prefect 等) を避け、軽量実装を保つ。

## 8.2 3 層の役割

```
[層 1] スキル層 (docs/skills/*.md)
  ← 「何をすべきか」の知識 (個別技術 / 観点リスト)
         ↓ 組み合わせ定義 (設計参照のみ)
[層 2] ワークフロー層 (workflows/*.yaml)
  ← スキル呼び出し順序の DAG 定義 (設計仕様書、人間と AI が参照)
         ↓ 設計参照
[層 3] ハーネス層 (harness/*.yaml)
  ← ワークフロー自動実行条件 + ゲート発火 + レビュー注入強度 (設計仕様書)
```

AI (Claude Code / Codex) は PLAN 起票時に層 2/3 YAML を **自然言語指示として** 読み、step 順序と on_failure 規約を適用する。専用 interpreter は無い。

source-derived のスキル群は、個人プロジェクト用の原文をそのまま使わず、UT-TDD 向けの **skill pack** として `docs/skills/*.md` に正本化する。curate 対象は「追加機能設計」「ドキュメント」「実装」「テスト」「Reverse」「運用」の単位に分け、各 skill pack は必ず workflow / harness / gate のどれに接続するかを明記する。

特に、追加機能設計では既存設計を破壊しない `add-design` / `add-impl` 原則、ドキュメント・実装・テストの成果物一致では 4 artifact trace / L6 QA doc-first / review 後の追加 regression を skill pack 側から参照できるようにする。skill は知識と観点の層に閉じ、実行条件や fail-close は harness-check 側で機械強制する。

## 8.3 エスカレーション L0-L3 (元 Critical C8 fix)

reviewer の自動切替レベル:

| Level | reviewer | 動作 |
|---|---|---|
| L0 | agent | AI レビューのみ |
| L1 | aim | AI実装・保守の人間レビュー追加 |
| L2 | council | tl + qa + aim 3 者会議 |
| L3 | human | po 直接通知 + 作業一時停止 |

**昇格判定の概念 (v3.0 で訂正)**: level は「同種失敗 N 回 / 再失敗 M 回」の **閾値を満たす最大値を冪等に算出**する。v2.1 で記述していた「current_level + 1 漸進」は誤り (N=15 を初回観測した場合 L1 止まりになり Human 停止が遅れる)。

例: 同種失敗 N=15 を初回観測した時点で `target_level = max(L1=3, L2=7, L3=15 を満たす)` = L3 と判定し、即 Human 通知。具体的算出ロジックは要件定義書 §8 で確定。

## 8.4 降格判定

`scripts/check-escalation-stale.sh` で定期実行 (週次):

- 違反検出ゼロ 90 日継続 → 降格 **推奨表示のみ** (自動降格しない)
- 未使用 30 日 → warning
- 未使用 90 日 → archive 候補 (human 確認後に非アクティブ化)

降格 / archive は **human (po または tl) 確認後にのみ実行**。

## 8.5 failure_log の取扱い (元 Critical C7 fix)

v2.1 では `failure_log.jsonl` を「git 管理対象」かつ「pre-push hook で書き込み」としていたが、これは矛盾 (push 失敗時の追記は commit に含まれず作業ツリーを dirty 化するだけ)。v3.0 では以下方針に確定する:

**方針: failure_log.jsonl は個人作業ログ (local-ignore) として扱い、チーム共有 audit trail は別経路で実現する**。

| ログ種別 | 位置 | git 管理 | 書き込み主体 |
|---------|------|---------|--------------|
| **個人作業ログ** | `.ut-tdd/audit/failure_log.jsonl` | **`.gitignore`** | ローカル pre-push hook / `scripts/log-failure.sh` |
| **チーム共有 audit** | GitHub Actions job summary + artifact / PR comment。PR label は状態表示のみ | (Actions が管理) | CI job |
| **escalation 集計** | チーム共有 audit のみを正本入力にする。個人ログは local advisory | — | `check-escalation-level.sh` |

詳細は要件定義書 §8 で確定する。

---

# §9 補助 4: チーム責任二極化

## 9.1 5 役割の責任マトリクス

構想書 v1.1 §2.3 の 5 役割を、本ハーネスの全要素にマッピング:

| 役割 | 略号 | 上流 / 下流 | 主責任 |
|---|---|---|---|
| **発注元** | po | (両端) | WHY / WHAT / 受入基準 / R3 Intent 検証 / リリース承認 |
| **TL** (技術責任者) | tl | **上流** | 仕様化 (L3 FR+AC) / アーキ (L4-L6) / G0.5-G6 ゲート / adversarial review / ハーネス設計 |
| **QA** (品質責任者) | qa | **下流** | テスト戦略 / G8-G9 ゲート (L8 結合・L9 総合) / インシデント指揮 / 観点リスト整備 / failure_pattern Issue 月次レビュー |
| **AI実装・保守** | aim | (中間) | AI 指示 / L7 実装委譲 / 3 点レビュー / アラート対応 / エスカレーション初動 / 4 段レビュー Layer 2 |
| **UI/UX デザイン** | uiux | (横断) | Figma / モック (L2 画面設計) / state-events / L10 UX 磨き (screen-design / frontend-design mode) |

## 9.2 役割 × mode マトリクス

mode は §2.5 の 9-mode。旧「経路 1/2/3 + 補助 1」を mode 名へ読み替えた。

| 役割 | Forward | Reverse / Scrum / Discovery | Add-feature | Recovery / Incident |
|---|---|---|---|---|
| **po** | L1 業務要求 / L3 受入条件 / G1·G3 / L11 UAT / L12 受入 | **R3 Intent 検証** / Discovery 成功条件 | (通常は不要) | P0/P1 で連絡 / Recovery スコープ承認 |
| **tl** | G0.5 企画突合 / L4-L6 設計 / G4-G6 | S4 decide / R1-R2 / R4 routing | 既存 doc 整合判断 | 技術対応指揮 / リオープン確認 |
| **qa** | G8-G9 / L8 結合・L9 総合テスト | (通常は L8/L9 で合流) | 回帰確認 | インシデント指揮 |
| **aim** | L7 実装委譲 / 3 点レビュー / 4 段 Layer 2 | S0-S3 PoC 実装 / R0 証拠 | 既存テスト維持確認 | 初動アラート対応 |
| **uiux** | L2 画面設計 / L10 UX 磨き | UX-spike PoC | 既存 UX との整合 | (通常は不要) |

## 9.3 PR レビュー 4 段階 (運用ルール書 §2.4 を実装)

| Layer | レビュアー | 観点 | 応答目安 |
|---|---|---|---|
| **Layer 1** | AI (自動) | コード規約 / 明らかなバグ / 典型的脆弱性 | PR 作成直後 |
| **Layer 2** | aim | テスト不足 / 観点漏れ / 運用影響 / vmodel 整合 | 1 営業日以内 |
| **Layer 3** | tl (必要時) | アーキ判断 / 技術選定の妥当性 / 大規模変更影響 | 1 営業日以内 |
| **Layer 4** | qa (リリース前) | 品質ゲート観点 / E2E / 運用観点 / G9·G11 判定 | リリース前 |

CODEOWNERS で Layer 3 / Layer 4 が自動アサインされる (具体的 path → owner マッピングは要件定義書 §6)。

## 9.4 インシデントエスカレーション (運用ルール書準拠)

```
発見
  ↓
#incident チャンネル投稿 (誰でも、状況 + 影響 + タイムスタンプ)
  ↓
[aim 初動]      影響範囲確認 / 緊急度 P0-P3 判定
  ↓
[qa 指揮]      対応方針 / 関係者招集
  ↓
[tl 技術]      原因切り分け / 修正方針 / hotfix ブランチ作成
  ↓
[該当者]      修正実施 (または se 委譲)
  ↓
[po]           顧客対応判断 (必要時)
  ↓
収束 → postmortem (48h 以内、P0/P1 必須)
  ↓
[全員]        再発防止策を観点リスト / AGENTS.md / CI に反映
```

## 9.5 役割不在時の代行

| 不在 | 代行 |
|---|---|
| tl | qa が技術判断も代行 (慎重に) |
| qa | aim が初動、リリースは保留 |
| po | 顧客影響を判断、不可逆な変更は保留 |
| 全員 (深夜等) | 影響軽微なら翌朝、重大なら誰かに連絡 |

---

# §10 用語集 (ユビキタス言語 SSoT / living glossary)

## §10.0 coding-rule governance 用語

| 用語 | 定義 |
|---|---|
| **coding-rules SSoT** | TypeScript/Bun core の coding rule 正本。`docs/governance/coding-rules.md` を rule ID と workflow placement の SSoT とし、doctor `checkCodingRules` が hard gate として検証する (導入層 L6、PLAN-L6-23/L7-24/REVERSE-23) |
| **CODING-RULE-WORKFLOW** | coding-rule 文書化が CI 後付けではなく Forward/Add-feature/mode workflow step であることを示す process doc anchor (導入層 L6、PLAN-L6-23) |
| **coding-rules workflow analyzer** | `loadCodingWorkflowDocs` / `analyzeCodingRules` によって coding-rule SSoT と workflow anchor の欠落を検出する lint (導入層 L7、PLAN-L7-24) |
| **coding-rules back-fill** | implemented coding-rule workflow を Reverse PLAN へ接続し、add-impl orphan を防ぐ back-fill 記録 (導入層 cross、PLAN-REVERSE-23) |
| **structured-error-handling** | catch block が explicit failure state を返す、記録する、変換する、または fail-open 意図を文書化する coding rule。無記録の空 catch と rethrow-only catch を禁止する (導入層 L6/L7、PLAN-L6-24/L7-25/REVERSE-24) |
| **rethrow-only catch** | catch block whose only statement is `throw`; failure state の変換・記録が無いため structured-error-handling violation とする (導入層 L7、PLAN-L7-25) |
| **error-handling back-fill** | structured-error-handling rule を Reverse PLAN に接続し、実装と governance 設計の trace を閉じる記録 (導入層 cross、PLAN-REVERSE-24) |
| **module-boundary** | source module 間の依存方向を coding rule として検証する境界。`lint`/`runtime`/`schema` の逆依存を禁止する (導入層 L6/L7、PLAN-L6-25/L7-26/REVERSE-25) |
| **reverse import** | lower-level governance module が higher-level runtime/CLI feature module を import する逆依存。module-boundary violation とする (導入層 L7、PLAN-L7-26) |
| **module-boundary back-fill** | module-boundary rule を Reverse PLAN に接続し、実装と governance 設計の trace を閉じる記録 (導入層 cross、PLAN-REVERSE-25) |
| **DDD/TDD strictness** | DDD 境界と TDD evidence を requirements-level SSoT から機械検出へ落とす rule 群。domain-boundary / invariant-test-trace / red-first-evidence / test-oracle-strength / integration-gwt を含む (導入層 L6/L7、PLAN-L6-26..30/L7-27..31/REVERSE-26..30) |
| **DDD-TDD-WORKFLOW** | DDD/TDD rule 文書化が Forward/Add-feature/mode workflow step であることを示す process doc anchor (導入層 L6、PLAN-L6-26..30) |
| **domain-boundary** | DDD の bounded-context / anti-corruption 原則を source import graph に適用し、lint/runtime/schema の逆依存を検出する rule (導入層 L6/L7、PLAN-L6-26/L7-27/REVERSE-26) |
| **invariant-test-trace** | DDD invariant declaration が L7 の U-* oracle と接続していることを検査する trace rule (導入層 L6/L7、PLAN-L6-27/L7-28/REVERSE-27) |
| **red-first evidence** | TDD Red が Green より先に存在することを `red_at <= green_at` evidence で確認する PLAN rule (導入層 L6/L7、PLAN-L6-28/L7-29/REVERSE-28) |
| **test-oracle-strength** | unit test が実行確認だけでなく具体的な assertion oracle を持つことを検査する rule。truthiness-only assertion は弱い oracle として扱う (導入層 L6/L7、PLAN-L6-29/L7-30/REVERSE-29) |
| **integration-gwt** | integration test design の `IT-*` row が Given / When / Then 粒度を持つことを検査する rule (導入層 L6/L8、PLAN-L6-30/L7-31/REVERSE-30) |
| **quantitative check** | vitest / lint / doctor など、システムが定量的に pass/fail する evidence。定性 review の前提条件として扱う (導入層 L6、PLAN-L6-26..30) |
| **qualitative review** | エージェントまたは人間が設計意図・粒度・リスクを判断する review evidence。機械 gate の代替ではない (導入層 L6、PLAN-L6-26..30) |
| **evidence bundle** | gate-significant decision で quantitative check と qualitative review の両方を揃える evidence grouping。片方だけでは freeze-ready としない (導入層 L6、PLAN-L6-26..30) |
| **DDD/TDD back-fill** | implemented DDD/TDD strictness rules を Reverse PLAN に接続し、requirements / design / test / workflow trace を閉じる記録 (導入層 cross、PLAN-REVERSE-26..30) |

> 本節は UT-TDD ユビキタス言語の**単一 SSoT** (§3.1.2.2 anti-corruption layer)。各工程は語を独自定義せず、新規導入 / 精緻化した語をここへ **back-merge** する **living glossary** とする。各語に **導入層** (初出工程) と **更新層** (意味を更新した工程、無ければ —) を記録する。§10.3 機構用語は既定で導入層 = L0。機械検証は要件定義書 §1.10.G.9。

## §10.1 ドメイン entity 用語 (DDD、L1 業務要求 §10.1 と 1:1)

| 用語 | 定義 | 導入層 | 更新層 |
|---|---|---|---|
| **plan** | 工程単位の作業計画 = **進め方手順書** (frontmatter + 工程表 + 実装計画)。機能仕様の入れ物ではない | L0 | L1 |
| **gate** | 工程間の通過判定点 (G0.5-G14、fail-close) | L0 | L1 |
| **artifact** | PLAN が generates する設計 / テスト設計 / 実装 / テストコード成果物 (V-model 4 artifact) | L0 | L1 |
| **pair** | 設計 ⇔ テスト設計の双方向対応 (V-model、L1↔L14 / L2↔L10 / L3↔L12 / L4↔L9 / L5↔L8 / L6↔L7) | L0 | L1 |
| **mode** | 開発経路種別 (9-mode: Forward / Reverse / Discovery / Refactor / Retrofit / Recovery / Scrum / Incident / Add-feature) | L0 | L1 |
| **drive** | 実装の主軸 (be / fe / fullstack / db / agent / scrum / reverse / poc / troubleshoot) | L0 | L1 |
| **agent_slot** | AI エージェント役割枠 (po / tl / qa / aim / uiux / se / docs) | L0 | L1 |
| **handover** | セッション間の作業引き継ぎ状態 (`.ut-tdd/handover/CURRENT.json`) | L0 | L1 |
| **sprint** | L7 実装スプリント単位 (TDD Red→Green→3 点 R) | L0 | L1 |
| **phase** | 現在の V-model 工程位置 (`.ut-tdd/phase.yaml`) | L0 | L1 |
| **carry** | 後段工程へ送る未確定事項・前提条件 | L0 | L1 |
| **trace** | 上流 ID → 下流 ID の双方向追跡記録 | L0 | L1 |

> L3 由来の派生 entity (acceptance_criterion / acceptance_test / plan_evaluation / skill_evaluation / model_evaluation / poc_evaluation / ipa_grade / cutover_command / kpi_metric / evaluation_batch / derived_view) は L1 業務要求 §10.1.1 に列挙。SSoT 定義は各導入層 (L3) で確定し本節へ back-merge する。
>
> **L4 集約 (Aggregate、導入層 L4)**: 上記 entity を DDD 集約に grouping した **Plan / Artifact / Workflow / Handover / Evaluation 集約** (data.md §2)。各集約ルート = plan / artifact / phase / handover / evaluation_batch。集約間は ID 参照のみ。詳細は [L4 データ設計 data.md](../design/harness/L4-basic-design/data.md)。

## §10.2 ワークフロー / メタモデル 用語

| 用語 | 定義 | 導入層 | 更新層 |
|---|---|---|---|
| **工程表 (roadmap)** | **機能群 (feature-group) を進める順番**の進行台帳。粒度 = **結合テストレベル** (V-model 結合テスト⇔基本設計の対)。**人間が見て「ここ担当する」と自己割当できる人間向けプランニングボード**であり、**全プログラム (forward 全バンド L0-L3 / L4-L6 / L7 / L8-L14 + cutover) を被覆**する。harness.db projection 経由で**中央 UI (フロント) へ返す**前提で backend を準備する (backend-first)。粒度階層 = 工程表 (roadmap) → 層内ゲート (gate) → 区間 (span)=PLAN → leaf=機能設計⇔単体テスト仕様書 (単体 V-pair)。**PLAN 内の §工程表 (下記、leaf 手順) とは別レベル** (名前衝突注意)。機械登録 = `src/schema/roadmap.ts` + `src/lint/roadmap-registry.ts`、被覆検査 = doctor (下記 [[全プログラム被覆]])。 | L0 | L4 |
| **§工程表 (PLAN 内手順)** | PLAN (=区間/span) 本文の §工程表。その区間を進める **作成手順 + 進捗 (☐/🔄/✅) + 各 Step の [並列]/[直列]**。**工程表 (roadmap) の leaf 側**であり top レベルの roadmap とは別 (同名異義)。区間内の AI 開発オーケストレーション (依存洗い出し→難易度分類→agent 割当→並列/直列) を表す。 | L0 | L6 |
| **human/AI plane (工程表/PLAN の責務分離)** | **工程表 (roadmap) = 人間向け** (人間が機能群を見て自己割当・進捗把握) / **PLAN (span) = AI 開発のオーケストレーション** (1機能群=1区間のスプリント: 依存・難易度分類・agent 割当・並列/直列)。人間が「何を・誰が」、AI が「どう作るか」を担う plane 分離。柱5 (オーケストレーション)。 | L0 | L4 |
| **全プログラム被覆 (program coverage)** | 工程表 (roadmap) が forward 全バンド (L0-L3 / L4-L6 / L7 / L8-L14 + cutover) を登録被覆している状態。doctor が未登録 forward work を hard violation として検出し、「実装どこまで?」を機械的に answer 可能にする (柱3 state DB 完全性)。検査 = `src/lint/roadmap-registry.ts` + doctor (fail-close、未登録バンドを park 宣言可)。 | L0 | L4 |
| **program rollup** | 複数の工程表 (roadmap) を横断集計し、全体進捗・フロンティアバンド・残り span を 1 ビューで返す projection。中央 UI へ返す人間向けサマリの源。 | L0 | L4 |
| **進め方手順書 (= PLAN)** | 工程をきれいに前へ進める段取り / 軌跡 / TODO。機能内容そのものは記述しない (それは L3 要件定義書 / 機能一覧の領域) | L0 | L1 |
| **工程進捗プラン** | Forward V-model の背骨を L0→L14 へ進める PLAN (メタモデル ① 必須スケルトン) | L0 | — |
| **駆動モデルプラン (駆動プラン)** | 工程進捗の途中で介在する内部ドライブ PLAN (メタモデル ② ケースバイケース)。「検証へ行く (kind=poc)」か「ドキュメントへ戻す (kind=reverse, fullback)」かで分離 | L0 | — |
| **駆動モデル (entry mode、11 種)** | 状況 signal で発動する入口 mode の現在集合 = Discovery / Scrum / Reverse / Recovery / Incident / Refactor / Retrofit / Add-feature / Research / design-bottomup / version-up (= `docs/process/modes/`、Forward 除く)。出口は必ず Forward spine へ合流。kind と非1:1 (Discovery/Scrum/design-bottomup=poc / Incident=troubleshoot+recovery / Add-feature=add-design+add-impl / version-up=既存 kind + `version_target`)。**legacy「9-mode ecosystem」(下記、Forward+8・Research 除く) とは同一 universe の別グルーピング、橋渡し = modes/README §3**。L4 function §3.1 が外部設計 (入口/状態遷移/出口/担当 block/gate) を確定 | L0 | L4 |
| **Forward spine (主線)** | L0-L14 V-model 本線。駆動モデルが出口で合流する終着であり、駆動モデルと並ぶ「mode の 1 つ」ではない (IMP-069 reconcile、PO 2026-06-05「Forward=spine」確定)。operational 正本 mode 構成 = Forward spine(1) + 駆動モデル(11、Research / design-bottomup / version-up 含む) + 工程専門(screen/frontend、2) | L0 | L4 |
| **triage (maturity 判定)** | item の成熟度を判定し「どの検証が要るか」を決める PLAN の役割。検証は opt-in (必須でない) | L0 | — |
| **確証なき設計 (Discovery 適用拡張)** | 紙上で実現性・妥当性が確定できない設計。確証を装って Forward 凍結せず Discovery (kind=poc) として起票し「設計→仮実装→検証→設計確定」で確定する (§2.5、PLAN-DISCOVERY-01 S4 confirmed 2026-06-04) | L0 | L3 |
| **検証ツールボックス** | opt-in の検証種別: Web 検証 (L0) / 概念検証 (L1) / 技術検証 (L3)。triage で必要時のみ発動、default cascade だが rigid でない | L0 | — |
| **fullback (V字回帰)** | 駆動プラン (検証) の exit 後、本線 V-model へ合流復帰すること (kind=reverse + forward_routing で復帰先指定) | L0 | — |
| **decision_outcome** | 検証 (PoC) の exit verdict: confirmed / rejected / pivot (S4 必須) | L0 | L3 |
| **promotion_strategy** | 検証成果物の昇格戦略: reuse-as-is / reuse-with-hardening (promote+実装ゲート) / redesign (throwaway 再設計) / discard (R4 必須) | L0 | L3 |
| **forward_routing** | fullback 時の本線復帰先 (L1 / L3 / L4 / L5 / gap-only の 5 値) | L0 | L3 |
| **要求 (L1) / 要件 (L3)** | L1 = 業務「要求」(BR/NFR、po 主体) / L3 = 「要件」(FR+AC、tl 主体、BR から trace)。別ドキュメント・別ゲート (G1 / G3) | L0 | — |
| **ユビキタス言語 / anti-corruption layer** | L0 §10 を単一 SSoT とし下層は独自定義禁止・参照のみとする DDD 原則 (§3.1.2.2) | L0 | — |

## §10.3 機構 / 機械検証 用語 (導入層は既定 L0)

| 用語 | 定義 |
|---|---|
| **ハーネス** | AI エージェントを安全に動かす土台 (構想書 v1.1 用語集) |
| **9-mode ecosystem** | Forward / Reverse / Discovery / Refactor / Retrofit / Recovery / Scrum / Incident / Add-feature の 9 mode + screen-design / frontend-design の 2 工程専門 (§2.5)。旧「3 経路 + 4 補助軸」を再編した入口分類。**legacy framing = Forward を 9 に算入し Research を除く数え方**。operational 正本 (L4 function §3) は **Forward=spine + current entry modes (Research / design-bottomup / version-up 含む) + 2 工程専門** で数える (IMP-069、橋渡し = modes/README §3、[[駆動モデル]]) |
| **scrum-reverse lint** | PoC confirmed (promotion_strategy≠redesign) ⇔ Reverse 合流 / reverse→confirmed poc 参照の整合検査 (§1.2、IMP-064)。`src/lint/scrum-reverse.ts` |
| **propagation lint** | concept §2.6 ⇔ requirements §7.8.1 の signal→mode 語彙一致検査 (L0⇔L3 伝播ドリフト検出、IMP-065)。`src/lint/propagation.ts` |
| **pair-freeze lint (設計層)** | design doc (①) ⇔ test-design doc (③) の `pair_artifact` 双方向整合・孤児0 検査 (G1-G6 設計層 pair freeze の機械担保、requirements §6.8.3)。function-spec §4 rule pair-exists/ref-resolves/trace-bidir の最小実装。G7 の 4 artifact 12 directed edge trace とは別レイヤー (導入層 L6、IMP-067)。`src/vmodel/lint.ts` |
| **self-pair** | `pair_artifact: self` の doc (wireframe mock 自体が③ペア、L2⇔L10、IMP-039/058)。pair-freeze lint は孤児扱いしない (導入層 L6、IMP-067) |
| **module-drift lint** | architecture §3.1 設計 module 集合 ⊇ `src/` 実在 module の包含 drift (impl→design back-fill 漏れ) を doctor が hard violation として検出する検査 (`src/lint/module-drift.ts`、`checkModuleDrift`、fail-close)。A-103 で handover/setup/web を「将来」放置した meta-drift を再発防止する ADR-002/IMP-032 の最小スライス。asset-drift (roster/skills の内容整合、IMP-033) / dependency-drift (import グラフ循環・逆依存、IMP-032 本体) とは別検査 (導入層 L6、IMP-075) |
| **検証発火 (verification trigger)** | V-model 層群の Forward freeze 完了を検知して検証サイクル発火タイミングを surface する機構 (doctor `checkVerificationGroups`)。検証ロードマップの「いつ検証するか」を人の記憶でなく V-model 構造で機械化 = 崩れ防止の全体調整 (導入層 L6、IMP-068)。`src/vmodel/lint.ts` |
| **descent-obligation (降下義務)** | 上流成果物 (要件 FR) + 層隣接 matrix から機械生成される「存在すべき下流/pair 成果物」。下流の自己宣言に依存せず、不在 (取りこぼし) を fail-close で検出する (FR-L1-03 抜け漏れ検出の absence-blind 是正)。pair-freeze (document-driven) を上流駆動 (absence-detecting) へ一般化 (導入層 L6、PLAN-L6-35)。機能設計 = `descent-obligation.md` |
| **impl-ahead ガード** | trace key の src/test が着地済なのに対応する設計/テスト設計 defer が未 discharge の状態を違反とする規則 (impl→設計 back-fill 未完の機械検出)。defer で免責しない (導入層 L6、PLAN-L6-35、[[feedback_impl_must_backfill_to_design]] の機械強化) |
| **absence-blindness** | 宣言された link のみ検証し「在るべき成果物の不在」を違反と扱えない検査様式の欠陥。document-driven な pair-freeze が draft/defer ホップを孤児にできず skill 片肺を素通りさせた事例の根本原因 (導入層 L6、PLAN-L6-35)。是正 = descent-obligation の上流駆動 obligation 生成 |
| **handover bypass 検知** | `ut-tdd handover` 機構を経ない手書き更新を `checkHandoverBypass` が surface する検査。CURRENT.json の `generated_by` 署名欠落 (手書き pointer) / latest_doc の `# Session Handover` entry 数 > 記録値 (手書き追記) で検知。presence/stale/drift の `checkHandoverDiscipline` と責務分離 (導入層 L6、IMP-078 gap①)。`src/handover/index.ts` |
| **active-plan marker stale** | current-plan marker の 2 行目 `updated_at` が古く、解決した active_plan が最新作業と乖離する状態 (`activePlanStale`)。古い PLAN を active と誤判定する事故源を機械検知。旧形式 (timestamp 無し) は判定不能 = stale 扱いにしない (後方互換、導入層 L6、IMP-078 gap②)。`src/runtime/session-log.ts` |
| **検証層群 (verification group)** | 検証発火の単位となる層群 (L0-L3 / L4-L6 / L0-L6 / L0-L7)。freeze 完了 = draft 0 + pair 孤児0 + confirmed≥1。placeholder は park (例: L2 screen track G2 DEFER) として発火を妨げない (導入層 L6、IMP-068、L0-L7 は PLAN-L7-43) |
| **検証サイクルゲート (verification cycle gate)** | 検証層群の Forward freeze 完了で機械発火する band 単位の検証サイクルゲート。band 終端層または band 性質で命名する: **L3 検証サイクルゲート** (L0-L3 上流) / **L6 検証サイクルゲート** (L4-L6 設計) / **設計検証サイクルゲート** (L0-L6 全設計層) / **実装検証サイクルゲート** (L0-L7 左腕+谷)。Forward の per-layer 正規ゲート (G0.5〜G7) とは別レイヤーで、検証ロードマップ (roadmap.md、living) 固有・driver にしない。旧称「GATE-A (L0-L6) / GATE-B (L0-L7)」を置換 (PO 2026-06-10、PLAN-REVERSE-36)。ゲート名の単一正本 = `src/vmodel/lint.ts` `VERIFICATION_GROUPS` |
| **配線** | signal → mode 自動 routing / mode → command 機械契約 (RecommendedCommandV1) / drive×layer 注入 (orchestration_mode 等) / 横断検出 の連携機構 (§2.6) |
| **orchestration_mode** | drive×layer ごとの「誰が判断し誰が実装するか」(pm_lead / claude_judge / claude_judge_codex_impl / codex_impl_qa_verify / claude_design_impl) |
| **L0-L14 + V-model** | V2 由来の 15 工程。左 (設計 L0-L6) と右 (検証 L8-L14) が対 (L1↔L14 / L2↔L10 / L3↔L12 / L4↔L9 / L5↔L8 / L6↔L7) |
| **V-model 4 artifact** | ① 設計 (文書) / ② 実装コード / ③ テスト設計 (文書) / ④ テストコード の **4 成果物 (2 文書 + 2 コード)** ※ v3.0 で訂正 |
| **Pair freeze** | 設計 artifact 凍結時にテスト設計 artifact も同時凍結するルール (V-model 左各層 G1/G3/G4/G5/G6 で発火) |
| **4 artifact trace freeze** | L7 実装完了時に 4 artifact 揃いと双方向 trace 6 pair を凍結するルール (G7 で発火) |
| **双方向 trace 6 pair** | 4 artifact の組み合わせ 6 pair それぞれを双方向 reference で結ぶ (実装上は 12 directed edge) |
| **逆ピラミッド** | ① ② が存在するが ③ ④ が無い / 不完全な状態 (G6/G7 で fail-close) |
| **Scrum 6 type** | hypothesis-test / tech-spike / design-spike / perf-spike / security-spike / ux-spike の 6 種 |
| **Reverse 5 type** | code / design / upgrade / normalization / fullback の 5 種 |
| **30 cell matrix** | Scrum 6 type × Reverse 5 type の自動 routing 表 (R1 skip 列を含む 30 セル) |
| **R3 Intent 検証** | 発注元 (po) が Reverse R3 で意図仮説を直接検証するステップ |
| **PLAN** | 工程ルール doc。frontmatter + 本文 |
| **PLAN-MM-NNN** | Master Plan。複数子 PLAN を親 hub として束ねる設計プラン |
| **kind / layer / drive / workflow_phase / artifact_type** | PLAN frontmatter の主要 enum 軸 (定義は要件定義書 §1) |
| **agent_slots** | PLAN で割り当てる役割スロット (po / tl / qa / aim / uiux / se / docs) |
| **3 層抽象化** | スキル / ワークフロー / ハーネスの YAML 階層 (v2.1: **設計仕様書**として位置付け、interpreter 不要) |
| **エスカレーション L0-L3** | reviewer 自動切替レベル (agent / aim / council / human)。level は閾値を満たす最大値を冪等に算出 |
| **recovery kind** | session 断絶・認識ずれからの再開のための PLAN 種別 |
| **session 終了前 fail-close** | commit/push 前の必須チェック (具体項目は要件定義書 §5) |
| **CODEOWNERS** | GitHub ファイル領域 × レビュアー責任マトリクス |
| **Conventional Commits** | コミットメッセージ規約 |
| **vmodel_lint** | 4 artifact 揃い + 双方向 trace を検証する CLI (実装詳細は要件定義書 §7 + 個別 PLAN) |
| **ut-tdd doctor** | 統合検証 CLI |
| **branch-kind-check** | ブランチ prefix と PLAN kind の整合性検証 |
| **failure_log** | 個人作業ログ (local-ignore)。チーム共有 audit trail は別経路 (§8.5) |
| **harness-check** | 全 PR 共通の Required Status Check (内部で branch type 分岐) |
| **Phase 0-A (solo) / Phase 0-B (team)** | CODEOWNERS bootstrap 2-stage (要件 §6.5)。0-A=branch protection なし / CODEOWNERS なし / harness-check 非 Required。0-B=CODEOWNERS + branch protection + Required。solo→team の格上げは人間サインオフのガバナンス変更。`ut-tdd setup` が出し分け emission を担う (導入層 L6、PLAN-L6-05) |
| **参加規模検出 (project scale detection)** | owner 種別 / collaborator 数 / 既存 CODEOWNERS・protection から solo/team を**提案**する検出 (`ut-tdd setup`)。確定は人間確認 + state 記録 (数だけで自動確定しない)。検出不能は solo に安全フォールバック (導入層 L6) |
| **emit-only (GitHub 設定)** | branch protection 等の GitHub 設定操作を harness が自動適用せず、スクリプト + 手順の生成にとどめる既定方針。適用は admin 人間 (opt-in `--apply-branch-protection` で対話下のみガード付き自動適用)。token は保持しない (導入層 L6) |
| **handover 機械ポインタ (CURRENT.json)** | `.ut-tdd/handover/CURRENT.json`。active PLAN / status / 最新 handover doc への pointer / digest 要約を機械可読で保持する単一 SSoT (gitignored)。`ut-tdd handover` が生成、CLAUDE.md ワークフロー・pre-push stale 検知の参照先 (旧 CURRENT.md は廃止、導入層 L6、PLAN-L6-06/L7-04) |
| **handover scaffold** | session-log PLAN digest と PLAN frontmatter から §6.8.5 の 6 セクション markdown を機械生成し、機械部 (①サマリ・②成果物) を prefill・判断部 (③Next Action〜⑥壊さない) を human placeholder にする生成物。AI が Next Action を捏造しない (導入層 L6) |
| **plan_id 活性化 (current-plan)** | `.ut-tdd/state/current-plan` を `ut-tdd plan use <id>` で設定し session-log の PLAN digest を populate させる経路。solo/main 直で branch から PLAN を読めず plan_id が null になる Gap を埋める (`resolveActivePlan` の入力、本体は不変、導入層 L6) |
| **handover stale** | `CURRENT.json` の `updated_at` が閾値 (既定 24h) を超えた状態 (`handoverStale`)。pre-push warn / plan-lint の機械基盤 (導入層 L6) |
| **handover discipline (規律 surface)** | PLAN 活動 (active_plan + digest あり) があるのに `CURRENT.json` が未生成 / stale / 別 PLAN を指す (drift) 状態を機械が warn すること (`checkHandoverDiscipline`)。handover-on-completion を agent 記憶でなく Stop-hook + `ut-tdd doctor` で surface する (導入層 L6 更新、IMP-047) |
| **plan family / dedup 正本化** | bare plan_id (`PLAN-L7-04`) と slug 付き (`PLAN-L7-04-handover-mechanism`) を同一 PLAN family と見なし (`sameFamilyPlan`、`-` 境界 prefix・対称・推移)、最長 (最具体) id を正本に digest を union 集約する (`dedupeDigests`)。handover prefill の `unknown` ゴーストを排除 (導入層 L6 更新、IMP-048) |
| **agent-slot / slot lifecycle** | subagent / team member の fire→release を機械記録する Layer-2 オーケストレーション単位 (`Slot`、`.ut-tdd/state/agent-slots.json`、`slot_source` = agent_guard/team_runner/manual、gitignored)。source reference の agent slot lifecycle 挙動を UT-TDD TS/Bun 実装として再定義したもの = `src/runtime/agent-slots.ts` (fire/release/listActive/listStale/`recordGuardFire`、全 fail-open、導入層 L6、IMP-050) |
| **peak_parallel** | 与えた slot 群の同時実行ピーク数 (sweep-line、`peakParallel`)。`ut-tdd doctor` が stale slot (5 分超 release なし) と併せて surface (導入層 L6、IMP-050) |
| **直列化 3 条件** | タスクを直列実行すべきかの機械判定キー: **file_conflict** (同一ファイルを書く) / **downstream_dependency** (前段成果物・判断に依存) / **shared_state** (DB / current-plan / handover 等の共有 state を変更)。いずれか true → 直列化必須 (`mustSerialize`)、すべて false → 並列可 (上限 8)。PLAN §工程表 の各 Step で `[並列]/[直列]` + 該当条件を明示 (要件 §G.4、導入層 L6、IMP-049) |
| **team 定義 (strategy)** | `.ut-tdd/teams/*.yaml` (`teamDefinitionSchema`、`src/schema/team.ts`)。`strategy: sequential|parallel` + `max_parallel` + `serialization` 3 条件 + `members[].serialize_after` で直列/並列を宣言。source reference の team runner 挙動を UT-TDD TS/Bun 実装として再定義したもので、`ut-tdd team run` (hybrid) の入力 (導入層 L6、IMP-050) |
| **shared hook entrypoint** | Claude Code hook が個別 hook 実装ではなく package-local `src/cli.ts` の `session start` / `hook post-tool-use` / `session summary` を呼び、`src/runtime/session-log.ts` の shared core に dispatch する入口。`.claude/hooks/session-log.ts` は後方互換 shim (導入層 L6、PLAN-L6-20/L7-21) |
| **adapter lifecycle wrapper** | `ut-tdd codex\|claude --execute` が provider CLI 実行を SessionStart / PostToolUse / Stop で包み、session-log PLAN digest と handover warning surface を記録する機構。raw guard 共存 env は wrapper が付与する (導入層 L6、PLAN-L6-20/L7-21) |
| **plan metadata separation** | `ut-tdd codex\|claude --plan <id>` の PLAN は harness/session-log metadata として保持し、provider CLI 引数へ `--plan-id` を転送しない規約。provider 境界を汚さず digest plan_id だけに使う (導入層 L6、PLAN-L6-20/L7-21) |
| **L6 FR unit coverage** | L1 FR registry の各 FR を L6 spec path、unit-level contract、U-* oracle へ接続する coverage matrix。L6 に入る前の FR 漏れ確認と L6 単体テスト粒度の 100% coverage を機械検査する (導入層 L6、PLAN-L6-21/L7-22/REVERSE-21) |
| **back-fill pairing** | 駆動モデルが「設計ドキュメントまで戻す」完全性。bottom-up build した impl を上位設計/governance へ Reverse 合流させ、§6 用語更新を L0 §10 へ back-merge する。`src/lint/backfill-pairing.ts` が「Reverse 無き impl」「glossary 未 merge」「legacy conditional debt 監査 drift」を検知 (`ut-tdd doctor`、fail-close、導入層 L6、IMP-051)。検査の主要出力 = `reverseOrphans` / `reverseLinkMissing` / `legacyAuditGaps` / `glossaryGaps` / `conditionalPending` / `conditionalDecisionMissing`。複合ラベルの表記ゆれは `normalizeTerm` (先頭コア語) で吸収 |
| **L6 completion readiness** | L6 docs、対応 L6 design/add-design PLAN、L7 unit-test design、G6 gate status を集約し、L6 完了可否を明示する機械判定。`src/lint/l6-completion.ts` が warn-only で surface し、G6 freeze 前の未完了条件を draft docs / draft PLANs / L7 draft / G6 not-pass として列挙する。導入層 L6、PLAN-L6-22。 |
| **L6 completion readiness lint** | `analyzeL6Completion` / `checkL6Completion` による L6 completion readiness の実装名。doctor に未完了条件を表示し、G6 audit 時に hard 化できる。導入層 L7、PLAN-L7-23。 |
| **completion readiness back-fill** | completion readiness lint の実装を Reverse PLAN へ接続し、add-impl が orphan にならないよう Forward/Gate 設計へ戻す記録。導入層 cross、PLAN-REVERSE-22。 |
| **KIND_BACKFILL マトリクス** | kind → back-fill 要否 (`required`/`conditional`/`none`) の正本表。add-impl=required / refactor・retrofit・troubleshoot=conditional / impl・design・add-design・poc・reverse・recovery=none。駆動モデル整理の機械正本 (導入層 L6、IMP-051) |
| **review_evidence** | design/impl/add-* PLAN が confirmed (gate/freeze 到達) 前に通した review 前置 (§2.1.2.1 review tier) を frontmatter に構造記録する証跡 (`reviewer` / `review_kind` = cross_agent\|intra_runtime_subagent\|human / `reviewed_at` / `verdict` / `scope` / `worker_model` / `reviewer_model`)。freeze 後の増分追補も entry を append。`src/lint/review-evidence.ts` + doctor `checkReviewEvidence` が「confirmed design/impl なのに review_evidence なし」を surface し、review-skip の silent 化を機械で塞ぐ (hard、§7.8.7「記録欠落→exit 1」の機械着地、導入層 L6、IMP-071) |
| **same_model_approval** | cross_agent review で worker と reviewer の (provider, model) が同一なら承認を無効化する原則 (`forbidden`、§2.1.2.1 核心ルール 2、cross-provider 要件)。機械着地 = review_evidence の `worker_model` ≠ `reviewer_model` を doctor `checkReviewEvidence` が `crossReviewViolations` で fail-close 検出 (単体 runtime は cross_agent を僭称できない、導入層 L6、IMP-076) |
| **worker_model / reviewer_model** | review_evidence entry の model 識別子。レビュー対象成果物を産出した model (worker) と reviewer の model。`review_kind=cross_agent` では両者 present かつ相異が必須 (same_model_approval、導入層 L6、IMP-076) |
| **tests_green_at** | review_evidence entry の定量検証 (vitest/doctor/lint) green 時刻。**`tests_green_at ≤ reviewed_at` (定量テスト→定性レビュー順序) は全駆動モデル workflow 普遍の不変条件** (未検証成果物をレビューしない、品質保証二軸の順序、柱6)。doctor `checkReviewEvidence` が `testBeforeReviewViolations` (欠落 / >reviewed_at) を fail-close 検出 (導入層 L6、IMP-077) |

---

# §11 参考文献

## 内部参考 (`docs/governance/` 配下)

- `ai-dev-team-concept_v1.1.md` (AI 駆動開発チーム構想書 v1.1)
- `ai-dev-team-operations_v1.1.md` (AI 駆動開発チーム運用ルール書 v1.1)
- `ut-tdd-agent-harness-concept_v3.1.md` (本書)
- `ut-tdd-agent-harness-requirements_v1.2.md` (要件定義書)
- `document-system-map.md` (**各工程の作成必須ドキュメントの業界標準 grounding 正本** = メタモデル ① 必須スケルトンの裏付け。基本設計=外部設計 / 詳細設計=内部設計 の確定、配線図=Design by Contract、L0-L14 標準マップ、A-61)

## 業界 standard

### V-model + 4 artifact 双方向 trace

- NASA SW Engineering Handbook Appendix (V&V 構造)
- IEEE Wikipedia: V-model (software development) の解説
- DO-178C 開発ライフサイクル仕様
- Parasoft: ISO 26262 Requirements Traceability の解説
- CMMI v2.0 SP 1.4 Requirements Management
- IEEE 829-2008 テスト成果物
- ISO/IEC/IEEE 29119-2 テスト設計仕様

### Scrum + Reverse engineering の参考

- Scrum.org — What is a Spike? の解説
- Agile Alliance — Spikes
- Martin Fowler — Exploratory Testing の解説
- SAFe — Spikes (enabler spike) の解説
- Mike Cohn — Spikes (time-box + validated) の解説
- Basecamp Shape Up — Uncertainty Reduction の解説
- OMG MOF 2.0 — Model-Driven Architecture の解説
- arc42 — Reverse Engineering Integration

### GitHub Actions + ブランチパイプライン

- Conventional Commits v1.0.0 specification
- commitlint official docs — @commitlint/config-conventional の設定参考
- GitHub branch protection rules — required status checks の設定参考
- GitHub Actions — workflow syntax / job ids / status check names の設定参考
- CODEOWNERS syntax and examples の設定参考
- Atlassian — Branch per feature workflow の運用参考

### 3 層抽象化 + エスカレーション (参考、interpreter は採用せず)

- AWS Step Functions — State Machine Abstraction (参考のみ)
- Temporal.io Workflow Abstraction (参考のみ)
- Prefect Flows & Tasks (参考のみ)
- PagerDuty Escalation Policy Design の参考
- AWS Incident Manager Escalation Plans の参考
- Martin Fowler: Approval Workflow Pattern の参考
- Google SRE — Escalation chapter の参考
- LaunchDarkly Flag Lifecycle (30/90 日閾値)

---

# §12 改定履歴

| Version | 日付 | 変更内容 | 策定者 |
|---|---|---|---|
| 2.1 | 2026-05-20 | (旧版) TL レビュー第 1+2 回 計 29 件反映、構想 + 要件 + 実装詳細を統合 | PM + TL |
| **3.0** | **2026-05-20** | **構想書と要件定義書に分離。本書は構想 (WHY/WHAT/どう繋がるか) のみ。TL Round 3 の概念レベル Critical 5 件 (C1/C4/C6/C7/C8) + I22 を反映** | **PM + TL** |
| **3.1+** | **2026-05-28** | **G1 sub-gate 構造 (G1-content / G1-pair / G1-trace) 追加 (§3.3.1)。DD1=a: G1 内 sub-gate として追加 (gate 番号体系維持)、DD2=a: FR-L1 P0 のみ画面 trace 必須 (P1/P2 は warn)。PO 承認済。2026-06-02 BR-22 fullback により R1=13 件 / R3=P0 19 件へ更新。要件定義書 §1.10.H と連動。** | **PMO (Sonnet)** |
| **3.1** | **2026-05-27** | **V2 source snapshot reference の工程・モード・配線をチーム開発向けに取り込み。(V1) §3 を L0-L14 + V-model に作り替え (旧 L0-L11+小数層を remap)。(V2) §2.5 9-mode ecosystem 新設 (Discovery/Refactor/Retrofit/screen-design/frontend-design 追加)。(V3) §2.6 配線新設 (signal→mode routing / RecommendedCommandV1 safety / 横断検出)。(V4) orchestration_mode 5 値。(V5) §3.5 工程別アンチパターン。`requires_human_approval` を「誰が承認するか」へチーム翻案。(V6) §2.1.2.1 execution mode × レビューゲート切り分け新設 (self-review が cross-agent review に化ける gate 崩壊を防止)。レビュー強度 3 ティア (① cross-agent / ② 専門サブエージェント / ③ self) を定義し、**単一エージェント時は ② 専門サブエージェント review を hard 要件化** (明文化 checklist 駆動、要件定義書 §7.8.7.1)。レビュー範囲を関数単位/機能単位/横断に拡張し、依存関係・重複実装の検出を §3.1.4 / AP-9・AP-10 に追加。(V8) ADR-001 で実装言語を **TypeScript (Bun)** に確定 (legacy source は概念のみ + 全面再実装、旧 W1-W3a Python は superseded)。(V7) §2.1.0 に 2 つのマスト原則 (① ルール同一性: Claude/Codex は同一ルール・同一判定・同一 exit code、CLAUDE.md/AGENTS.md は薄い adapter / ② hybrid 機能分散: 判断系↔実行系を別 runtime、二重実行禁止) を MUST 化。要件定義書は v1.2 連動** | **PM (Opus)** |

---

**本書は UT-TDD-agent-harness の概念定義書である。受入条件・enum 詳細・Phase 0 受入条件は `ut-tdd-agent-harness-requirements_v1.2.md` を参照。実装詳細 (validator / workflow YAML / hook script) は将来の個別 PLAN-XXX で詳細設計する。**
