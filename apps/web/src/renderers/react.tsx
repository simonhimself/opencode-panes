import { useEffect, useEffectEvent, useState } from "react";
import reactRuntimeSource from "virtual:panes-react-runtime";
import {
  SandboxedArtifactFrame,
  createErrorBridgeScript,
  createIsolatedDocument,
  createMessageNonce,
  escapeInlineScript,
  type RendererMessage,
} from "./iframe-security";
import { startReactCompilation } from "./react-compiler";

const REACT_START_TIMEOUT_MS = 3_000;

interface Preview {
  nonce: string;
  srcDoc: string;
}

export interface ReactArtifactRendererProps {
  onError?: ((error: string) => void) | undefined;
  source: string;
}

export function createReactSrcDoc(code: string, nonce: string): string {
  const bridge = escapeInlineScript(createErrorBridgeScript(nonce));
  const runtime = escapeInlineScript(reactRuntimeSource);
  const compiled = escapeInlineScript(code);
  return createIsolatedDocument(
    `<div id="root"></div><script>${bridge}</script><script>${runtime}</script><script>${compiled}</script><script>globalThis.__PANES_MOUNT__(globalThis.__PANES_COMPONENT__);</script>`,
    { allowScripts: true },
  );
}

export function ReactArtifactRenderer({
  onError,
  source,
}: ReactArtifactRendererProps) {
  const [preview, setPreview] = useState<Preview>();
  const [status, setStatus] = useState("Compiling React artifact...");
  const reportError = useEffectEvent((error: string) => onError?.(error));

  useEffect(() => {
    const task = startReactCompilation(source);
    setPreview(undefined);
    setStatus("Compiling React artifact...");

    void task.promise.then(
      (code) => {
        const nonce = createMessageNonce();
        setPreview({ nonce, srcDoc: createReactSrcDoc(code, nonce) });
        setStatus("Starting React artifact...");
      },
      (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message);
        reportError(message);
      },
    );

    return () => task.stop();
  }, [source]);

  useEffect(() => {
    if (!preview || status !== "Starting React artifact...") return;
    const timeout = window.setTimeout(() => {
      setPreview(undefined);
      setStatus(
        `React artifact did not start within ${REACT_START_TIMEOUT_MS}ms`,
      );
    }, REACT_START_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [preview, status]);

  const handleMessage = (message: RendererMessage) => {
    if (message.type === "ready") setStatus("React artifact running");
    else {
      const detail = message.stack
        ? `${message.message}\n\n${message.stack}`
        : message.message;
      setStatus(message.message);
      reportError(detail);
    }
  };

  return (
    <section data-renderer="react">
      <div role="status">{status}</div>
      {preview ? (
        <SandboxedArtifactFrame
          allowScripts
          nonce={preview.nonce}
          onMessage={handleMessage}
          srcDoc={preview.srcDoc}
          title="React artifact preview"
        />
      ) : null}
    </section>
  );
}
