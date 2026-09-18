import { describe, expect, it } from "vitest";
import {
  missingRuntimeImageScopes,
  NodeOnlyProcessObserver,
} from "../src/runtime/runtime-image-observer.ts";

describe("RuntimeImageScanner boundary", () => {
  it("CAND-NODEBOOT-202 blocks fallback runtimes before a child can spawn", () => {
    const observer = new NodeOnlyProcessObserver();
    const result = observer.invoke(
      { command: "bun", args: ["run", "status"], options: { shell: false } },
      () => {
        throw new Error("must not run");
      },
    );
    expect(result).toMatchObject({ outcome: "blocked", spawned: false, reason: "bun-runtime" });
  });

  it("CAND-NODEBOOT-203/204 fail closed for every unobserved runtime-image scope", () => {
    expect(missingRuntimeImageScopes(["status"])).toEqual([
      "doctor",
      "test",
      "hook",
      "descendant",
      "download",
    ]);
    expect(
      missingRuntimeImageScopes(["status", "doctor", "test", "hook", "descendant", "download"]),
    ).toEqual([]);
  });

  it("records invocation and explicit absence proofs as different evidence modes", () => {
    const observer = new NodeOnlyProcessObserver();
    const invocation = observer.invoke(
      { command: process.execPath, args: ["ut-tdd.mjs", "doctor"], options: { shell: false } },
      () => undefined,
      "doctor",
    );
    const absence = observer.proveNoFallback("download", "download port is disabled");
    expect(invocation).toMatchObject({ scope: "doctor", mode: "invocation", spawned: true });
    expect(absence).toMatchObject({
      scope: "download",
      mode: "absence",
      command: "<none>",
      spawned: false,
    });
  });
});
