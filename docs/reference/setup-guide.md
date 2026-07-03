# UT-TDD Agent Harness Pack セットアップガイド

このガイドだけで「導入 → 動作確認 → バージョン更新」まで完走できることを目的にしています。
コマンドの網羅は [README](../../README.md) のコマンド早見表、更新履歴は
[CHANGELOG.md](../../CHANGELOG.md) を参照してください。

---

## 0. 前提条件

| 要件 | 確認コマンド | 備考 |
|---|---|---|
| **Bun ≥ 1.3** | `bun --version` | ランタイム兼テストランナー。必須 |
| **git** | `git --version` | 必須 |
| Claude Code CLI | `claude --version` | 任意。Claude 委譲 / hook を使う場合 |
| Codex CLI | `codex --version` | 任意。Codex 委譲 / hybrid クロスレビューを使う場合 |

- OS は Windows / macOS / Linux いずれも可 (native Windows は第一級サポート、WSL 不要)。
- provider の API キーをリポジトリや設定ファイルに書く必要は**ありません** (認証は各公式 CLI のログインが保持)。

> **Windows で bun を npm shim 経由で入れている場合**: hook shell から実 Bun binary が
> 解決できる必要があります。`bun .ut-tdd\bin\ut-tdd.mjs --help` が失敗するときは
> `$env:PATH="$env:APPDATA\npm\node_modules\bun\bin;$env:PATH"` を追加してください。

## 1. 新規導入 (Pack をそのまま開発基盤として使う)

```sh
git clone https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack.git
cd UT-TDD_AGENT-HARNESS-Pack
bun install --frozen-lockfile
bun src/cli.ts setup --solo
bun .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke
```

`setup --solo` が生成するもの:

- `.ut-tdd/bin/ut-tdd.mjs` — 以後の入口になる wrapper
- `.claude/settings.json` / `.codex/hooks.json` — Claude / Codex のガード hook 配線
- `.claude/agents/` / `.claude/commands/` — サブエージェント / スキルコマンド定義
- `.github/workflows/` ほか CI・テンプレート (既存ファイルは上書きしません)

release tarball から導入する場合は、Releases ページの `vX.Y.Z.tar.gz` を取得し、
`vX.Y.Z.tar.gz.sha256` と照合してから展開して同じ手順を実行します:

```sh
sha256sum -c v0.1.4.tar.gz.sha256
tar -xzf v0.1.4.tar.gz -C <導入先ディレクトリ>
```

## 2. 既存プロジェクトへの投影

自分のプロジェクトにハーネス状態だけを投影する場合は、Pack checkout を残したまま
**対象プロジェクトのディレクトリで** setup を実行します:

```sh
cd <your-project>
<pack-checkout>/scripts/ut-tdd setup --dry-run   # まず書き込み内容を確認
<pack-checkout>/scripts/ut-tdd setup --solo
bun .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke
```

Windows PowerShell では `<pack-checkout>\scripts\ut-tdd.ps1 setup --solo`。

チーム開発では `--team --tl-team @org/tl --qa-team @org/qa --po-team @org/po` を
3 つセットで指定します (ブランチ保護は既定 emit-only、適用は人間の明示手順)。

## 3. 動作確認チェックリスト

導入直後に上から順に実行し、期待値と一致することを確認してください。

| # | コマンド | 期待値 |
|---|---|---|
| 1 | `bun .ut-tdd/bin/ut-tdd.mjs --help` | usage が表示される (wrapper 導通) |
| 2 | `bun .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke` | `setup-smoke - OK (checked=22, failed=0)` |
| 3 | `bun .ut-tdd/bin/ut-tdd.mjs status` | mode (`standalone` / `claude-only` / `codex-only` / `hybrid`) が表示される |
| 4 | `bun run typecheck` | exit 0 |
| 5 | `bun run test` | 全 green (配布安全 smoke suite) |

> **full `doctor` (フラグなし) はこの段階では赤になりますが正常です。**
> full doctor は設計 doc / PLAN / test-design が降下した後のガバナンス一括検証で、
> 初期導入の判定には `--setup-smoke` を使います。

## 4. バージョン更新 (tag-pin update)

Pack はタグ付き release (`v0.1.x`) で更新されます。変更点は先に
[CHANGELOG.md](../../CHANGELOG.md) で確認してください。

```sh
git fetch --tags
git checkout v0.1.4          # 追従運用なら: git pull origin main
bun install --frozen-lockfile
bun src/cli.ts setup --solo  # 冪等再実行
bun .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke
```

更新時の setup 再実行は**非破壊**です:

- あなたが所有するファイルは上書きされません。対話シェルでは既存ファイルごとに
  `上書きしますか？ [y/N]` を確認し (既定 N)、**非対話シェルでは確認を出さず常に既存を保護**します。
- `AGENTS.md` / `CLAUDE.md` / `.claude/CLAUDE.md` は `<!-- UT-TDD:managed:start/end -->`
  マーカー内だけが更新され、マーカー外のあなたの記述は保持されます。
- `.ut-tdd/` の runtime 状態 (harness.db 等) は wipe されません。

生成テンプレート自体の更新を取り込みたい場合のみ、対話シェルで setup を実行して
該当ファイルに `y` を答えてください (エンジンの挙動更新は checkout の更新だけで反映されます)。

## 5. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| full `doctor` が exit 1 | 正常 (§3 参照)。consumer 判定は `doctor --setup-smoke` |
| setup が既存ファイルで止まっているように見える | 対話シェルの上書き確認 (`[y/N]`) 待ちです。Enter (=N) で既存保護のまま進みます |
| `bun .ut-tdd/bin/ut-tdd.mjs ...` が exit 1 で `'ut-tdd' is not recognized` | wrapper がどの解決先も見つけられない状態。ハーネス checkout 直下 (`src/cli.ts` と `src/setup/index.ts` がある場所) で実行しているか、`bun install` 済みかを確認 |
| Windows で hook が bun を見つけられない | §0 の PATH 注記を参照 |
| doctor が「harness.db が古い」系で失敗 | `bun src/cli.ts db rebuild --json` で再投影してから再実行 |

wrapper (`.ut-tdd/bin/ut-tdd.mjs`) の解決順: ① 対象リポジトリの `node_modules/.bin/ut-tdd`
② リポジトリ直下のハーネス source (`src/cli.ts`、CI runner でも有効) ③ setup を実行した
Pack checkout の絶対パス ④ global `ut-tdd`。CI 上でも②により setup 実行マシンのパスに
依存しません。

## 6. 次の一歩

- `ut-tdd status` — 現在の実行モードと outstanding の確認
- `ut-tdd task classify --text "..."` — 着手前の難易度分類
- `ut-tdd team suggest --task "..."` — クロス provider チーム編成の要否判定
- `ut-tdd handover` — セッション間の引き継ぎ生成
- ワークフロー全体像: `docs/process/` (Forward / 駆動モデル / gate 定義)
