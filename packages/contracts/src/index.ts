import { z } from "zod";

export const ARTIFACT_TYPES = [
  "html",
  "react",
  "svg",
  "mermaid",
  "markdown",
  "code",
] as const;

export const MAX_ARTIFACT_SOURCE_BYTES = 1024 * 1024;
// MVP storage bounds keep the source-bearing revision list response manageable.
export const MAX_ARTIFACT_REVISIONS = 16;
export const MAX_ARTIFACT_TOTAL_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_TITLE_LENGTH = 200;
export const WORKSPACE_TOKEN_FRAGMENT_KEY = "workspaceToken";
export const MAX_REMOTE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_REMOTE_REVISION_BYTES = 100 * 1024 * 1024;

export const LOCAL_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;
export const CLOUD_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_ARTIFACT_SLUG_LENGTH = 128;
export const MAX_ARTIFACT_KIND_LENGTH = 64;
export const MAX_ARTIFACT_PATH_LENGTH = 1024;
export const MAX_MEDIA_TYPE_LENGTH = 256;
export const LOCAL_PREVIEW_ADAPTERS = ["browser", "renderer"] as const;
export const PANES_RENDERER_TYPES = [
  "react",
  "markdown",
  "mermaid",
  "code",
] as const;
export const PUBLICATION_DURATIONS = [1, 7, 30] as const;
export const DEFAULT_PUBLICATION_DURATION = 7;
export const SYNC_STATES = ["pending", "syncing", "synced", "failed"] as const;

export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);

export const artifactSourceSchema = z
  .string()
  .min(1, "Source is required")
  .superRefine((source, context) => {
    if (
      new TextEncoder().encode(source).byteLength > MAX_ARTIFACT_SOURCE_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: `Source must be at most ${MAX_ARTIFACT_SOURCE_BYTES} UTF-8 bytes`,
      });
    }
  });

export const createArtifactRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
  type: artifactTypeSchema,
  source: artifactSourceSchema,
  sessionId: z.string().trim().min(1).max(256),
});

export const createRevisionRequestSchema = z.strictObject({
  source: artifactSourceSchema,
});

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\S+$/)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Identifiers must not contain control characters",
  });
export const artifactIdSchema = identifierSchema;
export const revisionIdSchema = identifierSchema;
const capabilityTokenSchema = z.string().min(1).max(512).regex(/^\S+$/);
export const ownerTokenSchema = capabilityTokenSchema;
export const workspaceTokenSchema = capabilityTokenSchema;
const timestampSchema = z.iso.datetime();
const urlSchema = z.url();
const versionSchema = z.number().int().positive().safe();

const originValueSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Origin must be a valid URL",
      });
      return;
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Origins must use HTTP or HTTPS",
      });
    }
    if (
      origin.pathname !== "/" ||
      origin.search.length > 0 ||
      origin.hash.length > 0 ||
      origin.username.length > 0 ||
      origin.password.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Origin must not contain a path, query, fragment, or credentials",
      });
    }
    const authority =
      value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu)?.[1] ?? "";
    const hostname = authority.slice(authority.lastIndexOf("@") + 1);
    if (/[^\x00-\x7f]/u.test(hostname)) {
      context.addIssue({
        code: "custom",
        message: "Origins must use an ASCII hostname",
      });
    }
    if (
      origin.hostname.endsWith(".") ||
      origin.hostname
        .split(".")
        .some((label) => label.toLowerCase().startsWith("xn--"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Origins must not use ambiguous hostname aliases",
      });
    }
  })
  .transform((value) => new URL(value).origin);

const originListSchema = () =>
  z
    .array(originValueSchema)
    .superRefine((origins, context) => {
      const seen = new Set<string>();
      for (const [index, origin] of origins.entries()) {
        if (seen.has(origin)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "Origins must be unique after normalization",
          });
        }
        seen.add(origin);
      }
    })
    .transform((origins) => [...origins].sort());

export const requestedOriginsSchema = originListSchema();
export const approvedOriginsSchema = originListSchema();
export const httpOriginSchema = originValueSchema;

const normalizedPathCollisionKey = (path: string) =>
  path
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, "").toLocaleLowerCase())
    .join("/");

const normalizeRelativePath = (path: string) =>
  path
    .normalize("NFC")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

const relativePathInputSchema = z
  .string()
  .min(1)
  .max(MAX_ARTIFACT_PATH_LENGTH)
  .superRefine((path, context) => {
    if (/^[A-Za-z]:/u.test(path)) {
      context.addIssue({ code: "custom", message: "Path must be relative" });
    }
    if (path.startsWith("/") || path.includes("\\")) {
      context.addIssue({
        code: "custom",
        message: "Path must use relative POSIX syntax",
      });
    }
    if (/[\u0000-\u001f\u007f]/u.test(path)) {
      context.addIssue({
        code: "custom",
        message: "Path must not contain control characters",
      });
    }
    if (path.split("/").some((segment) => segment === "..")) {
      context.addIssue({
        code: "custom",
        message: "Path traversal is not allowed",
      });
    }
    for (const segment of path.split("/")) {
      if (segment.length === 0 || segment === ".") continue;
      if (/[ .]$/u.test(segment)) {
        context.addIssue({
          code: "custom",
          message: "Path segments must not end in a space or period",
        });
      }
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
        context.addIssue({
          code: "custom",
          message: "Windows device names are not valid path segments",
        });
      }
    }
  });

export const relativePathSchema = relativePathInputSchema
  .transform(normalizeRelativePath)
  .pipe(z.string().min(1));

export const artifactSlugSchema = z
  .string()
  .min(1)
  .max(MAX_ARTIFACT_SLUG_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const revisionNumberSchema = versionSchema;

const previewEntryBaseSchema = z.strictObject({
  entryPath: relativePathSchema,
});

export const browserPreviewEntrySchema = previewEntryBaseSchema.extend({
  adapter: z.literal("browser"),
});

export const rendererPreviewEntrySchema = previewEntryBaseSchema.extend({
  adapter: z.literal("renderer"),
  renderer: z.enum(PANES_RENDERER_TYPES),
});

export const previewEntrySchema = z.discriminatedUnion("adapter", [
  browserPreviewEntrySchema,
  rendererPreviewEntrySchema,
]);

const portableModeSchema = z.number().int().nonnegative().max(0o7777);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const rawByteSizeSchema = z.number().int().nonnegative().safe();
const artifactFileBaseSchema = z.strictObject({
  path: relativePathSchema,
  mode: portableModeSchema.optional(),
});

export const artifactFileSchema = z.discriminatedUnion("kind", [
  artifactFileBaseSchema.extend({
    kind: z.literal("file"),
    sha256: sha256Schema,
    byteSize: rawByteSizeSchema,
    mediaType: z.string().min(1).max(MAX_MEDIA_TYPE_LENGTH),
  }),
  artifactFileBaseSchema.extend({
    kind: z.literal("directory"),
    byteSize: z.literal(0),
  }),
]);

export const artifactFilesSchema = z
  .array(artifactFileSchema)
  .superRefine((files, context) => {
    const seen = new Map<string, number>();
    for (const [index, file] of files.entries()) {
      const key = normalizedPathCollisionKey(file.path);
      const previousIndex = seen.get(key);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "path"],
          message: `Path collides with file at index ${previousIndex}`,
        });
      } else {
        seen.set(key, index);
      }
      for (const [otherKey, otherIndex] of seen.entries()) {
        if (otherIndex === index) continue;
        const otherFile = files[otherIndex];
        if (!otherFile) continue;
        if (
          (key.startsWith(`${otherKey}/`) && otherFile.kind === "file") ||
          (otherKey.startsWith(`${key}/`) && file.kind === "file")
        ) {
          context.addIssue({
            code: "custom",
            path: [index, "path"],
            message: `Path conflicts with file at index ${otherIndex}`,
          });
        }
      }
    }
  });

export const finalizedRevisionSchema = z.strictObject({
  id: revisionIdSchema,
  version: revisionNumberSchema,
  preview: previewEntrySchema,
  approvedOrigins: approvedOriginsSchema,
  files: artifactFilesSchema,
  createdAt: timestampSchema,
});

export const localRevisionSchema = finalizedRevisionSchema;

export const cloudArtifactMappingSchema = z.strictObject({
  cloudProjectId: identifierSchema,
  cloudArtifactId: identifierSchema,
});

export const artifactManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(LOCAL_ARTIFACT_MANIFEST_SCHEMA_VERSION),
    projectId: artifactIdSchema,
    artifactId: artifactIdSchema,
    slug: artifactSlugSchema,
    title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
    kind: z.string().min(1).max(MAX_ARTIFACT_KIND_LENGTH).optional(),
    revisions: z.array(finalizedRevisionSchema),
    cloud: cloudArtifactMappingSchema.optional(),
  })
  .superRefine((manifest, context) => {
    for (const [index, revision] of manifest.revisions.entries()) {
      if (revision.version !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["revisions", index, "version"],
          message: "Finalized revisions must be contiguous and start at v1",
        });
      }
    }
  });

export const draftSchema = z.strictObject({
  artifactId: artifactIdSchema,
  baseRevision: revisionNumberSchema.nullable(),
  requestedOrigins: requestedOriginsSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const syncStateSchema = z.strictObject({
  status: z.enum(SYNC_STATES),
  syncedRevisionVersions: z.array(revisionNumberSchema),
  updatedAt: timestampSchema,
  error: z.string().min(1).max(1024).optional(),
});

export const ownerCredentialSchema = z.strictObject({
  artifactId: artifactIdSchema,
  credential: capabilityTokenSchema,
  createdAt: timestampSchema,
  rotatedAt: timestampSchema.optional(),
});

export const creatorLinkSchema = z.strictObject({
  artifactId: artifactIdSchema,
  url: urlSchema,
  status: z.enum(["active", "expired", "revoked"]),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
});

const publicationDurationSchema = z.union(
  PUBLICATION_DURATIONS.map((duration) => z.literal(duration)),
);

export const publicationSchema = z.strictObject({
  id: identifierSchema,
  artifactId: artifactIdSchema,
  revisionVersion: revisionNumberSchema,
  durationDays: publicationDurationSchema,
  publicUrl: urlSchema.optional(),
  status: z.enum(["active", "expired", "revoked"]),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  revokedAt: timestampSchema.optional(),
});

export const publicationStatusResponseSchema = z.strictObject({
  status: z.literal("active"),
  expiresAt: timestampSchema,
});

export const creatorPublicationRequestSchema = z.strictObject({
  revisionVersion: revisionNumberSchema,
  durationDays: z.union(
    PUBLICATION_DURATIONS.map((duration) => z.literal(duration)),
  ),
});

export const creatorPublicationExtendRequestSchema = z.strictObject({
  durationDays: z.union(
    PUBLICATION_DURATIONS.map((duration) => z.literal(duration)),
  ),
});

export const cloudManifestSchema = z.strictObject({
  schemaVersion: z.literal(CLOUD_MANIFEST_SCHEMA_VERSION),
  projectId: artifactIdSchema,
  artifactId: artifactIdSchema,
  slug: artifactSlugSchema,
  title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
  kind: z.string().min(1).max(MAX_ARTIFACT_KIND_LENGTH).optional(),
  revisions: z.array(finalizedRevisionSchema),
});

export const cloudManifestSelectionSchema = z.strictObject({
  version: revisionNumberSchema,
  paths: z.array(relativePathSchema).superRefine((paths, context) => {
    const seen = new Set<string>();
    for (const [index, path] of paths.entries()) {
      const key = normalizedPathCollisionKey(path);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Upload paths must be unique after normalization",
        });
      }
      seen.add(key);
    }
  }),
});

export const syncCreateRequestSchema = z.strictObject({
  projectId: artifactIdSchema,
  artifactId: artifactIdSchema,
  slug: artifactSlugSchema,
  title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
  kind: z.string().min(1).max(MAX_ARTIFACT_KIND_LENGTH).optional(),
  idempotencyKey: z.string().min(1).max(256),
  ownerCredential: ownerTokenSchema,
  creatorToken: ownerTokenSchema,
});

export const syncCreateResponseSchema = z.strictObject({
  cloudProjectId: artifactIdSchema,
  cloudArtifactId: artifactIdSchema,
  ownerCredential: ownerTokenSchema,
  creatorUrl: urlSchema,
  inventoryUrl: urlSchema,
  creatorExpiresAt: timestampSchema,
});

export const syncRevisionCommitRequestSchema = z.strictObject({
  manifest: cloudManifestSchema,
});

export const syncRevisionCommitResponseSchema = z.strictObject({
  cloudArtifactId: artifactIdSchema,
  version: revisionNumberSchema,
  committedAt: timestampSchema,
});

export const syncCreatorRotateRequestSchema = z.strictObject({});

export const syncCreatorRotateResponseSchema = z.strictObject({
  cloudArtifactId: artifactIdSchema,
  creatorToken: ownerTokenSchema,
  creatorUrl: urlSchema,
  creatorExpiresAt: timestampSchema,
});

export const creatorWorkspaceRevisionSchema = finalizedRevisionSchema;

export const creatorWorkspaceResponseSchema = z.strictObject({
  cloudArtifactId: identifierSchema,
  cloudProjectId: identifierSchema,
  slug: artifactSlugSchema,
  title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
  kind: z.string().min(1).max(MAX_ARTIFACT_KIND_LENGTH).optional(),
  creatorExpiresAt: timestampSchema,
  revisions: z.array(creatorWorkspaceRevisionSchema),
  publication: publicationSchema.nullable().optional(),
  publicationHistory: z.array(publicationSchema).optional(),
});

const publicArtifactFileSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    path: relativePathSchema,
    byteSize: rawByteSizeSchema,
    mediaType: z.string().min(1).max(MAX_MEDIA_TYPE_LENGTH),
  }),
  z.strictObject({
    kind: z.literal("directory"),
    path: relativePathSchema,
    byteSize: z.literal(0),
  }),
]);

export const publicPublicationRevisionSchema = z.strictObject({
  version: revisionNumberSchema,
  preview: previewEntrySchema,
  approvedOrigins: approvedOriginsSchema,
  files: z.array(publicArtifactFileSchema),
  createdAt: timestampSchema,
});

export const publicArtifactPresentationSchema = z.strictObject({
  slug: artifactSlugSchema,
  title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
  kind: z.string().min(1).max(MAX_ARTIFACT_KIND_LENGTH).optional(),
});

export const publicPublicationResponseSchema = z.strictObject({
  status: z.literal("active"),
  expiresAt: timestampSchema,
  artifact: publicArtifactPresentationSchema,
  revision: publicPublicationRevisionSchema,
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type CloudArtifactMapping = z.infer<typeof cloudArtifactMappingSchema>;
export type CloudManifest = z.infer<typeof cloudManifestSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type SyncState = z.infer<typeof syncStateSchema>;
export type OwnerCredential = z.infer<typeof ownerCredentialSchema>;
export type CreatorLink = z.infer<typeof creatorLinkSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type PublicationStatusResponse = z.infer<
  typeof publicationStatusResponseSchema
>;
export type CreatorPublicationRequest = z.infer<
  typeof creatorPublicationRequestSchema
>;
export type CreatorPublicationExtendRequest = z.infer<
  typeof creatorPublicationExtendRequestSchema
>;
export type PreviewEntry = z.infer<typeof previewEntrySchema>;
export type ArtifactFile = z.infer<typeof artifactFileSchema>;
export type FinalizedRevision = z.infer<typeof finalizedRevisionSchema>;
export type CloudManifestSelection = z.infer<
  typeof cloudManifestSelectionSchema
>;
export type SyncCreateRequest = z.infer<typeof syncCreateRequestSchema>;
export type SyncCreateResponse = z.infer<typeof syncCreateResponseSchema>;
export type SyncRevisionCommitRequest = z.infer<
  typeof syncRevisionCommitRequestSchema
>;
export type SyncRevisionCommitResponse = z.infer<
  typeof syncRevisionCommitResponseSchema
>;
export type SyncCreatorRotateResponse = z.infer<
  typeof syncCreatorRotateResponseSchema
>;
export type CreatorWorkspaceRevision = z.infer<
  typeof creatorWorkspaceRevisionSchema
>;
export type CreatorWorkspaceResponse = z.infer<
  typeof creatorWorkspaceResponseSchema
>;
export type PublicPublicationRevision = z.infer<
  typeof publicPublicationRevisionSchema
>;
export type PublicArtifactPresentation = z.infer<
  typeof publicArtifactPresentationSchema
>;
export type PublicPublicationResponse = z.infer<
  typeof publicPublicationResponseSchema
>;

export const deriveCloudManifest = (
  manifest: unknown,
  uploadSet?: readonly CloudManifestSelection[],
): CloudManifest => {
  const canonicalManifest = artifactManifestSchema.parse(manifest);
  const selections = uploadSet
    ? z.array(cloudManifestSelectionSchema).parse(uploadSet)
    : canonicalManifest.revisions.map((revision) => ({
        version: revision.version,
        paths: revision.files.map((file) => file.path),
      }));
  const selectedVersions = new Set<number>();

  const revisions = selections.map((selection) => {
    if (selectedVersions.has(selection.version)) {
      throw new Error(`Revision v${selection.version} selected more than once`);
    }
    selectedVersions.add(selection.version);

    const revision = canonicalManifest.revisions.find(
      (candidate) => candidate.version === selection.version,
    );
    if (!revision) {
      throw new Error(`Revision v${selection.version} does not exist`);
    }

    const selectedPaths = new Set(selection.paths);
    const files = revision.files.filter((file) => selectedPaths.has(file.path));
    if (files.length !== selectedPaths.size) {
      throw new Error(
        `Upload set contains a file outside revision v${selection.version}`,
      );
    }

    return { ...revision, files };
  });

  return cloudManifestSchema.parse({
    schemaVersion: CLOUD_MANIFEST_SCHEMA_VERSION,
    projectId: canonicalManifest.projectId,
    artifactId: canonicalManifest.artifactId,
    slug: canonicalManifest.slug,
    title: canonicalManifest.title,
    ...(canonicalManifest.kind ? { kind: canonicalManifest.kind } : {}),
    revisions,
  });
};

export const artifactSchema = z.strictObject({
  id: artifactIdSchema,
  title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
  type: artifactTypeSchema,
  currentRevisionId: revisionIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const revisionSchema = z.strictObject({
  id: revisionIdSchema,
  artifactId: artifactIdSchema,
  version: versionSchema,
  source: artifactSourceSchema,
  createdAt: timestampSchema,
});

export const artifactResponseSchema = z.strictObject({
  artifact: artifactSchema,
  revision: revisionSchema,
  viewerUrl: urlSchema,
});

export const createArtifactResponseSchema = z.strictObject({
  artifact: artifactSchema,
  revision: revisionSchema,
  ownerToken: ownerTokenSchema,
  viewerUrl: urlSchema,
});

export const revisionResponseSchema = z.strictObject({
  artifactId: artifactIdSchema,
  revision: revisionSchema,
  viewerUrl: urlSchema,
});

export const shareResponseSchema = z.strictObject({
  artifactId: artifactIdSchema,
  revisionId: revisionIdSchema,
  version: versionSchema,
  publicUrl: urlSchema,
  createdAt: timestampSchema,
});

export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "SOURCE_TOO_LARGE",
  "FILE_TOO_LARGE",
  "REVISION_TOO_LARGE",
  "HASH_MISMATCH",
  "INTERNAL_ERROR",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const errorIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  message: z.string().min(1),
});

export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    issues: z.array(errorIssueSchema).optional(),
  }),
});

export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;
export type CreateRevisionRequest = z.infer<typeof createRevisionRequestSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type ArtifactResponse = z.infer<typeof artifactResponseSchema>;
export type CreateArtifactResponse = z.infer<
  typeof createArtifactResponseSchema
>;
export type RevisionResponse = z.infer<typeof revisionResponseSchema>;
export type ShareResponse = z.infer<typeof shareResponseSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ErrorIssue = z.infer<typeof errorIssueSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
