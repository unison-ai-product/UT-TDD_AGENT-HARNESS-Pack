import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelEvaluationConfigPort } from "../contracts/projection-store.ts";

export class RepositoryModelEvaluationConfig implements ModelEvaluationConfigPort {
  readonly #repoRoot: string;

  constructor(repoRoot: string) {
    this.#repoRoot = repoRoot;
  }

  isEnabled(): boolean {
    const path = join(this.#repoRoot, ".ut-tdd", "config", "model-opt-in.yaml");
    if (!existsSync(path)) return false;
    try {
      const parsed = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
      return parsed?.enabled === true;
    } catch {
      return false;
    }
  }
}
