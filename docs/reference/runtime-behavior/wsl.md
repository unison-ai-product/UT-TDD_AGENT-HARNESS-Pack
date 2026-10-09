# WSL2 / VS Code Remote の挙動

### (未確認) automount を無効にした distro では、VS Code Remote-WSL が `wslServer.sh: not found` で起動しない

- 事実: Remote-WSL 拡張は、distro から Windows 側の `vscode-remote-wsl\...\vscode-server-stable-linux-x64.tar.gz` と `/scripts/wslServer.sh` を読む前提で動く。automount を無効にした専用 distro では、`Failed to translate` と `wslServer.sh: not found` で VS Code Server が起動しない。
- 対象バージョン: Remote-WSL 拡張 v0.104.3
- 確認日: 2026-10-07
- 確認方法: 専用 distro `ut-canary5-at003-linux` (`/etc/wsl.conf` で automount / interop / appendWindowsPath を無効) への接続試行。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: issue #418 の PO 決定コメント (2026-10-07、Linux 受入は Remote-SSH で接続)、issue #887。
- ハーネスへの影響: 隔離条件 (`/mnt/c` 無し) と Remote-WSL は両立しない。受入では loopback (127.0.0.1) 限定の sshd と Remote-SSH を採用する。契約は `docs/plans/PLAN-L7-531-pack-internal-canary-smoke.md` §3.6.9 と #887。

### (未確認) 専用 distro で automount / interop / Windows PATH を無効にしても、`unshare` user namespace と `bwrap` は exit 0 になる

- 事実: 専用 distro (Ubuntu 26.04.1 WSL image) で、`/mnt/c` 不在・DrvFs 無し・Windows PATH 無し・`cmd.exe` が exit 127 のまま、`unshare` と `bwrap` が exit 0 になった。root でも独立に再実行して確認した。
- 対象バージョン: Ubuntu 26.04.1 WSL image、Node 24.13.0 / npm 11.6.2、Git 2.53.0
- 確認日: 2026-10-07
- 確認方法: 専用 distro での上記コマンドの実測。実 Codex authoring の PASS の代用にはならない。 対象版と実行コマンドの両方が記録されていない (コード閲覧・観測・transcript のみ、または版が未確認) ため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: memory `project-canary5-wsl-control-auth-ready-20261007.md`、`project-canary5-wsl-toolchain-handoff-20261007.md`。
- ハーネスへの影響: Docker container で出た bwrap 拒否 (`codex.md` 参照) は、専用 WSL2 distro の probe では再現しなかった。実 authoring の結果は issue #418 の canary.5 記録で確認する。

### (未確認) WSL service が一度 `Wsl/Service/0x8007274c` の timeout を返したが、再実行は成功した

- 事実: toolchain の追加確認中に一度 timeout が出て、同じ確認の root 再実行は exit 0 だった。サービス再起動と distro 再作成はしていない。
- 対象バージョン: 記録なし。
- 確認日: 2026-10-07
- 確認方法: toolchain 追加確認の実行記録。対象版または実行コマンドの記録が無いため、項目全体を未確認として扱う。再現して記録するまで、実測の事実として扱わない。
- 出典: memory `project-canary5-wsl-toolchain-handoff-20261007.md`。
- ハーネスへの影響: 単発の timeout で distro を作り直さず、再実行で切り分ける。画面オフなど原因との関係は **未確認** (出典に記録なし)。
