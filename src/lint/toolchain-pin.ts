import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NODE_TOOLCHAIN_POLICY = {
  phase: "node_production",
  nodeAuthority: "sealed",
  executableReceipt: "required",
  nodeVersion: "24.13.0",
  npmVersion: "11.6.2",
  npmIntegrity:
    "sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==",
  esbuildVersion: "0.21.5",
  lockfileVersion: 3,
} as const;

export interface ToolchainPinDocs {
  packageJson: string | null;
  bunLock?: string | null;
  packageLock?: string | null;
  nodeVersion?: string | null;
}

export interface ToolchainPinViolation {
  rule:
    | "biome-package-spec-missing"
    | "biome-package-spec-not-exact"
    | "biome-lock-spec-missing"
    | "biome-lock-spec-not-exact"
    | "biome-package-lock-mismatch"
    | "node-version-mismatch"
    | "npm-version-mismatch"
    | "npm-package-manager-not-exact"
    | "npm-package-manager-integrity-missing"
    | "npm-package-manager-integrity-mismatch"
    | "npm-lock-invalid"
    | "npm-lock-version-mismatch"
    | "npm-lock-root-drift"
    | "esbuild-version-mismatch"
    | "bun-lock-present"
    | "bun-direct-parity-drift"
    | "runtime-authority-ambiguous";
  detail: string;
}

export interface ToolchainPinResult {
  ok: boolean;
  packageSpec: string | null;
  lockSpec: string | null;
  policy: typeof NODE_TOOLCHAIN_POLICY;
  violations: ToolchainPinViolation[];
}

const BIOME_PACKAGE = "@biomejs/biome";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

type PackageManifest = {
  packageManager?: unknown;
  engines?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  utTdd?: { nodeToolchain?: Record<string, unknown> };
};

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function packageBiomeSpec(packageJson: string | null): string | null {
  const parsed = parseJson(packageJson) as PackageManifest | null;
  const raw = parsed?.devDependencies?.[BIOME_PACKAGE] ?? parsed?.dependencies?.[BIOME_PACKAGE];
  return typeof raw === "string" ? raw : null;
}

function lockWorkspaceSpec(lockText: string | null, packageName: string): string | null {
  if (!lockText) return null;
  try {
    const parsed = JSON.parse(lockText) as {
      packages?: Record<
        string,
        { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
      >;
    };
    const root = parsed.packages?.[""];
    const value = root?.devDependencies?.[packageName] ?? root?.dependencies?.[packageName];
    if (typeof value === "string") return value;
  } catch {
    // Historical lock text is not authoritative.
  }
  const workspace = lockText.match(/"workspaces"\s*:\s*\{[\s\S]*?\n\s*\},\n\s*"packages"/)?.[0];
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (workspace ?? lockText).match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`))?.[1] ?? null;
}

function allDirect(manifest: PackageManifest | Record<string, unknown>): Record<string, string> {
  return { ...stringMap(manifest.dependencies), ...stringMap(manifest.devDependencies) };
}

function sameMap(left: Record<string, string>, right: Record<string, string>): boolean {
  return (
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  );
}

export function analyzeToolchainPin(docs: ToolchainPinDocs): ToolchainPinResult {
  const manifest = parseJson(docs.packageJson) as PackageManifest | null;
  const npmLock = parseJson(docs.packageLock);
  const npmRoot =
    npmLock?.packages && typeof npmLock.packages === "object"
      ? ((npmLock.packages as Record<string, unknown>)[""] as Record<string, unknown> | undefined)
      : undefined;
  const packageSpec = packageBiomeSpec(docs.packageJson);
  const lockSpec = lockWorkspaceSpec(docs.packageLock ?? null, BIOME_PACKAGE);
  const violations: ToolchainPinViolation[] = [];

  if (docs.bunLock)
    violations.push({ rule: "bun-lock-present", detail: "bun.lock must remain physically absent" });

  if (!packageSpec) violations.push({ rule: "biome-package-spec-missing", detail: BIOME_PACKAGE });
  else if (!EXACT_VERSION.test(packageSpec))
    violations.push({ rule: "biome-package-spec-not-exact", detail: packageSpec });
  if (!lockSpec) violations.push({ rule: "biome-lock-spec-missing", detail: BIOME_PACKAGE });
  else if (!EXACT_VERSION.test(lockSpec))
    violations.push({ rule: "biome-lock-spec-not-exact", detail: lockSpec });
  if (packageSpec && lockSpec && packageSpec !== lockSpec)
    violations.push({ rule: "biome-package-lock-mismatch", detail: `${packageSpec}/${lockSpec}` });

  const nodeFile = docs.nodeVersion?.trim() ?? "";
  const engineNode = manifest?.engines?.node;
  if (
    nodeFile !== NODE_TOOLCHAIN_POLICY.nodeVersion ||
    engineNode !== NODE_TOOLCHAIN_POLICY.nodeVersion ||
    nodeFile !== engineNode
  ) {
    violations.push({
      rule: "node-version-mismatch",
      detail: `${nodeFile || "missing"}/${String(engineNode ?? "missing")}`,
    });
  }

  const packageManager =
    typeof manifest?.packageManager === "string" ? manifest.packageManager : "";
  const managerMatch = packageManager.match(/^npm@([^+]+)(?:\+(sha512-[A-Za-z0-9+/=]+))?$/);
  if (managerMatch?.[1] !== NODE_TOOLCHAIN_POLICY.npmVersion)
    violations.push({ rule: "npm-package-manager-not-exact", detail: packageManager || "missing" });
  if (!managerMatch?.[2])
    violations.push({
      rule: "npm-package-manager-integrity-missing",
      detail: packageManager || "missing",
    });
  else if (managerMatch[2] !== NODE_TOOLCHAIN_POLICY.npmIntegrity)
    violations.push({
      rule: "npm-package-manager-integrity-mismatch",
      detail: managerMatch[2],
    });
  if (
    manifest?.engines?.npm !== NODE_TOOLCHAIN_POLICY.npmVersion ||
    managerMatch?.[1] !== manifest?.engines?.npm
  )
    violations.push({
      rule: "npm-version-mismatch",
      detail: `${String(manifest?.engines?.npm ?? "missing")}/${managerMatch?.[1] ?? "missing"}`,
    });

  if (!npmLock || !npmRoot)
    violations.push({ rule: "npm-lock-invalid", detail: "root package missing" });
  else {
    if (npmLock.lockfileVersion !== NODE_TOOLCHAIN_POLICY.lockfileVersion)
      violations.push({
        rule: "npm-lock-version-mismatch",
        detail: String(npmLock.lockfileVersion ?? "missing"),
      });
    if (!sameMap(allDirect(manifest ?? {}), allDirect(npmRoot)))
      violations.push({ rule: "npm-lock-root-drift", detail: "package.json/package-lock root" });
  }

  const packageDirect = allDirect(manifest ?? {});
  const lockDirect = npmRoot ? allDirect(npmRoot) : {};
  // Keep the historical Bun parity detector for synthetic/retained fixtures,
  // but do not require a retired bun.lock in the production toolchain.
  if (docs.bunLock) {
    const bunDirect = Object.fromEntries(
      Object.keys(packageDirect).map((name) => [
        name,
        lockWorkspaceSpec(docs.bunLock ?? null, name) ?? "",
      ]),
    );
    if (!sameMap(packageDirect, bunDirect))
      violations.push({
        rule: "bun-direct-parity-drift",
        detail: "package.json/bun.lock direct graph",
      });
  }
  if (
    packageDirect.esbuild !== NODE_TOOLCHAIN_POLICY.esbuildVersion ||
    (npmRoot ? allDirect(npmRoot).esbuild : null) !== NODE_TOOLCHAIN_POLICY.esbuildVersion ||
    lockDirect.esbuild !== NODE_TOOLCHAIN_POLICY.esbuildVersion
  )
    violations.push({
      rule: "esbuild-version-mismatch",
      detail: "esbuild must be exact across the npm graph",
    });

  const authority = manifest?.utTdd?.nodeToolchain;
  if (
    authority?.phase !== NODE_TOOLCHAIN_POLICY.phase ||
    authority?.nodeAuthority !== NODE_TOOLCHAIN_POLICY.nodeAuthority ||
    authority?.executableReceipt !== NODE_TOOLCHAIN_POLICY.executableReceipt
  )
    violations.push({
      rule: "runtime-authority-ambiguous",
      detail: "nodeToolchain policy mismatch",
    });

  return {
    ok: violations.length === 0,
    packageSpec,
    lockSpec,
    policy: NODE_TOOLCHAIN_POLICY,
    violations,
  };
}

export function toolchainPinMessages(result: ToolchainPinResult): string[] {
  if (result.ok)
    return [
      `toolchain-pin - OK (${BIOME_PACKAGE}=${result.packageSpec}; phase=${result.policy.phase})`,
    ];
  return [
    `toolchain-pin - violation ${result.violations.length}: ${result.violations
      .map((v) => `${v.rule}(${v.detail})`)
      .join(", ")}`,
  ];
}

export function loadToolchainPinDocs(repoRoot: string): ToolchainPinDocs {
  const read = (name: string): string | null => {
    const path = join(repoRoot, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  return {
    packageJson: read("package.json"),
    bunLock: read("bun.lock"),
    packageLock: read("package-lock.json"),
    nodeVersion: read(".node-version"),
  };
}
