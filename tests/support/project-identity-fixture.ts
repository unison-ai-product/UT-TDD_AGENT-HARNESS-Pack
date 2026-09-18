import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalProjectIdentityBytes } from "../../src/kernel/project-identity.ts";

export function ensureTrackedProjectIdentity(
  root: string,
  repositoryIdentity = "fixture/ut-tdd-project",
): void {
  if (!existsSync(join(root, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: root });
  }
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["config", "remote.origin.url", `git@github.com:${repositoryIdentity}.git`], {
    cwd: root,
  });
  writeFileSync(
    join(root, "ut-tdd.project.json"),
    canonicalProjectIdentityBytes(repositoryIdentity),
  );
  execFileSync("git", ["add", "ut-tdd.project.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "test: seed project identity"], { cwd: root });
}
