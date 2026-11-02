ESCALATE

## Why
The change itself looks good and ready to merge. All four round-1 reviews (security, ux, ui, code) are `VERDICT: PASS` with no real problems in their Notes, the merge-tree check is clean, and my spot-checks of the acceptance criteria pass. I am escalating only because the branch edits product documentation under `docs-site/docs/`. The approver rules say changes to `docs/` always escalate and that no repo tailoring relaxes this. The only record of the owner's approval is in agent-written text (the orchestrator's note, build.md, rework-1.md), and I cannot treat that as the owner's own consent to merge without a human looking.

## Acceptance criteria
1. `npm run check:docs` succeeds: met per build.md and review-code.md. I did not re-run it.
2. IMAP count is non-zero in both pages: met. build.md reports 19 and 17.
3. Each page has mxrouting.net, CREDENTIALS_ENCRYPTION_KEY, credentials-key, INBOX, read-only, 1 MiB and 32 MiB: met. I checked with grep and every term appears at least once in each page.
4. The tracking page names IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_SYNC_BYTES and imap-client.ts: met (grep).
5. The tracking page's API table has the imap connect, status, sync and disconnect rows: met per build.md and review-code.md.
6. The workflow page has a curl to the imap connect endpoint with accountKey and a payload of host, port, tls, username and password, plus a curl to sync: met. I checked the connect curl at post-application-workflow.md:151-162. It uses placeholder values, not real secrets.
7. Both frontmatter descriptions mention IMAP, and id, title and sidebar_position are unchanged: met. Only the `description` lines appear in the diff.
8. The stated defaults match the code: met. Port 993 is set in providers/imap.ts:30, the 32-character key minimum in credential-crypto.ts:16, and the searchDays and maxMessages defaults in imap-sync.ts:237-238.
9. Only the two docs-site/docs files changed: met (`git diff --stat`).
10. Optional visual check: not run. This criterion is optional.

## For the human
Decide whether to merge this edit to product documentation. If the edit was intended, merge `factory/004-imap-docs-update` into `main` yourself (commit 4174013). The spec's Assumptions say it was intended: the backlog deferred this item from jobs 001 and 003, and the repo has no fm-docs process. A short read of the two pages is enough, since all four reviewers passed it:
- docs-site/docs/features/post-application-tracking.md
- docs-site/docs/workflows/post-application-workflow.md

If you want future docs-site jobs to merge without escalation, the factory approver rules need changing. A note in the repo cannot do it, because the approver's rules say no repo tailoring relaxes the docs rule.
