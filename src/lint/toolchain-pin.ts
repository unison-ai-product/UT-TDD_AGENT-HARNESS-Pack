import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolchainPinDocs {
  packageJson: string | null;
  bunLock: string | null;
}

export interface ToolchainPinViolation {
  rule:
    | "biome-package-spec-missing"
    | "biome-package-spec-not-exact"
    | "biome-lock-spec-missing"
    | "biome-lock-spec-not-exact"
    | "biome-package-lock-mismatch";
  detail: string;
}

export interface ToolchainPinResult {
  ok: boolean;
  packageSpec: string | null;
  lockSpec: string | null;
  violations: ToolchainPinViolation[];
}

const BIOME_PACKAGE = "@biomejs/biome";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isExactVersion(spec: string | null): boolean {
  return Boolean(spec && EXACT_VERSION.test(spec));
}

function packageBiomeSpec(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as {
      devDependencies?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };
    const raw = parsed.devDependencies?.[BIOME_PACKAGE] ?? parsed.dependencies?.[BIOME_PACKAGE];
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

function lockWorkspaceBiomeSpec(lockText: string | null): string | null {
  if (!lockText) return null;
  const workspace = lockText.match(/"workspaces"\s*:\s*\{[\s\S]*?\n\s*\},\n\s*"packages"/)?.[0];
  const match = (workspace ?? lockText).match(/"@biomejs\/biome"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

export function analyzeToolchainPin(docs: ToolchainPinDocs): ToolchainPinResult {
  const packageSpec = packageBiomeSpec(docs.packageJson);
  const lockSpec = lockWorkspaceBiomeSpec(docs.bunLock);
  const violations: ToolchainPinViolation[] = [];

  if (!packageSpec) {
    violations.push({ rule: "biome-package-spec-missing", detail: BIOME_PACKAGE });
  } else if (!isExactVersion(packageSpec)) {
    violations.push({ rule: "biome-package-spec-not-exact", detail: packageSpec });
  }

  if (!lockSpec) {
    violations.push({ rule: "biome-lock-spec-missing", detail: BIOME_PACKAGE });
  } else if (!isExactVersion(lockSpec)) {
    violations.push({ rule: "biome-lock-spec-not-exact", detail: lockSpec });
  }

  if (packageSpec && lockSpec && packageSpec !== lockSpec) {
    violations.push({
      rule: "biome-package-lock-mismatch",
      detail: `${packageSpec}/${lockSpec}`,
    });
  }

  return { ok: violations.length === 0, packageSpec, lockSpec, violations };
}

export function toolchainPinMessages(result: ToolchainPinResult): string[] {
  if (result.ok) {
    return [`toolchain-pin - OK (${BIOME_PACKAGE}=${result.packageSpec})`];
  }
  const sample = result.violations.map((v) => `${v.rule}(${v.detail})`).join(", ");
  return [
    `toolchain-pin - violation ${result.violations.length}: ${sample}; pin biome exactly to avoid formatter drift`,
  ];
}

export function loadToolchainPinDocs(repoRoot: string): ToolchainPinDocs {
  const packagePath = join(repoRoot, "package.json");
  const lockPath = join(repoRoot, "bun.lock");
  return {
    packageJson: existsSync(packagePath) ? readFileSync(packagePath, "utf8") : null,
    bunLock: existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null,
  };
}
