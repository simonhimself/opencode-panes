import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = dirname(scriptsDirectory);
const defaultSourcePath = join(
  repositoryDirectory,
  "packages/opencode-plugin/dist/global.js",
);
const pluginFileName = "opencode-panes.js";

const packageManifest = `${JSON.stringify(
  {
    name: "opencode-panes",
    private: true,
    type: "module",
    exports: "./index.js",
  },
  null,
  2,
)}\n`;

export async function installPlugin(environment = process.env) {
  const source = await readFile(defaultSourcePath);
  // Configured plugin entries (with options) must be package directories;
  // auto-discovered plugins/ entries can be a single file.
  const packageDirectory = environment.OPENCODE_PANES_PACKAGE_DIR;
  if (packageDirectory) {
    if (environment.OPENCODE_PANES_PLUGIN_DIR)
      throw new Error(
        "Set OPENCODE_PANES_PACKAGE_DIR or OPENCODE_PANES_PLUGIN_DIR, not both.",
      );
    const destination = resolve(packageDirectory);
    await writeAtomically(destination, "package.json", packageManifest);
    await writeAtomically(destination, "index.js", source);
    return destination;
  }

  const configDirectory = opencodeConfigDirectory(environment);
  const pluginDirectory = resolve(
    environment.OPENCODE_PANES_PLUGIN_DIR ?? join(configDirectory, "plugins"),
  );
  await writeAtomically(pluginDirectory, pluginFileName, source);
  return join(pluginDirectory, pluginFileName);
}

async function writeAtomically(directory, fileName, contents) {
  const destinationPath = join(directory, fileName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await chmod(temporaryPath, 0o644);
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function opencodeConfigDirectory(environment) {
  const configuredDirectory =
    environment.OPENCODE_PANES_CONFIG_DIR ?? environment.OPENCODE_CONFIG_DIR;
  if (configuredDirectory) return resolve(configuredDirectory);

  const configHome =
    environment.XDG_CONFIG_HOME ??
    join(environment.HOME ?? homedir(), ".config");
  return join(configHome, "opencode");
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  const destinationPath = await installPlugin();
  process.stdout.write(
    `Installed OpenCode Panes plugin to ${destinationPath}\n`,
  );
}
