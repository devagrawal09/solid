import {
  $cleanup,
  createMemo,
  createRoot,
  createSignal,
  flush,
  installBlockDriver,
  onSettled
} from "../src/index.js";

// This file never builds a block either (see
// generator-body-without-driver.test.ts): `installBlockDriver` — what the
// capability linker injects into a module the Solid compiler did not
// transform (blocks-v2-performance.md §11) — installs the driver by itself,
// so generator bodies handed to the hook hosts run on it.
describe("installBlockDriver", () => {
  it("runs generator bodies without any block constructor", () => {
    installBlockDriver();
    installBlockDriver(); // idempotent
    const [n, setN] = createSignal(2);
    const log: string[] = [];
    let doubled!: () => number;
    const dispose = createRoot(dispose => {
      doubled = createMemo(function* () {
        return ((yield* n) as number) * 2;
      } as any) as any;
      onSettled(function* () {
        log.push("settled");
        yield* $cleanup(() => log.push("cleanup"));
      } as any);
      return dispose;
    });
    flush();
    expect(doubled()).toBe(4);
    expect(log).toEqual(["settled"]);
    setN(5);
    flush();
    expect(doubled()).toBe(10);
    dispose();
    expect(log).toEqual(["settled", "cleanup"]);
  });
});
