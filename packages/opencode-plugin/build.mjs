import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
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
  external: ["@opencode-ai/plugin"],
});
execFileSync(
  process.execPath,
  [
    join(typescriptDirectory, "bin/tsc"),
    "--project",
    join(packageDirectory, "tsconfig.build.json"),
  ],
  { stdio: "inherit" },
);
