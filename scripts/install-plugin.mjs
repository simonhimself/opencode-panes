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
const defaultCompilerWasmPath = join(
  repositoryDirectory,
  "packages/opencode-plugin/dist/react-compiler.wasm",
);
const pluginFileName = "opencode-panes.js";
const compilerWasmFileName = "react-compiler.wasm";

export async function installPlugin(environment = process.env) {
  const configDirectory = opencodeConfigDirectory(environment);
  const pluginDirectory = resolve(
    environment.OPENCODE_PANES_PLUGIN_DIR ?? join(configDirectory, "plugins"),
  );
  const destinationPath = join(pluginDirectory, pluginFileName);
  const source = await readFile(defaultSourcePath);
  const compilerWasm = await readFile(defaultCompilerWasmPath);
  const compilerWasmPath = join(pluginDirectory, compilerWasmFileName);

  await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    pluginDirectory,
    `.${pluginFileName}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await chmod(temporaryPath, 0o644);
    await rename(temporaryPath, destinationPath);
    await writeFile(compilerWasmPath, compilerWasm, {
      flag: "w",
      mode: 0o644,
    });
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return destinationPath;
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
