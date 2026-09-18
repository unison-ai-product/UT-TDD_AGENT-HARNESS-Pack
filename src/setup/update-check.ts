/**
 * Pack update-check advisory (PLAN-L7-362).
 *
 * Invariants:
 * - Advisory only, never a gate. Remote failures, missing tags, malformed
 *   manifests, and cache write failures must not make status / doctor red.
 * - The baseline is the harness checkout, not the consumer cwd.
 * - The canonical remote is package.json repository.url. Falling back to origin
 *   is allowed only when the harness root itself owns .git, so vendored installs
 *   do not accidentally read the consumer repository origin.
 * - Remote results are cached for 24 hours under the harness root.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "../shared/fs.ts";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_CACHE_PATH = join(".ut-tdd", "state", "update-check.json");
export const UPDATE_CHECK_DISABLE_ENV = "UT_TDD_SKIP_UPDATE_CHECK";
export const UPDATE_CHECK_REMOTE_ENV = "UT_TDD_UPDATE_CHECK_REMOTE";
export const UPDATE_CHECK_CACHE_DIR_ENV = "UT_TDD_UPDATE_CHECK_CACHE_DIR";
const LS_REMOTE_TIMEOUT_MS = 5000;

/**
 * PLAN-L7-462 step 2: node の spawn は Windows で `.cmd`/`.bat` を PATH 解決しない
 * (旧runtimeは解決していたため不可視だった)。adapter の provider `.cmd` shim 方式
 * (src/runtime/adapter.ts buildProviderInvocation) を踏襲し、PATH 上の git が
 * command script のときだけ ComSpec 経由 (shell:false) で包む。
 */
export function gitLsRemoteInvocation(
  remote: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const args = ["ls-remote", "--tags", remote];
  if (platform !== "win32") return { command: "git", args };
  const pathValue = env.PATH ?? env.Path ?? "";
  const exts = [".exe", ".com", ".cmd", ".bat"];
  let found: string | null = null;
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `git${ext}`);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }
  if (found && /\.(cmd|bat)$/i.test(found)) {
    // cmd.exe は引用の内側でも %VAR% を展開するため、% を含む remote は安全に渡せない。
    // その場合は wrap を諦めて素の "git" に落とす (advisory の fail-open 契約に一致)。
    if (args.some((token) => token.includes("%"))) return { command: "git", args };
    // 空白・cmd メタ文字を含む token のみ引用する (全引用すると shim 側の %1 比較を壊す)。
    const quote = (token: string) =>
      /[\s"^&|<>()!]/.test(token) ? `"${token.replace(/"/g, '""')}"` : token;
    const inner = [quote(found), ...args.map(quote)].join(" ");
    return {
      command: env.ComSpec ?? join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: found ?? "git", args };
}

export interface UpdateCheckDeps {
  /** Harness checkout root, not consumer cwd. */
  harnessRoot: string;
  nowMs: () => number;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
  /** True only when the harness root itself owns .git. */
  hasOwnGit: () => boolean;
  /** Optional configured remote for forks, mirrors, or private Pack channels. */
  remoteOverride?: () => string | null;
  /** Test/runner-only cache root; production defaults to harnessRoot/.ut-tdd. */
  cacheRoot?: () => string | null;
  /** Tag names from `git ls-remote --tags <remote>`; null means fail-open. */
  listRemoteTags: (remote: string) => string[] | null;
}

export interface UpdateCheckResult {
  /** True when remote or a fresh cache was consulted. False means advisory is silent. */
  checked: boolean;
  localVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  source: "remote" | "cache" | "none";
  /** Fail-open detail, set when checked=false. */
  detail: string | null;
}

/** Canonical package.json SemVer, including prerelease/build identifiers. */
export interface PackageSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

interface UpdateCheckCache {
  checkedAtMs: number;
  latestVersion: string | null;
  remote: string;
}

interface HarnessManifest {
  version: string | null;
  repositoryUrl: string | null;
  readable: boolean;
}

/** Parse `v0.1.4` / `0.1.4` into [major, minor, patch]. */
export function parseSemver(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const PACKAGE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parse a package.json version without accepting tag prefixes or whitespace coercion. */
export function parsePackageSemver(value: unknown): PackageSemver | null {
  if (typeof value !== "string") return null;
  const match = PACKAGE_SEMVER.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  )
    return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease,
    build: match[5]?.split(".") ?? [],
  };
}

/** Compare canonical package SemVer values; build metadata has no precedence. */
export function comparePackageSemver(a: PackageSemver, b: PackageSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (left.length !== right.length) return left.length - right.length;
      return left < right ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** Semver compare. Numeric comparison keeps 0.1.10 > 0.1.9. */
export function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Select the largest release tag from a tag list. */
export function latestReleaseTag(tags: string[]): string | null {
  let best: string | null = null;
  let bestV: [number, number, number] | null = null;
  for (const tag of tags) {
    const v = parseSemver(tag);
    if (!v) continue;
    if (!bestV || compareSemver(v, bestV) > 0) {
      best = tag.trim();
      bestV = v;
    }
  }
  return best;
}

/** Normalize package.json repository forms into a URL usable by git ls-remote. */
export function normalizeRepositoryUrl(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : typeof (repository as { url?: unknown })?.url === "string"
        ? ((repository as { url: string }).url as string)
        : null;
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^git\+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function readManifest(deps: UpdateCheckDeps): HarnessManifest {
  const raw = deps.readText(join(deps.harnessRoot, "package.json"));
  if (raw === null) return { version: null, repositoryUrl: null, readable: false };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; repository?: unknown };
    const version =
      typeof parsed.version === "string" && parsePackageSemver(parsed.version)
        ? parsed.version
        : null;
    return { version, repositoryUrl: normalizeRepositoryUrl(parsed.repository), readable: true };
  } catch {
    return { version: null, repositoryUrl: null, readable: false };
  }
}

function readCache(deps: UpdateCheckDeps): UpdateCheckCache | null {
  const raw = deps.readText(cachePath(deps));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateCheckCache>;
    if (typeof parsed.checkedAtMs !== "number" || typeof parsed.remote !== "string") return null;
    return {
      checkedAtMs: parsed.checkedAtMs,
      latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
      remote: parsed.remote,
    };
  } catch {
    return null;
  }
}

function cachePath(deps: UpdateCheckDeps): string {
  return join(deps.cacheRoot?.() ?? deps.harnessRoot, UPDATE_CHECK_CACHE_PATH);
}

function failOpen(localVersion: string | null, detail: string): UpdateCheckResult {
  return {
    checked: false,
    localVersion,
    latestVersion: null,
    updateAvailable: false,
    source: "none",
    detail,
  };
}

/** Silent non-gate result for env / CI opt-out. */
export function updateCheckDisabled(reason = UPDATE_CHECK_DISABLE_ENV): UpdateCheckResult {
  return failOpen(null, `disabled by ${reason}`);
}

function configuredRemote(deps: UpdateCheckDeps, manifest: HarnessManifest): string | null {
  const override = deps.remoteOverride?.();
  if (override) return override;
  if (manifest.repositoryUrl) return manifest.repositoryUrl;
  return deps.hasOwnGit() ? "origin" : null;
}

/**
 * Main update-check routine. Never throws.
 * Remote resolution order: explicit override, package.json repository.url, then
 * origin only when the harness root owns .git. If none is available, silence.
 */
export function checkForUpdate(deps: UpdateCheckDeps): UpdateCheckResult {
  let localVersion: string | null = null;
  try {
    const manifest = readManifest(deps);
    localVersion = manifest.version;
    if (!manifest.readable) return failOpen(null, "harness package.json unreadable");
    if (localVersion === null) {
      return failOpen(null, "harness package.json version is not a release version");
    }

    const remote = configuredRemote(deps, manifest);
    if (remote === null) {
      return failOpen(
        localVersion,
        "no canonical remote (package.json repository missing and harness root has no .git)",
      );
    }

    const cache = readCache(deps);
    let latestVersion: string | null;
    let source: "remote" | "cache";
    if (
      cache &&
      cache.remote === remote &&
      deps.nowMs() - cache.checkedAtMs < UPDATE_CHECK_TTL_MS
    ) {
      latestVersion = cache.latestVersion;
      source = "cache";
    } else {
      const tags = deps.listRemoteTags(remote);
      if (tags === null) return failOpen(localVersion, "remote tags unreachable");
      latestVersion = latestReleaseTag(tags);
      source = "remote";
      const next: UpdateCheckCache = { checkedAtMs: deps.nowMs(), latestVersion, remote };
      try {
        deps.writeText(cachePath(deps), JSON.stringify(next));
      } catch {
        // Fail-open: cache write failure only means the next status run checks remote again.
      }
    }

    const local = parsePackageSemver(localVersion);
    const latestStable = latestVersion ? parseSemver(latestVersion) : null;
    const latest = latestStable
      ? {
          major: latestStable[0],
          minor: latestStable[1],
          patch: latestStable[2],
          prerelease: [],
          build: [],
        }
      : null;
    return {
      checked: true,
      localVersion,
      latestVersion,
      updateAvailable: Boolean(local && latest && comparePackageSemver(latest, local) > 0),
      source,
      detail: null,
    };
  } catch (err) {
    return failOpen(localVersion, `update-check failed: ${String(err)}`);
  }
}

/** Render the single additive status text line. */
export function renderUpdateLine(r: UpdateCheckResult): string {
  if (r.updateAvailable && r.latestVersion) {
    return `update: v${r.localVersion} -> ${r.latestVersion} available (see CHANGELOG.md and update the Pack checkout, not the consumer repo)`;
  }
  if (r.checked && r.latestVersion === null) {
    return `update: no release tags on remote (v${r.localVersion})`;
  }
  if (r.checked) return `update: up-to-date (v${r.localVersion})`;
  return `update: check skipped (${r.detail ?? "unknown"})`;
}

/** Resolve the harness checkout root from this module location. */
export function defaultHarnessRoot(): string | null {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    return null;
  }
}

/** Harness package.json version for CLI --version. Fail-open to 0.0.0. */
export function readHarnessVersion(harnessRoot: string | null): string {
  if (harnessRoot === null) return "0.0.0";
  try {
    const parsed = JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function nodeUpdateCheckDeps(
  harnessRoot: string | null = defaultHarnessRoot(),
): UpdateCheckDeps {
  if (harnessRoot === null) {
    return {
      harnessRoot: "",
      nowMs: () => Date.now(),
      readText: () => null,
      writeText: () => {},
      hasOwnGit: () => false,
      remoteOverride: () => process.env[UPDATE_CHECK_REMOTE_ENV]?.trim() || null,
      cacheRoot: () => process.env[UPDATE_CHECK_CACHE_DIR_ENV]?.trim() || null,
      listRemoteTags: () => null,
    };
  }
  return {
    harnessRoot,
    nowMs: () => Date.now(),
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeText: (p, c) => {
      ensureDir(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    hasOwnGit: () => existsSync(join(harnessRoot, ".git")),
    remoteOverride: () => process.env[UPDATE_CHECK_REMOTE_ENV]?.trim() || null,
    cacheRoot: () => process.env[UPDATE_CHECK_CACHE_DIR_ENV]?.trim() || null,
    listRemoteTags: (remote) => {
      const invocation = gitLsRemoteInvocation(remote);
      const res = spawnSync(invocation.command, invocation.args, {
        cwd: harnessRoot,
        encoding: "utf8",
        timeout: LS_REMOTE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
      });
      if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
      const tags: string[] = [];
      for (const line of res.stdout.split("\n")) {
        const ref = line.split("\t")[1]?.trim();
        if (!ref?.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
        tags.push(ref.slice("refs/tags/".length));
      }
      return tags;
    },
  };
}
