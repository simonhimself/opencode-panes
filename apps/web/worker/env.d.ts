// Tests may omit this binding even though production declares it as required.
interface Env {
  PRIVATE_ARTIFACTS: R2Bucket;
  PANES_CREATE_API_KEY?: string;
  PUBLICATION_ENCRYPTION_KEY_V1?: string;
  PANES_ACCESS_ISSUER?: string;
  PANES_ACCESS_AUDIENCE?: string;
  PANES_ACCESS_ALLOWED_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

declare namespace Cloudflare {
  interface Env {
    PRIVATE_ARTIFACTS: R2Bucket;
  }
}
