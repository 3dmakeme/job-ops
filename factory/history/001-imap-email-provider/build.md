STATUS: READY

# Build: IMAP post-application email provider (MxRoute)

## Summary
The IMAP provider is now implemented end to end. `connect` validates the settings, checks the login over implicit TLS (or required STARTTLS), and stores the password AES-256-GCM encrypted. `status` returns only the non-secret fields plus `hasPassword`. `sync` reads INBOX read-only and feeds each message through the same smart-router ingestion Gmail uses. `disconnect` nulls the stored credentials. Gmail's per-message routing and persistence now live in a shared, provider-agnostic module that both providers use. The Tracking Inbox shows an IMAP connect form when `imap` is selected.

Two known checks fail, both already failing on the base commit and outside this job's files (see criteria 1 and 5).

Files changed:
- `orchestrator/package.json`, `package-lock.json`: added `imapflow`, `mailparser` and dev dependency `@types/mailparser`.
- `orchestrator/src/server/infra/credential-crypto.ts` (+ `.test.ts`): new. `encryptSecret`/`decryptSecret`, format `v1:<iv>:<tag>:<ciphertext>` (base64url). The key comes from `CREDENTIALS_ENCRYPTION_KEY` or from `DATA_DIR/credentials-key`, created like the `jwt.ts` secret (`wx`, `0600`, handles EEXIST races, module-level cache).
- `orchestrator/src/server/services/post-application/ingestion/message-ingest.ts`: new. `runPostApplicationIngestion` holds the code extracted from Gmail: sync-run start and completion, active jobs, `runWithConcurrency`, existing-message re-upsert, `buildEmailText` + `classifyWithSmartRouter`, the 95/50 thresholds, upsert, `createAutoStageEvent` with the analytics `provider` passed in, the counters, sync-state updates, and a provider-specific failure error code.
- `ingestion/gmail-sync.ts`: rewritten on top of `message-ingest.ts`. It still uses `GMAIL_SYNC_FAILED`, and the `__test__` export is unchanged. `ingestion/gmail-api.ts` now exports `cleanEmailHtmlForLlm` so IMAP converts HTML the same way.
- `ingestion/imap-client.ts` (+ `.test.ts`): new. All IMAP network I/O goes through this file.
  - It wraps `ImapFlow` with `secure: tls`, `doSTARTTLS: true` when `tls` is false, 15 s connection and greeting timeouts, `logger: false`, and no `tls`/`rejectUnauthorized` override.
  - Exposed methods: `connect`, `openInboxReadOnly` (EXAMINE), `searchUidsSince`, `fetchMessageSources` (BODY.PEEK via `source: true`), and `close` (logout, falling back to `close()`).
  - Errors are re-raised as `ImapAuthenticationError` or `ImapConnectionError`, which never carry the server response.
- `ingestion/imap-sync.ts` (+ `.test.ts`): new. `runImapIngestionSync` uses defaults of 90 days and 100 messages.
  - It decrypts the password and throws `ImapAccountNotConnectedError` when the integration is missing or the password can't be decrypted.
  - It opens one connection, fetches the newest `maxMessages` UIDs since now minus `searchDays`, and closes the connection in `finally`.
  - Each message is parsed with mailparser and mapped as the spec says (Message-ID or the `uid:<uidValidity>:<uid>` fallback, References/In-Reply-To threading, text or html-to-text body, 200-character snippet).
  - Messages are ingested with `provider: "imap"` and `IMAP_SYNC_FAILED`.
- `providers/imap.ts`: replaces the stub with the real connect/status/sync/disconnect adapter and an IMAP `toPublicIntegration` that returns `{ host, port, tls, username, hasPassword }`. Errors map as follows: auth failure → 400, unreachable → 502, not connected → 400.
- `providers/imap.test.ts`: new. Uses a real SQLite DB in a temp `DATA_DIR` and mocks `imap-client.ts`. `providers/service.test.ts`: the "not implemented" test is replaced with IMAP 400 and status dispatch tests.
- `orchestrator/src/client/pages/tracking-inbox/ImapConnectForm.tsx`: new. Controlled form with Host/Port/Use TLS/Username/Password, every field labelled, and a `toImapConnectPayload` validator.
- `orchestrator/src/client/pages/TrackingInboxPage.tsx`:
  - With `imap` selected and not connected, the form replaces the Gmail helper text.
  - The existing Connect button submits the form (`type="submit" form=...`).
  - Client-side validation shows a toast and sends no request.
  - On success it calls `postApplicationProviderConnect`, sends the same analytics events, shows the "Provider connected" toast and clears the password.
  - On failure it uses `showErrorToast` and keeps the fields.
  - When IMAP is connected, the status row shows `username @ host`.
  - The "not implemented yet" branch is removed. The Gmail path is unchanged.
- `orchestrator/src/client/pages/TrackingInboxPage.test.tsx`: 7 new IMAP and Gmail cases.
- `orchestrator/src/server/api/routes/post-application-providers.ts` (+ `.test.ts`), added in round 2: in demo mode (`DEMO_MODE=true`) the route rejects IMAP `connect` and `sync` with the project's `sendDemoBlocked` (403 FORBIDDEN) before it reaches the provider. Status and disconnect still work, and Gmail is unchanged.
- `.env.example`: commented `CREDENTIALS_ENCRYPTION_KEY`. `AGENTS.md`: the credential-encryption line under *Webhook and LLM Payload Defaults*.

## Acceptance criteria
1. [ ] `./orchestrator/node_modules/.bin/biome ci .` passes. **Not met, but the failures were already on the base.** It reports `Found 23 errors.` on this branch. I unpacked the base commit (`git merge-base main HEAD` = bf20444) into a scratch dir with `git archive` and ran the same command there: also `Found 23 errors.` Every error is in a file this branch doesn't touch: organizeImports/format issues in `factory/dashboard.html`, `factory/settings.json`, Jev/scorer/settings files and others. `biome ci` on the 16 changed files gives `Checked 16 files ... No fixes applied.` with no errors. I didn't fix the unrelated files: they belong to other work, and AGENTS/builder rules say to lint only changed files.
2. [x] `npm run check:types:shared` passed. `npm --workspace orchestrator run check:types` passed with 0 `error TS`.
3. [x] `npm --workspace gradcracker-extractor run check:types` and `npm --workspace ukvisajobs-extractor run check:types` both passed.
4. [x] `npm --workspace orchestrator run build:client` succeeded (`✓ built in 3.30s`).
5. [ ] `npm --workspace orchestrator run test:run` passes. **Met except for one test that already failed on the base.** Result: round 2 gives `Test Files 1 failed | 320 passed (321)`, `Tests 1 failed | 2387 passed | 2 skipped`. The one failure is `WatchlistPage.test.tsx > shows new rows by default with ignore actions` (`Unable to find an element with the text: May 1, 2026`), a date-dependent test this branch doesn't touch. It fails the same way when run from the base-commit archive. All new and relevant files pass. A targeted run of `credential-crypto.test.ts`, everything under `services/post-application` (`gmail-sync.test.ts`, `gmail-sync.idempotency.test.ts`, `imap-client.test.ts`, `imap-sync.test.ts`, `providers/imap.test.ts`, `providers/service.test.ts`, `job-emails.test.ts`) and `TrackingInboxPage.test.tsx` gave `Test Files 9 passed (9)`, `Tests 77 passed (77)`.
6. [x] `grep -rn "IMAP provider is not implemented yet" orchestrator/src` and `grep -rn "connect is not implemented yet" orchestrator/src/client` both print nothing.
7. [x] `grep -rn "rejectUnauthorized" orchestrator/src/server` prints nothing. The IMAP client never overrides TLS options, and `imap-client.test.ts` asserts the ImapFlow options have no `tls` property.
8. [x] `providers/imap.test.ts` "verifies login and stores only the encrypted password" reads the `post_application_integrations` row through drizzle and asserts that `JSON.stringify(credentials)` does not contain the test password and does contain `passwordEncrypted`. "returns status with hasPassword and no secret fields" asserts the sorted keys equal `host, port, tls, username, hasPassword`.
9. [x] `providers/imap.test.ts` "does not expose an integration to another tenant" connects under the default tenant. Under `runWithRequestContext({ tenantId: "tenant_b" })`, status reports `connected: false` with `integration: null`, and sync is rejected with 400 "IMAP account 'default' is not connected." without creating a client. The owning tenant still sees `connected: true`.
10. [x] `ingestion/imap-sync.test.ts`:
    - "maps messages and upserts them with provider imap" asserts the upsert input has `provider: "imap"`, `externalMessageId`, `externalThreadId`, `fromAddress`, `fromDomain`, `senderName`, `subject`, `receivedAt` and `snippet`, for a text message, an HTML-only message with no Message-ID (UID fallback `uid:777:11`, In-Reply-To threading, 200-character snippet) and an unthreaded message.
    - "routes each new message through the smart router" asserts `classifyWithSmartRouter`'s `emailText` contains the subject and the body, and that HTML link URLs are stripped.
    - Other tests cover: no re-classification of existing messages, one bad message → `errored: 1` with the rest ingested, `close` called on success and on failure (failure also marks the run `failed`/`IMAP_SYNC_FAILED` and the integration `error`), no flag, move or delete methods called, and an undecryptable or missing integration → not connected.
11. [x] Checked in the running app (production server from the worktree on port 5110 serving the built client, fresh `DATA_DIR`, viewed with `agent-browser --session 001-imap-email-provider-builder`). I didn't use `npm run dev` because its Vite proxy is hard-coded to port 3001, which other jobs may be using. To get past the onboarding gate, which needs an AI key and a resume, I used a page init script that stubs only the `GET /api/onboarding/status` response. All post-application calls went to the real server.
    - With Provider `imap`, the page shows the labelled fields Host (placeholder `mail.example.com`), Port (`993`, number), Use TLS (switch, `aria-checked=true`), Username (`autocomplete=username`) and Password (`type=password`, `autocomplete=current-password`). The Gmail helper text is hidden.
    - With host and username filled and the password empty, clicking Connect showed the toast "Host, username and password are required for IMAP." and sent no `/actions/connect` request: the fetch log and the agent-browser network log were both empty.
    - Connecting to `imap.nonexistent.invalid` sent one POST. The server logged 502 `UPSTREAM_ERROR` "Could not reach the IMAP server at imap.nonexistent.invalid:993." and warn reason `ENOTFOUND`, with no password anywhere in the server log (`grep -c` = 0). Host, port and username stayed filled in.
    - With Provider `gmail`, the OAuth helper text is shown, there are no IMAP fields, and Connect calls `GET /api/post-application/providers/gmail/oauth/start?accountKey=default` as before. The local server has no Google credentials, so it shows its existing "Gmail OAuth is not configured" toast.
12. [x] `orchestrator/package.json` lists `"imapflow": "^2.10.0"`, `"mailparser": "^3.14.1"` and dev `"@types/mailparser": "^3.9.0"`. `.env.example` line 62 is `# CREDENTIALS_ENCRYPTION_KEY=`, with an explanation and the reconnect note. `AGENTS.md` line 67 has the credential-encryption line.

## Validation
- `./orchestrator/node_modules/.bin/biome ci .`: fails with 23 errors, the same count as the base commit. None are in changed files.
- `biome ci` on the 16 changed files: passed.
- `npm run check:types:shared`: passed.
- `npm --workspace orchestrator run check:types`: passed.
- `npm --workspace gradcracker-extractor run check:types`: passed.
- `npm --workspace ukvisajobs-extractor run check:types`: passed.
- `npm --workspace orchestrator run build:client`: passed.
- `npm --workspace orchestrator run test:run` (round 2): 2387 passed, 1 failed. The failure (`WatchlistPage.test.tsx`, date-dependent) also fails on the base commit.
- Targeted vitest run (crypto, post-application, TrackingInboxPage): 77/77 passed.
- Round 2: `vitest run src/server/api/routes/post-application-providers.test.ts`: 11/11 passed. `biome ci` on the two route files passed. `check:types` gave 0 errors. `biome ci .` still gives 23 errors, the same as the base.

## Log
### Round 1
- Installed `imapflow`, `mailparser` and `@types/mailparser` with `npm install --workspace orchestrator ...`, so the root `package-lock.json` is updated.
- Added `credential-crypto.ts` with tests.
- Extracted `message-ingest.ts` from `gmail-sync.ts`. The Gmail tests pass unchanged, and the analytics `provider` and failure error code are now parameters.
- Added `imap-client.ts`, `imap-sync.ts` and the real `providers/imap.ts`, with tests.
- Added `ImapConnectForm.tsx`, wired it into `TrackingInboxPage.tsx`, and added page tests.
- Updated `.env.example` and `AGENTS.md`.
- Implementation choices:
  - mailparser runs with `skipHtmlToText` (plus the other skip options). Without it, mailparser fills `text` from the HTML itself and keeps link URLs, so the "else convert html with html-to-text" rule would never run. HTML is converted with Gmail's `cleanEmailHtmlForLlm`.
  - Sources are fetched over one connection, the connection is closed, and then messages are routed. The IMAP socket is never held open during slow LLM calls.
  - The password is validated as a non-empty string and is not trimmed.
  - The form uses `noValidate`, so the spec's toast handles an out-of-range port instead of the browser's native validation bubble.
  - Connect logs a `logger.warn` with reason `authentication`, the error code, or `unknown` when the login check fails. It never logs the password or the server text.
- Declined: none. No files under `docs/` were touched. The spec puts the docs-site pages out of scope.
- Commits: `7e6d1a2`, `f1d0207`, `c33b067`, `dcd75f3`, `9927d98`, `57b0117`, `e5a4e54`.

### Round 2
Reviews: code PASS, UI PASS, UX PASS, security CHANGES.
- Security finding 1: in demo mode an anonymous visitor could use IMAP connect/sync to probe the network or as an SSRF primitive, and could make the operator pay for LLM routing.
  - **Fixed** in `0e9656c`. `POST /api/post-application/providers/:provider/actions/:action` now calls `sendDemoBlocked(res, "Connecting and syncing IMAP mailboxes is disabled in the public demo.", { route })` when `isDemoMode()` and the request is `imap` with `connect` or `sync`. This check runs after the params are parsed and before the body is parsed or `executePostApplicationProviderAction` is called, so no IMAP client is ever created.
  - I limited the block to IMAP connect/sync and didn't block every non-status action: Gmail connect still needs a Google OAuth exchange, and the spec says Gmail behaviour must not change.
  - New tests: `post-application-providers.test.ts` "blocks imap connect/sync in demo mode without reaching the provider" starts the server with `DEMO_MODE=true` and real auth, posts a probe payload (host `10.0.0.1`), and asserts 403 `FORBIDDEN`, a `blockedReason` containing "disabled in the public demo", and that the mocked provider dispatcher was not called.
- Security notes (non-blocking), not changed this round:
  - Private-IP blocking in hosted mode: the spec explicitly decided against it. That's for the approver.
  - A per-message size cap on sync fetches: an optional hardening the spec doesn't ask for.
- PASS reviews' optional notes: no changes.
