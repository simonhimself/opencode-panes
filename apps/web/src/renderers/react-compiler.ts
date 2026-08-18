import { MAX_ARTIFACT_SOURCE_BYTES } from "@opencode-panes/contracts";

interface CompileResponse {
  id: string;
  code?: string;
  error?: string;
}

export interface ReactCompilationTask {
  promise: Promise<string>;
  stop: () => void;
}

export const DEFAULT_REACT_COMPILE_TIMEOUT_MS = 8_000;

export function startReactCompilation(
  source: string,
  timeoutMs = DEFAULT_REACT_COMPILE_TIMEOUT_MS,
): ReactCompilationTask {
  let worker: Worker | undefined;
  let rejectTask: ((error: Error) => void) | undefined;
  let settled = false;
  const byteLength = new TextEncoder().encode(source).byteLength;

  const promise = new Promise<string>((resolve, reject) => {
    rejectTask = reject;
    if (byteLength > MAX_ARTIFACT_SOURCE_BYTES) {
      settled = true;
      reject(
        new Error(
          `React artifact source exceeds ${MAX_ARTIFACT_SOURCE_BYTES} UTF-8 bytes`,
        ),
      );
      return;
    }

    const id = crypto.randomUUID();
    worker = new Worker(
      new URL("./react-compiler.worker.ts", import.meta.url),
      {
        name: "panes-react-compiler",
        type: "module",
      },
    );
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      reject(new Error(`React compilation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.addEventListener(
      "message",
      (event: MessageEvent<CompileResponse>) => {
        if (settled || event.data.id !== id) return;
        settled = true;
        window.clearTimeout(timeout);
        worker?.terminate();
        if (event.data.error) reject(new Error(event.data.error));
        else if (event.data.code) resolve(event.data.code);
        else reject(new Error("React compiler returned an empty result"));
      },
    );
    worker.addEventListener("error", (event) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      worker?.terminate();
      reject(new Error(event.message || "React compiler worker failed"));
    });
    worker.postMessage({ id, source });
  });

  return {
    promise,
    stop() {
      if (settled) return;
      settled = true;
      worker?.terminate();
      const error = new Error("React compilation stopped");
      error.name = "AbortError";
      rejectTask?.(error);
    },
  };
}
