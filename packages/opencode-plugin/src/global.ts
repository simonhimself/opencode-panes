import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { Plugin, PluginOptions } from "@opencode-ai/plugin";

import OpenCodePanesPlugin from "./index.js";

const PRODUCTION_API_BASE_URL = "https://opencode-panes.simons.workers.dev";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CREATION_KEY_FILE_NAME = "opencode-panes-create-key";

/**
 * Global entry point for the bundled local plugin.
 *
 * Defaults are deliberately here rather than in the package entry so local
 * development can continue to use its loopback API. Explicit plugin options
 * remain the final authority for users who need a different API or behavior.
 */
export const OpenCodePanesGlobalPlugin: Plugin = async (input, options) => {
  const resolvedOptions: PluginOptions = {
    apiBaseUrl:
      process.env.OPENCODE_PANES_API_BASE_URL ?? PRODUCTION_API_BASE_URL,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    ...options,
  };

  if (
    resolvedOptions.createApiKey === undefined &&
    process.env.OPENCODE_PANES_CREATE_API_KEY === undefined
  ) {
    const createApiKey = await readCreationKey();
    if (createApiKey) resolvedOptions.createApiKey = createApiKey;
  }

  return OpenCodePanesPlugin(input, resolvedOptions);
};

export default OpenCodePanesGlobalPlugin;

async function readCreationKey() {
  const configuredPath = process.env.OPENCODE_PANES_CREATE_API_KEY_FILE;
  const path = configuredPath
    ? isAbsolute(configuredPath)
      ? configuredPath
      : resolve(opencodeConfigDirectory(), configuredPath)
    : join(opencodeConfigDirectory(), "secrets", CREATION_KEY_FILE_NAME);

  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Could not read the Panes creation key at ${path}.`);
  }
}

function opencodeConfigDirectory() {
  const configuredDirectory =
    process.env.OPENCODE_PANES_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR;
  if (configuredDirectory) return resolve(configuredDirectory);

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "opencode");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
