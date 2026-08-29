import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const packageDirectory = dirname(fileURLToPath(import.meta.url));
const typescriptDirectory = dirname(require.resolve("typescript/package.json"));

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [join(packageDirectory, "src/index.ts")],
  outfile: join(packageDirectory, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [
    "@opencode-ai/plugin",
    "dompurify",
    "esbuild",
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
  external: ["esbuild"],
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
