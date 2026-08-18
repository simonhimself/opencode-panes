import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownArtifactRendererProps {
  enableGfm?: boolean;
  source: string;
}

const GFM_PLUGINS = [remarkGfm];
const NO_PLUGINS: [] = [];
const MARKDOWN_COMPONENTS: Components = {
  a({ children }) {
    return <span>{children}</span>;
  },
  img({ alt, src }) {
    if (
      typeof src === "string" &&
      /^data:image\/(?:gif|jpeg|png|webp);base64,/i.test(src)
    ) {
      return <img alt={alt ?? ""} src={src} />;
    }
    return <span>{alt ?? "Image blocked"}</span>;
  },
};

export function MarkdownArtifactRenderer({
  enableGfm = false,
  source,
}: MarkdownArtifactRendererProps) {
  return (
    <article data-renderer="markdown">
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={enableGfm ? GFM_PLUGINS : NO_PLUGINS}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}
