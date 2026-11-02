# Document the IMAP provider in the post-application docs-site pages
Outcome: merged 2026-11-02 after 1 review round (0 reworks) · Mission fit: Fits

> Feature: Update docs-site pages post-application-tracking.md and post-application-workflow.md to describe the IMAP provider (MxRoute example, password stored encrypted, CREDENTIALS_ENCRYPTION_KEY, INBOX read-only sync); also mention the IMAP sync limits of 1 MiB per message and 32 MiB per sync (IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_SYNC_BYTES in imap-client.ts)

## What shipped
Jobs 001 and 003 added IMAP support but left the docs-site pages Gmail-only. Commit `4174013` adds IMAP to `docs-site/docs/features/post-application-tracking.md` (IMAP setup with an MxRoute example, encrypted password storage, `CREDENTIALS_ENCRYPTION_KEY`, INBOX read-only sync, a limits subsection, API table rows, troubleshooting) and `docs-site/docs/workflows/post-application-workflow.md` (new "Option C" with curl examples for connect, status, sync and inbox review). Existing Gmail content was kept under a new Gmail heading. The change is 157 insertions and 10 deletions in those two files only.

## Approval path
- The factory builder refused the job because its rules forbid editing anything under a `docs` folder.
- The owner approved the edit, and a general-purpose agent built it in the job worktree (build.md, rework-1.md).
- All four reviewers passed in round 1.
- The approver escalated (`decision.md`: ESCALATE) because its rules say `docs/` changes always escalate, and the only record of the owner's approval was agent-written text.
- The owner then approved the merge directly in chat ("yes merge and carry on"; not recorded elsewhere in the job folder).

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. `npm run check:docs` succeeds | Met | build.md; review-code.md ran it: pass. Approver did not re-run it |
| 2. IMAP appears in both pages | Met | build.md: 19 and 17 hits |
| 3. Required terms in both pages | Met | review-code.md; approver grep in decision.md |
| 4. Limit constant names and `imap-client.ts` in tracking page | Met | decision.md (grep) |
| 5. API table lists imap connect/status/sync/disconnect | Met | build.md, review-code.md |
| 6. Workflow curl for connect (full body) and sync | Met | decision.md checked `post-application-workflow.md:151-162` |
| 7. Descriptions mention IMAP; id/title/sidebar_position unchanged | Met | decision.md: only `description` lines in diff |
| 8. Documented defaults match code | Met | decision.md; review-security checked STARTTLS, read-only, `BODY.PEEK[]` |
| 9. Only the two docs files changed | Met | `git diff --stat` on the branch |
| 10. Optional visual check | Not run | build.md; docs build passed. UX and UI reviewers did not use a browser |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |

## Iterations
### 1. Builder refused by the docs-folder rule
- **Caught by:** the factory builder itself, before round 1 (rework-1.md carries the owner's instruction). Escalated again by the approver (decision.md).
- **What was wrong:** the job edits `docs-site/docs/**`, which the factory's builder and approver rules treat as forbidden or always-escalate. Not a defect in the change.
- **Why the builder missed it:** not a miss. The spec's Assumptions already flagged the conflict, but the spec-writer cannot override builder or approver rules, so the job stalled twice.
- **Guardrail:** none for the code. See the table below.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|
| Factory approver/builder rules (plugin, outside this repo; owner decision) | A per-repo opt-in for docs-site paths, for example a `docsPaths` list in `factory/settings.json`, entered by the owner and not by an agent | Repeat refusals and escalations for docs-only backlog items. Unverified whether `settings.json` supports it |
| Backlog item template (`factory/backlog.md`) | A line on any item that touches `docs-site/docs/` saying "docs edit, owner pre-approved, expect escalation" | Surprise at the approver stage |

## Follow-ups
- [ ] Other Gmail-only docs pages: `docs-site/docs/getting-started/gmail-oauth-setup.md`, overview and self-hosting pages.
- [ ] Versioned docs (`docs-site/versioned_docs/**`) were not touched.
- [ ] The optional visual render check (`npm run docs:dev`, including the mermaid diagram) was not run by anyone.
- [ ] Cosmetic: the MxRoute table's Host cell is wider than its column padding in post-application-tracking.md.
- [ ] The curl examples use `localhost:3001` with no auth header, matching the existing Gmail examples.
- [ ] Confirm the MxRoute placeholder `<your-server>.mxrouting.net` on port 993 with TLS matches the real account.

## Mission fit
Fits: documents post-application email tracking and self-hosting setup for the user's own MxRoute IMAP server, both named in the mission. Drift: none.
