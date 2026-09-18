import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import {
  type CompiledRightArmRegistry,
  compileRightArmContract,
} from "../application/contract-compiler.ts";

export const VMODEL_CONTRACT_PATH = "docs/process/vmodel-contract.yaml";

export function loadCompiledRightArmRegistry(repoRoot = process.cwd()): CompiledRightArmRegistry {
  const source = readFileSync(resolve(repoRoot, VMODEL_CONTRACT_PATH), "utf8");
  return compileRightArmContract(YAML.parse(source));
}
