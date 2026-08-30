import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreatorWorkspaceResponse } from "@opencode-panes/contracts";
import mermaid from "mermaid";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatorWorkspace } from "../../src/creator-workspace";
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

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg style="max-width:100px"><style>.node{fill:#000}.node .label text{text-anchor:middle}</style><g class="node" style="color:#fffaf0"><rect style="fill:#165dcc;stroke:#171717;stroke-width:2px"/><g class="label"><text y="-10.1" style="fill:#fffaf0"><tspan class="text-outer-tspan row" x="0"><tspan>Readable</tspan><tspan> node</tspan></tspan></text></g></g><script>alert(1)</script></svg>',
    })),
  },
}));

vi.mock("../../src/renderers/react-compiler", () => ({
  startReactCompilation: vi.fn(() => ({
    promise: Promise.resolve("globalThis.__PANES_COMPONENT__ = () => null;"),
    stop: vi.fn(),
  })),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("sandboxed artifact iframe", () => {
  it("allows inline scripts through the parent and tighter artifact CSP intersection", () => {
    const staticHeaders = readFileSync(
      join(process.cwd(), "public/_headers"),
      "utf8",
    );

    expect(staticHeaders).toContain(
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
    );
    expect(createArtifactCsp(true)).toContain("script-src 'unsafe-inline'");
    expect(createArtifactCsp(true)).toContain("connect-src 'none'");
    expect(createArtifactCsp(true, ["https://api.example"])).toContain(
      "connect-src https://api.example",
    );
    expect(createArtifactCsp(true, ["https://api.example"])).toContain(
      "script-src 'unsafe-inline' https://api.example",
    );
  });

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

  it("keeps Creator code in an opaque script-free iframe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<script>alert("x")</script>')),
    );

    await renderCreatorWorkspace(
      "code",
      "text/plain",
      '<script>alert("x")</script>',
    );

    const frame = container.querySelector("iframe");
    const srcDoc = frame?.getAttribute("srcdoc") ?? "";
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(srcDoc).toContain("script-src 'none'");
    expect(srcDoc).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(srcDoc).not.toContain("<script>alert");
    expect(srcDoc).not.toContain("allow-same-origin");
  });

  it("gives Creator Markdown a readable isolated canvas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# Readable preview")),
    );

    await renderCreatorWorkspace(
      "markdown",
      "text/markdown",
      "# Readable preview",
    );

    const srcDoc =
      container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("color-scheme:light");
    expect(srcDoc).toContain("background:#f1f0ea");
    expect(srcDoc).toContain("color:#1f211f");
  });

  it("preserves safe Mermaid presentation colors on a readable canvas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("graph TD; A-->B;")),
    );

    await renderCreatorWorkspace("mermaid", "text/plain", "graph TD; A-->B;");

    const srcDoc =
      container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("data-panes-mermaid-canvas");
    expect(srcDoc).toContain('fill="#165dcc"');
    expect(srcDoc).toContain('fill="#fffaf0"');
    expect(srcDoc).toContain('text-anchor="middle"');
    expect(srcDoc).toContain("Readable node");
    expect(srcDoc).toContain("background:#f1f0ea");
    expect(srcDoc).toContain("box-sizing:border-box;width:100vw");
    expect(srcDoc).not.toContain("max-width:100px");
    expect(srcDoc).not.toContain(".node{fill:#000}");
    expect(srcDoc).not.toContain("<script>alert(1)</script>");
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        flowchart: { htmlLabels: false },
        htmlLabels: false,
      }),
    );
  });

  it.each([
    ["mermaid", "graph TD; A-->B;"],
    ["react", "export default function App() { return null; }"],
  ] as const)(
    "uses the existing sandboxed %s renderer path with approved origins",
    async (renderer, source) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(source)),
      );

      await renderCreatorWorkspace(renderer, "text/plain", source);

      const frame = container.querySelector("iframe");
      const srcDoc = frame?.getAttribute("srcdoc") ?? "";
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(srcDoc).toContain("connect-src https://api.example");
    },
  );
});

async function renderCreatorWorkspace(
  renderer: "code" | "markdown" | "mermaid" | "react",
  mediaType: string,
  source: string,
): Promise<void> {
  const workspace: CreatorWorkspaceResponse = {
    cloudArtifactId: "artifact-creator-test",
    cloudProjectId: "project-creator-test",
    creatorExpiresAt: "2026-09-28T10:00:00.000Z",
    revisions: [
      {
        approvedOrigins: ["https://api.example"],
        createdAt: "2026-08-29T12:00:00.000Z",
        files: [
          {
            byteSize: new TextEncoder().encode(source).byteLength,
            kind: "file",
            mediaType,
            path: "entry.txt",
            sha256: "a".repeat(64),
          },
        ],
        id: "revision-1",
        preview: { adapter: "renderer", entryPath: "entry.txt", renderer },
        version: 1,
      },
    ],
    slug: "creator-test",
    title: "Creator test",
  };

  await act(async () => {
    root.render(
      <CreatorWorkspace token="creator-token" workspace={workspace} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
