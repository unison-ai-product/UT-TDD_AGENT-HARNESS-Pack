import { describe, expect, it, vi } from "vitest";
import { removeTestTree } from "./support/temp-tree.ts";

describe("temporary tree cleanup", () => {
  it("U-TESTHYGIENE-008: collects DB handles before retrying Windows tree removal", () => {
    const order: string[] = [];
    const remove = vi.fn((_path: string, options?: object) => {
      order.push("remove");
      expect(options).toEqual({ recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    removeTestTree("fixture", {
      collectGarbage: () => order.push("gc"),
      remove,
    });

    expect(order).toEqual(["remove"]);
  });

  it("U-TESTHYGIENE-009: propagates final cleanup errors", () => {
    const failure = new Error("EBUSY");
    expect(() =>
      removeTestTree("fixture", {
        collectGarbage: () => undefined,
        remove: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);
  });
});
