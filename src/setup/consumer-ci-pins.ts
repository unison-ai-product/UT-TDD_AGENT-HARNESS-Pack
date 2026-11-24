import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const WORKFLOW_PATH = join(".github", "workflows", "harness-check.yml");
const PIN_KEYS = ["UT_TDD_CONSUMER_RUNTIME_VERSION", "UT_TDD_CONSUMER_RUNTIME_DIGEST"] as const;

function mapping(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Retain only consumer-selected release pins when setup regenerates its CI workflow. */
export function preserveConsumerCiPins(
  path: string,
  existing: string | null,
  rendered: string,
): string {
  if (path !== WORKFLOW_PATH || existing === null) return rendered;
  try {
    const current = mapping(parseYaml(existing));
    const output = mapping(parseYaml(rendered));
    const currentEnv = mapping(current?.env);
    const outputEnv = mapping(output?.env);
    if (!current || !output || !currentEnv || !outputEnv) return rendered;

    const pins = Object.fromEntries(
      PIN_KEYS.filter((key) => Object.hasOwn(currentEnv, key) && Object.hasOwn(outputEnv, key)).map(
        (key) => [key, currentEnv[key]],
      ),
    );
    return Object.keys(pins).length === 0
      ? rendered
      : stringifyYaml({ ...output, env: { ...outputEnv, ...pins } });
  } catch {
    // An invalid old workflow cannot provide trustworthy pins; regenerate defaults.
    return rendered;
  }
}
