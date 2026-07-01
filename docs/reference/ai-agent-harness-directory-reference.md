# AI コーディングエージェント ハーネス ディレクトリ構成リファレンス

> 対象ツール: **Claude Code / Codex CLI / Gemini CLI / Grok Build CLI（xAI 公式）**
> 基準日: 2026-06-01 / 各ツールの公式ドキュメントに基づく事実ベース
> 構成順: ① Claude Code → ② Codex → ③ 共通部分 → ④ 統合版 → ⑤ Gemini（補助） → ⑥ Grok（補助）

---

## 0. ハーネス3層モデル（本書の共通フレーム）

本書は各ツールのディレクトリを、ハーネスの責務レイヤに対応づけて整理する。

| 層 | 役割 | 性質 |
|---|---|---|
| **Layer A：指示** | 規約・ロール・出力規定をエージェントに渡す | ツール別の指示ファイル（CLAUDE.md / AGENTS.md / GEMINI.md） |
| **Layer B-local：決定論ゲート** | ツール実行前後のフック・サンドボックス・承認 | ツール別のローカル設定（形式が割れる） |
| **Layer B-remote：品質ゲート** | CI 上の最終検証 | **ツール非依存**（`.github/workflows/`） |
| **Layer C：ブランチ保護** | required checks・PR 必須・force-push 禁止 | GitHub リポジトリ設定（ディレクトリではない） |

設計原則の要約：**指示は一元化できる／設定とローカルフックは形式が割れるためツール別に維持／決定論ゲートの「真実」は CI に寄せる。**

---

## ① Claude Code

指示ファイルは `CLAUDE.md`、設定は `settings.json`（JSON）。プロジェクトスコープ（git 管理）とユーザースコープ（`~/.claude`、横断・非コミット）の二層。

### プロジェクトスコープ（コミット）

```
your-project/
├── CLAUDE.md              # Layer A: 常時ロードの指示・規約（@import で分割可）
├── CLAUDE.local.md        # 個人用の上書き（手動作成・gitignore）
├── .mcp.json              # チーム共有 MCP サーバ定義
├── .worktreeinclude       # 新規 worktree にコピーする gitignore 対象ファイル
├── .claude/
│   ├── settings.json      # permissions / hooks / env / model 既定
│   ├── settings.local.json# 個人上書き（自動 gitignore）
│   ├── rules/*.md         # トピック別・パスゲート可能な指示
│   ├── skills/<name>/SKILL.md # /name 呼び出し or 自動起動の再利用ワークフロー
│   ├── commands/*.md      # 単一ファイルのプロンプト（skills と同機構）
│   ├── agents/*.md        # サブエージェント定義（独自プロンプト・ツール）
│   ├── agent-memory/<name>/  # サブエージェントの永続メモリ
│   └── output-styles/*.md # system-prompt セクションの差し替え
└── .github/workflows/     # Layer B-remote: CI 品質ゲート（.claude 外）
```

### ユーザースコープ（`~/.claude`、コミットしない）

```
~/.claude/
├── settings.json          # 個人グローバル設定
├── .claude.json           # 認証・UI トグル・個人 MCP
├── projects/<project>/memory/   # セッション横断の auto memory
├── themes/*.json
└── keybindings.json
```

**事実メモ**
- 大半のユーザーが触るのは `CLAUDE.md` と `settings.json` のみ。残りは任意。
- 組織配布の `managed-settings.json`（システムレベル）が全てに優先。`--permission-mode` 等の CLI フラグはそのセッションの `settings.json` を上書き。
- 作業データ（transcripts 等）は `~/.claude` に蓄積し、`cleanupPeriodDays`（既定 30 日）で自動削除。

---

## ② Codex CLI

指示ファイルは `AGENTS.md`、設定は `config.toml`（TOML）。Claude Code と二層構成は同じだが形式が異なる。

### プロジェクトスコープ（コミット）

```
your-project/
├── AGENTS.md              # Layer A: 起動時自動ロードの指示（CLAUDE.md 相当）
├── PLANS.md               # 任意: 段階的計画ドキュメント
├── .codex/
│   ├── config.toml        # プロジェクト設定（root→cwd で近い方が優先）
│   ├── AGENTS.md          # 指示の代替配置（root の AGENTS.md と同等）
│   ├── hooks.json         # Layer B-local: PreToolUse/PostToolUse ゲート
│   └── hooks/*.py|*.sh    # フック実体スクリプト
└── .github/workflows/     # Layer B-remote: CI 品質ゲート
```

### グローバルスコープ（`~/.codex`、コミットしない）

```
~/.codex/                    # CODEX_HOME で変更可
├── config.toml              # 個人グローバル設定（TOML）
├── <profile>.config.toml    # プロファイル別オーバーレイ（--profile で切替）
├── AGENTS.md                # グローバル指示
├── AGENTS.override.md       # AGENTS.md より優先
├── rules/*.md               # 横断ルール
├── auth.json                # 認証（keyring 未使用時）
├── history.jsonl            # セッション履歴
└── log/                     # ログ（log_dir で変更可）
```

**事実メモ**
- 探索は cwd から親方向に辿り、既定では `.git` を含むディレクトリをプロジェクトルートとみなす。
- 指示の優先順位：グローバルは `AGENTS.override.md` →（無ければ）`AGENTS.md`。プロジェクトはルート→cwd で近い方が優先。
- フックはインライン `[[hooks.PreToolUse]]`（config.toml）か `hooks.json` のいずれか。同一レイヤに両方あると両方読込＋警告。
- サブエージェントは `config.toml` の `[agents]` テーブル。
- サンドボックス（read-only / workspace-write（既定）/ danger-full-access）と承認（untrusted / on-request / never）を一級のゲートとして持つ。`.git` と `.codex` は書込可ルート内でも保護。
- 組織強制は `requirements.toml`（`allow_managed_hooks_only=true` でユーザー/プロジェクト/セッションのフックを無視。config.toml では効かない）。

---

## ③ 共通部分

「物理的に同じファイル名」で共通化できるのは指示の一部のみ。設定・フックは形式が割れる。役割単位での対応表が実務上の共通部分となる。

### クロスリファレンス（役割 × ツール）

| 役割 | Claude Code | Codex | Gemini CLI | Grok Build CLI |
|---|---|---|---|---|
| 指示ファイル | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` | `AGENTS.md` |
| プロジェクト設定形式 | `settings.json`（JSON） | `config.toml`（TOML） | `settings.json`（JSON） | `config.toml`（TOML） |
| プロジェクト dir | `.claude/` | `.codex/` | `.gemini/` | `.grok/` |
| グローバル dir | `~/.claude/` | `~/.codex/` | `~/.gemini/` | `~/.grok/` |
| 個人上書き | `settings.local.json` | `.codex/config.toml` / プロファイル | ワークスペース `.gemini/` | `.grok/config.toml` |
| フック | `settings.json` `hooks` | `[hooks]` / `hooks.json` | `policies/`・sandbox | `.grok/hooks/*.json`（Claude 互換） |
| MCP | `.mcp.json` | `[mcp_servers]` | `settings.json` / extension | `config.toml` / `grok mcp` |
| サブエージェント | `agents/*.md` | `[agents]` | （extensions） | subagents（worktree 並列） |
| ルール | `rules/*.md` | `~/.codex/rules/*.md` | `GEMINI.md` 階層 | （AGENTS.md 系） |
| スキル | `skills/<>/SKILL.md` | skills | （extensions） | skills（`/skillify`） |
| 計画 | plan mode | `PLANS.md` | checkpointing / `/restore` | plan mode（`/plan`） |
| 組織強制 | `managed-settings.json` | `requirements.toml` | system `settings.json` | （未確認） |

### 真に共通化できる軸

1. **AGENTS.md の共有**：Codex と Grok Build はともに `AGENTS.md` を読む。この 2 ツールは指示ファイルを 1 本に統合できる。
2. **CI ゲート（Layer B-remote）**：`.github/workflows/` は全ツール非依存。決定論ゲートの真実をここに置けば、どの CLI が編集しても最終防壁は共通。
3. **ブランチ保護（Layer C）**：GitHub 設定なので完全に共通。
4. **TOML 系の親和性**：Codex と Grok はともに `config.toml`／`~/.<tool>/` 構成で、設定の考え方（プロファイル/権限モード/フック）が近い。

---

## ④ 統合版

`.ai/` を単一の真実（ツール非依存の指示ソース）とし、各ツールの規定ファイル名へは生成またはシンボリックリンクで供給する。設定とローカルフックはネイティブ維持、ゲートは CI に集約する。

```
your-project/
├── .ai/                        # ★単一の真実: ツール非依存の指示ソース
│   ├── instructions/           #   ロール・規約・出力規定（Markdown 断片）
│   ├── rules/                  #   トピック別ルール
│   └── shared/                 #   共有プロンプト・スキル素材
│
│   # ── Layer A：指示ファイル（.ai/ から生成 or symlink）──
├── CLAUDE.md                   # → .ai/ を @import（Claude Code）
├── AGENTS.md                   # → .ai/ を参照（Codex / Grok Build で共用）
├── GEMINI.md                   # → .ai/ を参照（Gemini CLI）
├── PLANS.md                    # 段階計画（Codex / Grok plan mode 共通の置き場）
│
│   # ── Layer B-local：ツール別ネイティブ設定（形式が割れるため非共通）──
├── .claude/
│   ├── settings.json           #   hooks / permissions / model
│   ├── rules/  skills/  agents/  output-styles/
├── .codex/
│   ├── config.toml             #   [hooks] [agents] [mcp_servers] sandbox/approval
│   └── hooks/
├── .gemini/
│   ├── settings.json
│   ├── commands/  extensions/  policies/
├── .grok/
│   ├── config.toml             #   [ui] permission_mode 他
│   └── hooks/*.json            #   Claude 互換 nested JSON
│
│   # ── MCP（定義は可能な範囲で共有、各 config から参照）──
├── .mcp.json                   # Claude Code 用（他ツールは各 config が参照）
│
│   # ── Layer B-remote / C：ツール非依存の最終防壁 ──
└── .github/
    └── workflows/              # 品質ゲート（各 CLI を headless/exec で起動）
```

### 統合の設計原則

1. **指示は一元化、設定は分散**：指示（Layer A）は `.ai/` に集約し、各ツールの規定名に展開。設定（Layer B-local）は JSON（Claude/Gemini）と TOML（Codex/Grok）で割れるため共通化しない。
2. **AGENTS.md は 1 本**：Codex と Grok Build が同じ `AGENTS.md` を読むため、この 2 ツール分の指示は 1 ファイルで足りる。
3. **ローカルフックは形式バラバラ → CI へ寄せる**：Grok は Claude 互換 JSON、Codex は TOML/JSON、Claude は `settings.json`。決定論ゲートの正典は `.github/workflows/` に置き、ローカルフックは「速い一次チェック」に留める。
4. **ロール分離をサンドボックスで表現**：判断系（Claude）は保守的に、実装系（Codex / Grok）は `workspace-write` + `on-request`/`ask` 程度に緩めて噛み合わせる。Gemini は補助（探索・要約・Google 連携）。
5. **生成 or symlink の選択**：複雑な分岐や断片合成が要るなら「生成」（`.ai/` → 各指示ファイルをビルド）、単純コピーで足りるなら symlink。チーム配布では生成＋CI 検証が崩れにくい。

---

## ⑤ Gemini CLI（補助）

指示ファイルは `GEMINI.md`、設定は `settings.json`（JSON）。プロジェクト（ワークスペース）・ユーザー・システムの三層。

### プロジェクト（ワークスペース）スコープ

```
your-project/
└── .gemini/
    ├── settings.json      # ワークスペース設定
    ├── GEMINI.md          # ワークスペースのコンテキスト
    ├── commands/          # カスタムスラッシュコマンド
    ├── extensions/        # プロジェクト拡張
    ├── policies/          # ワークスペースポリシー
    └── storage/           # セッションデータ
```

### ユーザースコープ（`~/.gemini`）

```
~/.gemini/
├── settings.json          # ユーザー設定
├── GEMINI.md              # グローバルコンテキスト/メモリ
├── extensions/            # ユーザーインストール拡張
└── storage/               # グローバルストレージ
```

**事実メモ**
- システム設定：`/etc/gemini-cli/settings.json`（Linux）等。**システム設定が全てに優先**し、次いでワークスペース > ユーザー。
- `GEMINI.md` は階層ロード：cwd → 親方向（`.git` かホームまで）に加え、サブディレクトリも探索（既定上限 200、`context.discoveryMaxDirs` で変更）。
- 拡張は `<scope>/.gemini/extensions/<name>/gemini-extension.json` 形式で、`mcpServers` / `contextFileName` / `excludeTools` を持つ。
- MCP は `settings.json` か拡張で定義。`settings.json` 側が同名サーバで優先。
- フックは Claude/Codex 的な PreToolUse/PostToolUse 体系ではなく、`policies/`（ワークスペースポリシー）と sandbox 設定、checkpointing（`/restore`）で制御。

---

## ⑥ Grok Build CLI（補助・xAI 公式）

xAI 公式のエージェント CLI。指示ファイルは **`AGENTS.md`（Codex と共通）**、設定は `config.toml`（TOML、Codex と類似）。フックは **Claude 互換の nested JSON 形式**。

```
your-project/
├── AGENTS.md              # Layer A: 起動時自動ロード（Codex と共用可能）
├── .grok/
│   ├── config.toml        # プロジェクト設定（対応環境のみ）
│   └── hooks/*.json       # フック（*.json をすべてマージ。Claude 互換 nested JSON）
└── .github/workflows/     # Layer B-remote

~/.grok/                   # グローバル設定ディレクトリ
├── config.toml            # [ui] permission_mode = "ask"（既定）/ "always-approve" 他
├── bin/grok               # 実行バイナリ
└── docs/                  # 同梱ドキュメント（user-guide 等）
```

**事実メモ**
- `AGENTS.md`・plugins・hooks・skills・MCP サーバが標準で動作。`grok inspect` で発見済みの設定ソース・指示・スキル・プラグイン・フック・MCP を確認できる。
- フックは `.grok/hooks/` 内の `*.json` をすべてマージ（複数のフックファイルが共存可能）。形式は Claude/Codex/Copilot 互換の nested JSON。
- 既定権限は `ask`（ツール呼び出しごとに確認）。グローバル既定は `~/.grok/config.toml` の `[ui] permission_mode`。CI では `--always-approve`（要注意）。
- plan mode：Grok が構造化計画を提示→承認/コメント/書換。Plan モードはセッション計画ファイル以外の write ツールをブロック。`/plan` で確認、Shift+Tab でモード切替。
- サブエージェントを git worktree で並列実行（research / implementation / review を分離）。`/skillify` でセッションを再利用スキル化。

> **重要な但し書き（Grok の同名乱立）**：本書は **xAI 公式の Grok Build CLI（`~/.grok/`、`AGENTS.md`、`config.toml`）** を記載。これとは別に、コミュニティ製 `grok-cli`（例：`~/.grok/user-settings.json`＋プロジェクト `.grok/GROK.md`）や `grok-4-cli`（`~/.grok-cli/config.json`）など、**規約の異なる第三者 CLI が複数存在する**。導入前に対象実装を確定すること。

---

## 設計上の注意（事実の取り扱い）

- **進化が速い**：4 ツールとも設定スキーマ・ファイル名・機能が頻繁に変わる。導入時は各ツールの `inspect`/`/init`/公式 docs で現物を確認すること（特に Gemini は 2025-09 に `settings.json` 構造が刷新済み）。
- **形式差は本質的**：JSON（Claude/Gemini）と TOML（Codex/Grok）は統合不能。共通化の対象は「指示」と「CI ゲート」に限定するのが安全。
- **フック互換の偏り**：Grok Build は Claude 互換 JSON、Codex は独自 TOML/JSON、Gemini は別体系。「Claude 互換フック」を共通基盤にしたいなら Claude + Grok の 2 系統が現実的。
- **組織強制の置き場が異なる**：Claude=`managed-settings.json`、Codex=`requirements.toml`、Gemini=system `settings.json`。エンタープライズ配布時はツールごとに別途設計。

---

## 出典（一次・準一次ソース）

- Claude Code: `code.claude.com/docs/en/claude-directory`, `/hooks`, `/sub-agents`, `/settings`
- Codex CLI: `developers.openai.com/codex/config-basic`, `/config-advanced`, `/config-reference`, `/guides/agents-md`；`github.com/openai/codex/blob/main/docs/config.md`
- Gemini CLI: `geminicli.com/docs/reference/configuration`, `google-gemini.github.io/gemini-cli/docs/`；`deepwiki.com/google-gemini/gemini-cli`
- Grok Build CLI（xAI 公式）: `mer.vin`（Grok Build CLI 解説, 2026-05）, `github.com/manaflow-ai/cmux`（`~/.grok/` 構成の検証）；コミュニティ版は `deepwiki.com/superagent-ai/grok-cli`, `grokipedia.com/page/Grok_CLI`
