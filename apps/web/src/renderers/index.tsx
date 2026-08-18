import type { ArtifactType } from "@opencode-panes/contracts";
import { CodeArtifactRenderer } from "./code";
import { HtmlArtifactRenderer } from "./html";
import { MarkdownArtifactRenderer } from "./markdown";
import { MermaidArtifactRenderer } from "./mermaid";
import { ReactArtifactRenderer } from "./react";
import { SvgArtifactRenderer } from "./svg";

export interface ArtifactRendererProps {
  onError?: ((error: string) => void) | undefined;
  source: string;
  type: ArtifactType;
}

export function ArtifactRenderer({
  onError,
  source,
  type,
}: ArtifactRendererProps) {
  switch (type) {
    case "html":
      return <HtmlArtifactRenderer onError={onError} source={source} />;
    case "react":
      return <ReactArtifactRenderer onError={onError} source={source} />;
    case "svg":
      return <SvgArtifactRenderer onError={onError} source={source} />;
    case "mermaid":
      return <MermaidArtifactRenderer onError={onError} source={source} />;
    case "markdown":
      return <MarkdownArtifactRenderer source={source} />;
    case "code":
      return <CodeArtifactRenderer source={source} />;
  }
}
