# Document the IMAP provider in the post-application docs-site pages

> Feature: Update docs-site pages post-application-tracking.md and post-application-workflow.md to describe the IMAP provider (MxRoute example, password stored encrypted, CREDENTIALS_ENCRYPTION_KEY, INBOX read-only sync); also mention the IMAP sync limits of 1 MiB per message and 32 MiB per sync (IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_SYNC_BYTES in imap-client.ts)

## Context

Jobs 001 (IMAP provider) and 003 (IMAP size caps) shipped IMAP support. Both specs put the docs-site pages out of scope and left them as a follow-up, which is this job (backlog item 004; `factory/history/001-imap-email-provider/summary.md` and `factory/history/003-imap-size-cap/summary.md`).

Pages to change (current docs only, Docusaurus site in the `docs-site` npm workspace):

- `docs-site/docs/features/post-application-tracking.md`: frontmatter `description: Gmail-based tracking inbox...`. The intro, Overview, Setup, Privacy and security, API reference and Common issues sections talk only about Gmail.
- `docs-site/docs/workflows/post-application-workflow.md`: "Option A: Manual" and "Option B: Automatic Gmail syncing" with curl examples against `/api/post-application/providers/gmail/...`, then "Which option should you use?", "Common problems" and "Related pages".

How IMAP works today (facts the docs must match):

- UI: **Tracking Inbox → Provider Controls**. The **Provider** select offers `gmail` and `imap`. With `imap` selected and not connected, `ImapConnectForm` shows **Host** (placeholder `mail.example.com`), **Port** (default `993`), **Use TLS** (default on), **Username**, **Password** (`orchestrator/src/client/pages/tracking-inbox/ImapConnectForm.tsx`, `orchestrator/src/client/pages/TrackingInboxPage.tsx`). The same Max Messages / Search Days fields and the sync action apply to both providers.
- API: `POST /api/post-application/providers/imap/actions/{connect|status|sync|disconnect}` (`orchestrator/src/server/api/routes/post-application-providers.ts`). Connect body is `{"accountKey":"default","payload":{"host","port","tls","username","password"}}`; `port` defaults to 993, `tls` to `true`. Host must be a bare hostname (no scheme, path or spaces). Sync body is `{"accountKey","maxMessages","searchDays"}`; IMAP defaults are `searchDays` 90 and `maxMessages` 100 (`orchestrator/src/server/services/post-application/providers/imap.ts`, `.../ingestion/imap-sync.ts`). Connect and sync are blocked in the public demo.
- Connect tests the login first; a rejected login returns 400 "IMAP login failed. Check the username and password."; an unreachable server returns 502 "Could not reach the IMAP server at host:port." (`imap-client.ts`, `providers/imap.ts`).
- Transport: `tls: true` is implicit TLS (port 993); `tls: false` still requires STARTTLS, so the password never travels unencrypted. Certificate validation stays on (`imap-client.ts`, `createImapClient`).
- Read-only: sync opens `INBOX` with `readOnly: true` and fetches with `BODY.PEEK[]`, so messages are never marked read, moved or deleted. Only INBOX is scanned; other folders are not (`imap-client.ts`, `openInboxReadOnly`, `fetchMessageSources`).
- Password storage: AES-256-GCM via `orchestrator/src/server/infra/credential-crypto.ts`. Key from `CREDENTIALS_ENCRYPTION_KEY` (at least 32 characters); if unset, one is generated and saved at `DATA_DIR/credentials-key`. Losing the key means IMAP accounts must be reconnected (`.env.example` lines 60-62). Status responses expose host, port, tls, username and `hasPassword`, never the password.
- Size limits: `IMAP_MAX_MESSAGE_BYTES` = 1 MiB and `IMAP_MAX_SYNC_BYTES` = 32 MiB in `orchestrator/src/server/services/post-application/ingestion/imap-client.ts`. Larger messages are truncated to 1 MiB; once the 32 MiB per-sync budget is used, remaining messages are skipped for that run and a warning is logged (`imap-sync.ts`, `selectUidsWithinBudget`). The limits are constants, not settings. `AGENTS.md` already records both.

Doc conventions (`AGENTS.md`, "Documentation Standards"): keep the frontmatter keys `id`, `title`, `description`, `sidebar_position`; concrete steps; copy-pasteable examples; state defaults and constraints explicitly; link with `/docs/...` URLs or the relative links the pages already use. The existing pages link the Gmail guide as `/docs/next/getting-started/gmail-oauth-setup`.

Validation: `npm run check:docs` (runs `docusaurus build`; `docs-site/docusaurus.config.ts` sets `onBrokenLinks: "throw"` and `onBrokenMarkdownLinks: "throw"`).

## Requirements

1. `docs-site/docs/features/post-application-tracking.md`:
   1. Frontmatter `description` and the intro sentence name both Gmail and IMAP (no longer "Gmail-based" only). `id`, `title`, `sidebar_position` unchanged.
   2. The Overview and the smart-router mermaid diagram no longer say the inbox is Gmail-only (for example "Recruitment email arrives in Gmail or IMAP inbox").
   3. Setup has a Gmail subsection (the existing content) and a new IMAP subsection with: when to use it (any mailbox reachable over IMAP, such as MxRoute); UI steps (Tracking Inbox → Provider Controls → Provider `imap` → Host, Port, Use TLS, Username, Password → connect); an MxRoute example (host of the form `<your-server>.mxrouting.net`, port `993`, TLS on, username = full email address, password = that mailbox's password); the defaults (port 993, TLS on) and that turning TLS off still requires STARTTLS; the host must be a bare hostname.
   4. Privacy and security covers IMAP: INBOX only, opened read-only, messages never marked read, moved or deleted; password stored AES-256-GCM encrypted, never returned by the API; key from `CREDENTIALS_ENCRYPTION_KEY` (at least 32 characters) or auto-generated at `DATA_DIR/credentials-key`; losing or changing the key means reconnecting IMAP accounts; a copy-pasteable `CREDENTIALS_ENCRYPTION_KEY=...` example (for example generated with `openssl rand -base64 48`).
   5. A statement of the sync limits: each message is capped at 1 MiB (larger ones are truncated), each sync run fetches at most 32 MiB in total and skips the rest with a logged warning; name `IMAP_MAX_MESSAGE_BYTES` and `IMAP_MAX_SYNC_BYTES` and their file `orchestrator/src/server/services/post-application/ingestion/imap-client.ts`; say they are fixed constants, not settings.
   6. API reference table gains `POST /api/post-application/providers/imap/actions/connect`, `.../status`, `.../sync` and `.../disconnect` rows.
   7. Common issues gains IMAP entries: login failed (check username is the full address and password); could not reach server (check host, port, TLS/STARTTLS); a large message or a busy inbox only partly synced (the 1 MiB / 32 MiB limits; narrow `searchDays` / `maxMessages` or sync again); IMAP accounts disconnected after key change.
2. `docs-site/docs/workflows/post-application-workflow.md`:
   1. Frontmatter `description` and the Goal section's two paths mention IMAP as well as Gmail.
   2. A new "Option C: Automatic IMAP syncing" section (after Option B) with: high-level flow; in-app steps; the MxRoute example; the encryption key note with `CREDENTIALS_ENCRYPTION_KEY` and `DATA_DIR/credentials-key`; INBOX read-only behaviour; the 1 MiB / 32 MiB limits (may be brief and link to the tracking page for detail); IMAP defaults `searchDays` 90 and `maxMessages` 100.
   3. Copy-pasteable curl examples for IMAP connect (MxRoute values, `"tls": true`, `"port": 993`), sync and status, plus inbox review with `provider=imap`, all matching the real request shapes in Context.
   4. "Which option should you use?" and "Common problems" cover IMAP (including that "I prefer not to grant Gmail access" can use IMAP or manual tracking).
3. All facts in both pages match the code cited in Context. No placeholder password or key in the docs looks like a real secret.
4. Existing Gmail content stays accurate and is not removed.

## Acceptance criteria

1. `npm run check:docs` from the repo root succeeds (no broken links or markdown errors).
2. `grep -c "IMAP" docs-site/docs/features/post-application-tracking.md docs-site/docs/workflows/post-application-workflow.md` reports a non-zero count for both files.
3. Each of the two pages contains `mxrouting.net`, `CREDENTIALS_ENCRYPTION_KEY`, `credentials-key`, `INBOX`, `read-only` (or "read only"), `1 MiB` and `32 MiB` (check with `grep -n`).
4. `docs-site/docs/features/post-application-tracking.md` contains `IMAP_MAX_MESSAGE_BYTES`, `IMAP_MAX_SYNC_BYTES` and `imap-client.ts`.
5. `docs-site/docs/features/post-application-tracking.md` API table lists `/api/post-application/providers/imap/actions/connect`, `/status`, `/sync` and `/disconnect`.
6. `docs-site/docs/workflows/post-application-workflow.md` contains a curl example posting to `/api/post-application/providers/imap/actions/connect` whose JSON body has `accountKey` and a `payload` object with `host`, `port`, `tls`, `username`, `password`; and a curl to `/api/post-application/providers/imap/actions/sync`.
7. The frontmatter `description` of both pages mentions IMAP, and both still have `id`, `title`, `description`, `sidebar_position` with unchanged `id`, `title`, `sidebar_position` (`git diff main -- docs-site/docs`).
8. The stated defaults match code: port 993, TLS on, `searchDays` 90, `maxMessages` 100 for IMAP, key minimum 32 characters (compare with `providers/imap.ts`, `ingestion/imap-sync.ts`, `infra/credential-crypto.ts`).
9. `git diff --stat main` shows changes only to the two files under `docs-site/docs/` (plus nothing else).
10. Optional visual check: `npm run docs:dev`, open `http://localhost:3006/docs/next/features/post-application-tracking` and `.../workflows/post-application-workflow`; the IMAP sections render and the mermaid diagram renders.

## Out of scope

- Any code change, including making the size limits configurable or changing defaults.
- `docs-site/versioned_docs/**` and `versioned_sidebars`; versioned snapshots are produced by the release/docs-version workflows.
- New docs pages (for example a dedicated "IMAP setup" getting-started guide) and sidebar changes.
- Screenshots or new images under `docs-site/static/`.
- `AGENTS.md` (already documents the encryption helper and both limits), `.env.example` (already documents `CREDENTIALS_ENCRYPTION_KEY`), `README.md`.
- Other docs-site pages that mention Gmail only (for example `docs-site/docs/getting-started/gmail-oauth-setup.md`, overview or self-hosting pages); note them in the handback as a possible follow-up rather than editing them.

## Assumptions

- Editing `docs-site/docs/` is allowed here despite the factory rule against requiring `docs/` changes: the request names these two pages explicitly and the backlog deferred them from jobs 001 and 003 to this job. The approver may escalate if the docs process (fm-docs) should own this instead.
- Only the current docs (`docs-site/docs/`) change, not versioned copies: the versioned folders are release snapshots generated by CI.
- The MxRoute example uses a placeholder host `<your-server>.mxrouting.net` with port 993 and TLS: MxRoute assigns a per-account server name and serves IMAP over SSL on 993; a real server name would be personal.
- IMAP gets its own "Option C" in the workflow page rather than folding into Option B: the setup and curl shapes differ enough from Gmail OAuth that a combined section would be harder to follow.
- `openssl rand -base64 48` is given as the key generation example: it yields well over 32 characters and is available on the Docker host and macOS.

## Mission fit
Fits: documents post-application email tracking and self-hosting setup for the user's own MxRoute IMAP server, both named in the mission.
