import { parse as parseYaml } from "yaml";

export function workflowNodeVersion(content: string): unknown {
  const parsed = parseYaml(content) as {
    jobs?: Record<string, { steps?: { uses?: unknown; with?: Record<string, unknown> }[] }>;
  };
  for (const job of Object.values(parsed.jobs ?? {})) {
    const setupNode = job.steps?.find((step) => step.uses === "actions/setup-node@v4");
    if (setupNode) return setupNode.with?.["node-version"];
  }
  return undefined;
}
