# commander (CLI 引数解析) の挙動

### (未確認) 親と子のコマンドが同じ option (`--json`) を宣言し、`enablePositionalOptions` が無いと、親が消費して子に届かない

- 事実: 親 `review` と子 `review live-dispatch` / `live-consume` が `--json` を宣言していた。`enablePositionalOptions()` を設定していないと、親が先に消費し、子の `opts.json` が false になって JSON ではなくテキストが出た。
- 対象バージョン: 修理前のハーネス (canary.5 の公開 bundle)。commander のバージョンは未確認。
- 確認日: 2026-10-07 (修理は 2026-10-08 までに main へ merge)
- 確認方法: canary.5 の consumer で `review live-dispatch --json` を実行し、stdout がテキストだったのを観測。`grep enablePositionalOptions` が 0 件。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: issue #888、PR #891。修理後の main では、親の宣言が `src/cli.ts:2201-2206`、子の宣言が `src/cli/review-live.ts:254` と `:349`、子の action は `command.optsWithGlobals<{ json?: boolean }>().json` で読む (`src/cli/review-live.ts:269`、`:351`)。
- ハーネスへの影響: 親子で同名 option を持つ場合、子の action は `optsWithGlobals()` で読む。修理はグローバル設定ではなく局所対応を採った (main `3581ee5c` でも `enablePositionalOptions` は 0 件)。実 CLI を通す結合テストが無いと、runner の単体テストは不一致を捕まえられない。
