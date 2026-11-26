import { AsyncLocalStorage } from "node:async_hooks";
import { expect as originalExpect } from "../../node_modules/vitest/dist/index.js";

export const testExpectScope =
  globalThis[Symbol.for("ut-tdd.vitest.assertion-required.expect-scope")] ??=
    new AsyncLocalStorage();

export const expect = new Proxy(originalExpect, {
  get(target, key, receiver) {
    const scoped = testExpectScope.getStore();
    return scoped && Reflect.has(scoped, key)
      ? Reflect.get(scoped, key, scoped)
      : Reflect.get(target, key, receiver);
  },
  apply(target, thisArg, argumentsList) {
    return Reflect.apply(testExpectScope.getStore() ?? target, thisArg, argumentsList);
  },
});
