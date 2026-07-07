import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkAgentSlots,
  checkHandover,
  type DoctorDeps,
  doctorSlotsDeps,
  handoverDeps,
} from "../src/doctor/runtime-state";
import type { Slot } from "../src/runtime/agent-slots";

const NOW = "2026-06-04T00:10:00.000Z";
const root = "/repo";
const handoverPath = join(root, ".ut-tdd", "handover", "CURRENT.json");
const slotsPath = join(root, ".ut-tdd", "state", "agent-slots.json");

function doctorDeps(files = new Map<string, string>()): DoctorDeps {
  return {
    repoRoot: root,
    now: NOW,
    readText: (path) => files.get(path) ?? null,
    listDir: (dir) =>
      [...files.keys()]
        .filter((path) => path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`))
        .map((path) => path.slice(dir.length + 1)),
  };
}

function slot(overrides: Partial<Slot> = {}): Slot {
  return {
    slot_id: "slot-1",
    agent_kind: "codex",
    role: null,
    slot_source: "agent_guard",
    fired_at: "2026-06-04T00:00:00.000Z",
    released_at: null,
    status: "running",
    exit_code: null,
    ...overrides,
  };
}

describe("doctor runtime-state direct checks", () => {
  it("adapts handover deps as read-only doctor state", () => {
    const files = new Map([[join(root, ".ut-tdd", "state", "current-plan"), "PLAN-X\n"]]);
    const adapted = handoverDeps(doctorDeps(files));

    expect(adapted.repoRoot).toBe(root);
    expect(adapted.now()).toBe(NOW);
    expect(adapted.readText(join(root, ".ut-tdd", "state", "current-plan"))).toBe("PLAN-X\n");
    expect(adapted.listDir(join(root, ".ut-tdd", "state"))).toEqual(["current-plan"]);
    expect(() => adapted.writeText("unused", "mutate")).toThrow("doctor is read-only");
  });

  it("surfaces handover pointer states without throwing on missing or malformed state", () => {
    expect(checkHandover(doctorDeps())).toContain("CURRENT.json");

    const files = new Map([[handoverPath, "{not-json"]]);
    expect(() => checkHandover(doctorDeps(files))).not.toThrow();
    expect(checkHandover(doctorDeps(files))).toContain("CURRENT.json");
  });

  it("adapts agent slot deps without allowing doctor writes", () => {
    const files = new Map([[slotsPath, JSON.stringify([slot({ status: "completed" })])]]);
    const adapted = doctorSlotsDeps(doctorDeps(files));

    expect(adapted.repoRoot).toBe(root);
    expect(adapted.now()).toBe(NOW);
    expect(adapted.readText(slotsPath)).toBe(files.get(slotsPath));
    expect(adapted.newId()).toBe("doctor-readonly");
    expect(() => adapted.writeText(slotsPath, "mutate")).not.toThrow();
    expect(files.get(slotsPath)).toContain("slot-1");
  });

  it("reports stale and healthy agent slot surfaces from injected state", () => {
    const staleFiles = new Map([[slotsPath, JSON.stringify([slot({ slot_id: "old" })])]]);
    const staleMessage = checkAgentSlots(doctorSlotsDeps(doctorDeps(staleFiles)));
    expect(staleMessage).toContain("stale");
    expect(staleMessage).toContain("old");

    const healthyFiles = new Map([
      [
        slotsPath,
        JSON.stringify([
          slot({
            status: "completed",
            released_at: "2026-06-04T00:02:00.000Z",
          }),
        ]),
      ],
    ]);
    const healthyMessage = checkAgentSlots(doctorSlotsDeps(doctorDeps(healthyFiles)));
    expect(healthyMessage).toContain("OK");
    expect(healthyMessage).toContain("peak_parallel");
  });
});
