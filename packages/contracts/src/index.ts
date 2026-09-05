import { z } from "zod";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 500;

export const filePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\\\u0000-\u001f\u007f?#%:]/u.test(value) &&
      value
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Use a safe relative file path",
  );

export function isExcludedPath(path: string): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        /^(?:\.git|node_modules|\.cache|\.next|\.nuxt|\.turbo|\.output|\.panes|\.panesignore|\.npmrc|\.netrc|\.ssh|id_rsa|id_ed25519|id_ecdsa|id_dsa|artifact\.json|draft\.json)$/iu.test(
          part,
        ) ||
        /^\.env(?:\.|$)/iu.test(part) ||
        /\.(?:pem|key|p12|pfx)$/iu.test(part),
    );
}

export const uploadFileSchema = z
  .object({
    path: filePathSchema.refine(
      (path) => !isExcludedPath(path),
      "This file is excluded from upload",
    ),
    mediaType: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu),
    size: z.number().int().min(0).max(MAX_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const uploadRequestSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/u),
    project: z
      .object({
        id: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(100),
      })
      .strict(),
    artifactKey: z.string().min(1).max(512),
    title: z.string().trim().min(1).max(200),
    entryPath: filePathSchema.refine(
      (path) => /\.(?:html?|svg)$/iu.test(path),
      "Choose an HTML or SVG entry; build framework source locally first",
    ),
    files: z.array(uploadFileSchema).min(1).max(MAX_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.files.map((file) => file.path)).size !== value.files.length
    )
      context.addIssue({ code: "custom", message: "Duplicate file paths" });
    if (!value.files.some((file) => file.path === value.entryPath))
      context.addIssue({
        code: "custom",
        message: "The entry file must be included",
      });
    if (
      value.files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES
    )
      context.addIssue({ code: "custom", message: "Upload exceeds 100 MiB" });
  });

export const uploadSessionSchema = z.object({
  uploadId: z.string(),
  artifactId: z.string(),
  complete: z.boolean(),
  dashboardUrl: z.string(),
});
export const uploadResultSchema = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  dashboardUrl: z.string(),
});

export const shareRequestSchema = z
  .object({
    versionId: z.string().min(1),
    expiresInDays: z.union([
      z.literal(1),
      z.literal(7),
      z.literal(30),
      z.null(),
    ]),
  })
  .strict();

export interface Project {
  id: string;
  name: string;
}
export interface ArtifactVersion {
  id: string;
  number: number;
  createdAt: string;
  entryPath: string;
  fileCount: number;
  bytes: number;
  /** Read-only, version-scoped URL. Never contains an upload or owner credential. */
  previewUrl: string;
}
export interface ArtifactShare {
  url: string;
  versionId: string;
  expiresAt: string | null;
  status: "active" | "expired";
}
export interface LibraryArtifact {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  versions: ArtifactVersion[];
  share: ArtifactShare | null;
}
export interface ArtifactLibrary {
  projects: Project[];
  artifacts: LibraryArtifact[];
}
export interface PublicArtifact {
  title: string;
  version: ArtifactVersion;
  expiresAt: string | null;
}
export type UploadRequest = z.infer<typeof uploadRequestSchema>;
export type UploadFile = z.infer<typeof uploadFileSchema>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export type UploadResult = z.infer<typeof uploadResultSchema>;
export type ShareRequest = z.infer<typeof shareRequestSchema>;
