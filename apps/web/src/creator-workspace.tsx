import type {
  ArtifactType,
  CreatorWorkspaceResponse,
  CreatorWorkspaceRevision,
} from "@opencode-panes/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { useEffect, useState } from "react";
import { ArtifactRenderer } from "./renderers";
import {
  SandboxedArtifactFrame,
  createIsolatedDocument,
} from "./renderers/iframe-security";
import { MarkdownArtifactRenderer } from "./renderers/markdown";
import { SourceCode } from "./renderers/source-code";
import { creatorFileUrl, fetchCreatorFile } from "./viewer";

type WorkspaceMode = "preview" | "files";

export function CreatorWorkspace({
  token,
  workspace,
}: {
  token: string;
  workspace: CreatorWorkspaceResponse;
}) {
  const [mode, setMode] = useState<WorkspaceMode>("preview");
  const [version, setVersion] = useState(workspace.revisions[0]?.version ?? 0);
  const revision =
    workspace.revisions.find((candidate) => candidate.version === version) ??
    workspace.revisions[0];

  useEffect(() => {
    setVersion(workspace.revisions[0]?.version ?? 0);
  }, [workspace.cloudArtifactId, workspace.revisions]);

  if (!revision) {
    return (
      <main className="entry-shell">
        <section className="entry-message">
          <span className="eyebrow">Creator workspace</span>
          <h1>No synced revisions</h1>
          <p>This Creator link has no committed content to inspect.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="creator-workspace-shell">
      <header className="workspace-header">
        <div className="identity-block">
          <span className="brand-mark" aria-hidden="true">
            OP
          </span>
          <div className="title-block">
            <span className="eyebrow">CREATOR WORKSPACE</span>
            <h1>{workspace.title}</h1>
          </div>
          <span className="type-readout">PRIVATE</span>
        </div>
        <div className="instrument-bar" aria-label="Creator workspace controls">
          <div className="segmented-control" aria-label="Workspace view">
            <button
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              type="button"
            >
              Preview
            </button>
            <button
              aria-pressed={mode === "files"}
              onClick={() => setMode("files")}
              type="button"
            >
              Files
            </button>
          </div>
          <label className="version-control">
            <span>Revision</span>
            <select
              aria-label="Select synced revision"
              onChange={(event) => setVersion(Number(event.target.value))}
              value={revision.version}
            >
              {workspace.revisions.map((candidate) => (
                <option key={candidate.id} value={candidate.version}>
                  v{candidate.version}
                </option>
              ))}
            </select>
          </label>
          <span className="creator-expiry">
            Access ends {formatDate(workspace.creatorExpiresAt)}
          </span>
        </div>
        <div className="status-strip" aria-live="polite">
          <span className="state-dot" />
          <span>
            {mode === "preview" ? "Preview loaded" : "File inspection"}
          </span>
          <span className="status-divider" />
          <span>v{revision.version}</span>
          <span>
            {revision.files.filter((file) => file.kind === "file").length} files
          </span>
        </div>
      </header>

      <section
        aria-label={`${workspace.title} revision ${revision.version} ${mode}`}
        className="creator-stage"
      >
        {mode === "preview" ? (
          <CreatorPreview revision={revision} token={token} />
        ) : (
          <CreatorFiles revision={revision} token={token} />
        )}
      </section>
    </main>
  );
}

function CreatorPreview({
  revision,
  token,
}: {
  revision: CreatorWorkspaceRevision;
  token: string;
}) {
  const label =
    revision.preview.adapter === "browser"
      ? "Browser artifact preview"
      : `${revision.preview.renderer} artifact preview`;
  if (revision.preview.adapter === "browser") {
    return (
      <div className="creator-preview-frame">
        <iframe
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          src={creatorFileUrl(
            token,
            revision.version,
            revision.preview.entryPath,
          )}
          title={label}
        />
      </div>
    );
  }
  return (
    <CreatorRendererPreview
      entryPath={revision.preview.entryPath}
      renderer={revision.preview.renderer}
      revision={revision}
      token={token}
    />
  );
}

function CreatorRendererPreview({
  entryPath,
  renderer,
  revision,
  token,
}: {
  entryPath: string;
  renderer: Extract<
    CreatorWorkspaceRevision["preview"],
    { adapter: "renderer" }
  >["renderer"];
  revision: CreatorWorkspaceRevision;
  token: string;
}) {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setSource(undefined);
    setError(undefined);
    void fetchCreatorFile(
      token,
      revision.version,
      entryPath,
      fetch,
      controller.signal,
    )
      .then(async (response) => {
        const bytes = await response.arrayBuffer();
        try {
          setSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          setError("The Preview entry is not valid UTF-8 text.");
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => controller.abort();
  }, [entryPath, revision.version, token]);

  if (error)
    return (
      <div className="creator-file-error" role="alert">
        {error}
      </div>
    );
  if (source === undefined)
    return (
      <div className="creator-loading" role="status">
        Loading Preview…
      </div>
    );
  if (renderer === "code" || renderer === "markdown") {
    return (
      <CreatorTextRenderer
        renderer={renderer}
        source={source}
        approvedOrigins={revision.approvedOrigins}
      />
    );
  }
  return (
    <div className="creator-renderer-canvas">
      <ArtifactRenderer
        approvedOrigins={revision.approvedOrigins}
        onError={setError}
        source={source}
        type={renderer as ArtifactType}
      />
    </div>
  );
}

function CreatorTextRenderer({
  approvedOrigins,
  renderer,
  source,
}: {
  approvedOrigins: readonly string[];
  renderer: "code" | "markdown";
  source: string;
}) {
  const body =
    renderer === "code"
      ? `<pre data-renderer="code"><code>${escapeHtml(source)}</code></pre>`
      : renderToStaticMarkup(
          <MarkdownArtifactRenderer enableGfm source={source} />,
        );
  return (
    <SandboxedArtifactFrame
      allowScripts={false}
      srcDoc={createIsolatedDocument(
        `<main data-panes-renderer="${renderer}">${body}</main>`,
        { allowScripts: false, approvedOrigins },
      )}
      title={`${renderer} artifact preview`}
    />
  );
}

function CreatorFiles({
  revision,
  token,
}: {
  revision: CreatorWorkspaceRevision;
  token: string;
}) {
  const files = [...revision.files].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
  const [selectedPath, setSelectedPath] = useState(revision.preview.entryPath);
  useEffect(() => setSelectedPath(revision.preview.entryPath), [revision.id]);
  const selectedEntry = files.find(
    (file) => file.kind === "file" && file.path === selectedPath,
  );
  const selected = selectedEntry?.kind === "file" ? selectedEntry : undefined;
  return (
    <div className="creator-files-layout">
      <nav aria-label="Revision file tree" className="creator-file-tree">
        <span className="eyebrow">REVISION FILES</span>
        <ul role="tree">
          {files.map((file) => (
            <li
              key={`${file.kind}:${file.path}`}
              role="treeitem"
              aria-level={file.path.split("/").length}
            >
              {file.kind === "file" ? (
                <button
                  className={file.path === selectedPath ? "is-selected" : ""}
                  onClick={() => setSelectedPath(file.path)}
                  type="button"
                >
                  {file.path}
                </button>
              ) : (
                <span className="creator-directory">{file.path}/</span>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <div className="creator-file-detail">
        {selected ? (
          <CreatorFileDetail
            file={selected}
            revision={revision}
            token={token}
          />
        ) : (
          <div className="creator-empty-file">Select a file to inspect.</div>
        )}
      </div>
    </div>
  );
}

function CreatorFileDetail({
  file,
  revision,
  token,
}: {
  file: Extract<CreatorWorkspaceRevision["files"][number], { kind: "file" }>;
  revision: CreatorWorkspaceRevision;
  token: string;
}) {
  const text = isTextMediaType(file.mediaType);
  const [content, setContent] = useState<string | undefined>(
    text ? undefined : "binary",
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    if (!text) {
      setContent("binary");
      return () => controller.abort();
    }
    setContent(undefined);
    void fetchCreatorFile(
      token,
      revision.version,
      file.path,
      fetch,
      controller.signal,
    )
      .then(async (response) => {
        const bytes = await response.arrayBuffer();
        try {
          setContent(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          setError("This file is marked as text but is not valid UTF-8.");
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => controller.abort();
  }, [file.path, revision.version, text, token]);

  return (
    <article className="creator-file-card">
      <header>
        <div>
          <span className="eyebrow">{file.path}</span>
          <h2>{file.mediaType}</h2>
        </div>
        <span className="file-size">{formatBytes(file.byteSize)}</span>
      </header>
      {error ? (
        <p className="creator-file-error" role="alert">
          {error}
        </p>
      ) : null}
      {content === undefined && !error ? (
        <div className="creator-loading" role="status">
          Loading file…
        </div>
      ) : null}
      {content === "binary" ? (
        <div className="binary-file">
          <p>This binary file is not decoded as text.</p>
          <a
            download
            href={creatorFileUrl(token, revision.version, file.path, true)}
          >
            Download {file.path.split("/").at(-1)}
          </a>
        </div>
      ) : content !== undefined && content !== "binary" ? (
        <SourceCode
          source={content}
          type={sourceType(file.path, file.mediaType)}
        />
      ) : null}
    </article>
  );
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    /^(?:application\/(?:javascript|json|typescript|xml)|image\/svg\+xml)$/u.test(
      mediaType,
    )
  );
}

function sourceType(path: string, mediaType: string): ArtifactType {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".mmd" || extension === ".mermaid") return "mermaid";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".svg" || mediaType === "image/svg+xml") return "svg";
  if ([".tsx", ".jsx"].includes(extension)) return "react";
  return "code";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
