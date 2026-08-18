import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EXECUTABLE_IFRAME_SANDBOX,
  MAX_RENDERER_ERROR_MESSAGE_CHARS,
  MAX_RENDERER_ERROR_STACK_CHARS,
  MAX_RENDERER_ERRORS_PER_WINDOW,
  RENDERER_MESSAGE_CHANNEL,
  RENDERER_ERROR_WINDOW_MS,
  SandboxedArtifactFrame,
  createArtifactCsp,
  createRendererMessageRateLimiter,
  isTrustedRendererMessage,
} from "../../src/renderers/iframe-security";
import { createHtmlSrcDoc } from "../../src/renderers/html";

describe("sandboxed artifact iframe", () => {
  it("places a restrictive CSP before HTML artifact content", () => {
    const marker = '<script src="https://attacker.example/x.js"></script>';
    const srcDoc = createHtmlSrcDoc(marker, "message-nonce");
    const cspPosition = srcDoc.indexOf("Content-Security-Policy");

    expect(cspPosition).toBeGreaterThan(-1);
    expect(cspPosition).toBeLessThan(srcDoc.indexOf(marker));
    expect(createArtifactCsp(true)).toContain("default-src 'none'");
    expect(createArtifactCsp(true)).toContain("connect-src 'none'");
    expect(createArtifactCsp(true)).toContain("form-action 'none'");
    expect(createArtifactCsp(true)).toContain("frame-src 'none'");
    expect(createArtifactCsp(true)).toContain("object-src 'none'");
    expect(createArtifactCsp(true)).not.toContain("navigate-to");
    expect(createArtifactCsp(false)).toContain("script-src 'none'");
    expect(createArtifactCsp(false)).toContain("img-src 'none'");
  });

  it("installs common egress guards before the error bridge and guest code", () => {
    const marker = "guest-code-marker";
    const srcDoc = createHtmlSrcDoc(`<script>${marker}</script>`, "nonce");
    const guardPosition = srcDoc.indexOf("XMLHttpRequest");
    const bridgePosition = srcDoc.indexOf(RENDERER_MESSAGE_CHANNEL);

    expect(guardPosition).toBeGreaterThan(-1);
    expect(guardPosition).toBeLessThan(bridgePosition);
    expect(bridgePosition).toBeLessThan(srcDoc.indexOf(marker));
    expect(srcDoc).toContain('lock(globalThis, "fetch"');
    expect(srcDoc).toContain('"WebSocket"');
    expect(srcDoc).toContain('"EventSource"');
    expect(srcDoc).toContain('"RTCPeerConnection"');
    expect(srcDoc).toContain('"webkitRTCPeerConnection"');
    expect(srcDoc).toContain('lock(globalThis, "open"');
    expect(srcDoc).toContain('lock(navigator, "sendBeacon"');
    expect(srcDoc).toContain('"dns-prefetch"');
    expect(srcDoc).toContain('http-equiv="x-dns-prefetch-control"');
  });

  it("grants executable frames scripts and no other sandbox capability", () => {
    const markup = renderToStaticMarkup(
      <SandboxedArtifactFrame
        allowScripts
        srcDoc="<!doctype html>"
        title="test artifact"
      />,
    );

    expect(EXECUTABLE_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("allow-forms");
    expect(markup).not.toContain("allow-popups");
    expect(markup).not.toContain("allow-top-navigation");
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });

  it("accepts renderer messages only from the expected window and nonce", () => {
    const expectedSource = window;
    const data = {
      channel: RENDERER_MESSAGE_CHANNEL,
      nonce: "correct-nonce",
      type: "error",
      message: "boom",
    } as const;
    const trusted = new MessageEvent("message", {
      data,
      source: expectedSource,
    });
    const wrongNonce = new MessageEvent("message", {
      data: { ...data, nonce: "wrong-nonce" },
      source: expectedSource,
    });
    const wrongSource = new MessageEvent("message", {
      data,
      source: null,
    });
    const invalidStack = new MessageEvent("message", {
      data: { ...data, stack: 42 },
      source: expectedSource,
    });
    const oversizedMessage = new MessageEvent("message", {
      data: {
        ...data,
        message: "x".repeat(MAX_RENDERER_ERROR_MESSAGE_CHARS + 1),
      },
      source: expectedSource,
    });
    const oversizedStack = new MessageEvent("message", {
      data: {
        ...data,
        stack: "x".repeat(MAX_RENDERER_ERROR_STACK_CHARS + 1),
      },
      source: expectedSource,
    });

    expect(
      isTrustedRendererMessage(trusted, expectedSource, "correct-nonce"),
    ).toBe(true);
    expect(
      isTrustedRendererMessage(wrongNonce, expectedSource, "correct-nonce"),
    ).toBe(false);
    expect(
      isTrustedRendererMessage(wrongSource, expectedSource, "correct-nonce"),
    ).toBe(false);
    expect(
      isTrustedRendererMessage(invalidStack, expectedSource, "correct-nonce"),
    ).toBe(false);
    expect(
      isTrustedRendererMessage(
        oversizedMessage,
        expectedSource,
        "correct-nonce",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererMessage(oversizedStack, expectedSource, "correct-nonce"),
    ).toBe(false);
  });

  it("rate limits renderer errors and recovers after the fixed window", () => {
    let time = 1_000;
    const accept = createRendererMessageRateLimiter(() => time);
    const message = {
      channel: RENDERER_MESSAGE_CHANNEL,
      message: "boom",
      nonce: "nonce",
      type: "error",
    } as const;

    for (let index = 0; index < MAX_RENDERER_ERRORS_PER_WINDOW; index += 1) {
      expect(accept(message)).toBe(true);
    }
    expect(accept(message)).toBe(false);
    time += RENDERER_ERROR_WINDOW_MS + 1;
    expect(accept(message)).toBe(true);
  });
});
