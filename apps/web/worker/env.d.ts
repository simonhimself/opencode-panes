// Tests may omit this binding even though production declares it as required.
interface Env {
  PRIVATE_ARTIFACTS: R2Bucket;
  PANES_CREATE_API_KEY?: string;
  PUBLICATION_ENCRYPTION_KEY_V1?: string;
}

declare namespace Cloudflare {
  interface Env {
    PRIVATE_ARTIFACTS: R2Bucket;
  }
}
