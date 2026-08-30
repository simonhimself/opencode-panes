import type { ArtifactType } from "@opencode-panes/contracts";
import { CodeArtifactRenderer } from "./code";
import { HtmlArtifactRenderer } from "./html";
import { MarkdownArtifactRenderer } from "./markdown";
import { MermaidArtifactRenderer } from "./mermaid";
import { ReactArtifactRenderer } from "./react";
import { SvgArtifactRenderer } from "./svg";

export interface ArtifactRendererProps {
  approvedOrigins?: readonly string[];
  onError?: ((error: string) => void) | undefined;
  source: string;
  type: ArtifactType;
}

export function ArtifactRenderer({
  approvedOrigins = [],
  onError,
  source,
  type,
}: ArtifactRendererProps) {
  switch (type) {
    case "html":
      return (
        <HtmlArtifactRenderer
          approvedOrigins={approvedOrigins}
          onError={onError}
          source={source}
        />
      );
    case "react":
      return (
        <ReactArtifactRenderer
          approvedOrigins={approvedOrigins}
          onError={onError}
          source={source}
        />
      );
    case "svg":
      return <SvgArtifactRenderer onError={onError} source={source} />;
    case "mermaid":
      return (
        <MermaidArtifactRenderer
          approvedOrigins={approvedOrigins}
          onError={onError}
          source={source}
        />
      );
    case "markdown":
      return <MarkdownArtifactRenderer enableGfm source={source} />;
    case "code":
      return <CodeArtifactRenderer source={source} />;
  }
}
