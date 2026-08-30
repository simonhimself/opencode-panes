import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = pathToFileURL(
  resolve("packages/opencode-plugin/dist/index.js"),
).href;
const pluginModule = await import(entry);
const plugin = pluginModule.default;

assert.equal(typeof plugin, "function", "built package must export a plugin");

const hooks = await plugin(
  {},
  {
    apiBaseUrl: "http://127.0.0.1:5173",
    autoOpen: false,
    createApiKey: "smoke-check-only",
  },
);
const prepare = hooks.tool?.artifact_prepare;
const finalize = hooks.tool?.artifact_finalize;
const sync = hooks.tool?.artifact_sync;
const adoptLegacy = hooks.tool?.artifact_adopt_legacy;

assert.equal(
  hooks.tool?.artifact,
  undefined,
  "legacy artifact tool must be removed",
);
assert.ok(prepare, "plugin must register the artifact_prepare tool");
assert.equal(typeof prepare.description, "string");
assert.equal(typeof prepare.execute, "function");
assert.ok(finalize, "plugin must register the artifact_finalize tool");
assert.equal(typeof finalize.execute, "function");
assert.ok(sync, "plugin must register the artifact_sync tool");
assert.equal(typeof sync.execute, "function");
assert.ok(adoptLegacy, "plugin must register the artifact_adopt_legacy tool");
assert.equal(typeof adoptLegacy.execute, "function");

console.log("Built plugin smoke check passed: local-first tools registered.");

const globalEntry = pathToFileURL(
  resolve("packages/opencode-plugin/dist/global.js"),
).href;
const globalPluginModule = await import(`${globalEntry}?smoke`);
const globalPlugin = globalPluginModule.default;
assert.equal(
  typeof globalPlugin,
  "function",
  "global plugin must export a plugin",
);
const globalHooks = await globalPlugin(
  {},
  {
    apiBaseUrl: "http://127.0.0.1:5173",
    autoOpen: false,
    requestTimeoutMs: 15000,
    createApiKey: "smoke-check-only",
  },
);
assert.equal(globalHooks.tool?.artifact, undefined);
assert.equal(typeof globalHooks.tool?.artifact_prepare?.execute, "function");
console.log(
  "Bundled global plugin smoke check passed: local-first tools registered.",
);

const isolatedDirectory = await mkdtemp(
  join(tmpdir(), "opencode-panes-smoke-"),
);
try {
  const isolatedPluginPath = join(isolatedDirectory, "plugin.js");
  await cp(
    resolve("packages/opencode-plugin/dist/global.js"),
    isolatedPluginPath,
  );
  await cp(
    resolve("packages/opencode-plugin/dist/react-compiler.wasm"),
    join(isolatedDirectory, "react-compiler.wasm"),
  );
  const isolatedModule = await import(
    `${pathToFileURL(isolatedPluginPath).href}?isolated`
  );
  const isolatedHooks = await isolatedModule.default(
    {},
    {
      apiBaseUrl: "http://127.0.0.1:5173",
      autoOpen: false,
      requestTimeoutMs: 15000,
      createApiKey: "smoke-check-only",
    },
  );
  const context = {
    sessionID: "isolated-smoke",
    messageID: "isolated-smoke",
    agent: "build",
    directory: isolatedDirectory,
    worktree: isolatedDirectory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  };
  const prepare = await isolatedHooks.tool.artifact_prepare.execute(
    { title: "Isolated React" },
    context,
  );
  const draftPath = toolMetadata(prepare).draftPath;
  await writeFile(
    join(draftPath, "App.tsx"),
    'throw new Error("React artifact must run in the browser"); export default function App() { return <button>Ready</button>; }',
  );
  const finalized = await isolatedHooks.tool.artifact_finalize.execute(
    {
      artifactId: toolMetadata(prepare).artifactId,
      entryPath: "App.tsx",
      adapter: "renderer",
      renderer: "react",
    },
    context,
  );
  assert.equal(toolMetadata(finalized).operation, "finalized");
  console.log(
    "Isolated global plugin smoke check passed: no repository dependencies required.",
  );
} finally {
  await rm(isolatedDirectory, { recursive: true, force: true });
}

function toolMetadata(result) {
  assert.ok(result && typeof result === "object" && result.metadata);
  return result.metadata;
}
