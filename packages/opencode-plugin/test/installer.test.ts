import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const buildPath = join(packageDirectory, "build.mjs");
const installerPath = join(repositoryDirectory, "scripts/install-plugin.mjs");
const builtPluginPath = join(packageDirectory, "dist/global.js");
const repositoryPath = `${repositoryDirectory}/`;

let temporaryDirectory: string;

beforeAll(async () => {
  await execFileAsync(process.execPath, [buildPath], {
    cwd: packageDirectory,
  });
  temporaryDirectory = await mkdtemp(join(tmpdir(), "opencode-panes-install-"));
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("global plugin installer", () => {
  it("installs under XDG_CONFIG_HOME without changing unrelated files", async () => {
    const xdgConfigHome = join(temporaryDirectory, "xdg");
    const unrelatedPath = join(xdgConfigHome, "opencode", "settings.json");
    await mkdirForFile(unrelatedPath, '{"keep":true}\n');

    await runInstaller({
      XDG_CONFIG_HOME: xdgConfigHome,
      HOME: join(temporaryDirectory, "home"),
    });

    const installedPath = join(
      xdgConfigHome,
      "opencode/plugins/opencode-panes.js",
    );
    expect(await readFile(installedPath, "utf8")).toContain(
      "opencode-panes.simons.workers.dev",
    );
    expect(await readFile(unrelatedPath, "utf8")).toBe('{"keep":true}\n');
    expect((await stat(installedPath)).isFile()).toBe(true);
    expect(
      (
        await stat(join(xdgConfigHome, "opencode/plugins/react-compiler.wasm"))
      ).isFile(),
    ).toBe(true);
  });

  it("supports an explicit plugin directory override", async () => {
    const pluginDirectory = join(temporaryDirectory, "custom-plugins");
    await runInstaller({ OPENCODE_PANES_PLUGIN_DIR: pluginDirectory });

    expect(
      await stat(join(pluginDirectory, "opencode-panes.js")),
    ).toMatchObject({ isFile: expect.any(Function) });
  });

  it("produces an isolated bundled module with no repository or package imports", async () => {
    const source = await readFile(builtPluginPath, "utf8");
    expect(source).not.toContain(repositoryPath);
    expect(source).not.toMatch(
      /(?:from|import\s*\()["'](?!node:)[^./][^"']*["']/,
    );
    expect(source).not.toContain("sourceMappingURL");

    const isolatedPath = join(temporaryDirectory, "isolated/opencode-panes.js");
    await mkdirForFile(isolatedPath, source);
    const inheritedEnvironment = removeEnvironmentVariables([
      "OPENCODE_PANES_CONFIG_DIR",
      "OPENCODE_PANES_CREATE_API_KEY",
      "OPENCODE_PANES_CREATE_API_KEY_FILE",
    ]);
    vi.stubEnv(
      "OPENCODE_PANES_CONFIG_DIR",
      join(temporaryDirectory, "isolated-config"),
    );

    const { module, hooks } = await (async () => {
      try {
        const module = await import(
          `${pathToFileURL(isolatedPath).href}?isolated`
        );
        return { module, hooks: await module.default({}) };
      } finally {
        vi.unstubAllEnvs();
        restoreEnvironmentVariables(inheritedEnvironment);
      }
    })();

    expect(typeof module.default).toBe("function");
    expect(typeof hooks.tool?.artifact_prepare?.execute).toBe("function");
    expect(typeof hooks.tool?.artifact_finalize?.execute).toBe("function");
    expect(typeof hooks.tool?.artifact_sync?.execute).toBe("function");
    expect(typeof hooks.tool?.artifact_adopt_legacy?.execute).toBe("function");
  }, 15_000);

  it("uses the global production defaults for local-first preparation", async () => {
    const configDirectory = join(temporaryDirectory, "runtime-config");
    const inheritedEnvironment = removeEnvironmentVariables([
      "OPENCODE_PANES_API_BASE_URL",
      "XDG_STATE_HOME",
    ]);
    const installedPath = join(configDirectory, "plugins/opencode-panes.js");
    await runInstaller({ OPENCODE_PANES_CONFIG_DIR: configDirectory });

    const fetchMock = vi.fn<typeof fetch>();
    vi.stubEnv("OPENCODE_PANES_CONFIG_DIR", configDirectory);
    vi.stubEnv("XDG_STATE_HOME", join(temporaryDirectory, "runtime-state"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const module = await import(
        `${pathToFileURL(installedPath).href}?runtime`
      );
      const hooks = await module.default({});
      const result = await hooks.tool?.artifact_prepare?.execute(
        { title: "Example", requestedOrigins: [] },
        {
          sessionID: "session-1",
          messageID: "message-1",
          agent: "build",
          directory: configDirectory,
          worktree: configDirectory,
          abort: new AbortController().signal,
          metadata: () => undefined,
          ask: vi.fn().mockResolvedValue(undefined),
        },
      );
      expect(result).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      restoreEnvironmentVariables(inheritedEnvironment);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  }, 15_000);
});

async function runInstaller(environment: Record<string, string>) {
  await execFileAsync(process.execPath, [installerPath], {
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      OPENCODE_PANES_CONFIG_DIR: undefined,
      OPENCODE_CONFIG_DIR: undefined,
      ...environment,
    },
  });
}

async function mkdirForFile(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function removeEnvironmentVariables(names: string[]) {
  const inherited: Record<string, string | undefined> = {};
  for (const name of names) {
    inherited[name] = process.env[name];
    delete process.env[name];
  }
  return inherited;
}

function restoreEnvironmentVariables(
  inherited: Record<string, string | undefined>,
) {
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
