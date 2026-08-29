export interface ArtifactNetworkPolicy {
  origins: string[];
  connectSrc: string[];
  imageSrc: string[];
  mediaSrc: string[];
  fontSrc: string[];
  styleSrc: string[];
  scriptSrc: string[];
}

export declare function normalizePreviewOrigins(
  origins: readonly string[],
): string[];
export declare function createArtifactNetworkPolicy(
  origins: readonly string[],
): ArtifactNetworkPolicy;
export declare function isAllowedArtifactNetworkRequest(
  value: string,
  origins: readonly string[],
): boolean;
