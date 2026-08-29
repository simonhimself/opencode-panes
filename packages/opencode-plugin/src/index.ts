import { createHash, randomUUID } from "node:crypto";
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
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import {
  MAX_ARTIFACT_SOURCE_BYTES,
  MAX_ARTIFACT_KIND_LENGTH,
  artifactManifestSchema,
  artifactFilesSchema,
  artifactSlugSchema,
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
  revisionResponseSchema,
  workspaceTokenSchema,
  type ArtifactManifest,
  type ArtifactFile,
  type ArtifactType,
  type FinalizedRevision,
  type PreviewEntry,
} from "@opencode-panes/contracts";
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const STATE_DIRECTORY_NAME = "opencode-panes";
const PROJECT_ID_FILE_NAME = ".panes-project.json";
const PREPARE_STATE_FILE_NAME = ".panes-prepare.json";
const FINALIZE_JOURNAL_FILE_NAME = ".panes-finalize.json";
const execFileAsync = promisify(execFile);

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
}

interface StoredArtifactState {
  apiOrigin: string;
  artifactId: string;
  ownerToken: string;
  viewerUrl: string;
  title: string;
  type: ArtifactType;
}

type AutoOpenStatus = "disabled" | "opened" | "permission-denied" | "failed";

export const OpenCodePanesPlugin: Plugin = async (_input, pluginOptions) => {
  const options = resolveOptions(pluginOptions);
  const previewServer = new LocalPreviewServer();
  const locks = new Map<string, Promise<void>>();

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
          return prepareArtifact(args, context);
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
        },
        async execute(args, context) {
          return finalizeArtifact(args, context, previewServer, locks);
        },
      }),
    },
  };
};

export default OpenCodePanesPlugin;

type PrepareArguments = {
  artifactId?: string | undefined;
  title?: string | undefined;
  slug?: string | undefined;
  kind?: string | undefined;
  requestedOrigins?: string[] | undefined;
  draftAction?: "resume" | "discard" | undefined;
  idempotencyKey?: string | undefined;
};

type PrepareOperation = "created" | "prepared";

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

async function prepareArtifact(args: PrepareArguments, context: ToolContext) {
  const request = validatePrepareArguments(args);
  const project = await resolveLocalProject(context);
  await mkdir(project.artifactRoot, { recursive: true });

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
    return prepareExistingArtifact(existing, request);
  }

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
}

async function prepareExistingArtifact(
  existing: LocalArtifact,
  request: ValidatedPrepareArguments,
) {
  await recoverFinalization(existing);
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
  title: string;
  slug?: string | undefined;
  kind?: string | undefined;
  requestedOrigins: string[];
  draftAction?: "resume" | "discard" | undefined;
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
  if (!artifactId?.success && !title) {
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
    title,
    slug: slug?.success ? slug.data : undefined,
    kind: kind || undefined,
    requestedOrigins: origins.data,
    idempotencyKey,
  };
  return {
    ...normalized,
    title: title ?? "",
    draftAction: args.draftAction,
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
};

interface FinalizeResult {
  operation: "finalized";
  projectId: string;
  artifactId: string;
  title: string;
  version: number;
  revisionPath: string;
  manifestPath: string;
  preview: PreviewEntry;
  previewUrl: string;
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

async function finalizeArtifact(
  args: FinalizeArguments,
  context: ToolContext,
  previewServer: LocalPreviewServer,
  locks: Map<string, Promise<void>>,
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
    const artifact = await readArtifactDirectory(existing.artifactDirectory);
    if (!artifact)
      throw new Error("The local artifact disappeared during finalization.");

    await verifyFinalizedRevisions(artifact);
    const draftPath = join(artifact.artifactDirectory, "draft");
    const draftMetadataPath = join(artifact.artifactDirectory, "draft.json");
    if (!(await pathExists(draftPath))) {
      if (recoveredRevision) {
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
    if (draft.requestedOrigins.length > 0) {
      throw new Error(
        "This Draft requests external origins. Origin approval is not available during local finalization.",
      );
    }

    const files = await scanRevisionFiles(draftPath);
    const entryFile = files.find(
      (file) => file.kind === "file" && file.path === request.preview.entryPath,
    );
    if (!entryFile || entryFile.kind !== "file") {
      throw new Error(
        `Preview entry ${JSON.stringify(request.preview.entryPath)} must be an existing file in the Draft.`,
      );
    }
    validatePreviewFile(request.preview, entryFile);

    const targetVersion = (latestRevision?.version ?? 0) + 1;
    const revisionPath = join(artifact.artifactDirectory, `v${targetVersion}`);
    if (await pathExists(revisionPath)) {
      throw new Error(`Revision v${targetVersion} already exists.`);
    }
    const revision: FinalizedRevision = {
      id: `revision-${randomUUID()}`,
      version: targetVersion,
      preview: request.preview,
      approvedOrigins: [],
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
    });
    try {
      await previewServer.probe(previewToken, request.preview.entryPath);
      await writeJsonDurable(journalPath, journal);
      crashForTest("before-rename");
      await rename(draftPath, revisionPath);
      crashForTest("after-rename");
      journal.phase = "renamed";
      await writeJsonDurable(journalPath, journal);
      await writeJsonDurable(
        join(artifact.artifactDirectory, "artifact.json"),
        nextManifest,
      );
      crashForTest("after-manifest");
      journal.phase = "manifest-replaced";
      await writeJsonDurable(journalPath, journal);
      crashForTest("before-cleanup");
      await unlink(journalPath);
      await removeDraftMetadata(artifact.artifactDirectory);
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
      if (!(error instanceof SimulatedCrashError)) {
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
  return { artifactId: artifactId.data, preview: preview.data };
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

function finalizeToolResult(result: FinalizeResult) {
  const metadata = { ...result };
  return {
    title: `Finalized ${result.title} v${result.version}`,
    output: JSON.stringify(metadata),
    metadata,
  };
}

interface LocalArtifact {
  artifactDirectory: string;
  manifest: ArtifactManifest;
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

async function scanRevisionFiles(root: string): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];

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
      const mode = stats.mode & 0o7777;
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Draft contains unsupported symlink ${JSON.stringify(relativePath)}.`,
        );
      }
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
    if (!(await pathExists(path))) {
      throw new Error(
        `Finalized Revision v${revision.version} is missing from disk.`,
      );
    }
    await verifyRevisionFiles(path, revision.files);
  }
}

async function verifyRevisionFiles(root: string, expected: ArtifactFile[]) {
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

async function writeJsonDurable(path: string, value: unknown) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o644);
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

class SimulatedCrashError extends Error {}

function crashForTest(phase: string) {
  if (process.env.OPENCODE_PANES_TEST_CRASH_PHASE === phase) {
    throw new SimulatedCrashError(`Simulated finalization crash at ${phase}.`);
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
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(artifactDirectory) === queued)
      locks.delete(artifactDirectory);
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
    const response = await requestLoopback(this.url(token, entryPath));
    if (response.statusCode !== 200) {
      throw new Error(
        `Local Preview validation failed with HTTP ${response.statusCode}.`,
      );
    }
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
    let contentType = file.mediaType;
    try {
      if (
        route.preview.adapter === "renderer" &&
        route.preview.entryPath === relativePath
      ) {
        body = Buffer.from(
          await rendererWrapper(route.preview.renderer, route.root, file.path),
        );
        contentType = "text/html";
      } else {
        body = await readFile(join(route.root, relativePath));
      }
    } catch {
      response.writeHead(409, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Finalized Revision files no longer match artifact.json.");
      return;
    }
    const contentTypeHeader =
      /^text\//u.test(contentType) ||
      /^(?:application\/(?:javascript|json|typescript|xml)|image\/svg\+xml)$/u.test(
        contentType,
      )
        ? `${contentType}; charset=utf-8`
        : contentType;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'",
      "content-type": contentTypeHeader,
      "content-length": body.byteLength,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "GET") response.end(body);
    else response.end();
  }
}

async function rendererWrapper(
  renderer: "react" | "markdown" | "mermaid" | "code",
  root: string,
  entryPath: string,
) {
  const source = (await readFile(join(root, entryPath))).toString("utf8");
  const encodedSource = JSON.stringify(source).replace(/</gu, "\\u003c");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="panes-adapter" content="renderer:${renderer}">
<title>Panes ${renderer} preview</title>
<style>body{margin:0;padding:2rem;background:#fff;color:#111;font:16px/1.5 ui-monospace,monospace}pre{white-space:pre-wrap}</style>
<main data-renderer="${renderer}" data-panes-renderer="${renderer}"><pre></pre></main>
<script>const source=${encodedSource};document.querySelector("pre").textContent=source;</script>`;
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

async function resolveLocalProject(context: ToolContext) {
  const git = await inspectGit(context.directory);
  const artifactRoot = join(
    git ? context.worktree : context.directory,
    "artifacts",
  );
  const projectId = git?.remote
    ? normalizeGitRemote(git.remote)
    : await readOrCreateProjectId(artifactRoot);
  if (!artifactIdSchema.safeParse(projectId).success) {
    throw new Error(
      "The project identity is not a valid local artifact identifier.",
    );
  }
  return { artifactRoot, projectId };
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

  return {
    apiBaseUrl,
    autoOpen: autoOpenValue,
    ...(createApiKeyValue ? { createApiKey: createApiKeyValue } : {}),
    requestTimeoutMs: requestTimeoutMsValue,
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
  metadata: { operation: "create" | "update"; title: string },
) {
  await context.ask({
    permission: "artifact_upload",
    patterns: [apiBaseUrl.origin],
    always: [apiBaseUrl.origin],
    metadata: { endpoint: apiBaseUrl.origin, ...metadata },
  });
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
