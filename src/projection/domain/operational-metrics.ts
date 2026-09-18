export interface DriveMetricFacts {
  mode: string;
  total: number;
  completed: number;
}

export interface OperationalMetricFacts {
  drives: readonly DriveMetricFacts[];
  hooks: { total: number; trouble: number };
  workflow: { total: number; blocked: number; humanRequired: number; retryGroups: number };
}

export interface OperationalMetric {
  subject: string;
  name: string;
  value: number;
  threshold: number;
  status: "pass" | "warn";
}

export function deriveOperationalMetrics(
  facts: OperationalMetricFacts,
): readonly OperationalMetric[] {
  const drives = aggregateDrives(facts.drives).map(driveMetric);
  return [
    ...drives,
    rateMetric({
      subject: "hooks",
      name: "trouble_event_rate",
      numerator: facts.hooks.trouble,
      denominator: facts.hooks.total,
    }),
    rateMetric({
      subject: "workflow",
      name: "workflow_blocked_rate",
      numerator: facts.workflow.blocked,
      denominator: facts.workflow.total,
    }),
    rateMetric({
      subject: "workflow",
      name: "workflow_human_required_rate",
      numerator: facts.workflow.humanRequired,
      denominator: facts.workflow.total,
    }),
    {
      subject: "workflow",
      name: "workflow_retry_groups",
      value: facts.workflow.retryGroups,
      threshold: 0,
      status: facts.workflow.retryGroups === 0 ? "pass" : "warn",
    },
  ];
}

function aggregateDrives(rows: readonly DriveMetricFacts[]): DriveMetricFacts[] {
  const byMode = new Map<string, DriveMetricFacts>();
  for (const row of rows) {
    const current = byMode.get(row.mode) ?? { mode: row.mode, total: 0, completed: 0 };
    byMode.set(row.mode, {
      mode: row.mode,
      total: current.total + row.total,
      completed: current.completed + row.completed,
    });
  }
  return [...byMode.values()].sort((left, right) =>
    left.mode < right.mode ? -1 : left.mode > right.mode ? 1 : 0,
  );
}

function driveMetric(facts: DriveMetricFacts): OperationalMetric {
  const value = ratio(facts.completed, facts.total);
  const meetsThreshold = facts.total > 0 && facts.completed / facts.total >= 0.8;
  return {
    subject: `drive:${facts.mode}`,
    name: "drive_firing_rate",
    value,
    threshold: 0.8,
    status: meetsThreshold ? "pass" : "warn",
  };
}

function rateMetric(input: {
  subject: string;
  name: string;
  numerator: number;
  denominator: number;
}): OperationalMetric {
  return {
    subject: input.subject,
    name: input.name,
    value: ratio(input.numerator, input.denominator),
    threshold: 0,
    status: input.numerator === 0 ? "pass" : "warn",
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}
