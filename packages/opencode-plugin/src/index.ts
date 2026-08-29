import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  createServer,
  get,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { parseHTML } from "linkedom";
import ignore, { type Ignore } from "ignore";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getReactBrowserRuntime,
  type ReactBrowserRuntime,
} from "@opencode-panes/renderers/react-browser-runtime";
import { createArtifactEgressGuardScript } from "@opencode-panes/renderers/iframe-security";
import { createArtifactNetworkPolicy } from "@opencode-panes/renderers/preview-security";
import {
  MAX_ARTIFACT_SOURCE_BYTES,
  MAX_ARTIFACT_KIND_LENGTH,
  artifactManifestSchema,
  artifactFilesSchema,
  artifactSlugSchema,
  deriveCloudManifest,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  artifactIdSchema,
  artifactTypeSchema,
  draftSchema,
  finalizedRevisionSchema,
  previewEntrySchema,
  relativePathSchema,
  createArtifactRequestSchema,
  createArtifactResponseSchema,
  createRevisionRequestSchema,
  errorEnvelopeSchema,
  ownerTokenSchema,
  requestedOriginsSchema,
  revisionNumberSchema,
  revisionResponseSchema,
  workspaceTokenSchema,
  syncCreateResponseSchema,
  syncRevisionCommitResponseSchema,
  type ArtifactManifest,
  type ArtifactFile,
  type ArtifactType,
  type Draft,
  type FinalizedRevision,
  type PreviewEntry,
  type CloudManifest,
} from "@opencode-panes/contracts";
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const STATE_DIRECTORY_NAME = "opencode-panes";
const PROJECT_ID_FILE_NAME = ".panes-project.json";
const PREPARE_STATE_FILE_NAME = ".panes-prepare.json";
const FINALIZE_JOURNAL_FILE_NAME = ".panes-finalize.json";
const IMPORT_JOURNAL_FILE_NAME = ".panes-import.json";
const ARTIFACT_LOCK_FILE_NAME = ".panes-lock.json";
const IMPORT_RECEIPT_TTL_MS = 5 * 60 * 1000;
const PREVIEW_FRAME_PATH = "__panes__/frame";
const execFileAsync = promisify(execFile);
const PROCESS_OWNER_ID = randomUUID();

const TOOL_DESCRIPTION = `Use this tool when the user explicitly requests an artifact, prototype, interactive design, diagram, visual explanation, substantial document, or standalone code preview. Prefer an artifact when the result is easier to understand visually than as terminal text. Omit artifactId to create an artifact. Reuse the returned artifact ID when the user asks to revise that artifact so Panes creates an immutable new version. Supply complete standalone source, not a patch or prose description. After success, present viewerUrl exactly as returned, including its fragment; never shorten, sanitize, or rewrite that URL.`;

export interface PanesPluginOptions {
  /** Panes API origin. Defaults to the local Vite/Workers development server. */
  apiBaseUrl?: string;
  /** Optional admission key for creating artifacts on a protected Panes API. */
  createApiKey?: string;
  /** Open the viewer after a successful upload. Requires a separate permission. */
  autoOpen?: boolean;
  /** Abort API requests after this many milliseconds. */
  requestTimeoutMs?: number;
}

interface ResolvedOptions {
  apiBaseUrl: URL;
  autoOpen: boolean;
  createApiKey?: string;
  requestTimeoutMs: number;
  failureInjector?: (phase: string) => void;
}

interface StoredArtifactState {
  apiOrigin: string;
  artifactId: string;
  ownerToken: string;
  viewerUrl: string;
  title: string;
  type: ArtifactType;
}

interface StoredSyncState {
  schemaVersion: 1;
  apiOrigin: string;
  projectId: string;
  artifactId: string;
  cloudProjectId: string;
  cloudArtifactId: string;
  ownerCredential: string;
  creatorUrl: string;
  inventoryUrl: string;
  creatorExpiresAt: string;
  creationIdempotencyKey: string;
  syncedRevisionVersions: number[];
  syncedRevisionManifests?: FinalizedRevision[];
}

interface SyncCheckpoint extends StoredSyncState {
  phase: "planned" | "identity" | "mapped";
  creatorToken: string;
}

type AutoOpenStatus = "disabled" | "opened" | "permission-denied" | "failed";

export const OpenCodePanesPlugin: Plugin = async (_input, pluginOptions) => {
  const options = resolveOptions(pluginOptions);
  const previewServer = new LocalPreviewServer();
  const locks = new Map<string, Promise<void>>();
  const originApprovals = new Map<string, OriginApproval>();
  const importReceipts = new Map<string, ImportReceipt>();

  return {
    tool: {
      artifact: tool({
        description: TOOL_DESCRIPTION,
        args: {
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .regex(/^\S+$/)
            .optional()
            .describe(
              "Existing Panes artifact ID when creating a new revision. Omit only for a new artifact.",
            ),
          title: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("Short human-readable artifact title."),
          type: tool.schema
            .enum(["html", "react", "svg", "mermaid", "markdown", "code"])
            .describe("Renderer for this artifact."),
          source: tool.schema
            .string()
            .min(1)
            .describe(
              `Complete standalone artifact source, limited to ${MAX_ARTIFACT_SOURCE_BYTES} UTF-8 bytes.`,
            ),
        },
        async execute(args, context) {
          if (args.artifactId) {
            return updateArtifact(
              { ...args, artifactId: args.artifactId },
              context,
              options,
            );
          }

          return createArtifact(
            {
              title: args.title,
              type: args.type,
              source: args.source,
            },
            context,
            options,
          );
        },
      }),
      artifact_prepare: tool({
        description:
          "Prepare a project-local Panes artifact or its next writable Draft. This never contacts Cloudflare, changes Git state, or creates a preview. Use normal filesystem tools to create Draft files, then use the finalize tool.",
        args: {
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe(
              "Existing local artifact ID when preparing its next Draft.",
            ),
          name: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("Existing artifact title or slug to resolve."),
          title: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("Title for a new local artifact."),
          slug: tool.schema
            .string()
            .trim()
            .min(1)
            .max(128)
            .optional()
            .describe("Optional safe artifact directory slug."),
          kind: tool.schema
            .string()
            .trim()
            .min(1)
            .max(MAX_ARTIFACT_KIND_LENGTH)
            .optional()
            .describe("Optional descriptive artifact kind."),
          requestedOrigins: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "HTTP(S) origins requested by the Draft, defaulting to none.",
            ),
          draftAction: tool.schema
            .enum(["resume", "discard"])
            .optional()
            .describe("Explicitly resume or discard an existing Draft."),
          revision: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Reopen this finalized Revision instead of preparing a Draft.",
            ),
          idempotencyKey: tool.schema
            .string()
            .trim()
            .min(1)
            .max(256)
            .optional()
            .describe(
              "Stable key for safely repeating this preparation request.",
            ),
        },
        async execute(args, context) {
          return prepareArtifact(args, context, locks, previewServer);
        },
      }),
      artifact_import: tool({
        description:
          "Import one existing file or directory into a project-local Panes Draft through a temporary copy. The source is never changed by ordinary import. A verification receipt is returned for a separate, explicitly confirmed source deletion.",
        args: {
          sourcePath: tool.schema
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Existing file or directory to copy."),
          source: tool.schema
            .string()
            .optional()
            .describe(
              "One-file convenience source text. Use filename with this form.",
            ),
          filename: tool.schema
            .string()
            .min(1)
            .max(1024)
            .optional()
            .describe("Destination path for one-file source convenience."),
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .regex(/^\S+$/)
            .optional()
            .describe("Existing local Artifact ID to receive the import."),
          title: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("Title for a new imported Artifact."),
          slug: tool.schema
            .string()
            .trim()
            .min(1)
            .max(128)
            .optional()
            .describe("Safe directory slug for a new imported Artifact."),
          kind: tool.schema
            .string()
            .trim()
            .min(1)
            .max(MAX_ARTIFACT_KIND_LENGTH)
            .optional()
            .describe("Optional descriptive kind for a new Artifact."),
          destinationPath: tool.schema
            .string()
            .min(1)
            .max(1024)
            .optional()
            .describe(
              "Relative Draft path. Directory sources default to the Draft root.",
            ),
          collision: tool.schema
            .enum(["error", "replace"])
            .optional()
            .describe("Required as replace when an import destination exists."),
          verificationReceipt: tool.schema
            .string()
            .min(1)
            .max(128)
            .optional()
            .describe("Receipt returned by a successful source import."),
          deleteSource: tool.schema
            .boolean()
            .optional()
            .describe("Request the separate source deletion action."),
          confirmDeletion: tool.schema
            .boolean()
            .optional()
            .describe("Explicitly confirm deletion of the verified source."),
        },
        async execute(args, context) {
          return importArtifact(args, context, locks, importReceipts);
        },
      }),
      artifact_discover: tool({
        description:
          "Scan the current project artifact root for valid local Panes manifests. Ambiguous names return choices without changing files.",
        args: {
          query: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("Exact artifact ID, slug, or title to resolve."),
        },
        async execute(args, context) {
          return discoverArtifacts(args, context);
        },
      }),
      artifact_reopen: tool({
        description:
          "Reopen a finalized local Panes Revision with a fresh process-local loopback preview URL. This never creates a Draft.",
        args: {
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .regex(/^\S+$/)
            .optional()
            .describe("Exact local artifact ID."),
          name: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("Artifact title or slug when an ID is unavailable."),
          revision: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Finalized Revision number, defaulting to the latest Revision.",
            ),
          draftAction: tool.schema
            .enum(["discard"])
            .optional()
            .describe(
              "Explicitly discard an abandoned Draft before reopening.",
            ),
        },
        async execute(args, context) {
          return reopenArtifact(args, context, previewServer, locks);
        },
      }),
      artifact_finalize: tool({
        description:
          "Finalize a prepared local Panes Draft after validating its Preview entry, then return a temporary loopback Local preview URL. This never contacts Cloudflare.",
        args: {
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .regex(/^\S+$/)
            .describe("Local artifact ID returned by artifact_prepare."),
          entryPath: tool.schema
            .string()
            .min(1)
            .max(1024)
            .describe("Relative POSIX path to the Preview entry in Draft."),
          adapter: tool.schema
            .enum(["browser", "renderer"])
            .describe("Preview adapter to validate and serve."),
          renderer: tool.schema
            .enum(["react", "markdown", "mermaid", "code"])
            .optional()
            .describe("Panes renderer when adapter is renderer."),
          requestedOrigins: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Normalized origins declared by the Draft."),
          approvedOrigins: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Exact origins approved for a nonce-confirmed Finalize."),
          approvalNonce: tool.schema
            .string()
            .trim()
            .min(1)
            .max(512)
            .optional()
            .describe(
              "One-time nonce returned when origin approval is required.",
            ),
        },
        async execute(args, context) {
          return finalizeArtifact(
            args,
            context,
            previewServer,
            locks,
            originApprovals,
            options,
          );
        },
      }),
      artifact_sync: tool({
        description:
          "Sync every unsynced finalized local Revision in order to private Cloudflare storage. This never publishes an artifact.",
        args: {
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .regex(/^\S+$/)
            .describe("Local artifact ID returned by artifact_prepare."),
          openCreatorAfterSuccess: tool.schema
            .boolean()
            .optional()
            .describe(
              "Open the returned 30-day Creator link after Sync succeeds.",
            ),
        },
        async execute(args, context) {
          return syncArtifact(args, context, locks, options);
        },
      }),
    },
  };
};

export default OpenCodePanesPlugin;

type PrepareArguments = {
  artifactId?: string | undefined;
  name?: string | undefined;
  title?: string | undefined;
  slug?: string | undefined;
  kind?: string | undefined;
  requestedOrigins?: string[] | undefined;
  draftAction?: "resume" | "discard" | undefined;
  revision?: number | undefined;
  idempotencyKey?: string | undefined;
};

type PrepareOperation = "created" | "prepared" | "imported";

type ImportArguments = {
  sourcePath?: string | undefined;
  source?: string | undefined;
  filename?: string | undefined;
  artifactId?: string | undefined;
  title?: string | undefined;
  slug?: string | undefined;
  kind?: string | undefined;
  destinationPath?: string | undefined;
  collision?: "error" | "replace" | undefined;
  verificationReceipt?: string | undefined;
  deleteSource?: boolean | undefined;
  confirmDeletion?: boolean | undefined;
};

interface ImportReceipt {
  token: string;
  sourcePath: string;
  sourceSnapshot: SourceSnapshot;
  artifactId: string;
  artifactDirectory: string;
  operationId: string;
  expiresAt: number;
}

interface ImportResult extends PrepareResult {
  operation: "imported";
  sourcePath?: string | undefined;
  sourceKind?: "file" | "directory" | undefined;
  verificationReceipt?: string | undefined;
  receiptExpiresAt?: string | undefined;
}

interface SourceEntry {
  path: string;
  kind: "file" | "directory";
  mode: number;
  sha256?: string | undefined;
  byteSize: number;
}

interface SourceSnapshot {
  kind: "file" | "directory";
  entries: SourceEntry[];
  digest: string;
}

interface ImportJournal {
  schemaVersion: 1;
  phase: "staged" | "installed";
  artifactId: string;
  stagingPath: string;
  draftPath: string;
  draftMetadataPath: string;
  prepareStatePath: string;
  destinationPath?: string | undefined;
  draft: Draft;
  result: ImportResult;
  files: ArtifactFile[];
}

type ReopenArguments = {
  artifactId?: string | undefined;
  name?: string | undefined;
  revision?: number | undefined;
  draftAction?: "discard" | undefined;
};

interface DiscoveredArtifact {
  projectId: string;
  artifactId: string;
  slug: string;
  title: string;
  kind?: string | undefined;
  artifactPath: string;
  revisions: number[];
  latestRevision: number | null;
  hasDraft: boolean;
  hasFinalizationJournal: boolean;
  integrity: "valid" | "modified" | "needs-recovery";
}

interface PrepareResult {
  operation: PrepareOperation;
  projectId: string;
  artifactId: string;
  slug: string;
  title: string;
  draftPath: string;
  manifestPath: string;
  draftMetadataPath: string;
  baseRevision: number | null;
  requestedOrigins: string[];
}

interface StoredPrepareState {
  idempotencyKey?: string;
  requestHash: string;
  result: PrepareResult;
}

async function prepareArtifact(
  args: PrepareArguments,
  context: ToolContext,
  locks: Map<string, Promise<void>>,
  previewServer: LocalPreviewServer,
) {
  const request = validatePrepareArguments(args);
  const project = await resolveLocalProject(context);

  if (request.artifactId || request.name) {
    const existing = await resolveArtifact(
      project.artifactRoot,
      request.artifactId,
      request.name,
    );
    if (!existing) {
      throw new Error(
        `No local artifact matching ${JSON.stringify(request.artifactId ?? request.name)} was found under ${project.artifactRoot}.`,
      );
    }
    return withArtifactLock(locks, existing.artifactDirectory, async () => {
      if (request.revision !== undefined) {
        return reopenExistingArtifact(
          existing,
          request.revision,
          request.draftAction,
          previewServer,
        );
      }
      return prepareExistingArtifact(existing, request);
    });
  }

  await mkdir(project.artifactRoot, { recursive: true });
  const slug = request.slug ?? slugify(request.title);
  const existing = await readArtifactDirectory(
    join(project.artifactRoot, slug),
  );
  if (existing) {
    const state = await readPrepareState(
      join(existing.artifactDirectory, PREPARE_STATE_FILE_NAME),
    );
    if (
      state &&
      state.requestHash === request.requestHash &&
      state.idempotencyKey === request.idempotencyKey
    ) {
      return prepareToolResult(state.result);
    }
    throw new Error(
      `Artifact slug ${JSON.stringify(slug)} already exists. Choose a different slug or provide its artifactId explicitly.`,
    );
  }

  const artifactDirectory = join(project.artifactRoot, slug);
  await mkdir(artifactDirectory);
  return withArtifactLock(locks, artifactDirectory, async () => {
    const artifactId = `artifact-${randomUUID()}`;
    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      projectId: project.projectId,
      artifactId,
      slug,
      title: request.title,
      ...(request.kind ? { kind: request.kind } : {}),
      revisions: [],
    } satisfies ArtifactManifest;
    await writeJson(join(artifactDirectory, "artifact.json"), manifest);

    const result = await installDraft({
      artifactDirectory,
      manifest,
      requestedOrigins: request.requestedOrigins,
      operation: "created",
      request,
      now,
    });
    return prepareToolResult(result);
  });
}

async function importArtifact(
  args: ImportArguments,
  context: ToolContext,
  locks: Map<string, Promise<void>>,
  receipts: Map<string, ImportReceipt>,
) {
  const request = validateImportArguments(args);
  if (request.deleteSource) {
    return deleteImportedSource(request, context, receipts, locks);
  }

  const project = await resolveLocalProject(context);
  const sourcePath = request.sourcePath
    ? resolve(context.directory, request.sourcePath)
    : undefined;
  const sourceSnapshot = sourcePath
    ? await snapshotSource(sourcePath)
    : undefined;
  const title =
    request.title ?? (sourcePath ? basename(sourcePath) : undefined);
  if (!title) throw validationError("A title is required for source text");
  if (title.length > 200)
    throw validationError("Title must be between 1 and 200 characters");
  const slug = request.slug ?? slugify(title);
  const artifactDirectory = join(project.artifactRoot, slug);
  assertImportDoesNotAliasArtifact(sourcePath, artifactDirectory);
  const destinationPath =
    request.destinationPath ??
    (sourceSnapshot?.kind === "file" && sourcePath
      ? relativePathSchema.parse(basename(sourcePath))
      : undefined);

  if (request.artifactId) {
    const existing = await findArtifact(
      project.artifactRoot,
      request.artifactId,
    );
    if (!existing) {
      throw new Error(
        `No local artifact with ID ${request.artifactId} was found under ${project.artifactRoot}.`,
      );
    }
    assertImportDoesNotAliasArtifact(sourcePath, existing.artifactDirectory);
    return withArtifactLock(locks, existing.artifactDirectory, async () => {
      await recoverFinalization(existing);
      await recoverImport(existing);
      const artifact = await readArtifactDirectory(existing.artifactDirectory);
      if (!artifact)
        throw new Error("The local artifact disappeared during import.");
      return installImportedDraft({
        artifact,
        sourcePath,
        sourceSnapshot,
        sourceText: request.source,
        destinationPath,
        collision: request.collision,
        receipts,
      });
    });
  }

  await mkdir(project.artifactRoot, { recursive: true });
  if (await pathExists(artifactDirectory)) {
    throw new Error(
      `Artifact slug ${JSON.stringify(slug)} already exists. Choose a different slug or provide its artifactId explicitly.`,
    );
  }
  const artifactId = `artifact-${randomUUID()}`;
  const now = new Date().toISOString();
  const manifest = artifactManifestSchema.parse({
    schemaVersion: 1,
    projectId: project.projectId,
    artifactId,
    slug,
    title,
    ...(request.kind ? { kind: request.kind } : {}),
    revisions: [],
  });
  await mkdir(artifactDirectory);
  try {
    await writeJson(join(artifactDirectory, "artifact.json"), manifest);
    return await withArtifactLock(locks, artifactDirectory, () =>
      installImportedDraft({
        artifact: { artifactDirectory, manifest },
        sourcePath,
        sourceSnapshot,
        sourceText: request.source,
        destinationPath,
        collision: request.collision,
        receipts,
        createdAt: now,
      }),
    );
  } catch (error) {
    await rm(artifactDirectory, { recursive: true, force: true });
    throw error;
  }
}

function validateImportArguments(args: ImportArguments) {
  const artifactId =
    args.artifactId === undefined
      ? undefined
      : artifactIdSchema.safeParse(args.artifactId);
  if (artifactId && !artifactId.success)
    throw validationError("Artifact ID is invalid");
  const sourcePath = args.sourcePath?.trim();
  if (args.sourcePath !== undefined && !sourcePath) {
    throw validationError("Source path must not be empty");
  }
  if (args.source !== undefined && args.sourcePath !== undefined) {
    throw validationError("Provide sourcePath or source text, not both");
  }
  if (args.source === undefined && args.sourcePath === undefined) {
    if (args.verificationReceipt === undefined || args.deleteSource !== true) {
      throw validationError(
        "An existing sourcePath or source text is required",
      );
    }
  }
  if (args.source !== undefined && args.filename === undefined) {
    throw validationError("filename is required with source text");
  }
  if (args.filename !== undefined && args.destinationPath !== undefined) {
    throw validationError("Provide filename or destinationPath, not both");
  }
  if (args.sourcePath !== undefined && args.filename !== undefined) {
    throw validationError("filename is only valid with source text");
  }
  const title = args.title?.trim();
  if (args.title !== undefined && (!title || title.length > 200)) {
    throw validationError("Title must be between 1 and 200 characters");
  }
  const slug =
    args.slug === undefined
      ? undefined
      : artifactSlugSchema.safeParse(args.slug.trim());
  if (slug && !slug.success)
    throw validationError(
      "Slug must use lowercase safe words separated by hyphens",
    );
  const kind = args.kind?.trim();
  if (
    args.kind !== undefined &&
    (!kind || kind.length > MAX_ARTIFACT_KIND_LENGTH)
  ) {
    throw validationError(
      `Kind must be at most ${MAX_ARTIFACT_KIND_LENGTH} characters`,
    );
  }
  const destinationInput = args.filename ?? args.destinationPath;
  const destination =
    destinationInput === undefined
      ? undefined
      : relativePathSchema.safeParse(destinationInput);
  if (destination && !destination.success) {
    throw validationError(
      "Import destination must be a safe relative POSIX path",
    );
  }
  if (
    args.collision !== undefined &&
    args.collision !== "error" &&
    args.collision !== "replace"
  ) {
    throw validationError("Import collision must be error or replace");
  }
  if (args.deleteSource === true) {
    if (!sourcePath) {
      throw validationError(
        "sourcePath is required to delete an imported source",
      );
    }
    if (!args.verificationReceipt) {
      throw validationError(
        "A verification receipt is required to delete a source",
      );
    }
    if (args.confirmDeletion !== true) {
      throw new Error(
        "Import source deletion requires explicit confirmation. Retry with confirmDeletion true.",
      );
    }
    if (
      args.title !== undefined ||
      args.slug !== undefined ||
      args.kind !== undefined ||
      args.destinationPath !== undefined ||
      args.collision !== undefined
    ) {
      throw validationError(
        "Source cleanup accepts only sourcePath, artifactId, verificationReceipt, and confirmDeletion",
      );
    }
  } else if (
    args.deleteSource !== undefined ||
    args.confirmDeletion !== undefined ||
    args.verificationReceipt !== undefined
  ) {
    throw validationError(
      "verificationReceipt and deletion confirmation are only valid for source cleanup",
    );
  }
  return {
    artifactId: artifactId?.success ? artifactId.data : undefined,
    sourcePath,
    source: args.source,
    title,
    slug: slug?.success ? slug.data : undefined,
    kind,
    destinationPath: destination?.success ? destination.data : undefined,
    collision: args.collision ?? "error",
    verificationReceipt: args.verificationReceipt,
    deleteSource: args.deleteSource === true,
    confirmDeletion: args.confirmDeletion === true,
  };
}

async function installImportedDraft(input: {
  artifact: LocalArtifact;
  sourcePath?: string | undefined;
  sourceSnapshot?: SourceSnapshot | undefined;
  sourceText?: string | undefined;
  destinationPath?: string | undefined;
  collision: "error" | "replace";
  receipts: Map<string, ImportReceipt>;
  createdAt?: string | undefined;
}) {
  const { artifact } = input;
  const draftPath = join(artifact.artifactDirectory, "draft");
  if (
    (await pathExists(draftPath)) ||
    (await pathExists(join(artifact.artifactDirectory, "draft.json"))) ||
    (await pathExists(
      join(artifact.artifactDirectory, PREPARE_STATE_FILE_NAME),
    ))
  ) {
    throw new Error(
      `Draft already exists for artifact ${artifact.manifest.artifactId}. Resume or discard it explicitly before importing.`,
    );
  }
  await verifyFinalizedRevisions(artifact);

  const stagingPath = join(
    artifact.artifactDirectory,
    `.panes-import-${randomUUID()}.tmp`,
  );
  let installed = false;
  try {
    const latestRevision = artifact.manifest.revisions.at(-1);
    if (latestRevision) {
      await cp(
        join(artifact.artifactDirectory, `v${latestRevision.version}`),
        stagingPath,
        { recursive: true, errorOnExist: true, force: false },
      );
    } else {
      await mkdir(stagingPath);
    }

    await importIntoStaging(
      stagingPath,
      input.sourcePath,
      input.sourceSnapshot,
      input.sourceText,
      input.destinationPath,
      input.collision,
    );
    const files = await scanRevisionFiles(stagingPath);
    if (input.sourcePath && input.sourceSnapshot) {
      const after = await snapshotSource(input.sourcePath);
      if (!sameSourceSnapshot(input.sourceSnapshot, after)) {
        throw new Error("Import source changed while it was being copied.");
      }
    }

    const now = input.createdAt ?? new Date().toISOString();
    const draft = draftSchemaParse({
      artifactId: artifact.manifest.artifactId,
      baseRevision: artifact.manifest.revisions.at(-1)?.version ?? null,
      requestedOrigins: [],
      createdAt: now,
      updatedAt: now,
    });
    const result: ImportResult = {
      operation: "imported",
      projectId: artifact.manifest.projectId,
      artifactId: artifact.manifest.artifactId,
      slug: artifact.manifest.slug,
      title: artifact.manifest.title,
      draftPath,
      manifestPath: join(artifact.artifactDirectory, "artifact.json"),
      draftMetadataPath: join(artifact.artifactDirectory, "draft.json"),
      baseRevision: draft.baseRevision,
      requestedOrigins: [],
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      ...(input.sourceSnapshot
        ? { sourceKind: input.sourceSnapshot.kind }
        : {}),
    };
    const draftMetadataPath = join(artifact.artifactDirectory, "draft.json");
    const prepareStatePath = join(
      artifact.artifactDirectory,
      PREPARE_STATE_FILE_NAME,
    );
    const journalPath = join(
      artifact.artifactDirectory,
      IMPORT_JOURNAL_FILE_NAME,
    );
    const journal: ImportJournal = {
      schemaVersion: 1,
      phase: "staged",
      artifactId: artifact.manifest.artifactId,
      stagingPath,
      draftPath,
      draftMetadataPath,
      prepareStatePath,
      draft,
      destinationPath: input.destinationPath,
      result,
      files,
    };
    await writeJsonDurable(journalPath, journal);
    await rename(stagingPath, draftPath);
    installed = true;
    journal.phase = "installed";
    await writeJsonDurable(journalPath, journal);
    await writeJsonDurable(draftMetadataPath, draft);
    await writeJsonDurable(prepareStatePath, {
      requestHash: importRequestHash(input),
      result: { ...result, operation: "prepared" },
    } satisfies StoredPrepareState);
    await unlink(journalPath);

    if (input.sourcePath && input.sourceSnapshot) {
      const token = `receipt-${randomUUID()}`;
      const receipt: ImportReceipt = {
        token,
        sourcePath: input.sourcePath,
        sourceSnapshot: input.sourceSnapshot,
        artifactId: artifact.manifest.artifactId,
        artifactDirectory: artifact.artifactDirectory,
        operationId: randomUUID(),
        expiresAt: Date.now() + IMPORT_RECEIPT_TTL_MS,
      };
      input.receipts.set(token, receipt);
      result.verificationReceipt = token;
      result.receiptExpiresAt = new Date(receipt.expiresAt).toISOString();
    }
    return importToolResult(result);
  } catch (error) {
    await unlink(
      join(artifact.artifactDirectory, IMPORT_JOURNAL_FILE_NAME),
    ).catch(() => undefined);
    if (installed) await rm(draftPath, { recursive: true, force: true });
    await unlink(join(artifact.artifactDirectory, "draft.json")).catch(
      () => undefined,
    );
    await unlink(
      join(artifact.artifactDirectory, PREPARE_STATE_FILE_NAME),
    ).catch(() => undefined);
    throw error;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

function importRequestHash(input: {
  sourcePath?: string | undefined;
  destinationPath?: string | undefined;
}) {
  return sha256(
    JSON.stringify({
      operation: "import",
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
    }),
  );
}

async function recoverImport(artifact: LocalArtifact) {
  const journalPath = join(
    artifact.artifactDirectory,
    IMPORT_JOURNAL_FILE_NAME,
  );
  if (!(await pathExists(journalPath))) {
    const entries = await readdir(artifact.artifactDirectory);
    for (const entry of entries) {
      if (entry.startsWith(".panes-import-") && entry.endsWith(".tmp")) {
        await rm(join(artifact.artifactDirectory, entry), {
          recursive: true,
          force: true,
        });
      }
    }
    return;
  }
  const journal = await readImportJournal(journalPath);
  if (journal.artifactId !== artifact.manifest.artifactId) {
    throw new Error("Import journal belongs to another artifact.");
  }
  if (
    dirname(resolve(journal.stagingPath)) !==
      resolve(artifact.artifactDirectory) ||
    !/^\.panes-import-[^/]+\.tmp$/u.test(basename(journal.stagingPath)) ||
    resolve(journal.draftPath) !==
      resolve(artifact.artifactDirectory, "draft") ||
    resolve(journal.draftMetadataPath) !==
      resolve(artifact.artifactDirectory, "draft.json") ||
    resolve(journal.prepareStatePath) !==
      resolve(artifact.artifactDirectory, PREPARE_STATE_FILE_NAME)
  ) {
    throw new Error("Import journal contains an unsafe path.");
  }
  const stagingExists = await pathExists(journal.stagingPath);
  const draftExists = await pathExists(journal.draftPath);
  if (stagingExists && draftExists) {
    throw new Error(
      "Import recovery found both staging and Draft directories.",
    );
  }
  if (stagingExists) {
    await rm(journal.stagingPath, { recursive: true, force: true });
    await unlink(journal.draftMetadataPath).catch(() => undefined);
    await unlink(journal.prepareStatePath).catch(() => undefined);
    await unlink(journalPath);
    return;
  }
  if (!draftExists) {
    await unlink(journal.draftMetadataPath).catch(() => undefined);
    await unlink(journal.prepareStatePath).catch(() => undefined);
    await unlink(journalPath);
    return;
  }
  await verifyRevisionFiles(journal.draftPath, journal.files);
  await writeJsonDurable(journal.draftMetadataPath, journal.draft);
  await writeJsonDurable(journal.prepareStatePath, {
    requestHash: importRequestHash({
      sourcePath: journal.result.sourcePath,
      destinationPath: journal.destinationPath,
    }),
    result: { ...journal.result, operation: "prepared" },
  } satisfies StoredPrepareState);
  await unlink(journalPath);
}

async function readImportJournal(path: string): Promise<ImportJournal> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Import journal at ${path} is malformed.`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Import journal at ${path} is invalid.`);
  }
  const journal = value as Partial<ImportJournal>;
  const draft = draftSchema.safeParse(journal.draft);
  const files = artifactFilesSchema.safeParse(journal.files);
  if (
    journal.schemaVersion !== 1 ||
    !["staged", "installed"].includes(String(journal.phase)) ||
    typeof journal.artifactId !== "string" ||
    typeof journal.stagingPath !== "string" ||
    typeof journal.draftPath !== "string" ||
    typeof journal.draftMetadataPath !== "string" ||
    typeof journal.prepareStatePath !== "string" ||
    !draft.success ||
    !files.success ||
    !journal.result ||
    typeof journal.result !== "object"
  ) {
    throw new Error(`Import journal at ${path} is invalid.`);
  }
  return {
    schemaVersion: 1,
    phase: journal.phase as ImportJournal["phase"],
    artifactId: journal.artifactId,
    stagingPath: journal.stagingPath,
    draftPath: journal.draftPath,
    draftMetadataPath: journal.draftMetadataPath,
    prepareStatePath: journal.prepareStatePath,
    ...(journal.destinationPath
      ? { destinationPath: journal.destinationPath }
      : {}),
    draft: draft.data,
    result: journal.result as ImportResult,
    files: files.data,
  };
}

function importToolResult(result: ImportResult) {
  const metadata = { ...result };
  return {
    title: `Imported ${result.title} Draft`,
    output: JSON.stringify(metadata),
    metadata,
  };
}

async function importIntoStaging(
  stagingPath: string,
  sourcePath: string | undefined,
  sourceSnapshot: SourceSnapshot | undefined,
  sourceText: string | undefined,
  destinationPath: string | undefined,
  collision: "error" | "replace",
) {
  const entries = sourceSnapshot
    ? importDestinationEntries(sourceSnapshot, destinationPath)
    : [
        {
          path: destinationPath as string,
          kind: "file" as const,
          mode: 0o644,
          byteSize: Buffer.byteLength(sourceText ?? "", "utf8"),
        },
      ];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (
      entries
        .slice(index + 1)
        .some((candidate) => importPathsConflict(candidate, entry))
    ) {
      throw new Error(
        `Import source contains colliding paths near ${JSON.stringify(entry.path)}.`,
      );
    }
  }
  const existing = await scanRevisionFiles(stagingPath);
  const conflicts = entries.filter((entry) =>
    existing.some((candidate) => importPathsConflict(candidate, entry)),
  );
  if (conflicts.length > 0 && collision !== "replace") {
    throw new Error(
      `Import destination collision at ${JSON.stringify(conflicts[0]?.path)}. Retry with collision "replace" or choose another destination.`,
    );
  }
  if (collision === "replace") {
    const removals = existing
      .filter((candidate) =>
        entries.some((entry) => shouldReplaceImportPath(candidate, entry)),
      )
      .map((entry) => entry.path)
      .sort((left, right) => right.length - left.length);
    for (const path of new Set(removals)) {
      await rm(join(stagingPath, path), { recursive: true, force: true });
    }
  }

  if (sourceSnapshot && sourcePath) {
    for (const entry of entries) {
      const sourceEntry = sourceSnapshot.entries.find(
        (candidate) =>
          candidate.path ===
          importSourceEntryPath(sourceSnapshot, entry.path, destinationPath),
      );
      if (!sourceEntry) {
        if (entry.kind === "directory")
          await mkdirSafe(join(stagingPath, entry.path));
        continue;
      }
      const sourceEntryPath = sourceEntry.path
        ? join(sourcePath, sourceEntry.path)
        : sourcePath;
      const target = join(stagingPath, entry.path);
      if (entry.kind === "directory") {
        await mkdirSafe(target);
        await chmod(target, entry.mode);
      } else {
        await assertNoSymlinkPath(sourceEntryPath);
        const bytes = await readSourceFile(sourceEntryPath);
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          sourceEntry.sha256
        ) {
          throw new Error("Import source changed while it was being copied.");
        }
        await writeStagedFile(target, bytes, entry.mode);
      }
    }
  } else {
    await writeStagedFile(
      join(stagingPath, destinationPath as string),
      Buffer.from(sourceText ?? "", "utf8"),
      0o644,
    );
  }
  return entries;
}

function importDestinationEntries(
  snapshot: SourceSnapshot,
  destinationPath: string | undefined,
) {
  return snapshot.entries.flatMap((entry) => {
    if (!entry.path && snapshot.kind === "file") {
      return [{ ...entry, path: destinationPath as string }];
    }
    if (!entry.path && !destinationPath) return [];
    const path = destinationPath
      ? entry.path
        ? `${destinationPath}/${entry.path}`
        : destinationPath
      : entry.path;
    return [{ ...entry, path }];
  });
}

function importSourceEntryPath(
  snapshot: SourceSnapshot,
  destinationEntryPath: string,
  destinationPath: string | undefined,
) {
  if (snapshot.kind === "file") return "";
  if (!destinationPath) return destinationEntryPath;
  if (destinationEntryPath === destinationPath) return "";
  return destinationEntryPath.slice(destinationPath.length + 1);
}

type ImportPathEntry = Pick<ArtifactFile, "path" | "kind">;

function importPathsConflict(
  existing: ImportPathEntry,
  incoming: ImportPathEntry,
) {
  const existingKey = importCollisionKey(existing.path);
  const incomingKey = importCollisionKey(incoming.path);
  return (
    existingKey === incomingKey ||
    (existing.kind === "file" && incomingKey.startsWith(`${existingKey}/`)) ||
    (incoming.kind === "file" && existingKey.startsWith(`${incomingKey}/`))
  );
}

function shouldReplaceImportPath(
  existing: ImportPathEntry,
  incoming: ImportPathEntry,
) {
  const existingKey = importCollisionKey(existing.path);
  const incomingKey = importCollisionKey(incoming.path);
  return (
    existingKey === incomingKey ||
    (incoming.kind === "directory" &&
      existingKey.startsWith(`${incomingKey}/`)) ||
    (existing.kind === "file" && incomingKey.startsWith(`${existingKey}/`))
  );
}

function importCollisionKey(path: string) {
  return path
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, "").toLocaleLowerCase())
    .join("/");
}

async function snapshotSource(sourcePath: string): Promise<SourceSnapshot> {
  await assertNoSymlinkPath(sourcePath);
  const root = await lstat(sourcePath);
  if (root.isSymbolicLink()) {
    throw new Error("Import sources must not be symlinks.");
  }
  if (!root.isFile() && !root.isDirectory()) {
    throw new Error("Import source must be a regular file or directory.");
  }
  const entries: SourceEntry[] = [];
  const visit = async (path: string, relativePath: string) => {
    await assertNoSymlinkPath(path);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Import source contains unsupported symlink ${JSON.stringify(relativePath || basename(path))}.`,
      );
    }
    const normalized = relativePath
      ? relativePathSchema.safeParse(relativePath)
      : { success: true as const, data: "" };
    if (!normalized.success) {
      throw new Error(
        `Import source contains an unsafe path ${JSON.stringify(relativePath)}.`,
      );
    }
    const mode = stats.mode & 0o7777;
    if (stats.isDirectory()) {
      entries.push({
        path: normalized.data,
        kind: "directory",
        mode,
        byteSize: 0,
      });
      const children = await readdir(path);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        const childPath = join(path, child);
        const childRelative = normalized.data
          ? `${normalized.data}/${child}`
          : child;
        await visit(childPath, childRelative);
      }
      return;
    }
    if (!stats.isFile()) {
      throw new Error(
        `Import source contains unsupported filesystem entry ${JSON.stringify(relativePath)}.`,
      );
    }
    const bytes = await readSourceFile(path);
    entries.push({
      path: normalized.data,
      kind: "file",
      mode,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    });
  };
  await visit(sourcePath, "");
  return {
    kind: root.isDirectory() ? "directory" : "file",
    entries,
    digest: sha256(JSON.stringify(entries)),
  };
}

async function readSourceFile(path: string) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error("Import source is no longer a regular file.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkPath(path: string) {
  let current = resolve(path);
  for (;;) {
    const stats = await lstat(current);
    if (
      stats.isSymbolicLink() &&
      !(platform() === "darwin" && ["/var", "/tmp"].includes(current))
    ) {
      throw new Error(`Import source path contains a symlink: ${path}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function mkdirSafe(path: string) {
  const existing = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Import destination is not a directory: ${path}`);
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path);
}

async function writeStagedFile(path: string, bytes: Buffer, mode: number) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

function sameSourceSnapshot(left: SourceSnapshot, right: SourceSnapshot) {
  return left.kind === right.kind && left.digest === right.digest;
}

function assertImportDoesNotAliasArtifact(
  sourcePath: string | undefined,
  artifactDirectory: string,
) {
  if (!sourcePath) return;
  const source = resolve(sourcePath);
  const artifact = resolve(artifactDirectory);
  if (isPathWithin(source, artifact) || isPathWithin(artifact, source)) {
    throw new Error(
      "Import source and destination must not alias the same Artifact state.",
    );
  }
}

function isPathWithin(path: string, parent: string) {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parent);
  return (
    resolvedPath === resolvedParent ||
    resolvedPath.startsWith(
      `${resolvedParent}${resolvedParent.endsWith("/") ? "" : "/"}`,
    )
  );
}

async function deleteImportedSource(
  request: ReturnType<typeof validateImportArguments>,
  context: ToolContext,
  receipts: Map<string, ImportReceipt>,
  locks: Map<string, Promise<void>>,
) {
  const token = request.verificationReceipt;
  if (!token)
    throw new Error("A verification receipt is required for source deletion.");
  const receipt = receipts.get(token);
  if (!receipt)
    throw new Error("The verification receipt is unknown or already consumed.");
  if (receipt.expiresAt <= Date.now()) {
    receipts.delete(token);
    throw new Error(
      "The verification receipt has expired. Import again before deleting the source.",
    );
  }
  if (!request.confirmDeletion) {
    throw new Error(
      "Import source deletion requires explicit confirmation. Retry with confirmDeletion true.",
    );
  }
  const sourcePath = resolve(context.directory, request.sourcePath ?? "");
  if (sourcePath !== receipt.sourcePath) {
    throw new Error(
      "The verification receipt does not match this source path.",
    );
  }
  if (request.artifactId && request.artifactId !== receipt.artifactId) {
    throw new Error("The verification receipt does not match this Artifact.");
  }
  return withArtifactLock(locks, receipt.artifactDirectory, async () => {
    const artifact = await readArtifactDirectory(receipt.artifactDirectory);
    if (!artifact || artifact.manifest.artifactId !== receipt.artifactId) {
      throw new Error(
        "The verification receipt no longer matches its destination Artifact.",
      );
    }
    const current = await snapshotSource(sourcePath);
    if (!sameSourceSnapshot(receipt.sourceSnapshot, current)) {
      throw new Error(
        "The imported source changed after verification; it was not deleted.",
      );
    }
    await rm(sourcePath, {
      recursive: receipt.sourceSnapshot.kind === "directory",
    });
    receipts.delete(token);
    return {
      title: "Deleted imported source",
      output: JSON.stringify({
        operation: "source-deleted",
        artifactId: receipt.artifactId,
        sourcePath,
        importOperationId: receipt.operationId,
      }),
      metadata: {
        operation: "source-deleted",
        artifactId: receipt.artifactId,
        sourcePath,
        importOperationId: receipt.operationId,
      },
    };
  });
}

async function prepareExistingArtifact(
  existing: LocalArtifact,
  request: ValidatedPrepareArguments,
) {
  await recoverFinalization(existing);
  await recoverImport(existing);
  const recovered = await readArtifactDirectory(existing.artifactDirectory);
  if (!recovered)
    throw new Error("The local artifact disappeared during recovery.");
  const { artifactDirectory, manifest } = recovered;
  if (request.title && request.title !== manifest.title) {
    throw new Error(
      `Artifact title is ${JSON.stringify(manifest.title)}. Retry with the stored title or omit title when preparing a revision.`,
    );
  }
  if (request.slug && request.slug !== manifest.slug) {
    throw new Error(
      `Artifact ID ${manifest.artifactId} uses slug ${JSON.stringify(manifest.slug)}.`,
    );
  }
  if (request.kind && request.kind !== manifest.kind) {
    throw new Error(
      `Artifact kind is ${JSON.stringify(manifest.kind ?? "unset")}. Retry without changing it.`,
    );
  }

  const draftDirectory = join(artifactDirectory, "draft");
  const draftMetadataPath = join(artifactDirectory, "draft.json");
  const prepareStatePath = join(artifactDirectory, PREPARE_STATE_FILE_NAME);
  const draftExists = await pathExists(draftDirectory);
  const draftMetadataExists = await pathExists(draftMetadataPath);
  const state = await readPrepareState(prepareStatePath);
  if (draftExists || draftMetadataExists || state) {
    if (
      state &&
      state.requestHash === request.requestHash &&
      state.idempotencyKey === request.idempotencyKey
    ) {
      return prepareToolResult(state.result);
    }
    if (request.draftAction === "resume") {
      if (!state) {
        throw new Error(
          `Draft for artifact ${manifest.artifactId} cannot be resumed because its preparation state is missing.`,
        );
      }
      return prepareToolResult(state.result);
    }
    if (request.draftAction !== "discard") {
      throw new Error(
        `Draft already exists for artifact ${manifest.artifactId}. Choose draftAction "resume" or "discard" explicitly.`,
      );
    }
    await rm(draftDirectory, { recursive: true, force: true });
    await unlink(draftMetadataPath).catch(() => undefined);
    await unlink(prepareStatePath).catch(() => undefined);
  }

  const now = new Date().toISOString();
  const result = await installDraft({
    artifactDirectory,
    manifest,
    requestedOrigins: request.requestedOrigins,
    operation: "prepared",
    request,
    now,
  });
  return prepareToolResult(result);
}

interface ValidatedPrepareArguments {
  artifactId?: string | undefined;
  name?: string | undefined;
  title: string;
  slug?: string | undefined;
  kind?: string | undefined;
  requestedOrigins: string[];
  draftAction?: "resume" | "discard" | undefined;
  revision?: number | undefined;
  idempotencyKey?: string | undefined;
  requestHash: string;
}

function validatePrepareArguments(
  args: PrepareArguments,
): ValidatedPrepareArguments {
  const artifactId =
    args.artifactId !== undefined
      ? artifactIdSchema.safeParse(args.artifactId)
      : undefined;
  if (artifactId && !artifactId.success)
    throw validationError("Artifact ID is invalid");

  const title = args.title?.trim();
  const name = args.name?.trim();
  if (args.name !== undefined && (!name || name.length > 200)) {
    throw validationError("Artifact name must be between 1 and 200 characters");
  }
  if (!artifactId?.success && !name && !title) {
    throw validationError("A title is required when creating an artifact");
  }
  if (args.title !== undefined && (!title || title.length > 200)) {
    throw validationError("Title must be between 1 and 200 characters");
  }

  const slug =
    args.slug !== undefined
      ? artifactSlugSchema.safeParse(args.slug.trim())
      : undefined;
  if (slug && !slug.success)
    throw validationError(
      "Slug must use lowercase safe words separated by hyphens",
    );

  const kind = args.kind?.trim();
  if (
    args.kind !== undefined &&
    (!kind || kind.length > MAX_ARTIFACT_KIND_LENGTH)
  ) {
    throw validationError(
      `Kind must be at most ${MAX_ARTIFACT_KIND_LENGTH} characters`,
    );
  }

  const origins = requestedOriginsSchema.safeParse(
    args.requestedOrigins === undefined ? [] : args.requestedOrigins,
  );
  if (!origins.success) {
    throw validationError("Requested origins must be unique HTTP(S) origins");
  }
  if (args.draftAction && !["resume", "discard"].includes(args.draftAction)) {
    throw validationError("Draft action must be resume or discard");
  }
  if (
    args.revision !== undefined &&
    !revisionNumberSchema.safeParse(args.revision).success
  ) {
    throw validationError("Revision must be a positive integer");
  }
  const idempotencyKey = args.idempotencyKey?.trim();
  if (
    args.idempotencyKey !== undefined &&
    (!idempotencyKey || idempotencyKey.length > 256)
  ) {
    throw validationError(
      "Idempotency key must be between 1 and 256 characters",
    );
  }

  const normalized = {
    artifactId: artifactId?.success ? artifactId.data : undefined,
    name,
    title,
    slug: slug?.success ? slug.data : undefined,
    kind: kind || undefined,
    requestedOrigins: origins.data,
    idempotencyKey,
  };
  return {
    ...normalized,
    name,
    title: title ?? "",
    draftAction: args.draftAction,
    revision: args.revision,
    requestHash: sha256(JSON.stringify(normalized)),
  };
}

async function installDraft(input: {
  artifactDirectory: string;
  manifest: ArtifactManifest;
  requestedOrigins: string[];
  operation: PrepareOperation;
  request: ValidatedPrepareArguments;
  now: string;
}) {
  const draftDirectory = join(input.artifactDirectory, "draft");
  const latestRevision = input.manifest.revisions.at(-1);
  if (latestRevision) {
    await cp(
      join(input.artifactDirectory, `v${latestRevision.version}`),
      draftDirectory,
      { recursive: true, errorOnExist: true, force: false },
    );
  } else {
    await mkdir(draftDirectory);
  }

  const draft = {
    artifactId: input.manifest.artifactId,
    baseRevision: latestRevision?.version ?? null,
    requestedOrigins: input.requestedOrigins,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const parsedDraft = draftSchemaParse(draft);
  const draftMetadataPath = join(input.artifactDirectory, "draft.json");
  await writeJson(draftMetadataPath, parsedDraft);
  const result: PrepareResult = {
    operation: input.operation,
    projectId: input.manifest.projectId,
    artifactId: input.manifest.artifactId,
    slug: input.manifest.slug,
    title: input.manifest.title,
    draftPath: draftDirectory,
    manifestPath: join(input.artifactDirectory, "artifact.json"),
    draftMetadataPath,
    baseRevision: parsedDraft.baseRevision,
    requestedOrigins: parsedDraft.requestedOrigins,
  };
  await writeJson(join(input.artifactDirectory, PREPARE_STATE_FILE_NAME), {
    ...(input.request.idempotencyKey
      ? { idempotencyKey: input.request.idempotencyKey }
      : {}),
    requestHash: input.request.requestHash,
    result,
  } satisfies StoredPrepareState);
  return result;
}

function draftSchemaParse(value: unknown) {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Could not create valid local Draft metadata");
  return parsed.data;
}

function prepareToolResult(result: PrepareResult) {
  const metadata = { ...result };
  return {
    title: `${result.operation === "created" ? "Created" : "Prepared"} ${result.title} Draft`,
    output: JSON.stringify(metadata),
    metadata,
  };
}

type FinalizeArguments = {
  artifactId: string;
  entryPath: string;
  adapter: "browser" | "renderer";
  renderer?: "react" | "markdown" | "mermaid" | "code" | undefined;
  requestedOrigins?: string[] | undefined;
  approvedOrigins?: string[] | undefined;
  approvalNonce?: string | undefined;
};

interface FinalizeResult {
  operation: "finalized" | "reopened";
  projectId: string;
  artifactId: string;
  title: string;
  version: number;
  revisionPath: string;
  manifestPath: string;
  preview: PreviewEntry;
  previewUrl: string;
}

interface OriginApprovalResult {
  operation: "approval-required";
  projectId: string;
  artifactId: string;
  title: string;
  preview: PreviewEntry;
  requestedOrigins: string[];
  approvalNonce: string;
}

interface OriginApproval {
  schemaVersion: 1;
  artifactId: string;
  approvalNonce: string;
  draftFingerprint: string;
  requestedOrigins: string[];
  preview: PreviewEntry;
}

type SyncArguments = {
  artifactId: string;
  openCreatorAfterSuccess?: boolean | undefined;
};

interface SyncResult {
  operation: "synced";
  artifactId: string;
  title: string;
  syncedVersion: number;
  pendingVersions: number[];
  creatorUrl: string;
  inventoryUrl: string;
  creatorExpiresAt: string;
  openCreatorAfterSuccess: AutoOpenStatus;
}

interface FinalizationJournal {
  schemaVersion: 1;
  phase: "prepared" | "renamed" | "manifest-replaced";
  artifactId: string;
  targetVersion: number;
  draftPath: string;
  revisionPath: string;
  revision: FinalizedRevision;
  manifest: ArtifactManifest;
}

async function syncArtifact(
  args: SyncArguments,
  context: ToolContext,
  locks: Map<string, Promise<void>>,
  options: ResolvedOptions,
) {
  const artifactId = artifactIdSchema.safeParse(args.artifactId);
  if (!artifactId.success) throw validationError("Artifact ID is invalid");
  if (
    args.openCreatorAfterSuccess !== undefined &&
    typeof args.openCreatorAfterSuccess !== "boolean"
  ) {
    throw validationError("openCreatorAfterSuccess must be a boolean");
  }

  const project = await resolveLocalProject(context);
  const existing = await findArtifact(project.artifactRoot, artifactId.data);
  if (!existing) {
    throw new Error(
      `No local artifact with ID ${artifactId.data} was found under ${project.artifactRoot}.`,
    );
  }
  return withArtifactLock(locks, existing.artifactDirectory, () =>
    syncLocalArtifact(
      existing,
      context,
      options,
      args.openCreatorAfterSuccess ?? false,
    ),
  );
}

async function syncLocalArtifact(
  existing: LocalArtifact,
  context: ToolContext,
  options: ResolvedOptions,
  openCreatorAfterSuccess: boolean,
) {
  await recoverFinalization(existing);
  await recoverImport(existing);
  const artifact = await readArtifactDirectory(existing.artifactDirectory);
  if (!artifact) throw new Error("The local artifact disappeared during Sync.");
  await verifyFinalizedRevisions(artifact);
  if (artifact.manifest.revisions.length === 0) {
    throw new Error("Sync requires at least one finalized Revision.");
  }
  if (
    (await pathExists(join(artifact.artifactDirectory, "draft"))) ||
    (await pathExists(join(artifact.artifactDirectory, "draft.json")))
  ) {
    throw new Error("Sync refuses an Artifact with an unfinished Draft.");
  }
  const panesIgnore = await readPanesIgnore(artifact.artifactDirectory);

  const checkpointPath = syncCheckpointPath(
    options.apiBaseUrl.origin,
    artifact.manifest.projectId,
    artifact.manifest.artifactId,
  );
  let state = await readSyncState(
    options.apiBaseUrl.origin,
    artifact.manifest.projectId,
    artifact.manifest.artifactId,
  );
  let checkpoint = await readSyncCheckpoint(checkpointPath);
  if (!state && artifact.manifest.cloud) {
    throw new Error(
      `Sync ownership state for artifact ${artifact.manifest.artifactId} is missing. Restore the protected Panes state before retrying.`,
    );
  }

  if (!state) {
    if (checkpoint) {
      if (
        checkpoint.apiOrigin !== options.apiBaseUrl.origin ||
        checkpoint.projectId !== artifact.manifest.projectId ||
        checkpoint.artifactId !== artifact.manifest.artifactId
      ) {
        throw new Error("Sync checkpoint does not match this local Artifact.");
      }
      if (checkpoint.phase === "identity") {
        state = syncStateFromCheckpoint(checkpoint);
        await writeSyncState(state);
      }
    }
  }

  if (!state) {
    if (!checkpoint) {
      const ownerCredential = `sync-owner-${randomUUID()}`;
      const creatorToken = `sync-creator-${randomUUID()}`;
      checkpoint = {
        schemaVersion: 1,
        phase: "planned",
        apiOrigin: options.apiBaseUrl.origin,
        projectId: artifact.manifest.projectId,
        artifactId: artifact.manifest.artifactId,
        creationIdempotencyKey: `sync-${randomUUID()}`,
        ownerCredential,
        creatorToken,
        cloudProjectId: "pending",
        cloudArtifactId: "pending",
        creatorUrl: "https://invalid.local/creator/pending",
        inventoryUrl: "https://invalid.local/inventory",
        creatorExpiresAt: new Date(0).toISOString(),
        syncedRevisionVersions: [],
        syncedRevisionManifests: [],
      };
      await writeSyncCheckpoint(checkpointPath, checkpoint);
      injectFailure(options, "sync-after-checkpoint");
    }
    if (checkpoint.phase !== "planned") {
      throw new Error("Sync checkpoint could not recover its cloud identity.");
    }

    await ensureUploadPermission(context, options.apiBaseUrl, {
      operation: "sync",
      title: artifact.manifest.title,
    });
    const createPayload = {
      projectId: artifact.manifest.projectId,
      artifactId: artifact.manifest.artifactId,
      slug: artifact.manifest.slug,
      title: artifact.manifest.title,
      ...(artifact.manifest.kind ? { kind: artifact.manifest.kind } : {}),
      idempotencyKey: checkpoint.creationIdempotencyKey,
      ownerCredential: checkpoint.ownerCredential,
      creatorToken: checkpoint.creatorToken,
    };
    const createResponse = await fetchPanes(
      new URL("/api/sync/artifacts", options.apiBaseUrl),
      {
        method: "POST",
        headers: jsonHeaders(undefined, options.createApiKey),
        body: JSON.stringify(createPayload),
      },
      context.abort,
      options.requestTimeoutMs,
    );
    const created = await parseApiResponse(
      createResponse,
      syncCreateResponseSchema,
      [
        ...(options.createApiKey ? [options.createApiKey] : []),
        checkpoint.ownerCredential,
        checkpoint.creatorToken,
      ],
    );
    const creatorUrl = validateCreatorUrl(
      created.creatorUrl,
      options.apiBaseUrl.origin,
      checkpoint.creatorToken,
    );
    const inventoryUrl = validateInventoryUrl(
      created.inventoryUrl,
      options.apiBaseUrl.origin,
    );
    checkpoint = {
      ...checkpoint,
      phase: "identity",
      cloudProjectId: created.cloudProjectId,
      cloudArtifactId: created.cloudArtifactId,
      creatorUrl,
      inventoryUrl,
      creatorExpiresAt: created.creatorExpiresAt,
    };
    await writeSyncCheckpoint(checkpointPath, checkpoint);
    state = syncStateFromCheckpoint(checkpoint);
    injectFailure(options, "sync-after-ownership");
    await writeSyncState(state);
  } else if (checkpoint && checkpoint.apiOrigin !== options.apiBaseUrl.origin) {
    throw new Error("Sync checkpoint belongs to another API origin.");
  }

  if (!state) throw new Error("Sync ownership state could not be recovered.");
  if (
    artifact.manifest.cloud &&
    (artifact.manifest.cloud.cloudProjectId !== state.cloudProjectId ||
      artifact.manifest.cloud.cloudArtifactId !== state.cloudArtifactId)
  ) {
    throw new Error(
      "The local cloud Artifact mapping conflicts with protected Sync state.",
    );
  }
  if (!artifact.manifest.cloud) {
    await writeJsonDurable(
      join(artifact.artifactDirectory, "artifact.json"),
      artifactManifestSchema.parse({
        ...artifact.manifest,
        cloud: {
          cloudProjectId: state.cloudProjectId,
          cloudArtifactId: state.cloudArtifactId,
        },
      }),
    );
    injectFailure(options, "sync-after-mapping");
  }

  const synced = new Set(state.syncedRevisionVersions);
  if (synced.size > 0 && !state.syncedRevisionManifests) {
    throw new Error(
      "Protected Sync state lacks filtered metadata for its committed Revisions. Restore the protected Panes state before retrying; Sync will not guess the prior cloud manifest.",
    );
  }
  if (synced.size > 0) {
    const committedVersions = [...synced].sort((left, right) => left - right);
    const storedVersions = new Set(
      state.syncedRevisionManifests!.map((revision) => revision.version),
    );
    if (
      storedVersions.size !== synced.size ||
      committedVersions.some(
        (version, index) =>
          version !== index + 1 || !storedVersions.has(version),
      )
    ) {
      throw new Error(
        "Protected Sync state has filtered metadata that does not correlate with its committed Revisions. Restore the protected Panes state before retrying.",
      );
    }
  }
  const pendingRevisions = artifact.manifest.revisions
    .filter((candidate) => !synced.has(candidate.version))
    .sort((left, right) => left.version - right.version);
  let lastSyncedVersion = state.syncedRevisionVersions.at(-1) ?? 0;
  for (const revision of pendingRevisions) {
    const selectedFiles = selectedSyncFiles(revision, panesIgnore);
    if (
      mandatorySyncExclusion(revision.preview.entryPath) ||
      panesIgnore.ignores(revision.preview.entryPath)
    ) {
      throw new Error(
        `Sync cannot upload the excluded Preview entry ${JSON.stringify(revision.preview.entryPath)}.`,
      );
    }
    const currentRevision = deriveCloudManifest(artifact.manifest, [
      {
        version: revision.version,
        paths: selectedFiles.map((file) => file.path),
      },
    ]).revisions[0];
    if (!currentRevision)
      throw new Error("Current cloud Revision could not be derived.");
    const committedRevisionManifests = state.syncedRevisionManifests;
    const previousRevisions = [...synced]
      .sort((left, right) => left - right)
      .map((version) => {
        const stored = committedRevisionManifests?.find(
          (candidate) => candidate.version === version,
        );
        if (!stored) {
          throw new Error(
            `Protected Sync state lacks filtered metadata for committed Revision v${version}. Restore the protected Panes state before retrying.`,
          );
        }
        return stored;
      });
    const cloudManifest: CloudManifest = {
      schemaVersion: 1,
      projectId: state.cloudProjectId,
      artifactId: state.cloudArtifactId,
      slug: artifact.manifest.slug,
      title: artifact.manifest.title,
      ...(artifact.manifest.kind ? { kind: artifact.manifest.kind } : {}),
      revisions: [...previousRevisions, currentRevision],
    };
    for (const file of selectedFiles) {
      if (file.kind !== "file") continue;
      const bytes = await readFile(
        join(artifact.artifactDirectory, `v${revision.version}`, file.path),
      );
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== file.byteSize || actualHash !== file.sha256) {
        throw new Error(
          `Finalized Revision ${revision.version} changed while Sync was reading ${file.path}.`,
        );
      }
      const uploadResponse = await fetchPanes(
        new URL(
          `/api/sync/artifacts/${encodeURIComponent(state.cloudArtifactId)}/revisions/${revision.version}/files/${encodeURIComponent(file.path)}`,
          options.apiBaseUrl,
        ),
        {
          method: "PUT",
          headers: {
            ...jsonHeaders(state.ownerCredential),
            "content-type": file.mediaType,
            "x-panes-file-sha256": file.sha256,
            "x-panes-file-byte-size": String(file.byteSize),
          },
          body: bytes,
        },
        context.abort,
        options.requestTimeoutMs,
      );
      if (uploadResponse.status !== 204) {
        await parseApiResponse(
          uploadResponse,
          syncRevisionCommitResponseSchema,
          [state.ownerCredential],
        );
      }
    }
    injectFailure(options, "sync-after-upload");
    const commitResponse = await fetchPanes(
      new URL(
        `/api/sync/artifacts/${encodeURIComponent(state.cloudArtifactId)}/revisions/${revision.version}/commit`,
        options.apiBaseUrl,
      ),
      {
        method: "POST",
        headers: jsonHeaders(state.ownerCredential),
        body: JSON.stringify({ manifest: cloudManifest }),
      },
      context.abort,
      options.requestTimeoutMs,
    );
    await parseApiResponse(commitResponse, syncRevisionCommitResponseSchema, [
      state.ownerCredential,
    ]);
    state = {
      ...state,
      syncedRevisionVersions: [
        ...new Set([...state.syncedRevisionVersions, revision.version]),
      ].sort((left, right) => left - right),
      syncedRevisionManifests: [
        ...(state.syncedRevisionManifests ?? []),
        currentRevision,
      ].sort((left, right) => left.version - right.version),
    };
    synced.add(revision.version);
    await writeSyncState(state);
    lastSyncedVersion = revision.version;
    injectFailure(options, "sync-after-commit");
  }

  await unlink(checkpointPath).catch(() => undefined);
  const pendingVersions = artifact.manifest.revisions
    .map((candidate) => candidate.version)
    .filter((version) => !state.syncedRevisionVersions.includes(version));
  const autoOpenStatus = await maybeOpenViewer(
    state.creatorUrl,
    context,
    openCreatorAfterSuccess,
  );
  return syncToolResult({
    operation: "synced",
    artifactId: artifact.manifest.artifactId,
    title: artifact.manifest.title,
    syncedVersion: lastSyncedVersion,
    pendingVersions,
    creatorUrl: state.creatorUrl,
    inventoryUrl: state.inventoryUrl,
    creatorExpiresAt: state.creatorExpiresAt,
    openCreatorAfterSuccess: autoOpenStatus,
  });
}

function syncStateFromCheckpoint(checkpoint: SyncCheckpoint): StoredSyncState {
  return {
    schemaVersion: 1,
    apiOrigin: checkpoint.apiOrigin,
    projectId: checkpoint.projectId,
    artifactId: checkpoint.artifactId,
    cloudProjectId: checkpoint.cloudProjectId,
    cloudArtifactId: checkpoint.cloudArtifactId,
    ownerCredential: checkpoint.ownerCredential,
    creatorUrl: checkpoint.creatorUrl,
    inventoryUrl: checkpoint.inventoryUrl,
    creatorExpiresAt: checkpoint.creatorExpiresAt,
    creationIdempotencyKey: checkpoint.creationIdempotencyKey,
    syncedRevisionVersions: checkpoint.syncedRevisionVersions,
    syncedRevisionManifests: checkpoint.syncedRevisionManifests ?? [],
  };
}

function mandatorySyncExclusion(path: string) {
  return path.split("/").some((segment) => {
    const lower = segment.toLocaleLowerCase();
    return (
      lower === ".panesignore" ||
      lower === "artifact.json" ||
      lower === "draft" ||
      lower === "draft.json" ||
      lower === ".git" ||
      lower === "node_modules" ||
      lower === "vendor" ||
      lower === ".cache" ||
      lower === ".parcel-cache" ||
      lower === ".vite" ||
      lower === ".turbo" ||
      lower === "__pycache__" ||
      lower === ".next" ||
      lower === ".nuxt" ||
      lower === "coverage" ||
      lower === ".env" ||
      lower.startsWith(".env.") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key") ||
      lower.endsWith(".p12")
    );
  });
}

async function readPanesIgnore(artifactDirectory: string): Promise<Ignore> {
  const path = join(artifactDirectory, ".panesignore");
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return ignore();
    throw error;
  }
  if (!stats.isFile()) {
    throw new Error("Artifact .panesignore must be a regular file.");
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(path),
    );
  } catch {
    throw new Error("Artifact .panesignore must contain valid UTF-8 rules.");
  }
  try {
    return ignore().add(contents);
  } catch (error) {
    throw new Error(
      `Artifact .panesignore contains invalid Gitignore rules: ${errorMessage(error)}`,
    );
  }
}

function selectedSyncFiles(revision: FinalizedRevision, panesIgnore: Ignore) {
  return revision.files.filter((file) => {
    if (mandatorySyncExclusion(file.path)) return false;
    const path = file.kind === "directory" ? `${file.path}/` : file.path;
    return !panesIgnore.ignores(path);
  });
}

async function finalizeArtifact(
  args: FinalizeArguments,
  context: ToolContext,
  previewServer: LocalPreviewServer,
  locks: Map<string, Promise<void>>,
  originApprovals: Map<string, OriginApproval>,
  options: ResolvedOptions,
) {
  const request = validateFinalizeArguments(args);
  const project = await resolveLocalProject(context);
  const existing = await findArtifact(project.artifactRoot, request.artifactId);
  if (!existing) {
    throw new Error(
      `No local artifact with ID ${request.artifactId} was found under ${project.artifactRoot}.`,
    );
  }

  return withArtifactLock(locks, existing.artifactDirectory, async () => {
    const recoveredRevision = await recoverFinalization(existing);
    await recoverImport(existing);
    const artifact = await readArtifactDirectory(existing.artifactDirectory);
    if (!artifact)
      throw new Error("The local artifact disappeared during finalization.");

    await verifyFinalizedRevisions(artifact);
    const draftPath = join(artifact.artifactDirectory, "draft");
    const draftMetadataPath = join(artifact.artifactDirectory, "draft.json");
    if (!(await pathExists(draftPath))) {
      if (request.approvalNonce && !recoveredRevision) {
        throw new Error(
          "The origin approval nonce is unknown or already consumed.",
        );
      }
      if (recoveredRevision) {
        if (request.approvalNonce) originApprovals.delete(request.artifactId);
        await verifyRevisionFiles(
          join(artifact.artifactDirectory, `v${recoveredRevision.version}`),
          recoveredRevision.files,
        );
        const previewToken = await previewServer.register({
          artifactId: artifact.manifest.artifactId,
          artifactDirectory: artifact.artifactDirectory,
          version: recoveredRevision.version,
          root: join(
            artifact.artifactDirectory,
            `v${recoveredRevision.version}`,
          ),
          files: recoveredRevision.files,
          preview: recoveredRevision.preview,
          approvedOrigins: recoveredRevision.approvedOrigins,
          reactRuntime: await reactRuntimeFor(recoveredRevision.preview),
          manifest: artifact.manifest,
        });
        await previewServer.probe(
          previewToken,
          recoveredRevision.preview.entryPath,
        );
        return finalizeToolResult({
          operation: "finalized",
          projectId: artifact.manifest.projectId,
          artifactId: artifact.manifest.artifactId,
          title: artifact.manifest.title,
          version: recoveredRevision.version,
          revisionPath: join(
            artifact.artifactDirectory,
            `v${recoveredRevision.version}`,
          ),
          manifestPath: join(artifact.artifactDirectory, "artifact.json"),
          preview: recoveredRevision.preview,
          previewUrl: previewServer.url(
            previewToken,
            recoveredRevision.preview.entryPath,
          ),
        });
      }
      throw new Error(
        `No writable Draft exists for artifact ${request.artifactId}. Prepare one before finalizing.`,
      );
    }
    const draft = await readDraftMetadata(draftMetadataPath);
    if (draft.artifactId !== request.artifactId) {
      throw new Error("Draft metadata does not belong to this artifact.");
    }
    const latestRevision = artifact.manifest.revisions.at(-1);
    if (draft.baseRevision !== (latestRevision?.version ?? null)) {
      throw new Error(
        "Draft is based on an older Revision. Prepare a new Draft before finalizing.",
      );
    }
    const requestedOrigins = resolveFinalizeOrigins(
      request,
      draft.requestedOrigins,
    );

    const draftStats = await lstat(draftPath);
    if (!draftStats.isDirectory() || draftStats.isSymbolicLink()) {
      throw new Error("Draft root must be a regular directory.");
    }
    const files = await scanRevisionFiles(draftPath, {
      materializeSymlinks: true,
    });
    const draftFingerprint = fingerprintDraft(files);
    const entryFile = files.find(
      (file) => file.kind === "file" && file.path === request.preview.entryPath,
    );
    if (!entryFile || entryFile.kind !== "file") {
      throw new Error(
        `Preview entry ${JSON.stringify(request.preview.entryPath)} must be an existing file in the Draft.`,
      );
    }
    validatePreviewFile(request.preview, entryFile);

    const approval = originApprovals.get(request.artifactId);
    if (requestedOrigins.length > 0) {
      if (!request.approvalNonce) {
        const validationToken = await previewServer.register({
          artifactId: request.artifactId,
          artifactDirectory: artifact.artifactDirectory,
          version: (latestRevision?.version ?? 0) + 1,
          root: draftPath,
          files,
          preview: request.preview,
          approvedOrigins: [],
          reactRuntime: await reactRuntimeFor(request.preview),
        });
        try {
          await previewServer.probe(validationToken, request.preview.entryPath);
        } finally {
          previewServer.remove(validationToken);
        }
        const approvalNonce = randomUUID();
        originApprovals.set(request.artifactId, {
          schemaVersion: 1,
          artifactId: request.artifactId,
          approvalNonce,
          draftFingerprint,
          requestedOrigins,
          preview: request.preview,
        });
        const result: OriginApprovalResult = {
          operation: "approval-required",
          projectId: artifact.manifest.projectId,
          artifactId: artifact.manifest.artifactId,
          title: artifact.manifest.title,
          preview: request.preview,
          requestedOrigins,
          approvalNonce,
        };
        return originApprovalToolResult(result);
      }
      if (
        !approval ||
        approval.approvalNonce !== request.approvalNonce ||
        approval.artifactId !== request.artifactId ||
        approval.draftFingerprint !== draftFingerprint ||
        !sameOriginSet(approval.requestedOrigins, requestedOrigins) ||
        JSON.stringify(approval.preview) !== JSON.stringify(request.preview)
      ) {
        originApprovals.delete(request.artifactId);
        throw new Error(
          "The origin approval nonce is invalid because the Draft, Preview, or origin set changed.",
        );
      }
    } else if (request.approvalNonce) {
      throw new Error(
        "An origin approval nonce requires the same non-empty approved origin set.",
      );
    }

    const targetVersion = (latestRevision?.version ?? 0) + 1;
    const revisionPath = join(artifact.artifactDirectory, `v${targetVersion}`);
    if (await pathExists(revisionPath)) {
      throw new Error(`Revision v${targetVersion} already exists.`);
    }
    const revision: FinalizedRevision = {
      id: `revision-${randomUUID()}`,
      version: targetVersion,
      preview: request.preview,
      approvedOrigins: requestedOrigins,
      files,
      createdAt: new Date().toISOString(),
    };
    const manifest = artifact.manifest;
    const nextManifest = artifactManifestSchema.parse({
      ...manifest,
      revisions: [...manifest.revisions, revision],
    });
    const journalPath = join(
      artifact.artifactDirectory,
      FINALIZE_JOURNAL_FILE_NAME,
    );
    const journal: FinalizationJournal = {
      schemaVersion: 1,
      phase: "prepared",
      artifactId: request.artifactId,
      targetVersion,
      draftPath,
      revisionPath,
      revision,
      manifest: nextManifest,
    };

    const previewToken = await previewServer.register({
      artifactId: request.artifactId,
      artifactDirectory: artifact.artifactDirectory,
      version: targetVersion,
      root: draftPath,
      files,
      preview: request.preview,
      approvedOrigins: requestedOrigins,
      reactRuntime: await reactRuntimeFor(request.preview),
    });
    try {
      await previewServer.probe(previewToken, request.preview.entryPath);
      await writeJsonDurable(journalPath, journal);
      injectFailure(options, "before-rename");
      await rename(draftPath, revisionPath);
      injectFailure(options, "after-rename");
      journal.phase = "renamed";
      await writeJsonDurable(journalPath, journal);
      await writeJsonDurable(
        join(artifact.artifactDirectory, "artifact.json"),
        nextManifest,
      );
      injectFailure(options, "after-manifest");
      journal.phase = "manifest-replaced";
      await writeJsonDurable(journalPath, journal);
      injectFailure(options, "before-cleanup");
      await unlink(journalPath);
      await removeDraftMetadata(artifact.artifactDirectory);
      originApprovals.delete(request.artifactId);
      previewServer.updateRoot(previewToken, revisionPath, nextManifest);
      return finalizeToolResult({
        operation: "finalized",
        projectId: nextManifest.projectId,
        artifactId: nextManifest.artifactId,
        title: nextManifest.title,
        version: targetVersion,
        revisionPath,
        manifestPath: join(artifact.artifactDirectory, "artifact.json"),
        preview: request.preview,
        previewUrl: previewServer.url(previewToken, request.preview.entryPath),
      });
    } catch (error) {
      if (!(error instanceof InjectedFailureError)) {
        previewServer.remove(previewToken);
      }
      throw error;
    }
  });
}

function validateFinalizeArguments(args: FinalizeArguments) {
  const artifactId = artifactIdSchema.safeParse(args.artifactId);
  if (!artifactId.success) throw validationError("Artifact ID is invalid");
  const entryPath = relativePathSchema.safeParse(args.entryPath);
  if (!entryPath.success) {
    throw validationError(
      "Preview entry path must be a safe relative POSIX path",
    );
  }
  const preview = previewEntrySchema.safeParse({
    adapter: args.adapter,
    entryPath: entryPath.data,
    ...(args.renderer === undefined ? {} : { renderer: args.renderer }),
  });
  if (!preview.success) {
    throw validationError(
      args.adapter === "renderer"
        ? "A renderer adapter requires one supported renderer"
        : "A browser adapter cannot specify a renderer",
    );
  }
  const requestedOrigins = parseFinalizeOrigins(args.requestedOrigins);
  const approvedOrigins = parseFinalizeOrigins(args.approvedOrigins);
  if (
    args.requestedOrigins !== undefined &&
    args.approvedOrigins !== undefined
  ) {
    throw validationError(
      "Finalize accepts requestedOrigins before approval or approvedOrigins with an approval nonce, not both",
    );
  }
  if (args.approvedOrigins !== undefined && !args.approvalNonce) {
    throw validationError("Approved origins require an approval nonce");
  }
  return {
    artifactId: artifactId.data,
    preview: preview.data,
    requestedOrigins,
    approvedOrigins,
    approvalNonce: args.approvalNonce,
  };
}

function parseFinalizeOrigins(origins: string[] | undefined) {
  if (origins === undefined) return undefined;
  const parsed = requestedOriginsSchema.safeParse(origins);
  if (!parsed.success)
    throw validationError("Finalize origins must be unique HTTP(S) origins");
  return parsed.data;
}

function resolveFinalizeOrigins(
  request: ReturnType<typeof validateFinalizeArguments>,
  draftOrigins: string[],
) {
  const declaredOrigins =
    request.requestedOrigins ?? request.approvedOrigins ?? draftOrigins;
  if (!sameOriginSet(declaredOrigins, draftOrigins)) {
    throw new Error(
      "Finalize origin declarations must exactly match the Draft requested origins.",
    );
  }
  return declaredOrigins;
}

function sameOriginSet(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left]
      .sort()
      .every((origin, index) => origin === [...right].sort()[index])
  );
}

function fingerprintDraft(files: readonly ArtifactFile[]) {
  return sha256(
    JSON.stringify(
      files.map((file) =>
        file.kind === "file"
          ? {
              kind: file.kind,
              path: file.path,
              sha256: file.sha256,
              byteSize: file.byteSize,
            }
          : { kind: file.kind, path: file.path },
      ),
    ),
  );
}

function originApprovalToolResult(result: OriginApprovalResult) {
  const metadata = { ...result };
  return {
    title: `Approval required for ${result.title} v1 preview`,
    output: JSON.stringify(metadata),
    metadata,
  };
}

function validatePreviewFile(
  preview: PreviewEntry,
  file: Extract<ArtifactFile, { kind: "file" }>,
) {
  const extension = file.path.includes(".")
    ? file.path.slice(file.path.lastIndexOf(".")).toLowerCase()
    : "";
  if (preview.adapter === "browser") {
    if (file.mediaType !== "text/html" && file.mediaType !== "image/svg+xml") {
      throw new Error(
        "Browser Preview entries must be HTML, SVG, or browser-built output with an HTML/SVG entry.",
      );
    }
    return;
  }
  const renderer = preview.renderer;
  const allowed: Record<
    Extract<PreviewEntry, { adapter: "renderer" }>["renderer"],
    string[]
  > = {
    react: [".js", ".jsx", ".mjs", ".ts", ".tsx"],
    markdown: [".md", ".markdown"],
    mermaid: [".mmd", ".mermaid"],
    code: [],
  };
  if (renderer !== "code" && !allowed[renderer].includes(extension)) {
    throw new Error(
      `The ${renderer} renderer cannot use ${JSON.stringify(file.path)} as its entry.`,
    );
  }
  if (
    file.mediaType.startsWith("image/") ||
    file.mediaType === "application/octet-stream"
  ) {
    throw new Error("Renderer Preview entries must contain text source.");
  }
}

function reactRuntimeFor(preview: PreviewEntry) {
  return preview.adapter === "renderer" && preview.renderer === "react"
    ? getReactBrowserRuntime()
    : undefined;
}

function finalizeToolResult(result: FinalizeResult) {
  const metadata = { ...result };
  return {
    title: `${result.operation === "reopened" ? "Reopened" : "Finalized"} ${result.title} v${result.version}`,
    output: JSON.stringify(metadata),
    metadata,
  };
}

interface LocalArtifact {
  artifactDirectory: string;
  manifest: ArtifactManifest;
}

async function discoverArtifacts(
  args: { query?: string | undefined },
  context: ToolContext,
) {
  const query = args.query?.trim();
  if (args.query !== undefined && (!query || query.length > 200)) {
    throw validationError(
      "Artifact query must be between 1 and 200 characters",
    );
  }
  const project = await resolveLocalProject(context, false);
  const artifacts = await scanLocalArtifacts(project.artifactRoot);
  const matches = query ? resolveArtifactMatches(artifacts, query) : artifacts;
  const resolution = query
    ? matches.length === 0
      ? "none"
      : matches.length === 1
        ? "single"
        : "ambiguous"
    : "all";
  const visible = matches.map((artifact) => artifact.discovery);
  const metadata = {
    operation: "discovered" as const,
    projectId: project.projectId,
    artifactRoot: project.artifactRoot,
    resolution,
    ...(resolution === "ambiguous" ? { choices: visible } : {}),
    artifacts: visible,
  };
  return {
    title: "Discovered local artifacts",
    output: JSON.stringify(metadata),
    metadata,
  };
}

async function reopenArtifact(
  args: ReopenArguments,
  context: ToolContext,
  previewServer: LocalPreviewServer,
  locks: Map<string, Promise<void>>,
) {
  const artifactId = args.artifactId;
  if (
    artifactId !== undefined &&
    !artifactIdSchema.safeParse(artifactId).success
  ) {
    throw validationError("Artifact ID is invalid");
  }
  const name = args.name?.trim();
  if (args.name !== undefined && (!name || name.length > 200)) {
    throw validationError("Artifact name must be between 1 and 200 characters");
  }
  if (
    args.revision !== undefined &&
    !revisionNumberSchema.safeParse(args.revision).success
  ) {
    throw validationError("Revision must be a positive integer");
  }
  if (!artifactId && !name) {
    throw validationError(
      "An artifactId or name is required to reopen an artifact",
    );
  }
  if (args.draftAction !== undefined && args.draftAction !== "discard") {
    throw validationError("Draft action must be discard");
  }
  const project = await resolveLocalProject(context, false);
  const existing = await resolveArtifact(
    project.artifactRoot,
    artifactId,
    name,
  );
  if (!existing) {
    throw new Error(
      `No local artifact matching ${JSON.stringify(artifactId ?? name)} was found under ${project.artifactRoot}.`,
    );
  }
  return withArtifactLock(locks, existing.artifactDirectory, () =>
    reopenExistingArtifact(
      existing,
      args.revision,
      args.draftAction,
      previewServer,
    ),
  );
}

async function reopenExistingArtifact(
  existing: LocalArtifact,
  version: number | undefined,
  draftAction: "discard" | "resume" | undefined,
  previewServer: LocalPreviewServer,
) {
  await recoverFinalization(existing);
  await recoverImport(existing);
  const artifact = await readArtifactDirectory(existing.artifactDirectory);
  if (!artifact)
    throw new Error("The local artifact disappeared during recovery.");
  await verifyFinalizedRevisions(artifact);

  const draftDirectory = join(artifact.artifactDirectory, "draft");
  const draftMetadata = join(artifact.artifactDirectory, "draft.json");
  const prepareState = join(
    artifact.artifactDirectory,
    PREPARE_STATE_FILE_NAME,
  );
  if (
    (await pathExists(draftDirectory)) ||
    (await pathExists(draftMetadata)) ||
    (await pathExists(prepareState))
  ) {
    if (draftAction !== "discard") {
      throw new Error(
        `Draft already exists for artifact ${artifact.manifest.artifactId}. Choose draftAction "discard" to reopen without it, or resume it with artifact_prepare.`,
      );
    }
    await rm(draftDirectory, { recursive: true, force: true });
    await removeDraftMetadata(artifact.artifactDirectory);
  }

  const revision =
    version === undefined
      ? artifact.manifest.revisions.at(-1)
      : artifact.manifest.revisions.find(
          (candidate) => candidate.version === version,
        );
  if (!revision) {
    throw new Error(
      version === undefined
        ? `Artifact ${artifact.manifest.artifactId} has no finalized Revisions to reopen.`
        : `Revision v${version} does not exist for artifact ${artifact.manifest.artifactId}.`,
    );
  }
  const revisionPath = join(artifact.artifactDirectory, `v${revision.version}`);
  await verifyRevisionFiles(revisionPath, revision.files);
  const token = await previewServer.register({
    artifactId: artifact.manifest.artifactId,
    artifactDirectory: artifact.artifactDirectory,
    version: revision.version,
    root: revisionPath,
    files: revision.files,
    preview: revision.preview,
    approvedOrigins: revision.approvedOrigins,
    reactRuntime: await reactRuntimeFor(revision.preview),
    manifest: artifact.manifest,
  });
  try {
    await previewServer.probe(token, revision.preview.entryPath);
  } catch (error) {
    previewServer.remove(token);
    throw error;
  }
  return finalizeToolResult({
    operation: "reopened",
    projectId: artifact.manifest.projectId,
    artifactId: artifact.manifest.artifactId,
    title: artifact.manifest.title,
    version: revision.version,
    revisionPath,
    manifestPath: join(artifact.artifactDirectory, "artifact.json"),
    preview: revision.preview,
    previewUrl: previewServer.url(token, revision.preview.entryPath),
  });
}

async function scanLocalArtifacts(artifactRoot: string) {
  let entries;
  try {
    entries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const artifacts: Array<{
    artifact: LocalArtifact;
    discovery: DiscoveredArtifact;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const artifact = await readArtifactDirectory(
        join(artifactRoot, entry.name),
      );
      if (!artifact) continue;
      const hasDraft =
        (await pathExists(join(artifact.artifactDirectory, "draft"))) ||
        (await pathExists(join(artifact.artifactDirectory, "draft.json"))) ||
        (await pathExists(
          join(artifact.artifactDirectory, PREPARE_STATE_FILE_NAME),
        ));
      const hasFinalizationJournal = await pathExists(
        join(artifact.artifactDirectory, FINALIZE_JOURNAL_FILE_NAME),
      );
      let integrity: DiscoveredArtifact["integrity"] = hasFinalizationJournal
        ? "needs-recovery"
        : "valid";
      if (!hasFinalizationJournal) {
        try {
          await verifyFinalizedRevisions(artifact);
        } catch {
          integrity = "modified";
        }
      }
      const revisions = artifact.manifest.revisions.map(
        (revision) => revision.version,
      );
      artifacts.push({
        artifact,
        discovery: {
          projectId: artifact.manifest.projectId,
          artifactId: artifact.manifest.artifactId,
          slug: artifact.manifest.slug,
          title: artifact.manifest.title,
          ...(artifact.manifest.kind ? { kind: artifact.manifest.kind } : {}),
          artifactPath: artifact.artifactDirectory,
          revisions,
          latestRevision: revisions.at(-1) ?? null,
          hasDraft,
          hasFinalizationJournal,
          integrity,
        },
      });
    } catch {
      // Discovery reports valid manifests only. A malformed or unsafe entry is
      // left untouched for the creator to inspect or restore from Git.
    }
  }
  return artifacts;
}

function resolveArtifactMatches(
  artifacts: Array<{ artifact: LocalArtifact; discovery: DiscoveredArtifact }>,
  query: string,
) {
  const exact = artifacts.filter(
    ({ discovery }) =>
      discovery.artifactId === query || discovery.slug === query,
  );
  if (exact.length > 0) return exact;
  const folded = query.toLocaleLowerCase();
  return artifacts.filter(
    ({ discovery }) => discovery.title.toLocaleLowerCase() === folded,
  );
}

async function resolveArtifact(
  artifactRoot: string,
  artifactId?: string,
  name?: string,
) {
  const artifacts = await scanLocalArtifacts(artifactRoot);
  const matches = resolveArtifactMatches(artifacts, artifactId ?? name ?? "");
  if (matches.length > 1) {
    const choices = matches.map(
      ({ discovery }) =>
        `${discovery.title} (${discovery.artifactId}, ${discovery.slug})`,
    );
    throw new Error(
      `Artifact name ${JSON.stringify(name)} is ambiguous. Choose one of: ${choices.join(", ")}.`,
    );
  }
  return matches[0]?.artifact;
}

async function findArtifact(artifactRoot: string, artifactId: string) {
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const artifact = await readArtifactDirectory(
      join(artifactRoot, entry.name),
    );
    if (artifact?.manifest.artifactId === artifactId) return artifact;
  }
  return undefined;
}

async function readArtifactDirectory(artifactDirectory: string) {
  let directoryStat;
  try {
    directoryStat = await lstat(artifactDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`Artifact path ${artifactDirectory} is not a directory.`);
  }
  try {
    const value = JSON.parse(
      await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
    );
    const parsed = artifactManifestSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Artifact manifest at ${artifactDirectory} is invalid.`);
    }
    return { artifactDirectory, manifest: parsed.data } satisfies LocalArtifact;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readPrepareState(
  path: string,
): Promise<StoredPrepareState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.requestHash !== "string"
    ) {
      throw new Error(`Preparation state at ${path} is invalid.`);
    }
    return value as StoredPrepareState;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readDraftMetadata(path: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Draft metadata is missing at ${path}.`);
    }
    throw new Error(`Draft metadata at ${path} is malformed.`);
  }
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Draft metadata at ${path} is invalid.`);
  return parsed.data;
}

async function scanRevisionFiles(
  root: string,
  options: { materializeSymlinks?: boolean } = {},
): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  const rootRealPath = options.materializeSymlinks
    ? await realpath(root)
    : undefined;

  async function visit(directory: string, relativeDirectory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const normalized = relativePathSchema.safeParse(relativePath);
      if (!normalized.success) {
        throw new Error(
          `Draft contains an unsafe path ${JSON.stringify(relativePath)}.`,
        );
      }
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        if (!options.materializeSymlinks || !rootRealPath) {
          throw new Error(
            `Finalized Revision contains an unexpected symlink ${JSON.stringify(relativePath)}.`,
          );
        }
        const target = await realpath(absolutePath).catch(() => undefined);
        if (
          !target ||
          (target !== rootRealPath &&
            !target.startsWith(
              `${rootRealPath}${process.platform === "win32" ? "\\" : "/"}`,
            ))
        ) {
          throw new Error(
            `Draft symlink escapes the Revision: ${JSON.stringify(relativePath)}.`,
          );
        }
        const targetStats = await lstat(target).catch(() => undefined);
        if (!targetStats?.isFile()) {
          throw new Error(
            `Draft symlink does not resolve to a regular file: ${JSON.stringify(relativePath)}.`,
          );
        }
        const bytes = await readFile(target);
        const temporary = join(directory, `.${randomUUID()}.symlink`);
        await writeFile(temporary, bytes, { mode: targetStats.mode & 0o7777 });
        try {
          await rename(temporary, absolutePath);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        const materializedStats = await lstat(absolutePath);
        const mode = materializedStats.mode & 0o7777;
        files.push({
          kind: "file",
          path: normalized.data,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.byteLength,
          mediaType: mediaTypeForPath(normalized.data, bytes),
          mode,
        });
        continue;
      }
      const mode = stats.mode & 0o7777;
      if (stats.isDirectory()) {
        files.push({
          kind: "directory",
          path: normalized.data,
          byteSize: 0,
          mode,
        });
        await visit(absolutePath, normalized.data);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(
          `Draft contains unsupported filesystem entry ${JSON.stringify(relativePath)}.`,
        );
      }
      const bytes = await readFile(absolutePath);
      files.push({
        kind: "file",
        path: normalized.data,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
        mediaType: mediaTypeForPath(normalized.data, bytes),
        mode,
      });
    }
  }

  await visit(root, "");
  const parsed = artifactFilesSchema.safeParse(files);
  if (!parsed.success)
    throw new Error("Draft files do not form a valid manifest.");
  return parsed.data;
}

async function verifyFinalizedRevisions(artifact: LocalArtifact) {
  const entries = await readdir(artifact.artifactDirectory, {
    withFileTypes: true,
  });
  const expectedDirectories = new Set(
    artifact.manifest.revisions.map((revision) => `v${revision.version}`),
  );
  for (const entry of entries) {
    if (/^v\d+$/u.test(entry.name) && !expectedDirectories.has(entry.name)) {
      throw new Error(`Found unexpected Revision directory ${entry.name}.`);
    }
  }
  for (const revision of artifact.manifest.revisions) {
    const path = join(artifact.artifactDirectory, `v${revision.version}`);
    let revisionStats;
    try {
      revisionStats = await lstat(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(
          `Finalized Revision v${revision.version} is missing from disk.`,
        );
      }
      throw error;
    }
    if (!revisionStats.isDirectory() || revisionStats.isSymbolicLink()) {
      throw new Error(
        `Finalized Revision v${revision.version} is not a regular directory.`,
      );
    }
    await verifyRevisionFiles(path, revision.files);
  }
}

async function verifyRevisionFiles(root: string, expected: ArtifactFile[]) {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Finalized Revision root must be a regular directory.");
  }
  const actual = await scanRevisionFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Finalized Revision files no longer match artifact.json.");
  }
}

async function recoverFinalization(artifact: LocalArtifact) {
  const journalPath = join(
    artifact.artifactDirectory,
    FINALIZE_JOURNAL_FILE_NAME,
  );
  if (!(await pathExists(journalPath))) return undefined;
  const journal = await readFinalizationJournal(journalPath);
  if (journal.artifactId !== artifact.manifest.artifactId) {
    throw new Error("Finalization journal belongs to another artifact.");
  }
  if (
    resolve(journal.draftPath) !==
      resolve(artifact.artifactDirectory, "draft") ||
    resolve(journal.revisionPath) !==
      resolve(artifact.artifactDirectory, `v${journal.targetVersion}`)
  ) {
    throw new Error("Finalization journal contains an unsafe path.");
  }

  const targetExists = await pathExists(journal.revisionPath);
  const draftExists = await pathExists(journal.draftPath);
  const currentRevision = artifact.manifest.revisions.find(
    (revision) => revision.version === journal.targetVersion,
  );
  if (targetExists && draftExists) {
    throw new Error(
      "Finalization recovery found both Draft and target Revision.",
    );
  }
  if (targetExists) {
    await verifyRevisionFiles(journal.revisionPath, journal.revision.files);
    if (currentRevision) {
      if (
        JSON.stringify(currentRevision) !== JSON.stringify(journal.revision) ||
        JSON.stringify(artifact.manifest) !== JSON.stringify(journal.manifest)
      ) {
        throw new Error("Finalization recovery found a conflicting Revision.");
      }
    } else {
      const expectedPrevious = journal.targetVersion - 1;
      if (artifact.manifest.revisions.length !== expectedPrevious) {
        throw new Error(
          "Finalization recovery found a non-contiguous Revision ledger.",
        );
      }
      if (
        JSON.stringify(artifact.manifest.revisions) !==
        JSON.stringify(journal.manifest.revisions.slice(0, expectedPrevious))
      ) {
        throw new Error(
          "Finalization recovery found a changed Revision ledger.",
        );
      }
      await writeJsonDurable(
        join(artifact.artifactDirectory, "artifact.json"),
        journal.manifest,
      );
    }
    await unlink(journalPath);
    await removeDraftMetadata(artifact.artifactDirectory);
    return journal.revision;
  }
  if (!draftExists && !currentRevision) {
    throw new Error(
      "Finalization recovery found neither Draft nor target Revision.",
    );
  }
  if (currentRevision) {
    throw new Error(
      "Finalization recovery found a manifest Revision without its files.",
    );
  }
  // Before rename, the validated Draft remains available for an explicit retry.
  await verifyRevisionFiles(journal.draftPath, journal.revision.files);
  await unlink(journalPath);
  return undefined;
}

async function removeDraftMetadata(artifactDirectory: string) {
  await unlink(join(artifactDirectory, "draft.json")).catch(() => undefined);
  await unlink(join(artifactDirectory, PREPARE_STATE_FILE_NAME)).catch(
    () => undefined,
  );
}

async function readFinalizationJournal(
  path: string,
): Promise<FinalizationJournal> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Finalization journal at ${path} is malformed.`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Finalization journal at ${path} is invalid.`);
  }
  const journal = value as Partial<FinalizationJournal>;
  if (
    journal.schemaVersion !== 1 ||
    !["prepared", "renamed", "manifest-replaced"].includes(
      String(journal.phase),
    ) ||
    typeof journal.artifactId !== "string" ||
    typeof journal.targetVersion !== "number" ||
    typeof journal.draftPath !== "string" ||
    typeof journal.revisionPath !== "string" ||
    !journal.revision ||
    !journal.manifest
  ) {
    throw new Error(`Finalization journal at ${path} is invalid.`);
  }
  const manifest = artifactManifestSchema.safeParse(journal.manifest);
  if (!manifest.success)
    throw new Error(`Finalization journal at ${path} is invalid.`);
  const revision = finalizedRevisionSchema.safeParse(journal.revision);
  if (!revision.success)
    throw new Error(`Finalization journal at ${path} is invalid.`);
  const manifestRevision = manifest.data.revisions.find(
    (candidate) => candidate.version === revision.data.version,
  );
  if (
    journal.targetVersion !== revision.data.version ||
    !manifestRevision ||
    manifest.data.revisions.at(-1)?.version !== journal.targetVersion ||
    JSON.stringify(manifestRevision) !== JSON.stringify(revision.data)
  ) {
    throw new Error(`Finalization journal at ${path} is invalid.`);
  }
  return {
    schemaVersion: 1,
    phase: journal.phase as FinalizationJournal["phase"],
    artifactId: journal.artifactId,
    targetVersion: journal.targetVersion,
    draftPath: journal.draftPath,
    revisionPath: journal.revisionPath,
    revision: revision.data,
    manifest: manifest.data,
  };
}

async function writeJsonDurable(path: string, value: unknown, mode = 0o644) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

class InjectedFailureError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function injectFailure(options: ResolvedOptions, phase: string) {
  if (!options.failureInjector) return;
  try {
    options.failureInjector(phase);
  } catch (error) {
    throw new InjectedFailureError(error);
  }
}

async function withArtifactLock<T>(
  locks: Map<string, Promise<void>>,
  artifactDirectory: string,
  operation: () => Promise<T>,
) {
  const previous = locks.get(artifactDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(artifactDirectory, queued);
  await previous;
  let fileLock: ArtifactFileLock | undefined;
  try {
    fileLock = await acquireArtifactFileLock(artifactDirectory);
    return await operation();
  } finally {
    try {
      if (fileLock) await fileLock.release();
    } finally {
      release();
      if (locks.get(artifactDirectory) === queued)
        locks.delete(artifactDirectory);
    }
  }
}

interface ArtifactFileLock {
  release: () => Promise<void>;
}

async function acquireArtifactFileLock(
  artifactDirectory: string,
): Promise<ArtifactFileLock> {
  const path = join(artifactDirectory, ARTIFACT_LOCK_FILE_NAME);
  const lock = {
    schemaVersion: 1,
    pid: process.pid,
    ownerId: PROCESS_OWNER_ID,
    createdAt: new Date().toISOString(),
  };
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`, {
          encoding: "utf8",
        });
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          let current: unknown;
          try {
            current = JSON.parse(await readFile(path, "utf8"));
          } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return;
            throw error;
          }
          if (isArtifactLock(current, lock)) await unlink(path);
        },
      };
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
      const current = await readArtifactLock(path);
      if (isArtifactLockLive(current)) {
        throw new Error(
          `Artifact ${artifactDirectory} is locked by a live Panes process. Retry after that operation completes.`,
        );
      }
      await unlink(path).catch((unlinkError) => {
        if (!(isNodeError(unlinkError) && unlinkError.code === "ENOENT"))
          throw unlinkError;
      });
    }
  }
}

async function readArtifactLock(path: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Artifact lock at ${path} is malformed.`);
  }
  if (!isArtifactLock(value))
    throw new Error(`Artifact lock at ${path} is invalid.`);
  return value;
}

function isArtifactLock(
  value: unknown,
  expected?: {
    schemaVersion: number;
    pid: number;
    ownerId: string;
    createdAt: string;
  },
): value is {
  schemaVersion: 1;
  pid: number;
  ownerId: string;
  createdAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  return (
    Object.keys(lock).length === 4 &&
    lock.schemaVersion === 1 &&
    typeof lock.pid === "number" &&
    Number.isInteger(lock.pid) &&
    lock.pid > 0 &&
    typeof lock.ownerId === "string" &&
    lock.ownerId.length > 0 &&
    typeof lock.createdAt === "string" &&
    (expected === undefined ||
      (lock.pid === expected.pid && lock.ownerId === expected.ownerId))
  );
}

function isArtifactLockLive(
  lock:
    | {
        schemaVersion: 1;
        pid: number;
        ownerId: string;
        createdAt: string;
      }
    | undefined,
) {
  if (!lock) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function mediaTypeForPath(path: string, bytes: Buffer) {
  const extension = path.includes(".")
    ? path.slice(path.lastIndexOf(".")).toLowerCase()
    : "";
  return (
    {
      ".html": "text/html",
      ".htm": "text/html",
      ".svg": "image/svg+xml",
      ".css": "text/css",
      ".js": "application/javascript",
      ".mjs": "application/javascript",
      ".cjs": "application/javascript",
      ".ts": "application/typescript",
      ".tsx": "application/typescript",
      ".jsx": "application/javascript",
      ".json": "application/json",
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".mmd": "text/plain",
      ".mermaid": "text/plain",
      ".txt": "text/plain",
      ".py": "text/x-python",
      ".rb": "text/x-ruby",
      ".go": "text/x-go",
      ".rs": "text/x-rust",
      ".java": "text/x-java-source",
      ".c": "text/x-c",
      ".h": "text/x-c",
      ".cpp": "text/x-c++src",
      ".yaml": "text/yaml",
      ".yml": "text/yaml",
      ".xml": "application/xml",
      ".sh": "application/x-sh",
      ".sql": "application/sql",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] ??
    (Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)
      ? "text/plain"
      : "application/octet-stream")
  );
}

interface PreviewRoute {
  artifactId: string;
  artifactDirectory: string;
  version: number;
  root: string;
  files: ArtifactFile[];
  preview: PreviewEntry;
  approvedOrigins: string[];
  reactRuntime?: ReactBrowserRuntime | undefined;
  manifest?: ArtifactManifest | undefined;
}

class LocalPreviewServer {
  private readonly routes = new Map<string, PreviewRoute>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private listening?: Promise<void>;

  constructor() {
    this.server.unref();
  }

  async register(route: PreviewRoute) {
    await this.listen();
    const token = randomUUID();
    this.routes.set(token, route);
    return token;
  }

  updateRoot(token: string, root: string, manifest: ArtifactManifest) {
    const route = this.routes.get(token);
    if (route) {
      route.root = root;
      route.manifest = manifest;
    }
  }

  remove(token: string) {
    this.routes.delete(token);
  }

  url(token: string, entryPath: string) {
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Local preview server is not listening.");
    return `http://127.0.0.1:${address.port}/preview/${encodeURIComponent(token)}/v${this.routes.get(token)?.version}/${encodePreviewPath(entryPath)}`;
  }

  async probe(token: string, entryPath: string) {
    const shell = await requestLoopback(this.url(token, entryPath));
    if (shell.statusCode !== 200) {
      throw new Error(
        `Local Preview validation failed with HTTP ${shell.statusCode}.`,
      );
    }
    const frame = await requestLoopback(this.frameUrl(token));
    if (frame.statusCode !== 200) {
      throw new Error(
        `Local Preview validation failed with HTTP ${frame.statusCode}.`,
      );
    }
  }

  private frameUrl(token: string) {
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Local preview server is not listening.");
    return `http://127.0.0.1:${address.port}/preview/${encodeURIComponent(token)}/v${this.routes.get(token)?.version}/${encodePreviewPath(PREVIEW_FRAME_PATH)}`;
  }

  private async listen() {
    if (!this.listening) {
      this.listening = new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(0, "127.0.0.1");
      });
    }
    await this.listening;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    let url: URL;
    try {
      if (/(?:^|\/)(?:\.\.?|%2e|%2f|%5c)(?:\/|$)/iu.test(request.url ?? "")) {
        throw new Error("Unsafe preview path.");
      }
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "preview" || segments.length < 4) {
      response.writeHead(404);
      response.end();
      return;
    }
    let token: string;
    try {
      token = decodeURIComponent(segments[1] ?? "");
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    const route = this.routes.get(token);
    if (!route || segments[2] !== `v${route.version}`) {
      response.writeHead(404);
      response.end();
      return;
    }
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(segments.slice(3).join("/"));
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const normalized = relativePathSchema.safeParse(relativePath);
    if (!normalized.success || normalized.data !== relativePath) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      if (route.manifest) {
        const artifact = await readArtifactDirectory(route.artifactDirectory);
        if (
          !artifact ||
          JSON.stringify(artifact.manifest) !== JSON.stringify(route.manifest)
        ) {
          throw new Error("Artifact manifest changed.");
        }
        await verifyFinalizedRevisions(artifact);
      }
      await verifyRevisionFiles(route.root, route.files);
    } catch {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("Finalized Revision files no longer match artifact.json.");
      return;
    }
    if (relativePath === route.preview.entryPath) {
      const body = renderPreviewShell(this.frameUrl(token), route.preview);
      this.sendHtml(
        response,
        request.method,
        body,
        createShellCsp(this.origin()),
      );
      return;
    }
    if (relativePath === PREVIEW_FRAME_PATH) {
      try {
        const body =
          route.preview.adapter === "browser"
            ? createBrowserFrame(
                (
                  await readLockedPreviewFile(
                    route.root,
                    route.preview.entryPath,
                  )
                ).toString("utf8"),
                this.baseUrl(token),
                route.approvedOrigins,
              )
            : await rendererWrapper(
                route.preview.renderer,
                route.root,
                route.preview.entryPath,
                route.reactRuntime,
                this.baseUrl(token),
                route.approvedOrigins,
              );
        this.sendHtml(
          response,
          request.method,
          body,
          createFrameCsp(this.origin(), route.approvedOrigins),
        );
      } catch {
        response.writeHead(409, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Finalized Revision files no longer match artifact.json.");
      }
      return;
    }
    const file = route.files.find(
      (candidate) =>
        candidate.kind === "file" && candidate.path === relativePath,
    );
    if (!file || file.kind !== "file") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body: Buffer;
    try {
      body = await readLockedPreviewFile(route.root, relativePath);
    } catch {
      response.writeHead(409, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Finalized Revision files no longer match artifact.json.");
      return;
    }
    const contentTypeHeader =
      /^text\//u.test(file.mediaType) ||
      /^(?:application\/(?:javascript|json|typescript|xml)|image\/svg\+xml)$/u.test(
        file.mediaType,
      )
        ? `${file.mediaType}; charset=utf-8`
        : file.mediaType;
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-security-policy": createFrameCsp(
        this.origin(),
        route.approvedOrigins,
      ),
      "content-type": contentTypeHeader,
      "content-length": body.byteLength,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "GET") response.end(body);
    else response.end();
  }

  private origin() {
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Local preview server is not listening.");
    return `http://127.0.0.1:${address.port}`;
  }

  private baseUrl(token: string) {
    const route = this.routes.get(token);
    if (!route) throw new Error("Local preview route is unavailable.");
    return `${this.origin()}/preview/${encodeURIComponent(token)}/v${route.version}/`;
  }

  private sendHtml(
    response: ServerResponse,
    method: string | undefined,
    body: string,
    contentSecurityPolicy: string,
  ) {
    const bytes = Buffer.from(body, "utf8");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": bytes.byteLength,
      "content-security-policy": contentSecurityPolicy,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (method === "GET") response.end(bytes);
    else response.end();
  }
}

function renderPreviewShell(frameUrl: string, preview: PreviewEntry) {
  const label =
    preview.adapter === "browser"
      ? "Browser artifact preview"
      : `${preview.renderer} artifact preview`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(label)}</title><style>html,body{height:100%;margin:0}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="${escapeHtmlAttribute(frameUrl)}" title="${escapeHtmlAttribute(label)}"></iframe></body></html>`;
}

function createBrowserFrame(
  source: string,
  baseUrl: string,
  approvedOrigins: readonly string[],
) {
  return createArtifactFrameDocument(
    source,
    baseUrl,
    "<title>Panes browser artifact</title>",
    approvedOrigins,
  );
}

function createArtifactFrameDocument(
  body: string,
  baseUrl: string,
  head = "",
  approvedOrigins: readonly string[] = [],
) {
  const origin = new URL(baseUrl).origin;
  const csp = createFrameCsp(origin, approvedOrigins);
  const guard = createArtifactEgressGuardScript({
    allowHttpNetwork: approvedOrigins.length > 0,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}"><meta http-equiv="x-dns-prefetch-control" content="off"><base href="${escapeHtmlAttribute(baseUrl)}"><script>${escapeInlineScript(guard)}</script>${head}</head><body>${body}</body></html>`;
}

function createShellCsp(origin: string) {
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src ${origin}; child-src ${origin}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; referrer-policy no-referrer`;
}

function createFrameCsp(origin: string, approvedOrigins: readonly string[]) {
  const policy = createArtifactNetworkPolicy(approvedOrigins);
  const scriptSrc = [origin, ...policy.scriptSrc].join(" ");
  const styleSrc = [origin, ...policy.styleSrc].join(" ");
  const imageSrc = [origin, ...policy.imageSrc, "data:", "blob:"].join(" ");
  const fontSrc = [origin, ...policy.fontSrc, "data:"].join(" ");
  const mediaSrc = [origin, ...policy.mediaSrc].join(" ");
  const connectSrc = policy.connectSrc.length
    ? policy.connectSrc.join(" ")
    : "'none'";
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${scriptSrc}; style-src 'unsafe-inline' ${styleSrc}; img-src ${imageSrc}; font-src ${fontSrc}; connect-src ${connectSrc}; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri ${origin}; form-action 'none'; manifest-src 'none'; media-src ${mediaSrc}; navigate-to 'none'`;
}

async function rendererWrapper(
  renderer: "react" | "markdown" | "mermaid" | "code",
  root: string,
  entryPath: string,
  reactRuntime: ReactBrowserRuntime | undefined,
  baseUrl: string,
  approvedOrigins: readonly string[],
) {
  const source = (await readLockedPreviewFile(root, entryPath)).toString(
    "utf8",
  );
  const rendered = await (renderer === "markdown"
    ? renderMarkdown(source)
    : renderer === "mermaid"
      ? renderMermaid(source)
      : renderer === "react"
        ? renderReactWrapper(source, reactRuntime)
        : `<pre data-renderer="code"><code>${escapeHtml(source)}</code></pre>`);
  return createArtifactFrameDocument(
    `<main data-panes-renderer="${renderer}">${rendered}</main>`,
    baseUrl,
    `<meta name="panes-adapter" content="renderer:${renderer}"><title>Panes ${renderer} preview</title><style>body{margin:0;padding:2rem;background:#fff;color:#111;font:16px/1.5 system-ui,sans-serif}pre{white-space:pre-wrap}svg{max-width:100%;height:auto}</style>`,
    approvedOrigins,
  );
}

function renderReactWrapper(
  source: string,
  runtime: ReactBrowserRuntime | undefined,
) {
  if (!runtime) throw new Error("React browser runtime is unavailable");
  const setup = escapeInlineScript(
    `globalThis.__PANES_REACT_SOURCE__=${JSON.stringify(source)};globalThis.__PANES_WASM_BASE64__=${JSON.stringify(Buffer.from(runtime.wasm).toString("base64"))};`,
  );
  return `<div id="root"></div><script>${setup}</script><script>${escapeInlineScript(runtime.source)}</script>`;
}

const MARKDOWN_COMPONENTS: Components = {
  a({ children }) {
    return React.createElement("span", null, children);
  },
  img({ alt, src }) {
    if (
      typeof src === "string" &&
      /^data:image\/(?:gif|jpeg|png|webp);base64,/i.test(src)
    ) {
      return React.createElement("img", { alt: alt ?? "", src });
    }
    return React.createElement("span", null, alt ?? "Image blocked");
  },
};

function renderMarkdown(source: string) {
  return renderToStaticMarkup(
    React.createElement(
      "article",
      { "data-renderer": "markdown" },
      React.createElement(
        ReactMarkdown,
        {
          components: MARKDOWN_COMPONENTS,
          remarkPlugins: [remarkGfm],
          skipHtml: true,
        },
        source,
      ),
    ),
  );
}

let mermaidRenderQueue = Promise.resolve();

function renderMermaid(source: string) {
  const render = mermaidRenderQueue.then(() => renderMermaidWithDom(source));
  mermaidRenderQueue = render.then(
    () => undefined,
    () => undefined,
  );
  return render;
}

async function renderMermaidWithDom(source: string) {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  const globals = installMermaidDom(dom);
  try {
    const { default: createDOMPurify } = await import("dompurify");
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      securityLevel: "strict",
      startOnLoad: false,
    });
    const { svg } = await mermaid.render(
      `panes-mermaid-${randomUUID()}`,
      source,
    );
    return sanitizeMermaidSvg(svg, dom, createDOMPurify);
  } finally {
    globals.restore();
  }
}

function installMermaidDom(dom: ReturnType<typeof parseHTML>) {
  const window = dom.window;
  const keys = [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "SVGElement",
    "XMLSerializer",
    "DOMParser",
    "CSSStyleSheet",
  ] as const;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  for (const key of keys) {
    const value =
      key === "CSSStyleSheet"
        ? (window.CSSStyleSheet ??
          class CSSStyleSheet {
            cssRules: unknown[] = [];
            insertRule() {}
            replaceSync() {}
          })
        : window[key];
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  const svgPrototype = window.SVGElement.prototype as SVGElement & {
    getBBox?: () => { height: number; width: number; x: number; y: number };
    getComputedTextLength?: () => number;
  };
  if (!svgPrototype.getBBox) {
    svgPrototype.getBBox = () => ({
      height: 20,
      width: 100,
      x: 0,
      y: 0,
    });
  }
  if (!svgPrototype.getComputedTextLength) {
    svgPrototype.getComputedTextLength = function () {
      return (this.textContent ?? "").length * 8;
    };
  }
  return {
    restore() {
      for (const key of keys) {
        const descriptor = descriptors.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

function sanitizeMermaidSvg(
  source: string,
  dom: ReturnType<typeof parseHTML>,
  createPurifier: typeof import("dompurify").default,
) {
  const purifier = createPurifier(dom.window);
  const clean = String(
    purifier.sanitize(source, {
      FORBID_ATTR: ["style"],
      FORBID_TAGS: [
        "script",
        "style",
        "foreignObject",
        "iframe",
        "object",
        "embed",
        "audio",
        "video",
      ],
      RETURN_TRUSTED_TYPE: false,
      USE_PROFILES: { svg: true, svgFilters: true },
    }),
  );
  const document = new dom.window.DOMParser().parseFromString(
    clean,
    "image/svg+xml",
  );
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error("Mermaid renderer did not produce one valid SVG root");
  }
  root.setAttribute("data-renderer", "mermaid");
  return root.toString();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function escapeInlineScript(source: string) {
  return source.replace(/<\/script/gi, "<\\/script");
}

function encodePreviewPath(path: string) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function requestLoopback(url: string) {
  return new Promise<{ statusCode?: number }>((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume();
      response.once("end", () => {
        const statusCode = response.statusCode;
        resolve(statusCode === undefined ? {} : { statusCode });
      });
    });
    request.once("error", reject);
  });
}

async function readLockedPreviewFile(root: string, relativePath: string) {
  const target = join(root, relativePath);
  const [resolvedRoot, resolvedTarget] = await Promise.all([
    realpath(root),
    realpath(target),
  ]);
  if (!isPathWithin(resolvedTarget, resolvedRoot)) {
    throw new Error("Preview path escapes the locked Revision snapshot.");
  }
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Preview path is not a regular file.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeJson(path: string, value: unknown) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function resolveLocalProject(
  context: ToolContext,
  createIdentity = true,
) {
  const git = await inspectGit(context.directory);
  const artifactRoot = join(
    git ? context.worktree : context.directory,
    "artifacts",
  );
  const projectId = git?.remote
    ? normalizeGitRemote(git.remote)
    : createIdentity
      ? await readOrCreateProjectId(artifactRoot)
      : await readProjectId(artifactRoot);
  if (!artifactIdSchema.safeParse(projectId).success) {
    throw new Error(
      "The project identity is not a valid local artifact identifier.",
    );
  }
  return { artifactRoot, projectId };
}

async function readProjectId(artifactRoot: string) {
  try {
    const value = JSON.parse(
      await readFile(join(artifactRoot, PROJECT_ID_FILE_NAME), "utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.projectId !== "string"
    ) {
      throw new Error(`Project identity at ${artifactRoot} is invalid.`);
    }
    return value.projectId;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return `project-unregistered-${sha256(resolve(artifactRoot))}`;
    }
    throw error;
  }
}

async function inspectGit(directory: string) {
  try {
    const { stdout: rootOutput } = await execFileAsync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      { timeout: 5_000 },
    );
    const root = resolve(rootOutput.trim());
    let remote: string | undefined;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", root, "config", "--get", "remote.origin.url"],
        { timeout: 5_000 },
      );
      remote = stdout.trim() || undefined;
    } catch {
      remote = undefined;
    }
    return { root, remote };
  } catch {
    return undefined;
  }
}

function normalizeGitRemote(remote: string) {
  let value = remote.trim();
  const scp = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/u);
  if (scp && !value.includes("//")) {
    value = `https://${scp[1]}/${scp[2]}`;
  } else if (value.startsWith("ssh://")) {
    value = `https://${value.slice("ssh://".length).replace(/^([^@]+)@/u, "")}`;
  } else if (value.startsWith("git+ssh://")) {
    value = `https://${value.slice("git+ssh://".length).replace(/^([^@]+)@/u, "")}`;
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/u, "")
      .toLowerCase();
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value.replace(/\/+$/u, "").replace(/\.git$/u, "");
  }
}

async function readOrCreateProjectId(artifactRoot: string) {
  const path = join(artifactRoot, PROJECT_ID_FILE_NAME);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.projectId !== "string"
    ) {
      throw new Error(`Project identity at ${path} is invalid.`);
    }
    return value.projectId;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
  const projectId = `project-${randomUUID()}`;
  await mkdir(artifactRoot, { recursive: true });
  await writeJson(path, { projectId });
  return projectId;
}

function slugify(title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 128)
    .replace(/-+$/u, "");
  const result = slug || "artifact";
  const parsed = artifactSlugSchema.safeParse(result);
  if (!parsed.success)
    throw new Error("Could not derive a safe artifact slug from the title");
  return parsed.data;
}

function resolveOptions(
  options: Record<string, unknown> | undefined,
): ResolvedOptions {
  const apiBaseUrlValue = options?.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  if (typeof apiBaseUrlValue !== "string") {
    throw new Error("Panes plugin option apiBaseUrl must be a string");
  }

  let apiBaseUrl: URL;
  try {
    apiBaseUrl = new URL(apiBaseUrlValue);
  } catch {
    throw new Error("Panes plugin option apiBaseUrl must be a valid URL");
  }

  if (
    !["http:", "https:"].includes(apiBaseUrl.protocol) ||
    apiBaseUrl.username ||
    apiBaseUrl.password ||
    apiBaseUrl.pathname !== "/" ||
    apiBaseUrl.search ||
    apiBaseUrl.hash
  ) {
    throw new Error(
      "Panes plugin option apiBaseUrl must be an HTTP(S) origin without credentials, a path, query, or fragment",
    );
  }
  if (apiBaseUrl.protocol === "http:" && !isLoopbackHost(apiBaseUrl)) {
    throw new Error(
      "Panes plugin option apiBaseUrl must use HTTPS unless its host is a verified loopback address",
    );
  }

  const autoOpenValue = options?.autoOpen ?? false;
  if (typeof autoOpenValue !== "boolean") {
    throw new Error("Panes plugin option autoOpen must be a boolean");
  }

  const createApiKeyValue =
    options?.createApiKey ?? process.env.OPENCODE_PANES_CREATE_API_KEY;
  if (
    createApiKeyValue !== undefined &&
    (typeof createApiKeyValue !== "string" || createApiKeyValue.length === 0)
  ) {
    throw new Error(
      "Panes plugin option createApiKey must be a non-empty string",
    );
  }

  const requestTimeoutMsValue =
    options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    typeof requestTimeoutMsValue !== "number" ||
    !Number.isInteger(requestTimeoutMsValue) ||
    requestTimeoutMsValue < 100 ||
    requestTimeoutMsValue > 120_000
  ) {
    throw new Error(
      "Panes plugin option requestTimeoutMs must be an integer from 100 to 120000",
    );
  }

  const configuredFailureInjector = options?.failureInjector;
  const failureInjector =
    process.env.NODE_ENV === "test" &&
    typeof configuredFailureInjector === "function"
      ? (phase: string) =>
          (configuredFailureInjector as (phase: string) => void)(phase)
      : undefined;

  return {
    apiBaseUrl,
    autoOpen: autoOpenValue,
    ...(createApiKeyValue ? { createApiKey: createApiKeyValue } : {}),
    requestTimeoutMs: requestTimeoutMsValue,
    ...(failureInjector ? { failureInjector } : {}),
  };
}

async function createArtifact(
  args: {
    title: string;
    type: ArtifactType;
    source: string;
  },
  context: ToolContext,
  options: ResolvedOptions,
) {
  const request = createArtifactRequestSchema.safeParse({
    title: args.title,
    type: args.type,
    source: args.source,
    sessionId: context.sessionID,
  });
  if (!request.success) {
    throw validationError(request.error.issues[0]?.message);
  }

  await ensureUploadPermission(context, options.apiBaseUrl, {
    operation: "create",
    title: request.data.title,
  });

  const response = await fetchPanes(
    new URL("/api/artifacts", options.apiBaseUrl),
    {
      method: "POST",
      headers: jsonHeaders(undefined, options.createApiKey),
      body: JSON.stringify(request.data),
    },
    context.abort,
    options.requestTimeoutMs,
  );
  const payload = await parseApiResponse(
    response,
    createArtifactResponseSchema,
    options.createApiKey ? [options.createApiKey] : [],
  );
  if (payload.revision.artifactId !== payload.artifact.id) {
    throw malformedSuccessResponse();
  }
  const viewerUrl = validateCreateViewerUrl(
    payload.viewerUrl,
    options.apiBaseUrl.origin,
    payload.artifact.id,
  );

  try {
    await writeArtifactState({
      apiOrigin: options.apiBaseUrl.origin,
      artifactId: payload.artifact.id,
      ownerToken: payload.ownerToken,
      viewerUrl,
      title: payload.artifact.title,
      type: payload.artifact.type,
    });
  } catch (error) {
    throw new Error(
      `Artifact ${payload.artifact.id} was created, but its owner token could not be saved. Future updates are unavailable until state storage is fixed. ${errorMessage(error)}`,
    );
  }

  const autoOpenStatus = await maybeOpenViewer(
    viewerUrl,
    context,
    options.autoOpen,
  );
  return toolResult({
    operation: "created",
    artifactId: payload.artifact.id,
    title: payload.artifact.title,
    type: payload.artifact.type,
    version: payload.revision.version,
    viewerUrl,
    autoOpenStatus,
  });
}

async function updateArtifact(
  args: {
    artifactId: string;
    title: string;
    type: ArtifactType;
    source: string;
  },
  context: ToolContext,
  options: ResolvedOptions,
) {
  const artifactId = artifactIdSchema.safeParse(args.artifactId);
  if (!artifactId.success) {
    throw validationError("Artifact ID is invalid");
  }

  const request = createRevisionRequestSchema.safeParse({
    source: args.source,
  });
  if (!request.success) {
    throw validationError(request.error.issues[0]?.message);
  }

  const state = await readArtifactState(
    options.apiBaseUrl.origin,
    artifactId.data,
  );
  if (args.title !== state.title) {
    throw new Error(
      `Artifact title is immutable. Retry the update with the stored title ${JSON.stringify(state.title)}.`,
    );
  }
  if (args.type !== state.type) {
    throw new Error(
      `Artifact type is immutable. Retry the update with the stored type ${JSON.stringify(state.type)}.`,
    );
  }
  await ensureUploadPermission(context, options.apiBaseUrl, {
    operation: "update",
    title: state.title,
  });
  const response = await fetchPanes(
    new URL(
      `/api/artifacts/${encodeURIComponent(artifactId.data)}/revisions`,
      options.apiBaseUrl,
    ),
    {
      method: "POST",
      headers: jsonHeaders(state.ownerToken),
      body: JSON.stringify(request.data),
    },
    context.abort,
    options.requestTimeoutMs,
  );

  let payload;
  try {
    payload = await parseApiResponse(response, revisionResponseSchema, [
      state.ownerToken,
    ]);
  } catch (error) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Panes authorization failed for artifact ${artifactId.data}. The locally stored owner token may be missing from the server or no longer valid. Create a new artifact or restore the matching Panes state file.`,
      );
    }
    throw error;
  }
  if (
    payload.artifactId !== artifactId.data ||
    payload.revision.artifactId !== artifactId.data
  ) {
    throw malformedSuccessResponse();
  }
  const viewerUrl = validateUpdateViewerUrl(
    payload.viewerUrl,
    options.apiBaseUrl.origin,
    payload.artifactId,
    state.viewerUrl,
  );

  const autoOpenStatus = await maybeOpenViewer(
    viewerUrl,
    context,
    options.autoOpen,
  );
  return toolResult({
    operation: "updated",
    artifactId: payload.artifactId,
    title: state.title,
    type: state.type,
    version: payload.revision.version,
    viewerUrl,
    autoOpenStatus,
  });
}

function jsonHeaders(ownerToken?: string, createApiKey?: string) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}),
    ...(createApiKey ? { "x-panes-create-key": createApiKey } : {}),
  };
}

async function fetchPanes(
  url: URL,
  init: RequestInit,
  callerSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal.aborted) abortFromCaller();

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Panes request timed out"));
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (callerSignal.aborted) {
      throw new Error("Panes upload was cancelled");
    }
    if (timedOut) {
      throw new Error(`Panes API request timed out after ${timeoutMs} ms`);
    }
    throw new Error(
      `Could not reach the Panes API at ${url.origin}. Check the configured API origin and network connection.`,
    );
  } finally {
    clearTimeout(timeout);
    callerSignal.removeEventListener("abort", abortFromCaller);
  }
}

async function parseApiResponse<T>(
  response: Response,
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  },
  secrets: string[] = [],
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "Panes API returned malformed JSON"
        : `Panes API request failed with HTTP ${response.status} and a malformed error response`,
    );
  }

  if (!response.ok) {
    const apiError = errorEnvelopeSchema.safeParse(payload);
    if (!apiError.success) {
      throw new Error(
        `Panes API request failed with HTTP ${response.status} and an unrecognized error response`,
      );
    }

    const issueText = redactSecrets(
      apiError.data.error.issues
        ?.map(
          (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
        )
        .join("; ") ?? "",
      secrets,
    );
    const suffix = issueText ? ` (${issueText})` : "";
    throw new Error(
      `Panes API request failed (${apiError.data.error.code}): ${redactSecrets(apiError.data.error.message, secrets)}${suffix}`,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw malformedSuccessResponse();
  }
  return parsed.data;
}

function validationError(message = "Artifact input is invalid") {
  if (message.includes(String(MAX_ARTIFACT_SOURCE_BYTES))) {
    return new Error(
      `Artifact source exceeds the ${MAX_ARTIFACT_SOURCE_BYTES}-byte UTF-8 limit. Reduce the source and call the artifact tool again.`,
    );
  }
  return new Error(`Artifact input is invalid: ${message}`);
}

function toolResult(input: {
  operation: "created" | "updated";
  artifactId: string;
  title: string;
  type: ArtifactType;
  version: number;
  viewerUrl: string;
  autoOpenStatus: AutoOpenStatus;
}) {
  const summary = {
    artifactId: input.artifactId,
    version: input.version,
    title: input.title,
    type: input.type,
    viewerUrl: input.viewerUrl,
    operation: input.operation,
    autoOpen: input.autoOpenStatus,
  };

  return {
    title: `${input.operation === "created" ? "Created" : "Updated"} ${input.title}`,
    output: JSON.stringify(summary),
    metadata: summary,
  };
}

async function maybeOpenViewer(
  viewerUrl: string,
  context: ToolContext,
  autoOpen: boolean,
): Promise<AutoOpenStatus> {
  if (!autoOpen) return "disabled";

  let url: URL;
  try {
    url = new URL(viewerUrl);
  } catch {
    return "failed";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "failed";

  try {
    await context.ask({
      permission: "artifact_open",
      patterns: [url.origin],
      always: [url.origin],
      metadata: { viewerUrl: url.href },
    });
  } catch {
    return "permission-denied";
  }

  try {
    await openBrowser(url.href);
    return "opened";
  } catch {
    return "failed";
  }
}

async function openBrowser(url: string) {
  const command =
    platform() === "darwin"
      ? { executable: "open", args: [url] }
      : platform() === "win32"
        ? {
            executable: "rundll32.exe",
            args: ["url.dll,FileProtocolHandler", url],
          }
        : { executable: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function isLoopbackHost(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

async function ensureUploadPermission(
  context: ToolContext,
  apiBaseUrl: URL,
  metadata: { operation: "create" | "update" | "sync"; title: string },
) {
  await context.ask({
    permission: "artifact_upload",
    patterns: [apiBaseUrl.origin],
    always: [apiBaseUrl.origin],
    metadata: { endpoint: apiBaseUrl.origin, ...metadata },
  });
}

function syncToolResult(input: SyncResult) {
  const metadata = {
    operation: input.operation,
    artifactId: input.artifactId,
    title: input.title,
    syncedVersion: input.syncedVersion,
    pendingVersions: input.pendingVersions,
    creatorUrl: input.creatorUrl,
    inventoryUrl: input.inventoryUrl,
    creatorExpiresAt: input.creatorExpiresAt,
    openCreatorAfterSuccess: input.openCreatorAfterSuccess,
  };
  return {
    title: `Synced ${input.title}`,
    output: JSON.stringify(metadata),
    metadata,
  };
}

function validateCreatorUrl(value: unknown, apiOrigin: string, token: string) {
  if (typeof value !== "string") throw malformedSuccessResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformedSuccessResponse();
  }
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/creator/${encodeURIComponent(token)}`
  ) {
    throw malformedSuccessResponse();
  }
  return url.href;
}

function validateInventoryUrl(value: unknown, apiOrigin: string) {
  if (typeof value !== "string") throw malformedSuccessResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformedSuccessResponse();
  }
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/inventory"
  ) {
    throw malformedSuccessResponse();
  }
  return url.href;
}

async function writeSyncState(state: StoredSyncState) {
  const path = syncStatePath(
    state.apiOrigin,
    state.projectId,
    state.artifactId,
  );
  await writeProtectedJson(path, state);
}

async function readSyncState(
  apiOrigin: string,
  projectId: string,
  artifactId: string,
): Promise<StoredSyncState | undefined> {
  const path = syncStatePath(apiOrigin, projectId, artifactId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(
      `Could not read local Sync state for artifact ${artifactId}.`,
    );
  }
  if (!isStoredSyncState(value, apiOrigin, projectId, artifactId)) {
    throw new Error(`Local Sync state for artifact ${artifactId} is invalid.`);
  }
  return value;
}

async function writeSyncCheckpoint(path: string, checkpoint: SyncCheckpoint) {
  await writeProtectedJson(path, checkpoint);
}

async function readSyncCheckpoint(
  path: string,
): Promise<SyncCheckpoint | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Sync checkpoint at ${path} is malformed.`);
  }
  if (!isSyncCheckpoint(value))
    throw new Error(`Sync checkpoint at ${path} is invalid.`);
  return value;
}

function isStoredSyncState(
  value: unknown,
  apiOrigin: string,
  projectId: string,
  artifactId: string,
): value is StoredSyncState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    (Object.keys(state).length === 12 || Object.keys(state).length === 13) &&
    state.schemaVersion === 1 &&
    state.apiOrigin === apiOrigin &&
    state.projectId === projectId &&
    state.artifactId === artifactId &&
    typeof state.cloudProjectId === "string" &&
    typeof state.cloudArtifactId === "string" &&
    ownerTokenSchema.safeParse(state.ownerCredential).success &&
    typeof state.creatorUrl === "string" &&
    typeof state.inventoryUrl === "string" &&
    typeof state.creatorExpiresAt === "string" &&
    typeof state.creationIdempotencyKey === "string" &&
    Array.isArray(state.syncedRevisionVersions) &&
    state.syncedRevisionVersions.every(
      (version) =>
        typeof version === "number" &&
        Number.isSafeInteger(version) &&
        version > 0,
    ) &&
    (state.syncedRevisionManifests === undefined ||
      (Array.isArray(state.syncedRevisionManifests) &&
        state.syncedRevisionManifests.every(
          (revision) => finalizedRevisionSchema.safeParse(revision).success,
        )))
  );
}

function isSyncCheckpoint(value: unknown): value is SyncCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return (
    (Object.keys(checkpoint).length === 14 ||
      Object.keys(checkpoint).length === 15) &&
    checkpoint.schemaVersion === 1 &&
    ["planned", "identity", "mapped"].includes(String(checkpoint.phase)) &&
    typeof checkpoint.apiOrigin === "string" &&
    typeof checkpoint.projectId === "string" &&
    typeof checkpoint.artifactId === "string" &&
    typeof checkpoint.cloudProjectId === "string" &&
    typeof checkpoint.cloudArtifactId === "string" &&
    ownerTokenSchema.safeParse(checkpoint.ownerCredential).success &&
    ownerTokenSchema.safeParse(checkpoint.creatorToken).success &&
    typeof checkpoint.creatorUrl === "string" &&
    typeof checkpoint.inventoryUrl === "string" &&
    typeof checkpoint.creatorExpiresAt === "string" &&
    typeof checkpoint.creationIdempotencyKey === "string" &&
    Array.isArray(checkpoint.syncedRevisionVersions) &&
    (checkpoint.syncedRevisionManifests === undefined ||
      (Array.isArray(checkpoint.syncedRevisionManifests) &&
        checkpoint.syncedRevisionManifests.every(
          (revision) => finalizedRevisionSchema.safeParse(revision).success,
        )))
  );
}

async function writeProtectedJson(path: string, value: unknown) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictPermissions(directory, 0o700);
  await writeJsonDurable(path, value, 0o600);
  await restrictPermissions(path, 0o600);
}

async function writeArtifactState(state: StoredArtifactState) {
  const directory = artifactStateDirectory(state.apiOrigin);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictPermissions(directory, 0o700);

  const target = artifactStatePath(state.apiOrigin, state.artifactId);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, target);
    await restrictPermissions(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readArtifactState(apiOrigin: string, artifactId: string) {
  const path = artifactStatePath(apiOrigin, artifactId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `No local owner token was found for artifact ${artifactId} at ${apiOrigin}. Only the OpenCode instance that created an artifact, or a restored Panes state file, can update it.`,
      );
    }
    throw new Error(
      `Could not read local Panes state for artifact ${artifactId}. ${errorMessage(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `Local Panes state for artifact ${artifactId} is malformed. Restore or remove that state file, then create a new artifact.`,
    );
  }

  if (!isStoredArtifactState(value, apiOrigin, artifactId)) {
    throw new Error(
      `Local Panes state for artifact ${artifactId} is invalid or belongs to another API origin.`,
    );
  }
  return value;
}

function isStoredArtifactState(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
): value is StoredArtifactState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).length === 6 &&
    state.apiOrigin === apiOrigin &&
    state.artifactId === artifactId &&
    ownerTokenSchema.safeParse(state.ownerToken).success &&
    isWorkspaceViewerUrl(state.viewerUrl, apiOrigin, artifactId) &&
    typeof state.title === "string" &&
    state.title.length > 0 &&
    artifactTypeSchema.safeParse(state.type).success
  );
}

function isWorkspaceViewerUrl(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
) {
  try {
    validateCreateViewerUrl(value, apiOrigin, artifactId);
    return true;
  } catch {
    return false;
  }
}

function validateCreateViewerUrl(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
) {
  const url = parseViewerUrl(value, apiOrigin, artifactId);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const entries = [...fragment.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== WORKSPACE_TOKEN_FRAGMENT_KEY ||
    !workspaceTokenSchema.safeParse(entries[0]?.[1]).success
  ) {
    throw malformedSuccessResponse();
  }
  return url.href;
}

function validateUpdateViewerUrl(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
  storedViewerUrl: string,
) {
  const storedUrl = validateCreateViewerUrl(
    storedViewerUrl,
    apiOrigin,
    artifactId,
  );
  const url = parseViewerUrl(value, apiOrigin, artifactId);
  if (url.hash && url.href !== storedUrl) {
    throw malformedSuccessResponse();
  }
  return storedUrl;
}

function parseViewerUrl(value: unknown, apiOrigin: string, artifactId: string) {
  if (typeof value !== "string") throw malformedSuccessResponse();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformedSuccessResponse();
  }
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.pathname !== `/artifacts/${encodeURIComponent(artifactId)}` ||
    url.search
  ) {
    throw malformedSuccessResponse();
  }
  return url;
}

function malformedSuccessResponse() {
  return new Error("Panes API returned a malformed success response");
}

function artifactStateDirectory(apiOrigin: string) {
  return join(stateRootDirectory(), "origins", sha256(apiOrigin), "artifacts");
}

function artifactStatePath(apiOrigin: string, artifactId: string) {
  return join(artifactStateDirectory(apiOrigin), `${sha256(artifactId)}.json`);
}

function syncStatePath(
  apiOrigin: string,
  projectId: string,
  artifactId: string,
) {
  return join(
    stateRootDirectory(),
    "origins",
    sha256(apiOrigin),
    "sync",
    `${sha256(`${projectId}:${artifactId}`)}.json`,
  );
}

function syncCheckpointPath(
  apiOrigin: string,
  projectId: string,
  artifactId: string,
) {
  return join(
    stateRootDirectory(),
    "origins",
    sha256(apiOrigin),
    "sync-checkpoints",
    `${sha256(`${projectId}:${artifactId}`)}.json`,
  );
}

function stateRootDirectory() {
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, STATE_DIRECTORY_NAME);
  }
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, STATE_DIRECTORY_NAME, "state");
  }
  return join(homedir(), ".local", "state", STATE_DIRECTORY_NAME);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function restrictPermissions(path: string, mode: number) {
  if (platform() === "win32") return;
  await chmod(path, mode);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function redactSecrets(value: string, secrets: string[]) {
  return secrets.reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
    value,
  );
}
