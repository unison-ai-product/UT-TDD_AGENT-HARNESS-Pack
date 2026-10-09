# ランタイム / 外部ツールの挙動メモ (実測)

実測で分かった外部ツールとランタイムの「仕様 (挙動)」を、改善を早めるための参照資料としてまとめる。推測は書かない。

## 運用 (3 行)

1. 今後わかった仕様はここへ追記し、memory 側は本資料への pointer にする。
2. 同じ事実を CLAUDE.md / AGENTS.md / 既存 docs に書いてある場合は、本文を写さず pointer にする。
3. 出典で裏付けられない項目は「未確認」と明記するか、入れない。secret・PII・個人の絶対 path は書かない (`~` や `<repo>` で表す)。

## 書式 (各事実 1 項目)

`### <事実の一文>` の下に、次の 6 行を置く。

- 事実 / 対象バージョン / 確認日 / 確認方法 / 出典 / ハーネスへの影響

対象版と実行したコマンドの両方が記録されている項目だけを実測の事実とする。どちらかが欠ける項目 (コード閲覧・観測・transcript のみを含む) は、見出しの先頭に `(未確認)` を付け、確認方法の行にその理由を書く。

## 索引

| ファイル | 対象 |
| --- | --- |
| `claude-code.md` | Claude Code (CLI / VS Code 拡張) |
| `codex.md` | Codex (CLI / GUI / hooks) |
| `commander.md` | commander (CLI 引数解析) |
| `wsl.md` | WSL2 / Remote-WSL / Remote-SSH |
| `windows-shell.md` | Windows のシェル挙動 |
| `harness-review-custody.md` | ハーネス自身の review custody 挙動 |

作成日: 2026-10-08 (起点は main `3581ee5c`)。
