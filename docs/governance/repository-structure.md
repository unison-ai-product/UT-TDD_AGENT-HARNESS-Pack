# UT-TDD リポジトリ構成ルール (Repository Structure)

- **Status**: accepted
- **Date**: 2026-05-27
- **正本**: 本書がリポジトリ配置の **canonical 正本**。`requirements_v1.2 §9.1`（Phase 0 存在チェック）と `CLAUDE.md` のディレクトリ節は本書を参照する。
- **前提**: ADR-001（harness 実装 = TypeScript/Bun、source snapshot は概念のみ）/ ADR-005（配布 = GitHub-pull、Web UI = 中央・全 project 横断、plugin = 補助チャネル）/ V-model 4 artifact（concept v3.1 §2.3）。
- **要件同期 (済)**: `docs/process/` (A) / `src/web/` は **requirements_v1.2 §9.1 Phase 0-A 存在チェックツリーに反映済**。canonical ツリーの全ディレクトリは実体 (`.gitkeep`) 作成済 (構成は要件定義で確定するため一括実体化)。各 `[予定]` ディレクトリは **ディレクトリ実体化済 / 中身 (機能・doc) は後続 PLAN で起こす** の意。`src/web/` も実体化済 (Phase 0-A 対象化は後続 PLAN)。
- **本 repo の位置づけ (ADR-005)**: 本 repo は **harness engine repo（= 配布の単一真実）**。各 project は本 repo を **git dependency（tag-pin）で pull** し、`ut-tdd setup` が adapter を投影する。下記 canonical ツリーは **engine repo の構成**。consume 側 project への投影レイアウトは §9 を参照。

## 1. canonical ツリー

```text
UT-TDD-agent-harness/
├── CLAUDE.md                     # Claude Code project context (正本ナビ)
├── AGENTS.md                     # Codex CLI project rules
├── .codex/                       # Codex CLI project-local config / hooks (trusted project layer)
│   ├── config.toml               #   enables project-local hooks
│   └── hooks.json                #   hook adapter (.claude/settings.json guard parity, PLAN-L7-139)
├── .vscode/                      # editor workspace recommendations/settings (tracked, non-runtime)
├── README.md                     # project overview / onboarding entrypoint
├── CHANGELOG.md                  # Pack release 履歴 (clean 配布に同梱、v0.1.4 で導入)
├── package.json                  # Node/Bun 依存 + scripts
├── tsconfig.json                 # TypeScript strict
├── bun.lock                      # Bun lockfile (tracked)
├── vitest.config.ts              # Vitest coverage reporter config (G7 coverage-summary evidence)
├── .gitattributes                # 改行正規化 (eol=lf、*.ps1 は crlf)
├── .editorconfig                 # editor/agent shared whitespace and newline defaults
├── .gitignore
│
├── src/                          # ★ harness TS core (実装 = ② 実装コード)
│   ├── cli.ts                    #   エントリ (commander)
│   ├── schema/                   #   zod 単一正本 (enum / 契約。drift を型で抑止)
│   ├── plan/                     #   plan lint / validator
│   ├── vmodel/                   #   V-model 4 artifact trace
│   ├── runtime/                  #   mode 検出 (standalone/claude-only/codex-only/hybrid) / orchestration
│   ├── doctor/                   #   統合検証 / 横断検出
│   └── web/                      #   [予定] 中央 Web UI service (15 画面 / 全 project 横断 / GitHub backbone、ADR-005 D2。backend 詳細は L2 設計)
├── tests/                        # ★ ④ テストコード (vitest、*.test.ts、src を mirror)
├── scripts/                      # ★ 薄い OS entrypoint のみ (core logic を置かない)
│   ├── ut-tdd                    #   POSIX / Git Bash
│   ├── ut-tdd.ps1                #   Windows PowerShell
│   └── install-hooks.{sh,ps1}    #   [予定] hook installer
│
├── docs/
│   ├── governance/               # ★ 現行正本 (本書群)
│   │   ├── README.md             #   正本 / 参照 / archive 境界
│   │   ├── ut-tdd-agent-harness-concept_v3.1.md       # 構想 (① 概念)
│   │   ├── ut-tdd-agent-harness-requirements_v1.2.md  # 要件 / 受入条件
│   │   ├── ut-tdd-agent-harness-extraction-plan_v0.1.md
│   │   └── repository-structure.md                    # 本書 (構成正本)
│   ├── adr/                      # ADR-NNN-slug.md (決定記録)
│   ├── process/                  # ★[新設] 工程(L0-L14)定義 + 駆動モデル定義の正本 (詳細・移管方針は §2 参照)
│   ├── design/                   # [予定] ① 設計 doc (D-API/D-DB 等)
│   ├── test-design/              # [予定] ③ テスト設計 doc
│   ├── research/                 # [予定] Research mode 成果 (research-memo。ADR は adr/、§2 参照)
│   ├── reference/                # 横断参照資料 (正本外、ai-agent-harness-directory-reference.md)
│   ├── skills/                   # [予定] UT-TDD 正本化 skill doc
│   ├── plans/                    # PLAN-NNN-slug.md (実装計画)
│   ├── templates/                # PLAN / prompt / state テンプレ
│   ├── migration/                # legacy source → UT-TDD 再設計資料 (旧 porting-map 等。code-port 部は ADR-001 で superseded)
│   ├── handover/                 # セッション handover
│   ├── memory/                   # 運用メモ
│   └── archive/                  # 旧版・superseded (正本ではない)
│
├── .claude/                      # Claude Code runtime / hook policy
│   ├── CLAUDE.md                 #   runtime / hook 方針
│   ├── settings.json             #   現状 hooks:{} の安全設定
│   ├── agents/                   #   subagent 定義 (code-reviewer 等)
│   └── hooks/                    #   hook script
│
├── .ut-tdd/                      # ★ UT-TDD runtime state + 監査証跡 (state 系 gitignored / 証跡系 tracked、§5)
│   ├── state/                    #   runtime.json 等 (generated、.gitkeep のみ tracked)
│   ├── audit/                    #   A-NNN-*.md / reports/*.md 監査記録 = tracked 証跡 (PO 決定 2026-06-10、A-128)。*.jsonl / escalation_state.json は gitignored
│   ├── evidence/                 #   verification-profiles 等の正規化 evidence JSON (tracked、secret/PII 禁止)
│   ├── cache/                    #   (.gitkeep のみ tracked)
│   ├── handover/                 #   CURRENT.* / *.bak は gitignored。provider/ (provider 間 handover 記録) は tracked
│   ├── teams/                    #   teams/*.yaml (local* は gitignored)
│   └── adapters/                 #   optional adapter 設定 (local* は gitignored)
│
├── .github/                      # workflows/harness-check.yml (Required Status Check)
│
└── legacy local state            # gitignored、正本にしない
```

`★` = 配置ルールが特に重要な領域。`[予定]` = **ディレクトリ実体 (`.gitkeep`) は作成済、中身 (機能コード・doc・workflow) は後続 PLAN で起こす**。構成 (どのディレクトリを置くか) は要件定義で確定するため一括実体化する。

## 2. 配置ルール (どこに何を置くか)

| 対象 | 置き場 | ルール |
|------|--------|--------|
| harness TS core (機能) | `src/<domain>/` | **機能の home**。domain 別 (cli/schema/plan/vmodel/runtime/doctor/web)。新機能はどの domain 配下かを要件 (L3) で確定してから追加。**bash / Python を core に置かない** (ADR-001) |
| 工程 / 駆動モデル定義 | `docs/process/` | **工程(L0-L14)定義 + 駆動モデル(Forward/Scrum/Reverse/Recovery/Add-feature/Retrofit/Refactor/Research)正本**。「どの工程/駆動を増やすか」は要件 (L3) で決め本 dir に置く (本 session の発端 gap を解消)。既存 `docs/governance/recovery-workflow.md` は **`docs/process/modes/recovery.md` へ統合完了 (2026-06-04、IMP-060)** = recovery 正本は `docs/process/modes/recovery.md`。recovery-workflow.md は superseded (historical、冒頭 banner) |
| 中央 Web UI service | `src/web/` | [予定] 全 project 横断の管理 UI (15 画面、GitHub backbone、ADR-005 D2)。backend 配置・通信境界は L2 設計 (ADR-003 §IMP-031 参照) |
| テストコード | `tests/` | vitest、`*.test.ts`、src を mirror |
| OS entrypoint | `scripts/` | **薄い wrapper のみ**。compiled binary or `bun run` を呼ぶだけで、core logic を持たない |
| enum / 契約 | `src/schema/` | **zod 単一正本**。enum を複数箇所に再定義しない (drift 防止、requirements §1.10 F) |
| 現行正本 doc | `docs/governance/` | concept v3.1 / requirements v1.2 / README / extraction-plan / 本書 |
| 決定記録 | `docs/adr/` | `ADR-NNN-slug.md` |
| 実装計画 | `docs/plans/` | `PLAN-NNN-slug.md`。superseded は `status: archived` |
| 移行資料 | `docs/migration/` | source capability reference。code-port 計画は ADR-001 で superseded |
| runtime state | `.ut-tdd/` (state/cache/logs/handover CURRENT/tmp/local*) | generated。**docs 目的で追跡しない** (CLAUDE.md 禁止事項) |
| 監査証跡 | `.ut-tdd/audit/*.md` / `.ut-tdd/audit/reports/*.md` / `.ut-tdd/evidence/` / `.ut-tdd/handover/provider/` | **tracked** (PO 決定 2026-06-10、A-128 F-1)。audit = A-NNN 監査記録、evidence = 正規化 JSON (secret/PII/raw transcript 禁止)。runtime state と区別する |
| 横断参照資料 | `docs/reference/` | tracked。参照用であり配置正本は本書 (例: `ai-agent-harness-directory-reference.md`) |

## 3. V-model 4 artifact の配置 (中核ルール、concept v3.1 §2.3)

4 artifact は**別物として別ディレクトリ**に置き、双方向 trace で結ぶ（混在禁止）。

| artifact | 置き場 |
|----------|--------|
| ① 設計 (文書) | `docs/design/` |
| ② 実装コード | `src/` |
| ③ テスト設計 (文書) | `docs/test-design/` |
| ④ テストコード | `tests/` |

## 4. 命名規約

- PLAN: `docs/plans/PLAN-NNN-slug.md` / ADR: `docs/adr/ADR-NNN-slug.md`
- TS source: `src/<domain>/<name>.ts` / test: `tests/<name>.test.ts`
- テスト設計: `docs/test-design/<feature>/<...>-test-design.md`
- ファイル名は英語（日本語ファイル名は Windows 文字化け回避のため禁止）

## 5. tracked / gitignored の境界

- **gitignored**: `node_modules/` `dist/` `*.tsbuildinfo` `coverage/` / `.ut-tdd/` runtime state (state/cache/logs/tmp/handover CURRENT.*・*.bak/audit *.jsonl・escalation_state.json、local*) / legacy local state / `__pycache__` / `docs/plans/*.lock` / `CLAUDE.local.md` `AGENTS.override.md` `.claude/settings.local.json` / secret 系 (`.env*` `*.key` `*.pem` `credentials.json`)
- **tracked**: `src/` `tests/` `docs/` (archive 含む) `scripts/` `package.json` `tsconfig.json` `bun.lock` `vitest.config.ts` `.gitattributes` `.editorconfig` / **監査証跡** `.ut-tdd/audit/*.md` `.ut-tdd/audit/reports/*.md` `.ut-tdd/evidence/` `.ut-tdd/handover/provider/` / **参照資料** `docs/reference/` (PO 決定 2026-06-10 tracked 化 / 2026-06-25 docs/reference へ移設、A-128 F-1 / IMP-127)

## 6. 境界

- **正本**: `docs/governance/*` + `docs/adr/*` + `docs/process/*` (工程/駆動モデル定義) + `src/` (TS core)。
- **generated / 非正本**: `.ut-tdd/state` `dist/` `node_modules/` legacy local state。
- **historical**: `docs/archive/`（旧版）/ `docs/migration/`（移行資料、code-port 部は superseded）。

## 7. 禁止事項

- `src/` core に bash / Python を持ち込まない（ADR-001。OS 差は `scripts/` の薄い wrapper に閉じる）。
- enum / 契約を `src/schema/` 以外で再定義しない。
- `.ut-tdd/` **runtime state** (state/cache/logs/tmp/handover CURRENT/local*) を docs 目的で Git 追跡しない。**監査証跡** (`audit/*.md` / `audit/reports/*.md` / `evidence/` / `handover/provider/`) は例外として tracked (§5、A-128 F-1)。
- source process reference を工程定義の正本として参照しない (正本 = `docs/process/`)。
- 日本語ファイル名を使わない。
- **`[予定]` ディレクトリの中身を後続 PLAN 不在のまま実装しない**: ディレクトリ実体 (`.gitkeep`) は構成確定として一括作成済だが、中身 (機能コード・doc・workflow。特に `src/web/`) は対応 PLAN が確定してから起こす。`.gitkeep` があることを実装許可と誤読しない。

## 8. config 最小化方針 (root の散らかり防止)

- `LICENSE`: MIT License (UNISON-TECHNOLOGY). 配布条件の canonical top-level file として tracked に含める。

JS/TS は「1 ツール = 1 設定ファイル」で root に config が溜まりやすい。**フォルダに隠す**のはツールが root を探すため不可（壊れる）。代わりに **ツールを減らす + package.json に集約** で抑える。

- **root config の下限**（避けられない）: `package.json` / `tsconfig.json` / `bun.lock` / `.editorconfig` (cross-editor newline/whitespace contract)。
- **lint + format = Biome 1 枚 (`biome.json`)**。**eslint + prettier を別々に足さない**（plugin/ignore で 4-6 枚に増えるのを防ぐ）。`bun run lint` / `bun run format`。
- **test = vitest**。`vitest.config.ts` は G7 coverage-summary evidence (`json-summary`) を生成するための tracked exception とする。
- commitlint 等 **config-in-package.json 対応**のツールは package.json のキーに入れ、新規 dotfile を作らない。
- **新ツール導入時の判断順**: ① 既存ツール (Biome / Bun / tsc) で代替できるか → ② package.json に同居できるか → ③ どうしても単独 config が要るか。①②で済むなら root に新ファイルを増やさない。

→ root config は **`package.json` / `tsconfig.json` / `bun.lock` / `.editorconfig` / `biome.json` / `vitest.config.ts` の 6 枚で頭打ち**に保つ。

## 9. 配布 3 層モデル (ADR-005)

harness の配置は 3 層で分離する。本書 §1 canonical ツリーは **① engine repo** の構成。

| 層 | 実体 | 配置 | 更新享受 |
|----|------|------|---------|
| **① engine repo (単一真実)** | harness engine + ルール + 工程/駆動モデル定義 (本 repo) | **GitHub repo**。consume 側は git dependency で **tag-pin** (`bun add github:<org>/ut-tdd-agent-harness#<tag>`、devDependencies にコミット) | tag を bump (`bun update`)。社内既定 = tag-pin + 定期 bump |
| **② project 投影 (adapter)** | consume 側 project に展開される `CLAUDE.md` / `.claude/` / `AGENTS.md` 等 | `ut-tdd setup` が engine から **投影**。内容を複製せず engine を参照する adapter | engine の tag bump に追従 |
| **③ 中央 UI service** | 全 project 横断の管理 Web UI (15 画面) | **中央 / team server**。各 project の GitHub repo を data backbone に読む (project-local でない) | UI service コード自体も engine と同 GitHub repo (`src/web/`) で管理 |

- **public npm publish しない** (社内コード、GitHub-pull で足りる)。
- **engine は tool 非依存 package**: CLI / CI (Layer B-remote `.github/workflows`) / Codex / 将来ツールが同一 engine を GitHub から取得 (ルール同一性、concept §2.1.0)。Claude plugin は **任意の補助配信チャネル**で主軸でない (ADR-005 D3)。
- consume 側 project の投影レイアウト (CLAUDE.md/.claude/AGENTS.md + `.ut-tdd/` state) の詳細は `ut-tdd setup` 仕様 (L4 external-if / L5 if-detail) で確定。
