import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { type Role, VALID_ROLES } from "../../schema/index.ts";

const SOURCE = "docs/governance/vmodel-role-contracts.md";

export interface RoleContractRegistry {
  readonly sourcePath: string;
  readonly targets: Readonly<Record<Role, string>>;
}

export function loadRoleContractRegistry(repoRoot: string): RoleContractRegistry {
  const content = execFileSync("git", ["-C", repoRoot, "show", `HEAD:${SOURCE}`], {
    encoding: "utf8",
  });
  const block = /```yaml\r?\n([\s\S]*?)\r?\n```/.exec(content)?.[1];
  const raw = block ? (parseYaml(block) as { role_contracts?: unknown }) : null;
  const contracts = raw?.role_contracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    throw new Error("role-contract-registry-invalid");
  }
  const values = contracts as Record<string, unknown>;
  if (
    Object.keys(values).length !== VALID_ROLES.length ||
    !VALID_ROLES.every((role) => typeof values[role] === "string" && values[role].trim())
  ) {
    throw new Error("role-contract-registry-invalid");
  }
  return Object.freeze({
    sourcePath: SOURCE,
    targets: Object.freeze(values as Record<Role, string>),
  });
}
