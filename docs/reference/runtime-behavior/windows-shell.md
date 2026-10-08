# Windows のシェル挙動

次の項目は本資料に写さない。正本の場所だけを示す。

- 文字化けの防止 (UTF-8 / `.editorconfig` / `.gitattributes` / `readability` gate): repo の `CLAUDE.md` (コミュニケーション節)。
- `.ps1` は UTF-8 BOM 付き必須、`nul` ファイル禁止、`ut-tdd` CLI は PowerShell から起動不可: 個人の全体設定 `~/.claude/CLAUDE.md` (Windows 固有の注意)。repo の CLAUDE.md / AGENTS.md には無い。

### (未確認) Bash tool は POSIX 限定で、日本語のファイル名は文字化けが finding ID まで汚染することがある

- 事実: Windows 固有のコマンドは別に扱う必要がある。新規ファイル名は英語にする。doc 本文は日本語 + UTF-8 で書き、`readability` gate が mojibake を fail-close する前提を保つ。
- 対象バージョン: 記録なし。
- 確認日: 2026-09-16 (memory の更新日)
- 確認方法: 未確認。memory の記述だけで、測定コマンド・対象版・結果の記録は無い。再現して記録するまで、実測の事実として扱わない。
- 出典: `.ut-tdd/memory/reference-windows-bash-tool-mojibake-gate-cmd-spawn--4065145dff86.md`。
- ハーネスへの影響: ファイル名は英語にする。

### (未確認) `.cmd` 経由の spawn は CI の盲点になりやすい

- 事実: テスト環境では見落とされがち。コマンド出力を tail で切り詰めて報告しない。
- 対象バージョン: 記録なし。
- 確認日: 2026-09-16 (memory の更新日)
- 確認方法: 未確認。memory の記述だけで、個別の再現手順と結果の記録は無い。再現して記録するまで、実測の事実として扱わない。
- 出典: 上記 memory。
- ハーネスへの影響: `.cmd` を spawn する経路は、Windows 実機での検証を別に持つ。
