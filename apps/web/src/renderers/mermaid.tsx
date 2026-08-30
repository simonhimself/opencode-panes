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

const MERMAID_CANVAS_HEAD =
  "<style data-panes-mermaid-canvas>:root{color-scheme:light}body{box-sizing:border-box;width:100vw;margin:0;padding:2rem;background:#f1f0ea;color:#1f211f;font:16px/1.5 system-ui,sans-serif}svg{display:block;width:100%;max-width:100%;height:auto;margin:0 auto}</style>";

const SAFE_MERMAID_PRESENTATION_ATTRIBUTES = new Set([
  "color",
  "fill",
  "fill-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
]);

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
          htmlLabels: false,
          securityLevel: "strict",
          startOnLoad: false,
        });
        const id = `panes-mermaid-${++renderSequence}`;
        const { svg } = await mermaid.render(id, source);
        if (!active) return;
        setSrcDoc(
          createIsolatedDocument(sanitizeMermaidSvg(svg), {
            allowScripts: false,
            approvedOrigins,
            head: MERMAID_CANVAS_HEAD,
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

function sanitizeMermaidSvg(source: string) {
  const document = new DOMParser().parseFromString(source, "text/html");
  const roots = document.querySelectorAll("svg");
  const root = roots.item(0);
  if (!root || roots.length !== 1) {
    throw new Error("Mermaid renderer did not produce one valid SVG root");
  }

  for (const row of root.querySelectorAll("tspan.text-outer-tspan")) {
    row.textContent = row.textContent ?? "";
  }

  // Mermaid emits presentation CSS. Convert only inert visual declarations to
  // SVG attributes so the shared sanitizer can still remove all CSS and code.
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const style = element.getAttribute("style");
    if (style) {
      for (const declaration of style.split(";")) {
        const separator = declaration.indexOf(":");
        if (separator < 1) continue;
        const property = declaration.slice(0, separator).trim().toLowerCase();
        const value = declaration
          .slice(separator + 1)
          .replace(/\s*!important\s*$/iu, "")
          .trim();
        if (
          SAFE_MERMAID_PRESENTATION_ATTRIBUTES.has(property) &&
          isSafeMermaidPresentationValue(value)
        ) {
          element.setAttribute(property, value);
        }
      }
      element.removeAttribute("style");
    }
  }

  for (const style of document.querySelectorAll("style")) style.remove();
  applyMermaidPresentationFallbacks(root);
  root.setAttribute("data-panes-mermaid-canvas", "");
  return sanitizeSvg(new XMLSerializer().serializeToString(root));
}

function isSafeMermaidPresentationValue(value: string) {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    /^[#(),.%\w\s+-]+$/u.test(value) &&
    !/(?:data|expression|javascript|url)\s*\(/iu.test(value)
  );
}

function applyMermaidPresentationFallbacks(root: Element) {
  for (const shape of root.querySelectorAll(
    ".node rect, .node circle, .node ellipse, .node polygon",
  )) {
    if (!shape.hasAttribute("fill")) shape.setAttribute("fill", "#f4eedc");
    if (!shape.hasAttribute("stroke")) shape.setAttribute("stroke", "#171717");
  }
  for (const text of root.querySelectorAll("text")) {
    if (!text.hasAttribute("fill")) text.setAttribute("fill", "#171717");
  }
  for (const text of root.querySelectorAll(".node .label text")) {
    if (!text.hasAttribute("text-anchor")) {
      text.setAttribute("text-anchor", "middle");
    }
  }
  for (const path of root.querySelectorAll(
    ".edgePath path, path.flowchart-link",
  )) {
    if (!path.hasAttribute("fill")) path.setAttribute("fill", "none");
    if (!path.hasAttribute("stroke")) path.setAttribute("stroke", "#171717");
  }
  for (const marker of root.querySelectorAll("marker path")) {
    if (!marker.hasAttribute("fill")) marker.setAttribute("fill", "#171717");
    if (!marker.hasAttribute("stroke"))
      marker.setAttribute("stroke", "#171717");
  }
}
