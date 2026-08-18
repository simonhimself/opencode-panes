export interface CodeArtifactRendererProps {
  source: string;
}

export function CodeArtifactRenderer({ source }: CodeArtifactRendererProps) {
  return (
    <pre data-renderer="code">
      <code>{source}</code>
    </pre>
  );
}
