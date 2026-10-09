# Codex の挙動

### `.codex/hooks.json` の hook 定義に `args` と `blockOnFailure` は無い

- 事実: 受け付ける項目は `type` / `command` / `commandWindows` / `timeout` / `async` / `statusMessage` / `additionalContextLimit`。`"command":"node","args":[...]` は素の `node` を起動して exit 1 で終わり、Codex は非ブロッキングの hook 失敗として扱う。
- 対象バージョン: codex-cli 0.154.0-alpha (VS Code 拡張同梱)
- 確認日: 2026-09-18
- 確認方法: Codex の binary を `grep -a -o 'commandWindowstimeoutasync[a-zA-Z]*'` で調べ、埋め込まれた項目名を読んだ。
- 出典: issue #668、Claude 側 memory `reference-codex-hook-schema-probe.md`。`.ut-tdd/memory/project-pr-669-plan-l7-668-codex-hook-command-schema-r*.md` は PR #669 の review 依頼の記録で、仕様の本文は含まない。
- ハーネスへの影響: hooks.json に `args` を書いても無言で失敗する。command を 1 本の文字列にする。

### (未確認) 生成した `.codex/hooks.json` の top-level `$comment` は未知 field として警告される

- 事実: Codex 0.159.2 (Windows) と 0.160.1 (Linux) で `unknown field $comment` / parse warning が実 transcript に再現した。native hook が正常に動いたかは未証明。
- 対象バージョン: Codex 0.159.2 / 0.160.1
- 確認日: 2026-10-07
- 確認方法: canary.5 の実 authoring の transcript。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: issue #418 のコメント (Windows / Linux の C5 実 authoring 結果)、issue #668、PR #886。
- ハーネスへの影響: hooks metadata の修理 (#886) を canary.6 で再配布する方針。

### (未確認) Codex の GUI スレッドは、作成時の cwd を持ち続ける

- 事実: 長期スレッドは移動前の cwd を指したままで、新しいスレッドが要る。
- 対象バージョン: 記録なし (2026-09-18 時点の VS Code 拡張)。
- 確認日: 2026-09-18
- 確認方法: PO の長期スレッドが移動前の path を指していた観測。対象版または実行コマンドの記録が無いため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: Claude 側 memory `reference-codex-hook-schema-probe.md`、issue #668。
- ハーネスへの影響: repo を移動したら、Codex の GUI では新しいスレッドで作業を始める。

### (未確認) `codex exec` の probe は scratch dir では project hook を起動しなかった

- 事実: trust override を付けても hook は起動しなかった。確認は GUI の新スレッドで行う。
- 対象バージョン: codex-cli 0.154.0-alpha
- 確認日: 2026-09-18
- 確認方法: scratch dir での `codex exec` probe。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: Claude 側 memory `reference-codex-hook-schema-probe.md`。
- ハーネスへの影響: hook の動作確認に `codex exec` の scratch probe を使わない。

### (未確認) Linux で bwrap の user namespace 作成が拒否されると、`workspace-write` でも実 write は失敗する

- 事実: sandbox が `workspace-write` でも、`bwrap: No permissions to create a new namespace` で shell / apply_patch の write が失敗し、authoring subject は作られなかった。session が task_complete でも、outer の exit 0 でも、文書作成の成功は証明されない。
- 対象バージョン: Codex gpt-6-luna / high。Codex CLI のバージョンは記録なし。
- 確認日: 2026-10-07 (06:37 UTC)
- 確認方法: 使い捨て Docker container (`node:24.13.0-bookworm`) での AT-DIST-003 Linux C4 attempt。bubblewrap を入れ直した後の `bwrap --ro-bind / / --unshare-user -- /bin/true` も exit 1。原因が host kernel か Docker の seccomp かは特定していない。対象版または実行コマンドの記録が無いため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: memory `feedback-at-dist-003-linux-bwrap-namespace-denial-blocks-live-authoring.md`、issue #418 comment 6032552682。
- ハーネスへの影響: user namespace が使えない環境では authoring を始めない (preflight)。専用 WSL2 distro では `unshare` と `bwrap` が exit 0 になった (`wsl.md` 参照)。
