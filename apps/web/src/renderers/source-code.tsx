import type { ArtifactType } from "@opencode-panes/contracts";

type SyntaxKind =
  | "attribute"
  | "comment"
  | "emphasis"
  | "entity"
  | "heading"
  | "keyword"
  | "number"
  | "operator"
  | "string"
  | "tag";

export interface SourceToken {
  kind?: SyntaxKind;
  value: string;
}

interface TokenRules {
  kinds: readonly SyntaxKind[];
  pattern: RegExp;
}

const MARKUP_RULES: TokenRules = {
  pattern:
    /(<!--[\s\S]*?-->|<!DOCTYPE\b[^>]*>)|(<\/?\s*[A-Za-z][\w:.-]*)|(\b[A-Za-z_:][\w:.-]*(?=\s*=))|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(&(?:#\d+|#x[\da-f]+|\w+);)|([=<>/]+)/gi,
  kinds: ["comment", "tag", "attribute", "string", "entity", "operator"],
};

const CODE_RULES: TokenRules = {
  pattern:
    /(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(<\/?[A-Za-z][\w:.-]*)|(\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|new|null|of|return|switch|throw|true|try|type|typeof|undefined|var|void|while|yield)\b)|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|(=>|===?|!==?|\?\?|\?\.|&&|\|\||[+\-*%{}()[\].,:;<>])/gi,
  kinds: ["comment", "string", "tag", "keyword", "number", "operator"],
};

const MARKDOWN_RULES: TokenRules = {
  pattern:
    /(<!--[\s\S]*?-->)|(^#{1,6}\s+[^\r\n]*|^>\s?[^\r\n]*)|(^\s*```[^\r\n]*|^\s*~~~[^\r\n]*|`[^`\r\n]+`)|(\[[^\]\r\n]+\]\([^)\r\n]+\))|(\*\*[^*\r\n]+\*\*|__[^_\r\n]+__)|(^\s*(?:[-*+]|\d+\.)\s+)/gm,
  kinds: ["comment", "heading", "keyword", "string", "emphasis", "operator"],
};

const MERMAID_RULES: TokenRules = {
  pattern:
    /(%%[^\r\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b(?:classDiagram|erDiagram|flowchart|gantt|gitGraph|graph|journey|mindmap|pie|quadrantChart|requirementDiagram|sequenceDiagram|stateDiagram(?:-v2)?|subgraph|timeline|title|end)\b)|(<?[-=.]+(?:>|\|)|--[ox])|(\b\d+(?:\.\d+)?\b)|([{}()[\]:;])/gi,
  kinds: ["comment", "string", "keyword", "operator", "number", "operator"],
};

export function tokenizeSource(
  source: string,
  type: ArtifactType,
): SourceToken[] {
  const rules = rulesFor(type);
  const tokens: SourceToken[] = [];
  let cursor = 0;

  for (const match of source.matchAll(rules.pattern)) {
    const start = match.index;
    if (start > cursor)
      pushToken(tokens, { value: source.slice(cursor, start) });

    const captureIndex = match
      .slice(1)
      .findIndex((capture) => capture !== undefined);
    const kind = rules.kinds[captureIndex];
    pushToken(tokens, kind ? { kind, value: match[0] } : { value: match[0] });
    cursor = start + match[0].length;
  }

  if (cursor < source.length)
    pushToken(tokens, { value: source.slice(cursor) });
  return tokens;
}

export function SourceCode({
  renderer,
  source,
  type,
}: {
  renderer?: "code";
  source: string;
  type: ArtifactType;
}) {
  const tokens = tokenizeSource(source, type);

  return (
    <pre
      className="source-code"
      data-language={type}
      {...(renderer ? { "data-renderer": renderer } : {})}
    >
      <code>
        {tokens.map((token, index) =>
          token.kind ? (
            <span className={`syntax-${token.kind}`} key={index}>
              {token.value}
            </span>
          ) : (
            token.value
          ),
        )}
      </code>
    </pre>
  );
}

function rulesFor(type: ArtifactType): TokenRules {
  if (type === "html" || type === "svg") return MARKUP_RULES;
  if (type === "markdown") return MARKDOWN_RULES;
  if (type === "mermaid") return MERMAID_RULES;
  return CODE_RULES;
}

function pushToken(tokens: SourceToken[], token: SourceToken): void {
  const previous = tokens.at(-1);
  if (previous && previous.kind === token.kind) {
    previous.value += token.value;
    return;
  }
  tokens.push(token);
}
