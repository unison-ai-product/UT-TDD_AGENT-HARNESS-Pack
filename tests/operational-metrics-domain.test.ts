import { describe, expect, it, vi } from "vitest";
import { projectOperationalMetrics } from "../src/projection/application/project-operational-metrics.ts";
import {
  deriveOperationalMetrics,
  type OperationalMetricFacts,
} from "../src/projection/domain/operational-metrics.ts";
import { stableId } from "../src/stable-id.ts";

const facts: OperationalMetricFacts = {
  drives: [
    { mode: "scrum", total: 5, completed: 4 },
    { mode: "forward", total: 3, completed: 2 },
  ],
  hooks: { total: 4, trouble: 1 },
  workflow: { total: 3, blocked: 1, humanRequired: 2, retryGroups: 1 },
};

describe("U-DOMAIN-006: operational metrics", () => {
  it("derives every metric family in stable order with policy thresholds", () => {
    expect(deriveOperationalMetrics(facts)).toEqual([
      expect.objectContaining({ subject: "drive:forward", value: 0.6667, status: "warn" }),
      expect.objectContaining({ subject: "drive:scrum", value: 0.8, status: "pass" }),
      expect.objectContaining({ name: "trouble_event_rate", value: 0.25, status: "warn" }),
      expect.objectContaining({ name: "workflow_blocked_rate", value: 0.3333, status: "warn" }),
      expect.objectContaining({
        name: "workflow_human_required_rate",
        value: 0.6667,
        status: "warn",
      }),
      expect.objectContaining({ name: "workflow_retry_groups", value: 1, status: "warn" }),
    ]);
  });

  it("treats zero populations and zero findings as measured pass, not missing", () => {
    expect(
      deriveOperationalMetrics({
        drives: [],
        hooks: { total: 0, trouble: 0 },
        workflow: { total: 0, blocked: 0, humanRequired: 0, retryGroups: 0 },
      }),
    ).toEqual([
      expect.objectContaining({ name: "trouble_event_rate", value: 0, status: "pass" }),
      expect.objectContaining({ name: "workflow_blocked_rate", value: 0, status: "pass" }),
      expect.objectContaining({ name: "workflow_human_required_rate", value: 0, status: "pass" }),
      expect.objectContaining({ name: "workflow_retry_groups", value: 0, status: "pass" }),
    ]);
  });

  it("does not turn a below-threshold raw drive rate into pass after display rounding", () => {
    const [metric] = deriveOperationalMetrics({
      drives: [{ mode: "forward", total: 100_000, completed: 79_996 }],
      hooks: { total: 0, trouble: 0 },
      workflow: { total: 0, blocked: 0, humanRequired: 0, retryGroups: 0 },
    });
    expect(metric).toMatchObject({ value: 0.8, status: "warn" });
  });

  it("coalesces duplicate semantic drive modes before deriving stable IDs", () => {
    const metrics = deriveOperationalMetrics({
      drives: [
        { mode: "unknown", total: 1, completed: 1 },
        { mode: "unknown", total: 1, completed: 0 },
      ],
      hooks: { total: 0, trouble: 0 },
      workflow: { total: 0, blocked: 0, humanRequired: 0, retryGroups: 0 },
    });
    expect(metrics).toHaveLength(5);
    expect(metrics[0]).toMatchObject({ subject: "drive:unknown", value: 0.5, status: "warn" });
  });

  it("orders arbitrary mode text independently of the host locale", () => {
    const metrics = deriveOperationalMetrics({
      drives: [
        { mode: "ä", total: 1, completed: 1 },
        { mode: "z", total: 1, completed: 1 },
      ],
      hooks: { total: 0, trouble: 0 },
      workflow: { total: 0, blocked: 0, humanRequired: 0, retryGroups: 0 },
    });
    expect(metrics.slice(0, 2).map((metric) => metric.subject)).toEqual(["drive:z", "drive:ä"]);
  });

  it("reads once and records one deterministic event per metric with injected time", () => {
    const readOperationalMetricFacts = vi.fn(() => facts);
    const record = vi.fn();
    projectOperationalMetrics({
      read: { readOperationalMetricFacts },
      store: { record },
      computedAt: "fixed",
    });
    expect(readOperationalMetricFacts).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(facts.drives.length + 4);
    const signalId = stableId("telemetry-signal", "drive:forward:drive_firing_rate");
    expect(record.mock.calls[0][0]).toEqual({
      table: "quality_signals",
      id: signalId,
      row: {
        signal_id: signalId,
        source: "telemetry-metrics",
        subject_id: "drive:forward",
        metric: "drive_firing_rate",
        value: 0.6667,
        threshold: 0.8,
        status: "warn",
        computed_at: "fixed",
      },
    });
    expect(record.mock.calls.every(([event]) => event.row.computed_at === "fixed")).toBe(true);
    const events = record.mock.calls.map(([event]) => event);
    expect(events.every((event) => event.id === event.row.signal_id)).toBe(true);
    expect(new Set(record.mock.calls.map(([event]) => event.id)).size).toBe(
      record.mock.calls.length,
    );
    const replay = vi.fn();
    projectOperationalMetrics({
      read: { readOperationalMetricFacts: () => facts },
      store: { record: replay },
      computedAt: "fixed",
    });
    expect(replay.mock.calls.map(([event]) => event)).toEqual(events);
  });
});
