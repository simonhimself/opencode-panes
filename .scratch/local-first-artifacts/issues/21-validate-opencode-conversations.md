# 21: Validate real OpenCode conversations

**What to build:** Validate the implemented local-first experience through real OpenCode conversations rather than adding another automated seam. Exercise the installed plugin with multiple model providers and send any failure back to the ticket that owns that behavior.

**Blocked by:** 04: Discover, reopen, and recover local Artifacts; 05: Import existing files and directories; 06: Enforce approved-origin preview security; 14: Download a selected Revision as a safe ZIP; 16: Manage cloud lifecycle from the inventory; 17: Recover an Owner credential with a reconnect code; 19: Export and adopt a Legacy artifact locally; 20: Contract the legacy source-string mutation path

**Status:** ready-for-agent

- [ ] A real OpenCode conversation completes create, review, revise, import, Sync, Publication, expiry handling, inventory login, recovery, deletion, and Legacy adoption.
- [ ] The conversational workflow is validated with the primary supported model and at least one additional provider before claiming model reliability.
- [ ] The complete create-to-Publication workflow works from the installed plugin with no required Panes skill or slash command.
- [ ] Ordinary Sync leaves the Creator workspace closed, while publish intent opens it after success and leaves final Revision and duration selection to the human.
- [ ] Conversation acceptance records enough reproducible detail to return failures to their owning implementation ticket instead of adding a cross-runtime test harness here.
