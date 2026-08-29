import { JSDOM } from "jsdom";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { describe, expect, it } from "vitest";
import { createReactSrcDoc } from "../../src/renderers/react";
import { createReactBuildOptions } from "../../src/renderers/react-build";

describe("React browser runtime", () => {
  it("updates visible state after a click inside the sandboxed document", async () => {
    const originalTextEncoder = globalThis.TextEncoder;
    const originalUint8Array = globalThis.Uint8Array;
    let dom: JSDOM | undefined;
    try {
      globalThis.TextEncoder = NodeTextEncoder;
      globalThis.Uint8Array = new NodeTextEncoder().encode("")
        .constructor as typeof Uint8Array;
      const { build } = await import("esbuild");
      const result = await build(
        createReactBuildOptions(`
          import React, { useState } from "react";

          export default function Counter() {
            const [count, setCount] = useState(0);
            return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
          }
        `) as Parameters<typeof build>[0],
      );
      const compiled = result.outputFiles?.[0]?.text;
      if (!compiled) throw new Error("React compiler did not emit JavaScript");

      dom = new JSDOM(createReactSrcDoc(compiled, "test-nonce"), {
        runScripts: "dangerously",
        url: "http://127.0.0.1/preview/test",
      });
      await waitForRender();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const button = dom.window.document.querySelector("button");
      expect(button?.textContent).toBe("Count: 0");

      button?.click();
      await waitForRender();

      expect(button?.textContent).toBe("Count: 1");
    } finally {
      dom?.window.close();
      globalThis.TextEncoder = originalTextEncoder;
      globalThis.Uint8Array = originalUint8Array;
    }
  });
});

function waitForRender() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
