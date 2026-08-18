import DOMPurify from "dompurify";
import { useEffect, useEffectEvent, useState } from "react";
import {
  SandboxedArtifactFrame,
  createIsolatedDocument,
} from "./iframe-security";

const FORBIDDEN_SVG_TAGS = [
  "script",
  "style",
  "foreignObject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
] as const;

export interface SvgArtifactRendererProps {
  onError?: ((error: string) => void) | undefined;
  source: string;
}

export function sanitizeSvg(source: string): string {
  const clean = String(
    DOMPurify.sanitize(source, {
      FORBID_ATTR: ["style"],
      FORBID_TAGS: [...FORBIDDEN_SVG_TAGS],
      RETURN_TRUSTED_TYPE: false,
      USE_PROFILES: { svg: true, svgFilters: true },
    }),
  );
  const document = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error("Artifact source must contain one valid SVG root");
  }

  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "style" || name === "src") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        (name === "href" || name === "xlink:href") &&
        !value.startsWith("#")
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        /(?:javascript:|data:|@import)/i.test(value) ||
        (/url\s*\(/i.test(value) &&
          !/^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return new XMLSerializer().serializeToString(root);
}

export function createSvgSrcDoc(source: string): string {
  return createIsolatedDocument(sanitizeSvg(source), { allowScripts: false });
}

export function SvgArtifactRenderer({
  onError,
  source,
}: SvgArtifactRendererProps) {
  const [srcDoc, setSrcDoc] = useState<string>();
  const [error, setError] = useState<string>();
  const reportError = useEffectEvent((message: string) => onError?.(message));

  useEffect(() => {
    try {
      setSrcDoc(createSvgSrcDoc(source));
      setError(undefined);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setSrcDoc(undefined);
      setError(message);
      reportError(message);
    }
  }, [source]);

  return (
    <section data-renderer="svg">
      {error && !onError ? <pre role="alert">{error}</pre> : null}
      {srcDoc ? (
        <SandboxedArtifactFrame
          allowScripts={false}
          srcDoc={srcDoc}
          title="SVG artifact preview"
        />
      ) : null}
    </section>
  );
}
