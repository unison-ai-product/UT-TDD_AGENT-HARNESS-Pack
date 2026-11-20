import { expect } from "vitest";
import type { HarnessDb } from "../../src/state-db/index.ts";

export function expectPlanFreeSessionProjection(
  db: HarnessDb,
  sessionId: string,
): readonly [unknown, unknown] {
  const hookEvent = db.prepare("SELECT * FROM hook_events WHERE session_id = ?").get(sessionId);
  expect(hookEvent).toMatchObject({ hook_name: "PostToolUse", event_type: "tool_use" });
  const testRun = db.prepare("SELECT * FROM test_runs WHERE session_id = ?").get(sessionId);
  expect(testRun).toMatchObject({
    command: "PowerShell (tsc)",
    shell: "powershell",
    status: "passed",
  });
  return [hookEvent?.plan_id, testRun?.plan_id];
}
