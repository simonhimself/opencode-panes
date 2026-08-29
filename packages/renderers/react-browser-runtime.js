import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const runtimeEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "react-browser-runtime-entry.js",
);

export async function getReactBrowserRuntime() {
  const result = await build({
    bundle: true,
    entryPoints: [runtimeEntry],
    format: "iife",
    minify: true,
    platform: "browser",
    target: ["es2022"],
    write: false,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("React browser runtime bundle was not emitted");

  return {
    source: output.text,
    wasm: await readFile(require.resolve("esbuild-wasm/esbuild.wasm")),
  };
}
