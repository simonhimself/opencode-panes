import { useEffect, useEffectEvent, useState } from "react";
import {
  SandboxedArtifactFrame,
  createIsolatedDocument,
} from "./iframe-security";
import { sanitizeSvg } from "./svg";

export interface MermaidArtifactRendererProps {
  approvedOrigins?: readonly string[];
  onError?: ((error: string) => void) | undefined;
  source: string;
}

let renderSequence = 0;

export function MermaidArtifactRenderer({
  approvedOrigins = [],
  onError,
  source,
}: MermaidArtifactRendererProps) {
  const [srcDoc, setSrcDoc] = useState<string>();
  const [error, setError] = useState<string>();
  const reportError = useEffectEvent((message: string) => onError?.(message));

  useEffect(() => {
    let active = true;
    const render = async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          flowchart: { htmlLabels: false },
          securityLevel: "strict",
          startOnLoad: false,
        });
        const id = `panes-mermaid-${++renderSequence}`;
        const { svg } = await mermaid.render(id, source);
        if (!active) return;
        setSrcDoc(
          createIsolatedDocument(sanitizeSvg(svg), {
            allowScripts: false,
            approvedOrigins,
          }),
        );
        setError(undefined);
      } catch (caught) {
        if (!active) return;
        const message =
          caught instanceof Error ? caught.message : String(caught);
        setSrcDoc(undefined);
        setError(message);
        reportError(message);
      }
    };

    void render();
    return () => {
      active = false;
    };
  }, [approvedOrigins, source]);

  return (
    <section data-renderer="mermaid">
      {error && !onError ? <pre role="alert">{error}</pre> : null}
      {srcDoc ? (
        <SandboxedArtifactFrame
          allowScripts
          srcDoc={srcDoc}
          title="Mermaid artifact preview"
        />
      ) : null}
    </section>
  );
}
