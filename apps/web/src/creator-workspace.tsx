import type {
  ArtifactType,
  CreatorWorkspaceResponse,
  CreatorWorkspaceRevision,
} from "@opencode-panes/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { useEffect, useMemo, useState } from "react";
import { ArtifactRenderer } from "./renderers";
import {
  SandboxedArtifactFrame,
  createIsolatedDocument,
} from "./renderers/iframe-security";
import { MarkdownArtifactRenderer } from "./renderers/markdown";
import { SourceCode } from "./renderers/source-code";
import {
  creatorFileUrl,
  creatorRevisionZipUrl,
  extendCreatorPublication,
  fetchCreatorFile,
  fetchCreatorWorkspace,
  publishCreatorPublication,
  republishCreatorPublication,
  unpublishCreatorPublication,
  type PublicationDuration,
} from "./viewer";

type WorkspaceMode = "preview" | "files";

export type CapabilityFile =
  | {
      kind: "file";
      path: string;
      byteSize: number;
      mediaType: string;
    }
  | { kind: "directory"; path: string; byteSize: 0 };

export type CapabilityRevision = {
  version: number;
  preview: CreatorWorkspaceRevision["preview"];
  approvedOrigins: readonly string[];
  files: readonly CapabilityFile[];
  createdAt: string;
};

export interface CapabilityFileClient {
  fileUrl: (path: string, download?: boolean) => string;
  fetchFile: (
    path: string,
    signal?: AbortSignal,
    download?: boolean,
  ) => Promise<Response>;
}

export function CreatorWorkspace({
  token,
  workspace,
}: {
  token: string;
  workspace: CreatorWorkspaceResponse;
}) {
  const [currentWorkspace, setCurrentWorkspace] =
    useState<CreatorWorkspaceResponse>(workspace);
  const [mode, setMode] = useState<WorkspaceMode>("preview");
  const [version, setVersion] = useState(
    currentWorkspace.revisions[0]?.version ?? 0,
  );
  const [duration, setDuration] = useState<PublicationDuration>(7);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [feedbackError, setFeedbackError] = useState(false);
  const revision =
    currentWorkspace.revisions.find(
      (candidate) => candidate.version === version,
    ) ?? currentWorkspace.revisions[0];
  const activePublication = currentWorkspace.publication ?? null;
  const fileClient = useMemo<CapabilityFileClient>(
    () => ({
      fileUrl: (path, download) =>
        creatorFileUrl(token, revision?.version ?? 0, path, download),
      fetchFile: (path, signal, download) =>
        fetchCreatorFile(
          token,
          revision?.version ?? 0,
          path,
          fetch,
          signal,
          download,
        ),
    }),
    [revision?.version, token],
  );

  useEffect(() => {
    setCurrentWorkspace(workspace);
    setVersion(workspace.revisions[0]?.version ?? 0);
  }, [workspace]);

  const refreshWorkspace = async () => {
    const next = await fetchCreatorWorkspace(token);
    setCurrentWorkspace(next);
  };

  const runPublicationAction = async (
    action: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(true);
    setFeedback(undefined);
    setFeedbackError(false);
    try {
      await action();
      await refreshWorkspace();
      setFeedback(success);
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : String(caught));
      setFeedbackError(true);
    } finally {
      setBusy(false);
    }
  };

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
            <h1>{currentWorkspace.title}</h1>
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
              {currentWorkspace.revisions.map((candidate) => (
                <option key={candidate.id} value={candidate.version}>
                  v{candidate.version}
                </option>
              ))}
            </select>
          </label>
          <span className="creator-expiry">
            Access ends {formatDate(currentWorkspace.creatorExpiresAt)}
          </span>
          <a
            className="workspace-download"
            download
            href={creatorRevisionZipUrl(token, revision.version)}
            referrerPolicy="no-referrer"
          >
            Download ZIP
          </a>
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

      <PublicationControls
        activePublication={activePublication}
        busy={busy}
        duration={duration}
        feedback={feedback}
        feedbackError={feedbackError}
        onDurationChange={setDuration}
        onExtend={() =>
          void runPublicationAction(
            () => extendCreatorPublication(token, duration),
            "Publication extended.",
          )
        }
        onPublish={() =>
          void runPublicationAction(
            () => publishCreatorPublication(token, revision.version, duration),
            `Revision v${revision.version} published.`,
          )
        }
        onRepublish={() =>
          void runPublicationAction(
            () =>
              republishCreatorPublication(token, revision.version, duration),
            `Revision v${revision.version} republished.`,
          )
        }
        onUnpublish={() =>
          void runPublicationAction(
            () => unpublishCreatorPublication(token),
            "Publication unpublished.",
          )
        }
        revision={revision}
        history={currentWorkspace.publicationHistory ?? []}
      />

      <section
        aria-label={`${workspace.title} revision ${revision.version} ${mode}`}
        className="creator-stage"
      >
        {mode === "preview" ? (
          <CapabilityPreview client={fileClient} revision={revision} />
        ) : (
          <CapabilityFiles client={fileClient} revision={revision} />
        )}
      </section>
    </main>
  );
}

function PublicationControls({
  activePublication,
  busy,
  duration,
  feedback,
  feedbackError,
  history,
  onDurationChange,
  onExtend,
  onPublish,
  onRepublish,
  onUnpublish,
  revision,
}: {
  activePublication: CreatorWorkspaceResponse["publication"];
  busy: boolean;
  duration: PublicationDuration;
  feedback: string | undefined;
  feedbackError: boolean;
  history: NonNullable<CreatorWorkspaceResponse["publicationHistory"]>;
  onDurationChange: (duration: PublicationDuration) => void;
  onExtend: () => void;
  onPublish: () => void;
  onRepublish: () => void;
  onUnpublish: () => void;
  revision: CreatorWorkspaceRevision;
}) {
  const isActive = activePublication?.status === "active";
  return (
    <section
      className="publication-controls"
      aria-labelledby="publication-title"
    >
      <div className="publication-heading">
        <div>
          <span className="eyebrow">PUBLICATION</span>
          <h2 id="publication-title">One public link, chosen by you</h2>
        </div>
        <span className={`publication-state ${isActive ? "is-active" : ""}`}>
          {isActive ? "Active" : "Not published"}
        </span>
      </div>
      <p className="publication-summary">
        {isActive
          ? `Revision v${activePublication.revisionVersion} is public until ${formatDateTime(activePublication.expiresAt)}.`
          : `Revision v${revision.version} is selected. Publishing will make only this synced Revision public.`}
      </p>
      {isActive && activePublication.publicUrl ? (
        <a
          className="publication-url"
          href={activePublication.publicUrl}
          rel="noreferrer"
          target="_blank"
        >
          {activePublication.publicUrl}
        </a>
      ) : null}
      <div className="publication-actions">
        <label>
          <span>Duration</span>
          <select
            disabled={busy}
            onChange={(event) =>
              onDurationChange(
                Number(event.target.value) as PublicationDuration,
              )
            }
            value={duration}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <button disabled={busy} onClick={onPublish} type="button">
          Publish v{revision.version}
        </button>
        {isActive ? (
          <>
            <button disabled={busy} onClick={onExtend} type="button">
              Extend by {duration} {duration === 1 ? "day" : "days"}
            </button>
            <button disabled={busy} onClick={onRepublish} type="button">
              Republish v{revision.version}
            </button>
            <button disabled={busy} onClick={onUnpublish} type="button">
              Unpublish
            </button>
          </>
        ) : null}
      </div>
      {isActive ? (
        <p className="publication-hint">
          Publishing this same Revision keeps its existing expiry. Use Extend
          when you want to add time.
        </p>
      ) : null}
      {feedback ? (
        <p
          className="publication-feedback"
          role={feedbackError ? "alert" : "status"}
        >
          {feedback}
        </p>
      ) : null}
      {history.length > 0 ? (
        <details className="publication-history">
          <summary>Publication history ({history.length})</summary>
          <ul>
            {history.map((publication) => (
              <li key={publication.id}>
                v{publication.revisionVersion} · {publication.status} · expires{" "}
                {formatDateTime(publication.expiresAt)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function CapabilityPreview({
  revision,
  client,
}: {
  revision: CapabilityRevision;
  client: CapabilityFileClient;
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
          src={client.fileUrl(revision.preview.entryPath)}
          title={label}
        />
      </div>
    );
  }
  return (
    <CapabilityRendererPreview
      entryPath={revision.preview.entryPath}
      renderer={revision.preview.renderer}
      revision={revision}
      client={client}
    />
  );
}

function CapabilityRendererPreview({
  entryPath,
  renderer,
  revision,
  client,
}: {
  entryPath: string;
  renderer: Extract<
    CapabilityRevision["preview"],
    { adapter: "renderer" }
  >["renderer"];
  revision: CapabilityRevision;
  client: CapabilityFileClient;
}) {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setSource(undefined);
    setError(undefined);
    void client
      .fetchFile(entryPath, controller.signal)
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
  }, [client, entryPath, revision.version]);

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

export function CapabilityFiles({
  revision,
  client,
}: {
  revision: CapabilityRevision;
  client: CapabilityFileClient;
}) {
  const files = [...revision.files].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
  const [selectedPath, setSelectedPath] = useState(revision.preview.entryPath);
  useEffect(
    () => setSelectedPath(revision.preview.entryPath),
    [revision.preview.entryPath, revision.version],
  );
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
          <CapabilityFileDetail
            file={selected}
            revision={revision}
            client={client}
          />
        ) : (
          <div className="creator-empty-file">Select a file to inspect.</div>
        )}
      </div>
    </div>
  );
}

function CapabilityFileDetail({
  file,
  revision,
  client,
}: {
  file: Extract<CapabilityRevision["files"][number], { kind: "file" }>;
  revision: CapabilityRevision;
  client: CapabilityFileClient;
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
    void client
      .fetchFile(file.path, controller.signal)
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
  }, [client, file.path, revision.version, text]);

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
            href={client.fileUrl(file.path, true)}
            referrerPolicy="no-referrer"
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

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
