# Claude Code の挙動

### (未確認) Linux で distro の PATH に node が無いと、consumer の hook が `Executable not found: node` で失敗する

- 事実: hook は PATH 上の `node` を探す。無いと hook が失敗する。`/usr/local/bin` に node / npm / npx / claude / codex の symlink を置くと解消した。
- 対象バージョン: Claude Code のバージョンは記録なし (未確認)。Node は 24.13.0 (distro 内の `/opt/node-v24.13.0-linux-x64`)。
- 確認日: 2026-10-07
- 確認方法: symlink 設置後に SessionStart の `hook_success` と `entrypoint=claude-vscode` を実測した。対象版または実行コマンドの記録が無いため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: issue #418 の 2026-10-07 コメント (「AT-DIST-003 019 (review join) は canary.5 では失敗します。製品の欠陥 #888」)。memory `project-canary5-wsl-toolchain-handoff-20261007.md` は Node の導入手順と明示 PATH を記録している (symlink の記述は無い)。
- ハーネスへの影響: Linux 受入環境では、hook を走らせる前に node を標準 PATH へ置く前提確認が要る。

### (未確認) consumer の wake は、`CLAUDE_CODE_ENTRYPOINT=claude-vscode` のときだけ対象になる

- 事実: `isClaudeMemoryWakeTarget` は `env.CLAUDE_CODE_ENTRYPOINT === "claude-vscode"` かつ `UT_TDD_DISABLE_CLAUDE_MEMORY_WAKE !== "1"` を要求する。generation marker は `<session>.generation` で、内容は `process.pid:Date.now()`。
- 対象バージョン: main `3581ee5c` のコード。
- 確認日: 2026-10-08
- 確認方法: コードを読んだ。`src/runtime/claude-memory-wake.ts:266-270` (対象判定)、`:1314-1315` (marker 名と内容)。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: 上記のコード。issue #887 の PO 決定が `CLAUDE_CODE_ENTRYPOINT=claude-vscode` の実測を AT-DIST-003 の契約へ入れるとしている。
- ハーネスへの影響: `claude` コマンドの直起動など、entrypoint が違うセッションは wake の対象にならない。受入では VS Code 拡張経由のセッションを使う。marker は project の runtime bus root の下の `claude-memory-wake/` に置かれる (`src/runtime/claude-memory-wake.ts:291`、`requireProjectMemoryRoot(repoRoot).runtimeBusRoot`)。

### Claude Code CLI 2.1.289 は `claude-haiku-5-5` を拒否し、2.1.293 で受け付けた

- 事実: 2.1.289 は `--model claude-haiku-5-5` を拒否し、2.1.293 で受け付けた。alias の opus / sonnet / haiku は 5.5、fable は 5.1 を指す。
- 対象バージョン: Claude Code CLI 2.1.289 / 2.1.293
- 確認日: 2026-10-08
- 確認方法: Windows の Claude Code CLI (`~/.local/bin/claude.exe`) で `--model claude-haiku-5-5` を指定して実行した。2.1.289 は拒否し、更新後の 2.1.293 は受け付けた。更新後に `claude --version` が `2.1.293 (Claude Code)` を返すことを再確認した (2026-10-08)。Git Bash の PATH には `claude` が無いので、絶対 path で呼ぶ。
- 出典: control の実測 (2026-10-08)。モデル指定の方針は v4 決定 V4D-097 (#733 6050468759、モデルは常に最新を指す)。
- ハーネスへの影響: 世代を固定したモデル ID は、CLI が古いと拒否される。CLI の更新が遅れても壊れないように、モデル指定は alias (`opus` / `sonnet` / `haiku` / `fable`) で行う (V4D-097)。
