import { describe, expect, it, vi } from "vitest";
import { startReactCompilation } from "../../src/renderers/react-compiler";

describe("React compiler local-first input bound", () => {
  it("does not reject an entry just over the removed Legacy 1 MiB cap", async () => {
    const postMessage = vi.fn();
    class TestWorker {
      addEventListener(
        event: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        if (event === "message") {
          queueMicrotask(() =>
            (listener as (event: MessageEvent) => void)({
              data: { id: "compiler-test", code: "compiled" },
            } as MessageEvent),
          );
        }
      }

      postMessage(value: unknown) {
        postMessage(value);
      }

      terminate() {}
    }
    vi.stubGlobal("crypto", { randomUUID: () => "compiler-test" });
    vi.stubGlobal("Worker", TestWorker);

    try {
      const task = startReactCompilation("x".repeat(1024 * 1024 + 1));
      await expect(task.promise).resolves.toBe("compiled");
      expect(postMessage).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
