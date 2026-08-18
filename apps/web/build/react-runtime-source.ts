import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const VIRTUAL_MODULE_ID = "virtual:panes-react-runtime";
const RESOLVED_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;
const entryPoint = fileURLToPath(
  new URL("../src/renderers/react-runtime-entry.ts", import.meta.url),
);

export function reactRuntimeSource(): Plugin {
  return {
    name: "panes-react-runtime-source",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_MODULE_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_MODULE_ID) return null;

      const result = await build({
        entryPoints: [entryPoint],
        bundle: true,
        define: { "process.env.NODE_ENV": '"production"' },
        format: "iife",
        minify: true,
        platform: "browser",
        target: ["es2022"],
        write: false,
      });
      const output = result.outputFiles[0];
      if (!output)
        throw new Error("React iframe runtime bundle was not emitted");

      return `export default ${JSON.stringify(output.text)};`;
    },
  };
}
