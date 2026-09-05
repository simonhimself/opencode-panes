import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const packageDirectory = dirname(fileURLToPath(import.meta.url));
await rm(join(packageDirectory, "dist"), { recursive: true, force: true });
await mkdir(join(packageDirectory, "dist"), { recursive: true });
// A single standalone ESM file, including the SDK tool helper and contract schemas.
await build({
  entryPoints: [join(packageDirectory, "src/index.ts")],
  outfile: join(packageDirectory, "dist/global.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
});
execFileSync(
  process.execPath,
  [
    join(dirname(require.resolve("typescript/package.json")), "bin/tsc"),
    "--project",
    join(packageDirectory, "tsconfig.build.json"),
  ],
  { stdio: "inherit" },
);
