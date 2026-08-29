import * as React from "react";
import { createRoot } from "react-dom/client";
import { build, initialize } from "esbuild-wasm";
import { createReactBuildOptions } from "./react-build.js";

const runtime = globalThis;
const source = runtime.__PANES_REACT_SOURCE__;
const wasmBase64 = runtime.__PANES_WASM_BASE64__;

Object.defineProperty(runtime, "__PANES_REACT__", {
  configurable: false,
  value: Object.freeze({ ...React }),
  writable: false,
});

async function start() {
  if (typeof source !== "string") {
    throw new Error("React artifact source was not provided");
  }
  if (typeof wasmBase64 !== "string") {
    throw new Error("React compiler WASM bytes were not provided");
  }

  const wasmBytes = Uint8Array.from(atob(wasmBase64), (character) =>
    character.charCodeAt(0),
  );
  const wasmModule = await WebAssembly.compile(wasmBytes);
  await initialize({ wasmModule, worker: false });
  const result = await build(createReactBuildOptions(source));
  const compiled = result.outputFiles?.[0]?.text;
  if (!compiled) throw new Error("React compiler did not emit JavaScript");

  const compiledScript = document.createElement("script");
  compiledScript.textContent = compiled;
  document.head.append(compiledScript);
  const component = runtime.__PANES_COMPONENT__;
  if (typeof component !== "function") {
    throw new Error("React compiler did not produce a component");
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("React artifact root was not found");
  createRoot(rootElement).render(React.createElement(component));
  runtime.__PANES_READY__?.();
}

void start().catch((error) => {
  queueMicrotask(() => {
    throw error;
  });
});
