import { useEffect, useEffectEvent, useRef } from "react";
import { createArtifactEgressGuardScript } from "@opencode-panes/renderers/iframe-security";
import { createArtifactNetworkPolicy } from "@opencode-panes/renderers/preview-security";

export const EXECUTABLE_IFRAME_SANDBOX = "allow-scripts";
export const RENDERER_MESSAGE_CHANNEL = "opencode-panes-renderer";
export const MAX_RENDERER_ERROR_MESSAGE_CHARS = 2_048;
export const MAX_RENDERER_ERROR_STACK_CHARS = 8_192;
export const MAX_RENDERER_ERRORS_PER_WINDOW = 5;
export const RENDERER_ERROR_WINDOW_MS = 10_000;

const SHARED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
] as const;

export type RendererMessage =
  | { channel: typeof RENDERER_MESSAGE_CHANNEL; nonce: string; type: "ready" }
  | {
      channel: typeof RENDERER_MESSAGE_CHANNEL;
      nonce: string;
      type: "error";
      message: string;
      stack?: string;
    };

export interface SandboxedArtifactFrameProps {
  allowScripts: boolean;
  nonce?: string;
  onMessage?: (message: RendererMessage) => void;
  srcDoc: string;
  title: string;
}

export function createArtifactCsp(
  allowScripts: boolean,
  approvedOrigins: readonly string[] = [],
): string {
  const policy = createArtifactNetworkPolicy(approvedOrigins);
  const scriptOrigins = policy.scriptSrc.join(" ");
  const styleOrigins = policy.styleSrc.join(" ");
  const imageOrigins = policy.imageSrc.join(" ");
  const fontOrigins = policy.fontSrc.join(" ");
  const connectOrigins = policy.connectSrc.length
    ? policy.connectSrc.join(" ")
    : "'none'";
  return [
    ...SHARED_CSP_DIRECTIVES,
    allowScripts
      ? `script-src 'unsafe-inline' ${scriptOrigins}`
      : "script-src 'none'",
    `style-src 'unsafe-inline' ${styleOrigins}`,
    allowScripts ? `img-src data: blob: ${imageOrigins}` : "img-src 'none'",
    `font-src data: ${fontOrigins}`,
    `connect-src ${connectOrigins}`,
  ].join("; ");
}

export function createMessageNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function isTrustedRendererMessage(
  event: MessageEvent<unknown>,
  expectedSource: Window | null,
  expectedNonce: string,
): event is MessageEvent<RendererMessage> {
  if (!expectedSource || event.source !== expectedSource) return false;
  if (typeof event.data !== "object" || event.data === null) return false;

  const data = event.data as Record<string, unknown>;
  const hasValidStack =
    data.stack === undefined ||
    (typeof data.stack === "string" &&
      data.stack.length <= MAX_RENDERER_ERROR_STACK_CHARS);
  return (
    data.channel === RENDERER_MESSAGE_CHANNEL &&
    data.nonce === expectedNonce &&
    (data.type === "ready" ||
      (data.type === "error" &&
        typeof data.message === "string" &&
        data.message.length <= MAX_RENDERER_ERROR_MESSAGE_CHARS &&
        hasValidStack))
  );
}

export function createRendererMessageRateLimiter(
  now: () => number = Date.now,
): (message: RendererMessage) => boolean {
  const acceptedErrors: number[] = [];
  return (message) => {
    if (message.type !== "error") return true;
    const cutoff = now() - RENDERER_ERROR_WINDOW_MS;
    while (acceptedErrors[0] !== undefined && acceptedErrors[0] <= cutoff) {
      acceptedErrors.shift();
    }
    if (acceptedErrors.length >= MAX_RENDERER_ERRORS_PER_WINDOW) return false;
    acceptedErrors.push(now());
    return true;
  };
}

export function createErrorBridgeScript(nonce: string): string {
  const channel = JSON.stringify(RENDERER_MESSAGE_CHANNEL);
  const serializedNonce = JSON.stringify(nonce);
  return `(() => {
    const channel = ${channel};
    const nonce = ${serializedNonce};
    const send = (payload) => parent.postMessage({ channel, nonce, ...payload }, "*");
    addEventListener("error", (event) => send({
      type: "error",
      message: event.message || "Artifact runtime error",
      stack: event.error && typeof event.error.stack === "string" ? event.error.stack : undefined,
    }));
    addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      send({
        type: "error",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });
    addEventListener("DOMContentLoaded", () => send({ type: "ready" }), { once: true });
  })();`;
}

export function createIsolatedDocument(
  body: string,
  options: {
    allowScripts: boolean;
    approvedOrigins?: readonly string[];
    head?: string;
  },
): string {
  const csp = escapeHtmlAttribute(
    createArtifactCsp(options.allowScripts, options.approvedOrigins),
  );
  const guard = options.allowScripts
    ? `<script>${escapeInlineScript(createArtifactEgressGuardScript())}</script>`
    : "";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8">${guard}${options.head ?? ""}</head><body>${body}</body></html>`;
}

export function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

export function SandboxedArtifactFrame({
  allowScripts,
  nonce,
  onMessage,
  srcDoc,
  title,
}: SandboxedArtifactFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const notifyMessage = useEffectEvent((message: RendererMessage) => {
    onMessage?.(message);
  });

  useEffect(() => {
    if (!nonce) return;
    const acceptMessage = createRendererMessageRateLimiter();

    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        isTrustedRendererMessage(
          event,
          iframeRef.current?.contentWindow ?? null,
          nonce,
        ) &&
        acceptMessage(event.data)
      ) {
        notifyMessage(event.data);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [nonce]);

  return (
    <iframe
      ref={iframeRef}
      referrerPolicy="no-referrer"
      sandbox={allowScripts ? EXECUTABLE_IFRAME_SANDBOX : ""}
      srcDoc={srcDoc}
      title={title}
    />
  );
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
