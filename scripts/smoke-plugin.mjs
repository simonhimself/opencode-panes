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
