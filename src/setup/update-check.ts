/**
 * Pack update-check advisory (PLAN-L7-362) — 導入済み consumer へ新 release の存在を
 * `ut-tdd status` の additive な 1 行で知らせる。
 *
 * 設計不変条件:
 *  - **advisory であって gate ではない**: remote 不達 / tag 無し / package.json 欠落を含む
 *    全経路 fail-open。status / doctor を赤にしない (throw しない)。
 *  - **基準は harness checkout であって consumer cwd ではない**: 投影導入 (setup-guide §2)
 *    では cwd の package.json / origin は利用者自身のプロジェクトを指すため、local version も
 *    remote tags もモジュール位置から解決した harness root で読む。
 *  - **remote の正は package.json `repository.url`** (TL review 所見1): node_modules 配下へ
 *    ベンダリング導入された harness root は自身の `.git` を持たず、`git ls-remote origin` が
 *    上位 (consumer 自身) の `.git` / origin を継承して誤読する。remote 名 `origin` への
 *    fallback は harness root 自身が `.git` を持つ場合に限る。
 *  - **キャッシュ TTL 24h**: `.ut-tdd/state/update-check.json` (harness root 側) に保存し、
 *    TTL 内は remote へ問い合わせない。remote が変わった cache は stale 扱い。remote 失敗時は
 *    キャッシュを書かず次回再試行。
 *  - **ls-remote は認証不要**: public Pack repo の tag 列挙に gh / token を要求しない。
 *    timeout 付き spawnSync で hang を防ぐ (setup 非対話ハングの教訓、PLAN-L7-361)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_CACHE_PATH = join(".ut-tdd", "state", "update-check.json");
/** CI / テストで advisory の remote 問い合わせを止める opt-out (fail-open と同じ沈黙表示)。 */
export const UPDATE_CHECK_DISABLE_ENV = "UT_TDD_SKIP_UPDATE_CHECK";
const LS_REMOTE_TIMEOUT_MS = 5000;

export interface UpdateCheckDeps {
  /** harness checkout の root (consumer cwd ではない)。 */
  harnessRoot: string;
  nowMs: () => number;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
  /** harness root 自身が `.git` を持つか (継承 .git による origin 誤読の防止)。 */
  hasOwnGit: () => boolean;
  /** `git ls-remote --tags <remote>` の tag 名一覧。null = remote 不達 (fail-open)。 */
  listRemoteTags: (remote: string) => string[] | null;
}

export interface UpdateCheckResult {
  /** remote または TTL 内キャッシュを参照できたか。false = advisory 沈黙。 */
  checked: boolean;
  localVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  source: "remote" | "cache" | "none";
  /** fail-open 理由 (checked=false のときのみ)。 */
  detail: string | null;
}

interface UpdateCheckCache {
  checkedAtMs: number;
  latestVersion: string | null;
  remote: string;
}

/** `v0.1.4` / `0.1.4` を [major, minor, patch] へ。release tag 形式以外は null。 */
export function parseSemver(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** semver 比較 (a > b なら正)。数値比較なので 0.1.10 > 0.1.9。 */
export function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** tag 一覧から最大の release tag (vX.Y.Z) を選ぶ。該当なしは null。 */
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

interface HarnessManifest {
  version: string | null;
  repositoryUrl: string | null;
  readable: boolean;
}

/** `git+https://...git` / `{ type, url }` / 素の文字列 repository を ls-remote へ渡せる URL へ。 */
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

/** env opt-out 時の沈黙結果 (CLI 配線が使う。fail-open と同じ非 gate 表示)。 */
export function updateCheckDisabled(): UpdateCheckResult {
  return failOpen(null, `disabled by ${UPDATE_CHECK_DISABLE_ENV}`);
}

/**
 * update-check 本体。remote 参照は TTL 24h キャッシュ越し。**never throws** (全経路 fail-open)。
 * remote の解決順: package.json `repository.url` → (harness root 自身に `.git` がある場合のみ)
 * remote 名 `origin`。どちらも無ければ advisory 沈黙 (ベンダリング導入で consumer の origin を
 * 誤読しないための fail-open、TL review 所見1)。
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

    const remote = manifest.repositoryUrl ?? (deps.hasOwnGit() ? "origin" : null);
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
        // fail-open: キャッシュ書き込み失敗は次回 remote 再試行に倒す。
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

/** status text 向け 1 行 (additive advisory、A-138 ITEM-1 / IMP-139 の前例に倣う)。 */
export function renderUpdateLine(r: UpdateCheckResult): string {
  if (r.updateAvailable && r.latestVersion) {
    return `update: v${r.localVersion} -> ${r.latestVersion} available (see CHANGELOG.md; git fetch --tags && git checkout ${r.latestVersion})`;
  }
  if (r.checked && r.latestVersion === null) {
    return `update: no release tags on remote (v${r.localVersion})`;
  }
  if (r.checked) return `update: up-to-date (v${r.localVersion})`;
  return `update: check skipped (${r.detail ?? "unknown"})`;
}

/** モジュール位置 (src/setup/) から harness checkout root を解決する。**never throws**。 */
export function defaultHarnessRoot(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    // fail-open: 非 file: 実行形態では cwd に倒す (CLI 起動を止めない、TL review 所見4)。
    return process.cwd();
  }
}

/** harness root の package.json version (CLI --version 表示用)。fail-open で "0.0.0"。 */
export function readHarnessVersion(harnessRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function nodeUpdateCheckDeps(harnessRoot = defaultHarnessRoot()): UpdateCheckDeps {
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
