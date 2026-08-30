# 13: Isolate public multi-file Publications

**What to build:** Let a public-link holder preview and inspect only the Revision selected for the active Publication. Supporting files work normally, but no route or UI reveals private, earlier, or later Revisions.

**Blocked by:** 12: Publish one selected Revision with explicit expiry

**Status:** ready-for-agent

- [ ] A valid public token authorizes the selected Revision and its declared files only.
- [ ] Public request validation uses the token hash and never requires decrypting the recoverable token ciphertext.
- [ ] Public Preview resolves nested assets without exposing private object identifiers or direct bucket access.
- [ ] Public Files displays the selected Revision's safe file tree, highlighted text, and binary metadata.
- [ ] Directory listing, traversal, guessed paths outside the selected Revision, and requests for another Revision fail without metadata leakage.
- [ ] Direct-browser and Panes-renderer adapters use the same approved-origin policy inputs and match the Revision validated locally and viewed through the Creator workspace.
- [ ] Expired or revoked public links return `410 Gone` through the existing status view; unknown tokens return `404 Not Found`.
- [ ] Responses are non-cacheable where capability state requires it and never leak creator, owner, project, or unpublished Revision data.
