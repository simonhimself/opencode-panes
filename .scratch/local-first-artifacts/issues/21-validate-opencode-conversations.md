# 21: Validate real OpenCode conversations

**What to build:** Validate the implemented local-first experience through real OpenCode conversations rather than adding another automated seam. Exercise the installed plugin with multiple model providers and send any failure back to the ticket that owns that behavior.

**Blocked by:** 04: Discover, reopen, and recover local Artifacts; 05: Import existing files and directories; 06: Enforce approved-origin preview security; 14: Download a selected Revision as a safe ZIP; 16: Manage cloud lifecycle from the inventory; 17: Recover an Owner credential with a reconnect code; 19: Export and adopt a Legacy artifact locally; 20: Contract the legacy source-string mutation path

**Status:** blocked

- [ ] A real OpenCode conversation completes create, review, revise, import, Sync, Publication, expiry handling, inventory login, recovery, deletion, and Legacy adoption.
- [x] The conversational workflow is validated with the primary supported model and at least one additional provider before claiming model reliability.
- [x] The complete create-to-Publication workflow works from the installed plugin with no required Panes skill or slash command.
- [x] Ordinary Sync leaves the Creator workspace closed, while publish intent opens it after success and leaves final Revision and duration selection to the human.
- [x] Conversation acceptance records enough reproducible detail to return failures to their owning implementation ticket instead of adding a cross-runtime test harness here.

## Acceptance evidence

- On August 30, 2026, the primary `openai/gpt-5.6-sol` conversation completed every immediately testable step: create, review, revise, import, private Sync, explicit publish intent, human Publication, Access-authenticated Inventory, Legacy export/adoption, Owner reconnect, and confirmed cloud-copy deletion. Natural expiry remains the explicitly time-gated exception below. The adopted local Artifact retained byte-matched `v1` and revised `v2`; first Sync created a separate cloud identity and left the one-Revision Legacy source readable.
- The additional-provider `opencode-go/glm-5.3-flash` conversation used only the installed plugin to create Markdown `v1`, reopen and finalize `v2`, privately Sync with Creator closed, and invoke publish intent. The human selected Revision 2 and a one-day duration. Inventory and the Public viewer then showed the immutable Revision 2 Publication.
- Recovery acceptance quarantined only the adopted Artifact's protected local Sync state after explicit approval. A one-time ten-minute reconnect code replaced the Owner credential without rotating Creator access or Publication; ordinary Sync then reconfirmed versions 1 and 2 with Creator opening disabled.
- Deletion acceptance used a fresh, Artifact-specific human confirmation. Inventory removed only the adopted cloud copy, while local `v1`/`v2` hashes and the original Legacy Artifact remained unchanged. The invalid quarantined Owner state was removed after separate approval.
- A production first-Sync failure was returned to Ticket 19. Its cause was issuance expiry being reapplied to an already consumed, exactly bound adoption grant. Regression coverage keeps expired code redemption invalid while allowing exact, unrevoked provenance to complete first Sync.
- The remaining unchecked case is natural Publication expiry. The one-day secondary-provider Publication expires at `2026-08-31T10:49:21.696Z`; production time and stored expiry are intentionally not manipulated. After that time, verify the Public URL is unavailable and Inventory reports expiry, then mark this ticket done.
