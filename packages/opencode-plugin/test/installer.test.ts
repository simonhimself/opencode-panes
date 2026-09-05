import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const installerPath = join(repositoryDirectory, "scripts/install-plugin.mjs");
let temporaryDirectory: string;

beforeAll(async () => {
  await exec(process.execPath, [join(packageDirectory, "build.mjs")], {
    cwd: packageDirectory,
  });
  temporaryDirectory = await mkdtemp(join(tmpdir(), "panes-installer-"));
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("standalone installer", () => {
  it("installs only JavaScript, atomically replaces it, and preserves unrelated configuration", async () => {
    const configHome = join(temporaryDirectory, "xdg");
    const config = join(configHome, "opencode/settings.json");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, '{"keep":true}\n');
    const environment = { XDG_CONFIG_HOME: configHome };
    await install(environment);
    const plugins = join(configHome, "opencode/plugins");
    const path = join(plugins, "opencode-panes.js");
    expect(await readdir(plugins)).toEqual(["opencode-panes.js"]);
    const source = await readFile(path, "utf8");
    expect(source).toBe(
      await readFile(join(packageDirectory, "dist/global.js"), "utf8"),
    );
    expect(source).not.toContain("simons.workers.dev");
    expect(source).not.toContain("react-compiler.wasm");
    expect(source).not.toContain(repositoryDirectory);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await writeFile(path, "old plugin");
    await install(environment);
    expect(await readFile(path, "utf8")).toBe(source);
    expect(await readdir(plugins)).toEqual(["opencode-panes.js"]);
    expect(await readFile(config, "utf8")).toBe('{"keep":true}\n');
  });

  it.each([
    "OPENCODE_PANES_PLUGIN_DIR",
    "OPENCODE_PANES_CONFIG_DIR",
    "OPENCODE_CONFIG_DIR",
  ])("supports %s without touching real global paths", async (variable) => {
    const target = join(temporaryDirectory, variable);
    await install({ [variable]: target });
    const plugins =
      variable === "OPENCODE_PANES_PLUGIN_DIR"
        ? target
        : join(target, "plugins");
    expect(await readdir(plugins)).toEqual(["opencode-panes.js"]);
  });

  it("builds one JS bundle and passes the isolated no-dependency upload smoke test", async () => {
    expect((await readdir(join(packageDirectory, "dist"))).sort()).toEqual([
      "global.js",
      "index.d.ts",
    ]);
    const result = await exec(
      process.execPath,
      [join(repositoryDirectory, "scripts/smoke-plugin.mjs")],
      { cwd: repositoryDirectory },
    );
    expect(result.stdout).toContain("Standalone plugin smoke passed");
  }, 15_000);
});

async function install(environment: Record<string, string>) {
  await exec(process.execPath, [installerPath], {
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      HOME: join(temporaryDirectory, "home"),
      XDG_CONFIG_HOME: join(temporaryDirectory, "default-config"),
      OPENCODE_PANES_PLUGIN_DIR: undefined,
      OPENCODE_PANES_CONFIG_DIR: undefined,
      OPENCODE_CONFIG_DIR: undefined,
      ...environment,
    },
  });
}
