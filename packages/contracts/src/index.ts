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

const identifierSchema = z.string().min(1).max(128).regex(/^\S+$/);
export const artifactIdSchema = identifierSchema;
export const revisionIdSchema = identifierSchema;
const capabilityTokenSchema = z.string().min(1).max(512).regex(/^\S+$/);
export const ownerTokenSchema = capabilityTokenSchema;
export const workspaceTokenSchema = capabilityTokenSchema;
const timestampSchema = z.iso.datetime();
const urlSchema = z.url();
const versionSchema = z.number().int().positive();

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
