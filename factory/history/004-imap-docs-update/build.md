STATUS: READY

# Build: IMAP docs update (round 1)

Note: the factory builder refused this job because its rules forbid editing anything under a `docs` folder. The repo owner explicitly approved the edit, so a general-purpose agent implemented the spec in the job worktree instead. Reviewers should treat this as a normal build.

Commit `4174013` on `factory/004-imap-docs-update`: "docs: document IMAP provider in post-application pages".

Files changed (only these two, 157 insertions, 10 deletions):
- docs-site/docs/features/post-application-tracking.md
- docs-site/docs/workflows/post-application-workflow.md

Acceptance criteria (as reported by the implementing agent):
1. `npm run check:docs` succeeded, no broken links: Met.
2. IMAP mentioned in both pages (19 and 17 hits): Met.
3. Required terms present in both pages (mxrouting.net, CREDENTIALS_ENCRYPTION_KEY, credentials-key, INBOX, read-only, 1 MiB, 32 MiB): Met.
4. IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_SYNC_BYTES, imap-client.ts named in the limits subsection: Met.
5. API table lists imap connect, status, sync, disconnect: Met.
6. Workflow page has curl examples for connect, status, sync, inbox review: Met.
7. Descriptions mention IMAP; id, title, sidebar_position unchanged: Met.
8. Documented defaults match the code (993, TLS on, 90 days, 100 messages, 32-char key minimum): Met.
9. Diff touches only the two files: Met.
10. Visual check with `npm run docs:dev`: Not run. The docs build passed.

Extras: both pages note that IMAP connect and sync are disabled in the public demo. Gmail content is kept under a new Gmail subsection.
