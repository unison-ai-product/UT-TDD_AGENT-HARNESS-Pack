# UT-TDD Agent Harness Pack セットアップガイド

このガイドでは、「導入 → 動作確認 → 新しい版への対応 → 困ったとき」を順に説明します。
コマンドの一覧は [README](../../README.md) のコマンド早見表にあります。各版の変更点は
[Releases](https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases) の release notes に書いています。

---

## 0. 前提条件

| 要件 | 確認コマンド | 備考 |
|---|---|---|
| **Node.js 24** | `node -v` | 必須。release asset はこの Node だけで動きます (`npm ci` は不要) |
| **git** | `git --version` | 必須 |
| 入れる先の git repository と **origin remote** | `git remote -v` | 必須。origin が無いと、setup は runtime を入れたうえで exit 2 (`identity_repository_unbound`) で終わります (§5) |
| Claude Code CLI / VS Code の Claude 拡張 | `claude --version` | 任意。Claude の hook と委譲を使う場合 |
| Codex CLI | `codex --version` | 任意。Codex の委譲と、Claude との相互 review を使う場合 |

- **動作保証環境は Windows です** (native で動き、WSL は要りません)。公開した release asset を使った受入を、版ごとに行っています。
- **Linux / WSL2 はベストエフォートです。** CI は Linux でも毎回走らせ、公開前のリハーサルでも動作を確かめています。ただし、版ごとの正式な受入は、利用の実績や必要が出てきた時点で行います ([#928](https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/928))。Linux で動かない場合は、バグ報告で知らせてください。再現できたものは修理し、回帰テストを足します。
- macOS は検証していません。
- provider の API キーを、repository や設定ファイルに書く必要は**ありません**。認証は、各公式 CLI のログインがそのまま使われます。

> **Windows**: `node -v` が失敗する場合は、Node.js の公式インストーラーで PATH を有効にし、シェルを開き直してください。

## 1. 導入 (release asset から入れる)

1. [Releases](https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases) から、使いたい版の asset を 5 つともダウンロードし、**新しく作った空のフォルダ**に置きます。そのフォルダには、この 5 つ以外のファイルを置かないでください (ほかのファイルがあると、setup が `consumer_runtime_asset_set_mismatch` で止まります)。

   | asset | 中身 |
   |---|---|
   | `<版>.ut-tdd.mjs` | setup を実行する入口 |
   | `<版>.consumer-runtime.json` | 封印した runtime |
   | `<版>.consumer.sha256` | runtime の SHA-256 |
   | `<版>.tar.gz` | Pack の配布物一式 |
   | `<版>.tar.gz.sha256` | 配布物一式の SHA-256 |

2. 入れたい repository で、次を実行します (Windows の PowerShell でもそのまま使えるように、1 行で書いています)。`<consumer anchor>` には、その版の release notes にある consumer anchor (`sha256:...`) を入れてください。

```sh
echo ".ut-tdd/" >> .git/info/exclude   # runtime の状態を git の差分に出さない
node <フォルダ>/<版>.ut-tdd.mjs setup --solo --consumer-runtime-release <フォルダ> --expected-consumer-digest <consumer anchor>
```

Windows PowerShell では、1 行目の代わりに `Add-Content -Encoding ascii .git/info/exclude ".ut-tdd/"` を使ってください (`>>` だと UTF-16 で書き込まれ、git が読めません)。

setup は、asset の SHA-256 が consumer anchor と一致することを最初に確かめます。一致しない場合は
`consumer_runtime_anchor_mismatch` を出して exit 1 で止まり、ファイルを 1 つも書きません。

setup が作るもの:

- `.ut-tdd/` — runtime と、ハーネスの状態 (`.git/info/exclude` に入れておけば、git の差分には出ません)
- `.ut-tdd/bin/ut-tdd.mjs` — 以後の入口になる launcher
- `.claude/settings.json` / `.codex/hooks.json` — Claude / Codex の hook の配線
- `AGENTS.md` / `CLAUDE.md` — Codex / Claude 向けの規約 (managed block の中だけをハーネスが管理します)
- `.github/`、`.gitignore`、`.editorconfig`、`.gitattributes`、`commitlint.config.cjs`、`ut-tdd.project.json` — CI とテンプレート、設定 (既にあるファイルは上書きしません)

作られたファイルは、確認してから commit してください。

release asset からの導入 (`--consumer-runtime-release`) は `--solo` だけに対応しています (`--team` や `--dry-run` と一緒に指定すると exit 1 で止まります)。
チーム開発で使う場合は、上の手順で導入したあとに、launcher で次を実行します。まず `--dry-run` を付けて書き込む内容を確かめ、問題なければ `--dry-run` を外して実行してください。

```sh
node .ut-tdd/bin/ut-tdd.mjs setup --dry-run --team --tl-team @org/tl --qa-team @org/qa --po-team @org/po
```

3 つのチームは必ずセットで指定してください。ブランチ保護は既定では出力するだけで、適用は人の手で行います。

## 2. 動作確認チェックリスト

導入した repository の中で、上から順に実行してください。期待値と一致すれば導入は完了です。

| # | コマンド | 期待値 |
|---|---|---|
| 1 | `node .ut-tdd/bin/ut-tdd.mjs --help` | usage が表示され、exit 0 |
| 2 | `node .ut-tdd/bin/ut-tdd.mjs doctor --setup-smoke` | `doctor: setup-smoke - OK (checked=23, failed=0)` |
| 3 | `node .ut-tdd/bin/ut-tdd.mjs status` | 1 行目に `mode:` (`standalone` / `claude-only` / `codex-only` / `hybrid`) が表示される |
| 4 | VS Code で repository を開き、Claude 拡張で新しい chat を始める | 最初の応答の前に、`session-start digest` が読み込まれる |

> **`doctor` をフラグなしで実行すると赤になりますが、異常ではありません。**
> フラグなしの doctor は、設計文書・PLAN・テスト設計がそろってから使うガバナンスの一括検証です。
> 導入の判定には `--setup-smoke` を使ってください。

## 3. 新しい版への対応

新しい版は Pack の [Releases](https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS-Pack/releases) で公開します。
GitHub で Pack リポジトリを **Watch → Custom → Releases** に設定しておくと、公開したときに通知が届きます。

> **いまの canary 版の制約** (どちらも修正予定です)
> - release asset から入れた環境では、`ut-tdd status` の更新通知が動きません。`update: check skipped (harness package.json unreadable)` と表示されます ([#867](https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/867))。新しい版は、上の Watch で知ってください。
> - 一度入れた runtime を、新しい版の asset で上書きすることはできません。setup が `consumer_runtime_update_unsupported` で止まり、元の版のまま残ります ([#930](https://github.com/unison-ai-product/UT-TDD_AGENT-HARNESS/issues/930))。新しい版を試すときは、まだ入れていない repository (または新しい clone) に入れてください。

## 4. setup を流し直したとき

同じ版で setup を流し直しても、壊れることはありません。

- あなたが所有するファイルは上書きしません。対話シェルでは、既存のファイルごとに `上書きしますか？ [y/N]` と確認します (既定は N)。**非対話シェルでは確認を出さず、常に既存のファイルを残します**。
- `AGENTS.md` / `CLAUDE.md` / `.claude/CLAUDE.md` は、`<!-- UT-TDD:managed:start/end -->` の中だけを更新します。マーカーの外に書いた内容は残ります。
- `.ut-tdd/` の runtime 状態 (harness.db など) は消しません。

## 5. 困ったとき

| 症状 | 原因と対処 |
|---|---|
| setup が `consumer_runtime_anchor_mismatch` で止まる | `--expected-consumer-digest` の値が、その版の release notes の consumer anchor と違います。asset が途中で壊れていないかも確認してください。ファイルは 1 つも書かれていません |
| setup が exit 2 で `identity_repository_unbound` と出る | origin remote がありません。runtime はすでに入っているので、最初の導入コマンドを流し直しても `already installed` で終わるだけです。`git remote add origin <url>` のあと、`node .ut-tdd/bin/ut-tdd.mjs setup --solo` を実行してください。案内が出たら、`ut-tdd.project.json` を commit します |
| setup が `consumer_runtime_asset_set_mismatch` で止まる | asset を置いたフォルダに、5 つの asset 以外のファイルがあります。5 つだけを入れた空のフォルダを使ってください |
| setup が `consumer_runtime_update_unsupported` で止まる | すでに別の版の runtime が入っています。§3 の制約を見てください |
| setup が止まっているように見える | 対話シェルで、上書きの確認 (`[y/N]`) を待っています。Enter (=N) を押せば、既存のファイルを残したまま進みます |
| フラグなしの `doctor` が exit 1 | 異常ではありません (§2)。導入の判定は `doctor --setup-smoke` で行ってください |
| Windows で hook が Node を見つけられない | §0 の PATH の注記を見てください |

launcher (`.ut-tdd/bin/ut-tdd.mjs`) が参照するのは、`.ut-tdd/runtime/activation/active.json` (activation pointer) の 1 つだけです。
`node_modules`、source、global の `ut-tdd` には切り替えません。pointer が無い場合や、bundle の digest が一致しない場合は、
`consumer_runtime_absent` などで fail-close します。

上の表で解決しないときは、[README のバグ報告](../../README.md#-バグ報告) の手順で知らせてください。

## 6. 次の一歩

- `node .ut-tdd/bin/ut-tdd.mjs status` — いまの実行モードと、未完了の作業を確認する
- `node .ut-tdd/bin/ut-tdd.mjs task classify --text "..."` — 着手する前に、作業の難しさを分類する
- `node .ut-tdd/bin/ut-tdd.mjs handover` — セッション間の引き継ぎを作る
- ハーネス自体を開発・検証する場合は、Pack を clone して `npm ci` のあと、`node src/cli.ts <command>` を使います
