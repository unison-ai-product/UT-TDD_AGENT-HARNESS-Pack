import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";

export function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

/** 書いた file だけを index へ入れる。index にだけ在る symlink / submodule を `git add .` が working tree で上書きしないため。 */
export function writeStaged(root: string, path: string, text: string): void {
  write(root, path, text);
  git(root, ["add", "--", path]);
}

/** index にだけ mode 120000 / 160000 の entry を足す (Windows でも symlink / submodule を作らない)。 */
export function stageSpecial(
  root: string,
  mode: "120000" | "160000",
  path: string,
  target = "target.ts",
) {
  const oid =
    mode === "160000"
      ? git(root, ["rev-parse", "HEAD"])
      : git(root, ["hash-object", "-w", "--stdin"], target);
  git(root, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
}

/** fixture の commit に特殊 entry が実際に入ったこと (fixture が通常 file へ化けていないこと) を、結果に依らず確かめる。 */
export function expectTreeEntry(
  root: string,
  rev: string,
  path: string,
  mode: string,
  target?: string,
) {
  const line = git(root, ["ls-tree", rev, "--", path]);
  expect(line.startsWith(`${mode} `)).toBe(true);
  if (target !== undefined) expect(git(root, ["cat-file", "-p", `${rev}:${path}`])).toBe(target);
}
