import type { PublicPublicationResponse } from "@opencode-panes/contracts";
import { useMemo, useState } from "react";
import {
  CapabilityFiles,
  CapabilityPreview,
  type CapabilityFileClient,
} from "./creator-workspace";
import { fetchPublicFile, publicFileUrl, publicRevisionZipUrl } from "./viewer";

export function PublicWorkspace({
  token,
  workspace,
}: {
  token: string;
  workspace: PublicPublicationResponse;
}) {
  const [mode, setMode] = useState<"preview" | "files">("preview");
  const client = useMemo<CapabilityFileClient>(
    () => ({
      fileUrl: (path, download) => publicFileUrl(token, path, download),
      fetchFile: (path, signal, download) =>
        fetchPublicFile(token, path, fetch, signal, download),
    }),
    [token],
  );
  const fileCount = workspace.revision.files.filter(
    (file) => file.kind === "file",
  ).length;
  const typeLabel =
    workspace.revision.preview.adapter === "browser"
      ? "BROWSER"
      : workspace.revision.preview.renderer.toUpperCase();

  return (
    <main className="creator-workspace-shell public-workspace-shell">
      <a className="skip-link" href="#public-publication-stage">
        Skip to publication
      </a>
      <header className="workspace-header">
        <div className="identity-block">
          <span className="brand-mark" aria-hidden="true">
            OP
          </span>
          <div className="title-block">
            <span className="eyebrow">PUBLIC PUBLICATION</span>
            <h1>{workspace.artifact.title}</h1>
          </div>
          <span className="type-readout">{typeLabel}</span>
        </div>
        <div className="instrument-bar" aria-label="Public publication views">
          <div className="segmented-control" aria-label="Publication view">
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
          <span className="public-expiry">
            Available until {formatDateTime(workspace.expiresAt)}
          </span>
          <a
            className="workspace-download"
            download
            href={publicRevisionZipUrl(token)}
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
          <span>v{workspace.revision.version}</span>
          <span>{fileCount} files</span>
        </div>
      </header>

      <aside className="public-notice">
        <strong>User-generated content.</strong> This read-only artifact runs in
        an isolated viewer. OpenCode Panes does not verify its accuracy.
      </aside>

      <section
        aria-label={`${workspace.artifact.title} publication ${mode}`}
        className="creator-stage"
        id="public-publication-stage"
      >
        {mode === "preview" ? (
          <CapabilityPreview client={client} revision={workspace.revision} />
        ) : (
          <CapabilityFiles client={client} revision={workspace.revision} />
        )}
      </section>
    </main>
  );
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
