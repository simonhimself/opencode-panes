import { useState } from "react";
import {
  SandboxedArtifactFrame,
  createErrorBridgeScript,
  createIsolatedDocument,
  createMessageNonce,
  escapeInlineScript,
  type RendererMessage,
} from "./iframe-security";

export interface HtmlArtifactRendererProps {
  onError?: ((error: string) => void) | undefined;
  source: string;
}

export function createHtmlSrcDoc(source: string, nonce: string): string {
  const bridge = escapeInlineScript(createErrorBridgeScript(nonce));
  return createIsolatedDocument(`<script>${bridge}</script>${source}`, {
    allowScripts: true,
  });
}

export function HtmlArtifactRenderer({
  onError,
  source,
}: HtmlArtifactRendererProps) {
  const [nonce] = useState(createMessageNonce);
  const [error, setError] = useState<string>();
  const srcDoc = createHtmlSrcDoc(source, nonce);
  const handleMessage = (message: RendererMessage) => {
    if (message.type === "error") {
      const detail = message.stack
        ? `${message.message}\n\n${message.stack}`
        : message.message;
      setError(detail);
      onError?.(detail);
    }
  };

  return (
    <section data-renderer="html">
      {error && !onError ? <pre role="alert">{error}</pre> : null}
      <SandboxedArtifactFrame
        allowScripts
        nonce={nonce}
        onMessage={handleMessage}
        srcDoc={srcDoc}
        title="HTML artifact preview"
      />
    </section>
  );
}
