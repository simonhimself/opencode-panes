import { createHash } from "node:crypto";
import { get } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextEncoder as NodeTextEncoder } from "node:util";

import { JSDOM } from "jsdom";
import { artifactManifestSchema } from "@opencode-panes/contracts";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodePanesPlugin } from "../src/index.js";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "opencode-panes-finalize-"));
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(project, { recursive: true, force: true });
});

describe("artifact_finalize tool", () => {
  it("returns a script-free outer shell with a restrictive artifact frame", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Framed site" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "index.html"),
      '<script>document.body.dataset.executed = "yes";</script><h1>Inside</h1>',
    );

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const shell = await getText(metadata(result).previewUrl as string);

    expect(shell.status).toBe(200);
    expect(shell.body).not.toContain("<script");
    expect(shell.body).not.toContain("document.body.dataset.executed");
    expect(shell.body).toContain('sandbox="allow-scripts"');
    expect(shell.body).not.toContain("allow-same-origin");
    expect(shell.body).toMatch(
      /<iframe[^>]+sandbox="allow-scripts"[^>]+src="[^"]+__panes__\/frame[^>]*>/,
    );

    const frame = await getText(
      frameUrl(shell.body, metadata(result).previewUrl as string),
    );
    expect(frame.body).toContain("document.body.dataset.executed");
    expect(frame.contentSecurityPolicy).toContain("connect-src 'none'");
    expect(frame.contentSecurityPolicy).toContain("sandbox allow-scripts");
    expect(frame.contentSecurityPolicy).not.toContain("allow-same-origin");
  });

  it("confines direct HTML execution to the finalized artifact frame", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Framed interaction" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "index.html"),
      '<button id="action">Run</button><script>document.querySelector("#action").dataset.bound = "yes";</script>',
    );

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const shell = await getText(metadata(result).previewUrl as string);
    const previewUrl = metadata(result).previewUrl as string;
    const frame = await getText(frameUrl(shell.body, previewUrl));

    expect(shell.body).not.toContain('id="action"');
    expect(frame.body).toContain('id="action"');
    expect(frame.body).toContain('"XMLHttpRequest"');
    const dom = new JSDOM(frame.body, {
      runScripts: "dangerously",
      url: frameUrl(shell.body, previewUrl),
    });
    try {
      await waitForRender();
      expect(
        dom.window.document
          .querySelector("#action")
          ?.getAttribute("data-bound"),
      ).toBe("yes");
    } finally {
      dom.window.close();
    }
  });

  it("executes stateful React through the finalized Local preview frame", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Framed React" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "App.tsx"),
      `import React, { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}`,
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "App.tsx",
        adapter: "renderer",
        renderer: "react",
      },
      context,
    );
    const shell = await getText(metadata(result).previewUrl as string);
    expect(shell.body).not.toContain("__PANES_REACT_SOURCE__");
    expect(shell.body).not.toContain("<script");
    const frameResponseUrl = frameUrl(
      shell.body,
      metadata(result).previewUrl as string,
    );
    const frameResponse = await getText(frameResponseUrl);
    const originalTextEncoder = globalThis.TextEncoder;
    const originalUint8Array = globalThis.Uint8Array;
    let dom: JSDOM | undefined;
    try {
      globalThis.TextEncoder = NodeTextEncoder;
      globalThis.Uint8Array = new NodeTextEncoder().encode("")
        .constructor as typeof Uint8Array;
      dom = new JSDOM(frameResponse.body, {
        runScripts: "dangerously",
        url: frameResponseUrl,
      });
      await waitForRender(1000);
      const button = dom.window.document.querySelector("button");
      expect(button?.textContent).toBe("Count: 0");

      button?.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await waitForRender();

      expect(button?.textContent).toBe("Count: 1");
    } finally {
      dom?.window.close();
      globalThis.TextEncoder = originalTextEncoder;
      globalThis.Uint8Array = originalUint8Array;
    }
  });

  it("finalizes a browser draft and serves its raw nested files over loopback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Site" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await mkdir(join(draftPath, "assets"));
    await writeFile(
      join(draftPath, "index.html"),
      '<script type="module" src="assets/app.js"></script>',
    );
    await writeFile(
      join(draftPath, "assets", "app.js"),
      "export const answer = 42;\n",
    );

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "./index.html", adapter: "browser" },
      context,
    );

    const resultMetadata = metadata(result);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resultMetadata).toMatchObject({
      operation: "finalized",
      artifactId,
      version: 1,
    });
    expect(resultMetadata.previewUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/preview\/[^/]+\/v1\/index\.html$/,
    );

    const preview = await getText(String(resultMetadata.previewUrl));
    expect(preview.status).toBe(200);
    expect(preview.contentType).toMatch(/^text\/html/);
    expect(preview.contentSecurityPolicy).toContain("connect-src 'none'");
    expect(preview.body).toContain('sandbox="allow-scripts"');
    const frame = await getText(
      frameUrl(preview.body, String(resultMetadata.previewUrl)),
    );
    expect(frame.body).toContain(
      '<script type="module" src="assets/app.js"></script>',
    );
    const asset = await getText(
      `${String(resultMetadata.previewUrl).replace("index.html", "assets/app.js")}`,
    );
    expect(asset.status).toBe(200);
    expect(asset.contentType).toMatch(/^application\/javascript/);
    expect(asset.accessControlAllowOrigin).toBe("*");
    expect(asset.body).toBe("export const answer = 42;\n");

    const artifactDirectory = join(project, "artifacts", "site");
    const manifest = artifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
      ),
    );
    expect(manifest.revisions[0]).toMatchObject({
      version: 1,
      preview: { adapter: "browser", entryPath: "index.html" },
      approvedOrigins: [],
    });
    expect(manifest.revisions[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          path: "index.html",
          byteSize: Buffer.byteLength(
            '<script type="module" src="assets/app.js"></script>',
          ),
          mediaType: "text/html",
        }),
        expect.objectContaining({
          kind: "file",
          path: "assets/app.js",
          byteSize: Buffer.byteLength("export const answer = 42;\n"),
          mediaType: "application/javascript",
        }),
        expect.objectContaining({ kind: "directory", path: "assets" }),
      ]),
    );
    expect(
      await stat(join(artifactDirectory, "v1", "index.html")),
    ).toMatchObject({
      isFile: expect.any(Function),
    });
    expect(await readdir(artifactDirectory)).not.toContain("draft");
    expect(await readdir(artifactDirectory)).not.toContain(
      ".panes-finalize.json",
    );
  });

  it("requires origin approval before promotion and applies the approved policy to the HTTP frame", async () => {
    const context = toolContext();
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const prepare = await executePluginTool(
      plugin,
      "artifact_prepare",
      {
        title: "Approved origins",
        requestedOrigins: [
          "HTTPS://API.Example.com:443/",
          "https://cdn.example.com/",
        ],
      },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "index.html"),
      '<img src="https://cdn.example.com/image.png"><script>fetch("https://api.example.com/data");</script>',
    );

    const approval = await executePluginTool(
      plugin,
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    expect(metadata(approval)).toMatchObject({
      operation: "approval-required",
      artifactId,
      requestedOrigins: ["https://api.example.com", "https://cdn.example.com"],
    });
    expect(metadata(approval).approvalNonce).toEqual(expect.any(String));
    expect(
      JSON.parse(
        await readFile(
          join(project, "artifacts", "approved-origins", "artifact.json"),
          "utf8",
        ),
      ).revisions,
    ).toEqual([]);

    const result = await executePluginTool(
      plugin,
      "artifact_finalize",
      {
        artifactId,
        entryPath: "index.html",
        adapter: "browser",
        approvedOrigins: ["https://cdn.example.com", "https://api.example.com"],
        approvalNonce: metadata(approval).approvalNonce,
      },
      context,
    );
    expect(metadata(result)).toMatchObject({
      operation: "finalized",
      version: 1,
      preview: { adapter: "browser", entryPath: "index.html" },
    });

    const previewUrl = metadata(result).previewUrl as string;
    const shell = await getText(previewUrl);
    expect(shell.body).toContain('sandbox="allow-scripts"');
    expect(shell.body).not.toContain("allow-same-origin");
    const frame = await getText(frameUrl(shell.body, previewUrl));
    expect(frame.contentSecurityPolicy).toContain(
      "connect-src https://api.example.com https://cdn.example.com",
    );
    for (const directive of [
      "img-src",
      "media-src",
      "font-src",
      "style-src",
      "script-src",
    ]) {
      expect(frame.contentSecurityPolicy).toMatch(
        new RegExp(
          `${directive}[^;]*https://api\\.example\\.com[^;]*https://cdn\\.example\\.com`,
        ),
      );
    }
    expect(frame.contentSecurityPolicy).not.toContain("ws:");
    expect(frame.contentSecurityPolicy).not.toContain("wss:");
    expect(frame.contentSecurityPolicy).toContain("navigate-to 'none'");
    expect(frame.body).toContain('"WebSocket"');
    expect(frame.body).not.toContain('lock(globalThis, "fetch"');

    const manifest = JSON.parse(
      await readFile(
        join(project, "artifacts", "approved-origins", "artifact.json"),
        "utf8",
      ),
    );
    expect(manifest.revisions[0].approvedOrigins).toEqual([
      "https://api.example.com",
      "https://cdn.example.com",
    ]);
    expect(
      await readdir(join(project, "artifacts", "approved-origins")),
    ).not.toContain(".panes-origin-approval.json");
  });

  it("invalidates an origin approval when the Draft changes and consumes the nonce after promotion", async () => {
    const context = toolContext();
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const prepare = await executePluginTool(
      plugin,
      "artifact_prepare",
      { title: "Nonce binding", requestedOrigins: ["https://api.example.com"] },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await writeFile(join(draftPath, "index.html"), "<h1>one</h1>");
    const approval = await executePluginTool(
      plugin,
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    await writeFile(join(draftPath, "index.html"), "<h1>changed</h1>");
    await expect(
      executePluginTool(
        plugin,
        "artifact_finalize",
        {
          artifactId,
          entryPath: "index.html",
          adapter: "browser",
          approvedOrigins: ["https://api.example.com"],
          approvalNonce: metadata(approval).approvalNonce,
        },
        context,
      ),
    ).rejects.toThrow(/Draft changed|approval nonce/i);
    expect(
      stat(join(project, "artifacts", "nonce-binding", "v1")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const freshApproval = await executePluginTool(
      plugin,
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const finalized = await executePluginTool(
      plugin,
      "artifact_finalize",
      {
        artifactId,
        entryPath: "index.html",
        adapter: "browser",
        approvedOrigins: ["https://api.example.com"],
        approvalNonce: metadata(freshApproval).approvalNonce,
      },
      context,
    );
    expect(metadata(finalized).version).toBe(1);
    await expect(
      executePluginTool(
        plugin,
        "artifact_finalize",
        {
          artifactId,
          entryPath: "index.html",
          adapter: "browser",
          approvedOrigins: ["https://api.example.com"],
          approvalNonce: metadata(freshApproval).approvalNonce,
        },
        context,
      ),
    ).rejects.toThrow(/nonce|Draft/i);
  });

  it("serves a supported renderer through a generated wrapper without rewriting stored source", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Notes" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    const source = "# Hello\n\nThis is **markdown**.\n";
    await writeFile(join(draftPath, "README.md"), source);

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "README.md",
        adapter: "renderer",
        renderer: "markdown",
      },
      context,
    );
    const previewUrl = metadata(result).previewUrl as string;
    const response = await getPreviewFrame(previewUrl);

    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/html/);
    expect(response.body).toContain('<article data-renderer="markdown">');
    expect(response.body).toContain("<h1>Hello</h1>");
    expect(response.body).toContain("<strong>markdown</strong>");
    expect(
      await readFile(
        join(project, "artifacts", "notes", "v1", "README.md"),
        "utf8",
      ),
    ).toBe(source);
  });

  it("executes GFM through the Markdown renderer on the Local preview surface", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "GFM Notes" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const source =
      "# Release\n\n| Area | Status |\n| --- | --- |\n| API | **ready** |\n\n- [x] shipped\n";
    await writeFile(
      join(metadata(prepare).draftPath as string, "README.md"),
      source,
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "README.md",
        adapter: "renderer",
        renderer: "markdown",
      },
      context,
    );
    const previewUrl = metadata(result).previewUrl as string;
    const response = await getPreviewFrame(previewUrl);

    expect(response.status).toBe(200);
    expect(response.body).toContain("<table>");
    expect(response.body).toContain("<th>Area</th>");
    expect(response.body).toContain("<strong>ready</strong>");
    expect(response.body).toContain('type="checkbox"');
    expect(response.body).toContain("shipped");
  });

  it("renders Mermaid as an SVG diagram surface", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Diagram" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "diagram.mmd"),
      "flowchart LR\n  A[Start] --> B[Finish]",
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "diagram.mmd",
        adapter: "renderer",
        renderer: "mermaid",
      },
      context,
    );
    const previewUrl = metadata(result).previewUrl as string;
    const response = await getPreviewFrame(previewUrl);

    expect(response.status).toBe(200);
    expect(response.body).toContain('data-renderer="mermaid"');
    expect(response.body).toContain('class="flowchart"');
    expect(response.body).toContain("Start");
    expect(response.body).toContain("Finish");
  });

  it("executes non-trivial Mermaid syntax through the actual diagram renderer", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Decision Diagram" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "diagram.mmd"),
      "flowchart LR\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| D[Retry]",
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "diagram.mmd",
        adapter: "renderer",
        renderer: "mermaid",
      },
      context,
    );
    const response = await getPreviewFrame(
      metadata(result).previewUrl as string,
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain('class="flowchart"');
    expect(response.body).toContain('class="node default"');
    expect(response.body).toContain("Choice");
    expect(response.body).toContain("yes");
    expect(response.body).toContain("no");
  });

  it("serves a browser React runtime rather than evaluating the entry in Node", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "React" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const source =
      "export default function App() { return <button>Click me</button> }";
    await writeFile(
      join(metadata(prepare).draftPath as string, "App.tsx"),
      source,
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "App.tsx",
        adapter: "renderer",
        renderer: "react",
      },
      context,
    );
    const previewUrl = metadata(result).previewUrl as string;
    const response = await getPreviewFrame(previewUrl);

    expect(response.status).toBe(200);
    expect(response.body).toContain('<div id="root"></div>');
    expect(response.body).toContain("__PANES_REACT_SOURCE__");
    expect(response.body).not.toContain("__PANES_WASM_URL__");
    expect(response.body).not.toContain("<pre>");
    const wasm = await getText(
      new URL("__panes__/esbuild.wasm", previewUrl).toString(),
    );
    expect(wasm.status).toBe(404);
  });

  it("executes nested JSX, expressions, props, and state through the React compiler/runtime", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Interactive React" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const source = `
      import React, { useState } from "react";

      function Badge({ label }) {
        return <strong data-kind="badge">{label}</strong>;
      }

      export default function App() {
        const [count] = useState(2);
        return (
          <section>
            <h1>{\`Count: \${count}\`}</h1>
            <Badge label="Ready" />
          </section>
        );
      }
    `;
    await writeFile(
      join(metadata(prepare).draftPath as string, "App.tsx"),
      source,
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "App.tsx",
        adapter: "renderer",
        renderer: "react",
      },
      context,
    );
    const response = await getPreviewFrame(
      metadata(result).previewUrl as string,
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("__PANES_REACT_SOURCE__");
    expect(response.body).toContain("Count:");
    expect(response.body).not.toContain("React component rendered without");
  });

  it("does not evaluate malicious React source in the plugin process", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Untrusted React" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const source = `
      throw new Error("artifact source was evaluated in Node");
      export default function App() { return <button>Never rendered in Node</button>; }
    `;
    await writeFile(
      join(metadata(prepare).draftPath as string, "App.tsx"),
      source,
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "App.tsx",
        adapter: "renderer",
        renderer: "react",
      },
      context,
    );
    const response = await getPreviewFrame(
      metadata(result).previewUrl as string,
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("artifact source was evaluated in Node");
  });

  it("keeps code entries source-oriented", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Code" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "example.py"),
      "print('hello')",
    );

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "example.py",
        adapter: "renderer",
        renderer: "code",
      },
      context,
    );
    const response = await getPreviewFrame(
      metadata(result).previewUrl as string,
    );

    expect(response.body).toContain(
      '<pre data-renderer="code"><code>print(&#39;hello&#39;)</code></pre>',
    );
  });

  it("does not activate the injected failure boundary outside test mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Production" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    await writeFile(
      join(metadata(prepare).draftPath as string, "index.html"),
      "<h1>Production</h1>",
    );
    const failureInjector = vi.fn(() => {
      throw new Error("should not run");
    });

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
      { failureInjector },
    );

    expect(metadata(result).version).toBe(1);
    expect(failureInjector).not.toHaveBeenCalled();
  });

  it.each([
    ["browser with a renderer", { adapter: "browser", renderer: "code" }],
    ["renderer without a renderer name", { adapter: "renderer" }],
    [
      "markdown with an HTML entry",
      { adapter: "renderer", renderer: "markdown" },
    ],
  ] as const)("rejects %s adapter combinations", async (_case, input) => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Invalid" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await writeFile(join(draftPath, "index.html"), "<h1>Invalid</h1>");

    await expect(
      executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", ...input },
        context,
      ),
    ).rejects.toThrow(/Artifact input is invalid|cannot use/);
  });

  it.each([
    "before-rename",
    "after-rename",
    "after-manifest",
    "before-cleanup",
  ] as const)(
    "recovers and returns the finalized preview after a %s interruption",
    async (phase) => {
      const context = toolContext();
      const prepare = await executeTool(
        "artifact_prepare",
        { title: `Crash ${phase}` },
        context,
      );
      const artifactId = metadata(prepare).artifactId as string;
      const draftPath = metadata(prepare).draftPath as string;
      await writeFile(join(draftPath, "index.html"), `<h1>${phase}</h1>`);

      const failureInjector = (injectedPhase: string) => {
        if (injectedPhase === phase) {
          throw new Error(`Simulated finalization crash at ${phase}`);
        }
      };
      await expect(
        executeTool(
          "artifact_finalize",
          { artifactId, entryPath: "index.html", adapter: "browser" },
          context,
          { failureInjector },
        ),
      ).rejects.toThrow(`Simulated finalization crash at ${phase}`);

      const recovered = await executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", adapter: "browser" },
        context,
      );
      expect(metadata(recovered)).toMatchObject({
        operation: "finalized",
        version: 1,
      });
      expect(
        (await getText(metadata(recovered).previewUrl as string)).status,
      ).toBe(200);

      const artifactDirectory = join(project, "artifacts", `crash-${phase}`);
      const manifest = JSON.parse(
        await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
      );
      expect(manifest.revisions).toHaveLength(1);
      expect(await readdir(artifactDirectory)).not.toContain(
        ".panes-finalize.json",
      );
      expect(
        await stat(join(artifactDirectory, "v1", "index.html")),
      ).toMatchObject({
        isFile: expect.any(Function),
      });
    },
  );

  it("records raw binary bytes and blocks changed finalized history", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Immutable" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    const html = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x68, 0x31, 0x3e, 0x0a]);
    const binary = Buffer.from([0x00, 0xff, 0x01, 0xfe]);
    await mkdir(join(draftPath, "assets"));
    await writeFile(join(draftPath, "index.html"), html);
    await writeFile(join(draftPath, "assets", "payload.bin"), binary);

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const artifactDirectory = join(project, "artifacts", "immutable");
    const manifest = artifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
      ),
    );
    expect(manifest.revisions[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "index.html",
          sha256: createHash("sha256").update(html).digest("hex"),
          byteSize: html.byteLength,
        }),
        expect.objectContaining({
          path: "assets/payload.bin",
          sha256: createHash("sha256").update(binary).digest("hex"),
          byteSize: binary.byteLength,
        }),
      ]),
    );

    const previewUrl = metadata(result).previewUrl as string;
    await writeFile(join(artifactDirectory, "v1", "index.html"), "changed");
    const changedPreview = await getText(previewUrl);
    expect(changedPreview.status).toBe(409);

    const next = await executeTool("artifact_prepare", { artifactId }, context);
    expect(next).toBeDefined();
    await expect(
      executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", adapter: "browser" },
        context,
      ),
    ).rejects.toThrow("no longer match artifact.json");
    await expect(stat(join(artifactDirectory, "v2"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an unexpected finalized Revision directory without changing the ledger", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Gap" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await writeFile(join(draftPath, "index.html"), "<h1>one</h1>");
    await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const artifactDirectory = join(project, "artifacts", "gap");
    await mkdir(join(artifactDirectory, "v9"));
    const next = await executeTool("artifact_prepare", { artifactId }, context);
    await writeFile(
      join(metadata(next).draftPath as string, "index.html"),
      "<h1>two</h1>",
    );

    await expect(
      executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", adapter: "browser" },
        context,
      ),
    ).rejects.toThrow("unexpected Revision directory");
    const manifest = JSON.parse(
      await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
    );
    expect(manifest.revisions).toHaveLength(1);
  });
});

async function executeTool(
  name: "artifact_prepare" | "artifact_finalize",
  args: Record<string, unknown>,
  context: ToolContext,
  options: { failureInjector?: (phase: string) => void } = {},
) {
  const plugin = await OpenCodePanesPlugin(
    {} as Parameters<typeof OpenCodePanesPlugin>[0],
    options,
  );
  const definition = plugin.tool?.[name] as ToolDefinition | undefined;
  if (!definition) throw new Error(`${name} was not registered`);
  return definition.execute(args, context);
}

async function executePluginTool(
  plugin: Awaited<ReturnType<typeof OpenCodePanesPlugin>>,
  name: "artifact_prepare" | "artifact_finalize",
  args: Record<string, unknown>,
  context: ToolContext,
) {
  const definition = plugin.tool?.[name] as ToolDefinition | undefined;
  if (!definition) throw new Error(`${name} was not registered`);
  return definition.execute(args, context);
}

function toolContext(): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
  };
}

function getText(url: string) {
  return new Promise<{
    status: number;
    contentType: string;
    contentSecurityPolicy: string;
    accessControlAllowOrigin: string;
    body: string;
  }>((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          contentSecurityPolicy: String(
            response.headers["content-security-policy"] ?? "",
          ),
          accessControlAllowOrigin: String(
            response.headers["access-control-allow-origin"] ?? "",
          ),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.once("error", reject);
  });
}

function frameUrl(shell: string, previewUrl: string) {
  const source = shell.match(/<iframe[^>]+src="([^"]+)"/u)?.[1];
  if (!source)
    throw new Error("preview shell did not contain an artifact frame");
  return new URL(source, previewUrl).toString();
}

async function getPreviewFrame(previewUrl: string) {
  const shell = await getText(previewUrl);
  return getText(frameUrl(shell.body, previewUrl));
}

function waitForRender(delay = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function metadata(result: ToolResult) {
  if (typeof result === "string" || !result.metadata) {
    throw new Error("expected metadata result");
  }
  return result.metadata as Record<string, unknown>;
}
