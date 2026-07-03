import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkForUpdate,
  compareSemver,
  latestReleaseTag,
  normalizeRepositoryUrl,
  parseSemver,
  renderUpdateLine,
  UPDATE_CHECK_CACHE_PATH,
  UPDATE_CHECK_DISABLE_ENV,
  UPDATE_CHECK_REMOTE_ENV,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheckDeps,
  updateCheckDisabled,
} from "../src/setup/update-check";

const ROOT = "/harness";
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT) {
  const base = { cwd, encoding: "utf8" as const, env, timeout: 120_000 };
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "bun", CLI_PATH, ...args], base);
  }
  return spawnSync("bun", [CLI_PATH, ...args], base);
}

function mockDeps(
  over: Partial<UpdateCheckDeps> & {
    version?: string;
    repository?: unknown;
    tags?: string[] | null;
  } = {},
): UpdateCheckDeps & { files: Map<string, string>; remoteCalls: string[] } {
  const files = new Map<string, string>();
  if (over.version !== undefined || over.repository !== undefined) {
    files.set(
      join(ROOT, "package.json"),
      JSON.stringify({
        ...(over.version !== undefined ? { version: over.version } : {}),
        ...(over.repository !== undefined ? { repository: over.repository } : {}),
      }),
    );
  }
  const remoteCalls: string[] = [];
  const { version: _v, repository: _r, tags, ...rest } = over;
  return {
    files,
    remoteCalls,
    harnessRoot: ROOT,
    nowMs: () => 1_000_000,
    readText: (p) => files.get(p) ?? null,
    writeText: (p, c) => files.set(p, c),
    hasOwnGit: () => true,
    listRemoteTags: (remote) => {
      remoteCalls.push(remote);
      return tags === undefined ? [] : tags;
    },
    ...rest,
  };
}

function makeFakeGit(root: string) {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  if (process.platform === "win32") {
    const script = join(fakeBin, "git.cmd");
    writeFileSync(
      script,
      [
        "@echo off",
        'echo %*>> "%UT_TDD_FAKE_GIT_LOG%"',
        'if "%1"=="ls-remote" (',
        "  echo abc\trefs/tags/v0.1.99",
        "  exit /b 0",
        ")",
        "exit /b 1",
        "",
      ].join("\r\n"),
    );
    return fakeBin;
  }
  const script = join(fakeBin, "git");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$UT_TDD_FAKE_GIT_LOG"',
      'if [ "$1" = "ls-remote" ]; then',
      '  printf "abc\\trefs/tags/v0.1.99\\n"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return fakeBin;
}

describe("update-check semver primitives", () => {
  it("U-UPDCHK-001: parseSemver accepts v-prefixed and bare release tags only", () => {
    expect(parseSemver("v0.1.4")).toEqual([0, 1, 4]);
    expect(parseSemver("0.1.4")).toEqual([0, 1, 4]);
    expect(parseSemver("v0.2.0-rc.1")).toBeNull();
    expect(parseSemver("release-candidate")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });

  it("U-UPDCHK-002: latestReleaseTag picks numeric max and ignores non-semver", () => {
    expect(latestReleaseTag(["v0.1.9", "v0.1.10", "v0.1.2", "nightly", "v1.0.0-beta"])).toBe(
      "v0.1.10",
    );
    expect(latestReleaseTag(["nightly", "poc"])).toBeNull();
    expect(latestReleaseTag([])).toBeNull();
    expect(compareSemver([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
  });

  it("U-UPDCHK-017: normalizeRepositoryUrl accepts string / object forms and strips git+", () => {
    expect(normalizeRepositoryUrl("https://example.com/pack.git")).toBe(
      "https://example.com/pack.git",
    );
    expect(normalizeRepositoryUrl({ type: "git", url: "git+https://example.com/pack.git" })).toBe(
      "https://example.com/pack.git",
    );
    expect(normalizeRepositoryUrl("")).toBeNull();
    expect(normalizeRepositoryUrl(undefined)).toBeNull();
    expect(normalizeRepositoryUrl({ type: "git" })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("U-UPDCHK-003: newer remote tag surfaces updateAvailable and writes the cache", () => {
    const deps = mockDeps({ version: "0.1.4", tags: ["v0.1.3", "v0.1.4", "v0.1.5"] });
    const r = checkForUpdate(deps);
    expect(r).toMatchObject({
      checked: true,
      localVersion: "0.1.4",
      latestVersion: "v0.1.5",
      updateAvailable: true,
      source: "remote",
    });
    const cache = JSON.parse(deps.files.get(join(ROOT, UPDATE_CHECK_CACHE_PATH)) ?? "{}");
    expect(cache).toEqual({ checkedAtMs: 1_000_000, latestVersion: "v0.1.5", remote: "origin" });
  });

  it("U-UPDCHK-004: local at latest or ahead is not an update", () => {
    expect(checkForUpdate(mockDeps({ version: "0.1.4", tags: ["v0.1.4"] })).updateAvailable).toBe(
      false,
    );
    expect(checkForUpdate(mockDeps({ version: "0.2.0", tags: ["v0.1.4"] })).updateAvailable).toBe(
      false,
    );
  });

  it("U-UPDCHK-005: fresh cache short-circuits the remote", () => {
    const deps = mockDeps({
      version: "0.1.4",
      listRemoteTags: () => {
        throw new Error("remote must not be consulted inside TTL");
      },
    });
    deps.files.set(
      join(ROOT, UPDATE_CHECK_CACHE_PATH),
      JSON.stringify({
        checkedAtMs: 1_000_000 - UPDATE_CHECK_TTL_MS + 1,
        latestVersion: "v0.1.5",
        remote: "origin",
      }),
    );
    const r = checkForUpdate(deps);
    expect(r).toMatchObject({ checked: true, updateAvailable: true, source: "cache" });
  });

  it("U-UPDCHK-006: stale cache falls through to the remote", () => {
    const deps = mockDeps({ version: "0.1.4", tags: ["v0.1.6"] });
    deps.files.set(
      join(ROOT, UPDATE_CHECK_CACHE_PATH),
      JSON.stringify({
        checkedAtMs: 1_000_000 - UPDATE_CHECK_TTL_MS,
        latestVersion: "v0.1.5",
        remote: "origin",
      }),
    );
    const r = checkForUpdate(deps);
    expect(r).toMatchObject({ latestVersion: "v0.1.6", source: "remote" });
  });

  it("U-UPDCHK-007: unreachable remote fails open without caching", () => {
    const deps = mockDeps({ version: "0.1.4", tags: null });
    const r = checkForUpdate(deps);
    expect(r).toMatchObject({
      checked: false,
      updateAvailable: false,
      source: "none",
      detail: "remote tags unreachable",
    });
    expect(deps.files.has(join(ROOT, UPDATE_CHECK_CACHE_PATH))).toBe(false);
  });

  it("U-UPDCHK-008: missing or malformed harness package.json fails open", () => {
    expect(checkForUpdate(mockDeps({ tags: ["v9.9.9"] }))).toMatchObject({
      checked: false,
      detail: "harness package.json unreadable",
    });
    const broken = mockDeps({ tags: ["v9.9.9"] });
    broken.files.set(join(ROOT, "package.json"), "{not json");
    expect(checkForUpdate(broken).checked).toBe(false);
    expect(checkForUpdate(mockDeps({ version: "workspace:*", tags: ["v9.9.9"] }))).toMatchObject({
      checked: false,
      detail: "harness package.json version is not a release version",
    });
  });

  it("U-UPDCHK-009: cache write failure stays fail-open", () => {
    const deps = mockDeps({
      version: "0.1.4",
      tags: ["v0.1.5"],
      writeText: () => {
        throw new Error("disk full");
      },
    });
    expect(checkForUpdate(deps)).toMatchObject({ checked: true, updateAvailable: true });
  });

  it("U-UPDCHK-010: remote with no release tags is checked but silent", () => {
    const r = checkForUpdate(mockDeps({ version: "0.1.4", tags: ["nightly"] }));
    expect(r).toMatchObject({ checked: true, latestVersion: null, updateAvailable: false });
  });

  it("U-UPDCHK-012: package.json repository.url is preferred over the origin fallback", () => {
    const deps = mockDeps({
      version: "0.1.4",
      repository: { type: "git", url: "git+https://example.com/pack.git" },
      tags: ["v0.1.5"],
      hasOwnGit: () => false,
    });
    const r = checkForUpdate(deps);
    expect(r).toMatchObject({ checked: true, updateAvailable: true });
    expect(deps.remoteCalls).toEqual(["https://example.com/pack.git"]);
  });

  it("U-UPDCHK-013: vendored install with no canonical remote never reads consumer origin", () => {
    const deps = mockDeps({ version: "0.1.4", tags: ["v9.9.9"], hasOwnGit: () => false });
    const r = checkForUpdate(deps);
    expect(r).toMatchObject({ checked: false, updateAvailable: false, source: "none" });
    expect(r.detail).toContain("no canonical remote");
    expect(deps.remoteCalls).toEqual([]);
  });

  it("U-UPDCHK-014: corrupt cache JSON and remote-mismatch cache are stale", () => {
    const broken = mockDeps({ version: "0.1.4", tags: ["v0.1.5"] });
    broken.files.set(join(ROOT, UPDATE_CHECK_CACHE_PATH), "{not json");
    expect(checkForUpdate(broken)).toMatchObject({ source: "remote", updateAvailable: true });

    const moved = mockDeps({
      version: "0.1.4",
      repository: "https://example.com/pack.git",
      tags: ["v0.1.6"],
    });
    moved.files.set(
      join(ROOT, UPDATE_CHECK_CACHE_PATH),
      JSON.stringify({ checkedAtMs: 999_999, latestVersion: "v0.1.5", remote: "origin" }),
    );
    expect(checkForUpdate(moved)).toMatchObject({ latestVersion: "v0.1.6", source: "remote" });
  });

  it("U-UPDCHK-018: explicit remote override supports forks and mirrors", () => {
    const deps = mockDeps({
      version: "0.1.4",
      repository: "https://example.com/pack.git",
      tags: ["v0.1.5"],
      remoteOverride: () => "https://mirror.example.com/pack.git",
    });
    expect(checkForUpdate(deps)).toMatchObject({ checked: true, updateAvailable: true });
    expect(deps.remoteCalls).toEqual(["https://mirror.example.com/pack.git"]);
    const cache = JSON.parse(deps.files.get(join(ROOT, UPDATE_CHECK_CACHE_PATH)) ?? "{}");
    expect(cache.remote).toBe("https://mirror.example.com/pack.git");
  });
});

describe("renderUpdateLine", () => {
  it("U-UPDCHK-011: one advisory line per outcome without raw git checkout commands", () => {
    const base = checkForUpdate(mockDeps({ version: "0.1.4", tags: ["v0.1.5"] }));
    const line = renderUpdateLine(base);
    expect(line).toBe(
      "update: v0.1.4 -> v0.1.5 available (see CHANGELOG.md and update the Pack checkout, not the consumer repo)",
    );
    expect(line).not.toContain("git fetch");
    expect(line).not.toContain("git checkout");
    expect(renderUpdateLine(checkForUpdate(mockDeps({ version: "0.1.4", tags: ["v0.1.4"] })))).toBe(
      "update: up-to-date (v0.1.4)",
    );
    expect(renderUpdateLine(checkForUpdate(mockDeps({ version: "0.1.4", tags: [] })))).toBe(
      "update: no release tags on remote (v0.1.4)",
    );
    expect(renderUpdateLine(checkForUpdate(mockDeps({ version: "0.1.4", tags: null })))).toBe(
      "update: check skipped (remote tags unreachable)",
    );
    expect(renderUpdateLine(updateCheckDisabled())).toBe(
      `update: check skipped (disabled by ${UPDATE_CHECK_DISABLE_ENV})`,
    );
    expect(renderUpdateLine(updateCheckDisabled("CI"))).toBe(
      "update: check skipped (disabled by CI)",
    );
  });
});

describe("status CLI wiring", () => {
  const disabledEnv = { ...process.env, [UPDATE_CHECK_DISABLE_ENV]: "1" };

  it("U-UPDCHK-015: status --json keeps existing fields and adds update additively", () => {
    const res = runCli(["status", "--json"], disabledEnv);
    expect(res.status, res.stderr || res.stdout).toBe(0);
    const json = JSON.parse(res.stdout);
    for (const key of ["mode", "claude", "codex", "nextAction", "outstanding"]) {
      expect(json, `existing status field ${key} must survive`).toHaveProperty(key);
    }
    expect(json.update).toMatchObject({ checked: false, updateAvailable: false });
    expect(String(json.update.detail)).toContain(UPDATE_CHECK_DISABLE_ENV);
  });

  it("U-UPDCHK-016: status text emits exactly one update advisory line", () => {
    const res = runCli(["status"], disabledEnv);
    expect(res.status, res.stderr || res.stdout).toBe(0);
    const updateLines = res.stdout.split("\n").filter((l) => l.startsWith("update: "));
    expect(updateLines).toEqual([
      `update: check skipped (disabled by ${UPDATE_CHECK_DISABLE_ENV})`,
    ]);
  });

  it("U-UPDCHK-019: CI skips remote checks by default for deterministic runs", () => {
    const res = runCli(["status", "--json"], {
      ...process.env,
      CI: "true",
      [UPDATE_CHECK_DISABLE_ENV]: "",
    });
    expect(res.status, res.stderr || res.stdout).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json.update).toMatchObject({
      checked: false,
      updateAvailable: false,
      detail: "disabled by CI",
    });
  });

  it("U-UPDCHK-020: status from a consumer cwd uses configured Pack remote, never consumer origin", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ut-tdd-update-check-"));
    try {
      const fakeBin = makeFakeGit(tmp);
      const consumerRoot = join(tmp, "consumer");
      mkdirSync(join(consumerRoot, ".git"), { recursive: true });
      const logPath = join(tmp, "git.log");
      const remote = `https://example.com/pack-${process.pid}-${Date.now()}.git`;

      const res = runCli(
        ["status", "--json"],
        {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          CI: "",
          [UPDATE_CHECK_DISABLE_ENV]: "",
          [UPDATE_CHECK_REMOTE_ENV]: remote,
          UT_TDD_FAKE_GIT_LOG: logPath,
        },
        consumerRoot,
      );

      expect(res.status, res.stderr || res.stdout).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.update).toMatchObject({
        checked: true,
        latestVersion: "v0.1.99",
        source: "remote",
      });
      const logText = readFileSync(logPath, "utf8");
      expect(logText).toContain(remote);
      expect(logText).not.toContain("origin");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
