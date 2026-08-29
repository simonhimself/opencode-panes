import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const packageDirectory = dirname(fileURLToPath(import.meta.url));
const typescriptDirectory = dirname(require.resolve("typescript/package.json"));
const rendererDirectory = join(packageDirectory, "../renderers");

const browserRuntimeBuild = await build({
  entryPoints: [join(rendererDirectory, "react-browser-runtime-entry.js")],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: ["es2022"],
  write: false,
});
const browserRuntimeOutput = browserRuntimeBuild.outputFiles?.[0];
if (!browserRuntimeOutput)
  throw new Error("React browser runtime bundle was not emitted");
const compilerWasmPath = require.resolve("esbuild-wasm/esbuild.wasm");
const compilerWasm = await readFile(compilerWasmPath);
const embeddedRuntimePlugin = {
  name: "panes-embedded-react-browser-runtime",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^@opencode-panes\/renderers\/react-browser-runtime$/ },
      () => ({ namespace: "panes-runtime", path: "runtime" }),
    );
    pluginBuild.onLoad(
      { filter: /^runtime$/, namespace: "panes-runtime" },
      () => ({
        contents: `import{readFile}from"node:fs/promises";export async function getReactBrowserRuntime(){return{source:${JSON.stringify(browserRuntimeOutput.text)},wasm:await readFile(new URL("./react-compiler.wasm",import.meta.url))}}`,
        loader: "js",
      }),
    );
  },
};

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await mkdir(join(packageDirectory, "dist"), { recursive: true });
await writeFile(
  join(packageDirectory, "dist/react-compiler.wasm"),
  compilerWasm,
);
await build({
  entryPoints: [join(packageDirectory, "src/index.ts")],
  outfile: join(packageDirectory, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [embeddedRuntimePlugin],
  external: [
    "@opencode-ai/plugin",
    "dompurify",
    "linkedom",
    "mermaid",
    "react",
    "react-dom",
    "react-dom/server",
    "react-markdown",
    "remark-gfm",
  ],
});
const globalBuild = await build({
  entryPoints: [join(packageDirectory, "src/global.ts")],
  outfile: join(packageDirectory, "dist/global.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: true,
  plugins: [embeddedRuntimePlugin],
  write: false,
});
const globalOutput = globalBuild.outputFiles[0];
if (!globalOutput) throw new Error("Global plugin bundle was not emitted");
await writeFile(
  join(packageDirectory, "dist/global.js"),
  `import{createRequire as __panesCreateRequire}from"node:module";const require=__panesCreateRequire(import.meta.url);\n${globalOutput.text.replace(/from"(?!node:)/g, 'fr\\u006fm"')}`,
);
execFileSync(
  process.execPath,
  [
    join(typescriptDirectory, "bin/tsc"),
    "--project",
    join(packageDirectory, "tsconfig.build.json"),
  ],
  { stdio: "inherit" },
);
