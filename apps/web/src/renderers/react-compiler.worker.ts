import { build, initialize, type Message } from "esbuild-wasm";
import wasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { createReactBuildOptions } from "./react-build";

interface CompileRequest {
  id: string;
  source: string;
}

interface CompileResponse {
  id: string;
  code?: string;
  error?: string;
}

const initializeEsbuild = initialize({ wasmURL: wasmUrl, worker: false });

self.addEventListener(
  "message",
  async (event: MessageEvent<CompileRequest>) => {
    const { id, source } = event.data;
    const response: CompileResponse = { id };

    try {
      await initializeEsbuild;
      const result = await build(createReactBuildOptions(source));
      const output = result.outputFiles?.[0];
      if (!output) throw new Error("React compiler did not emit JavaScript");
      response.code = output.text;
    } catch (error) {
      response.error = formatCompileError(error);
    }

    self.postMessage(response);
  },
);

function formatCompileError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "errors" in error &&
    Array.isArray(error.errors)
  ) {
    const messages = (error.errors as Message[]).map(({ location, text }) =>
      location ? `${location.line}:${location.column + 1} ${text}` : text,
    );
    if (messages.length > 0) return messages.join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
