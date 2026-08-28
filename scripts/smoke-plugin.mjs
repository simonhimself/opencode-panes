import assert from "node:assert/strict";
import { resolve } from "node:path";
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
const artifact = hooks.tool?.artifact;

assert.ok(artifact, "plugin must register the artifact tool");
assert.equal(typeof artifact.description, "string");
assert.equal(typeof artifact.execute, "function");
assert.deepEqual(Object.keys(artifact.args).sort(), [
  "artifactId",
  "source",
  "title",
  "type",
]);

console.log("Built plugin smoke check passed: artifact tool registered.");

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
assert.equal(typeof globalHooks.tool?.artifact?.execute, "function");
console.log(
  "Bundled global plugin smoke check passed: artifact tool registered.",
);
