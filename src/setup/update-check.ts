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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_CACHE_PATH = join(".ut-tdd", "state", "update-check.json");
export const UPDATE_CHECK_DISABLE_ENV = "UT_TDD_SKIP_UPDATE_CHECK";
export const UPDATE_CHECK_REMOTE_ENV = "UT_TDD_UPDATE_CHECK_REMOTE";
const LS_REMOTE_TIMEOUT_MS = 5000;

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
      typeof parsed.version === "string" && parseSemver(parsed.version) ? parsed.version : null;
    return { version, repositoryUrl: normalizeRepositoryUrl(parsed.repository), readable: true };
  } catch {
    return { version: null, repositoryUrl: null, readable: false };
  }
}

function readCache(deps: UpdateCheckDeps): UpdateCheckCache | null {
  const raw = deps.readText(join(deps.harnessRoot, UPDATE_CHECK_CACHE_PATH));
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
        deps.writeText(join(deps.harnessRoot, UPDATE_CHECK_CACHE_PATH), JSON.stringify(next));
      } catch {
        // Fail-open: cache write failure only means the next status run checks remote again.
      }
    }

    const local = parseSemver(localVersion);
    const latest = latestVersion ? parseSemver(latestVersion) : null;
    return {
      checked: true,
      localVersion,
      latestVersion,
      updateAvailable: Boolean(local && latest && compareSemver(latest, local) > 0),
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
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    hasOwnGit: () => existsSync(join(harnessRoot, ".git")),
    remoteOverride: () => process.env[UPDATE_CHECK_REMOTE_ENV]?.trim() || null,
    listRemoteTags: (remote) => {
      const res = spawnSync("git", ["ls-remote", "--tags", remote], {
        cwd: harnessRoot,
        encoding: "utf8",
        timeout: LS_REMOTE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
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
