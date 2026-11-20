import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { expect } from "vitest";

/** memory directory の読み取りを OS の権限で拒否する (Windows は icacls、POSIX は chmod 0)。 */
export function denyDirectoryRead(path: string): void {
  if (process.platform === "win32") {
    const deny = spawnSync(
      "icacls",
      [path, "/deny", `${process.env.USERNAME}:(OI)(CI)(RX)`, "/T", "/C"],
      { encoding: "utf8", windowsHide: true },
    );
    expect(deny.error?.message ?? "", "icacls deny must start").toBe("");
    expect(deny.signal, "icacls deny must exit normally").toBeNull();
    expect(deny.status, String(deny.stderr)).toBe(0);
  } else {
    chmodSync(path, 0);
  }
}

/** denyDirectoryRead で付けた拒否を戻す。 */
export function restoreDirectoryRead(path: string): void {
  if (process.platform === "win32") {
    const reset = spawnSync("icacls", [path, "/reset", "/T", "/C"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(reset.error?.message ?? "", "icacls reset must start").toBe("");
    expect(reset.signal, "icacls reset must exit normally").toBeNull();
    expect(reset.status, reset.stderr).toBe(0);
  } else {
    chmodSync(path, 0o700);
  }
}
