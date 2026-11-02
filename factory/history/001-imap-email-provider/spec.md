# IMAP post-application email provider (MxRoute)

> Feature: Implement the IMAP post-application email provider (currently a stub in orchestrator/src/server/services/post-application/providers/imap.ts that always throws "IMAP provider is not implemented yet"). Target mail host is MxRoute: plain IMAP over TLS (port 993) with username and password login, no OAuth. Needs: connect (store host, port, TLS, username, password; verify login), status, sync (fetch recent messages and feed them through the same ingestion and email-router path Gmail uses, including the Jev/LLM email routing), disconnect; a client connect form next to Gmail in the tracking inbox; the password must be protected at rest (check how Gmail tokens are stored and encrypt if they are not already); multi-tenant scoping per AGENTS.md; tests for provider, sync mapping and the form.

## Context

**Provider framework (server).** All paths under `orchestrator/src/server/services/post-application/`.
- `providers/types.ts` defines `PostApplicationProviderAdapter` (`connect`, `status`, `sync`, `disconnect`, each returning `{ status: PostApplicationProviderStatus, message? }`).
- `providers/registry.ts` maps `gmail` and `imap` to adapters. `providers/service.ts` (`executePostApplicationProviderAction`) dispatches and converts errors with `toProviderAppError` (`providers/errors.ts`): `providerInvalidRequest` becomes 400 INVALID_REQUEST, `providerUpstreamError` becomes 502 UPSTREAM_ERROR, and everything else becomes 503.
- `providers/imap.ts` is the stub. Each method throws `providerNotImplemented`.
- `providers/service.test.ts:212` currently asserts that IMAP maps to "not implemented".
- `providers/gmail.ts` is the reference adapter:
  - It parses `args.payload?.payload`.
  - It persists through `upsertConnectedPostApplicationIntegration`.
  - It builds status through `toPublicIntegration`, which strips secrets and returns only `has*` flags plus non-secret metadata.
  - It disconnects through `disconnectPostApplicationIntegration`, which nulls `credentials`.

**Routes.** `orchestrator/src/server/api/routes/post-application-providers.ts` exposes `POST /api/post-application/providers/:provider/actions/:action`, and `:provider` already accepts `imap`.
- Connect body: `{ accountKey?, payload?: Record<string, unknown> }`.
- Sync body: `{ accountKey?, maxMessages? (1-500), searchDays? (1-365) }`.
- No route changes are needed for IMAP.

**Storage and tenancy.**
- `orchestrator/src/server/repositories/post-application-integrations.ts` stores `credentials` as a JSON column on `post_application_integrations`. Every query is scoped by `privateDataScopeFilter` (`orchestrator/src/server/tenancy/private-scope.ts`: `tenantId`, plus `userId` in hosted mode).
- The messages and sync-runs repositories (`post-application-messages.ts`, `post-application-sync-runs.ts`) are scoped the same way.
- The DB `provider` CHECK constraint already allows `'imap'` (`orchestrator/src/server/db/migrate.ts:701,718,742`). Messages have a unique index on (tenant, user, provider, account, `external_message_id`) (`orchestrator/src/server/db/schema.ts:1017`).
- Cross-tenant tests use `runWithRequestContext` from `orchestrator/src/server/infra/request-context.ts` (example: `orchestrator/src/server/tenancy/private-scope.test.ts`).

**Gmail tokens are stored in plaintext.** The refresh and access tokens sit unencrypted inside the `credentials` JSON. The repo has no encryption helper (no `createCipheriv` anywhere in `orchestrator/src/server`).

**Persisted-secret pattern.** `orchestrator/src/server/auth/jwt.ts` uses `JWT_SECRET` from env when set. Otherwise it generates a random secret once and writes it to `join(getDataDir(), "jwt-secret")` with `flag: "wx", mode: 0o600`, handling EEXIST races, and caches it at module level. The secret is install-global, not tenant data.

**Ingestion path.** `ingestion/gmail-sync.ts` (`runGmailIngestionSync`) runs these steps:
1. Load the integration and start a sync run (`startPostApplicationSyncRun`).
2. List message ids.
3. Load active jobs (`getAllJobs(["applied","in_progress","processing"])` and `minifyActiveJobs`).
4. For each message, with `POST_APPLICATION_ROUTER_CONCURRENCY` concurrency:
   - Parse From/Subject/Date (`parseFromHeader`, `parseReceivedAt`).
   - If the message already exists (`getPostApplicationMessageByExternalId`), re-upsert it with the stored classification.
   - Otherwise, build `emailText` with `buildEmailText` (`ingestion/gmail-api.ts`) and call `classifyWithSmartRouter` (`ingestion/email-router.ts`). That call goes to Jev when `shouldUseJev("emailRoutingEngine")` is on and falls back to the LLM.
   - Apply the 95/50 confidence thresholds (`resolveProcessingStatus`), call `upsertPostApplicationMessage`, and run `createAutoStageEvent` on auto-link.
5. Complete the run and update the integration sync state.

Within that flow, `createAutoStageEvent` hard-codes `provider: "gmail"` in the `tracking_email_matched` analytics event, and the error code `GMAIL_SYNC_FAILED` is Gmail-specific. Tests: `ingestion/gmail-sync.test.ts` and `ingestion/gmail-sync.idempotency.test.ts`.

**Client.**
- `orchestrator/src/client/pages/TrackingInboxPage.tsx` has a Provider select listing `gmail` and `imap`, an Account Key input, and Connect/Sync/Disconnect buttons.
- `runProviderAction("connect")` currently shows the toast "`${provider} connect is not implemented yet. Use Gmail for now.`" for any provider other than Gmail.
- The helper text at about line 698 describes Gmail OAuth only.
- `orchestrator/src/client/api/post-application.ts` already exports `postApplicationProviderConnect({ provider, accountKey, payload })`.
- Page sub-components live in `orchestrator/src/client/pages/tracking-inbox/` (for example `EmailViewerList.tsx`). UI primitives come from `@/components/ui/*` (`input`, `label`, `switch`, `button`).
- The page test is `orchestrator/src/client/pages/TrackingInboxPage.test.tsx`, which mocks `../api`.

**Dependencies.** No IMAP or MIME library is installed. `html-to-text` is already a dependency of `orchestrator`.

## Requirements

1. **IMAP client library.** Add `imapflow` and `mailparser`, plus `@types/mailparser` as a dev dependency, to the `orchestrator` workspace. Update the root `package-lock.json` with `npm install --workspace orchestrator ...`. Put all IMAP network I/O behind one small module, `orchestrator/src/server/services/post-application/ingestion/imap-client.ts`. Tests mock that module and never open a real socket.

2. **Credential encryption helper.** Add `orchestrator/src/server/infra/credential-crypto.ts`.
   - It exports `encryptSecret(plain: string): Promise<string>` and `decryptSecret(cipher: string): Promise<string>`.
   - It uses AES-256-GCM with a random 12-byte IV per call. The output is a self-describing string: a `v1:` prefix, then base64url IV, auth tag and ciphertext.
   - The key comes from env `CREDENTIALS_ENCRYPTION_KEY` (at least 32 characters, hashed with SHA-256 into 32 bytes) when set. Otherwise it is generated once and persisted at `join(getDataDir(), "credentials-key")`, following the `jwt.ts` pattern (`flag: "wx"`, `mode: 0o600`, EEXIST race handling, module-level cache).
   - `decryptSecret` throws a plain `Error` when the auth tag fails or the format is wrong. It must never include the ciphertext or the plaintext in the error.
   - Add `CREDENTIALS_ENCRYPTION_KEY` to `.env.example`, commented out, with a one-line explanation and a note that losing the key means IMAP accounts must be reconnected.

3. **IMAP connect.** `imapProvider.connect` must:
   - Validate `args.payload?.payload` and reject invalid input with `providerInvalidRequest` (HTTP 400). The fields are:
     - `host`: a non-empty hostname with no scheme, path or whitespace, at most 253 characters.
     - `port`: an integer from 1 to 65535, default 993.
     - `tls`: a boolean, default `true`.
     - `username`: non-empty.
     - `password`: non-empty.
   - Verify the login by opening an IMAP connection through `imap-client.ts` and logging out.
     - `tls: true` means implicit TLS (the 993 case).
     - `tls: false` means connect plain and require STARTTLS, so the password is never sent unencrypted. If the server has no STARTTLS, the connect fails.
     - Certificate validation stays on. `rejectUnauthorized: false` must not be used.
     - The connection and greeting timeout is 15 seconds.
   - Map failures to errors whose messages contain no password and no raw server response:
     - An authentication failure becomes `providerInvalidRequest("IMAP login failed. Check the username and password.")` (400).
     - DNS, TCP, TLS or timeout failures become `providerUpstreamError("Could not reach the IMAP server ...")` (502).
   - On success, call `upsertConnectedPostApplicationIntegration` with `provider: "imap"` and `displayName` set to `username`. The credentials are `{ host, port, tls, username, passwordEncrypted: await encryptSecret(password) }`. The plaintext password is never stored, logged or returned.
   - Log with `logger.info`, using the same fields Gmail logs.

4. **IMAP status.** `imapProvider.status` reads the stored integration and makes no network call. It returns `connected: true` only when the integration status is `connected` and `passwordEncrypted` is present. Through an IMAP `toPublicIntegration`, the public `integration.credentials` is exactly `{ host, port, tls, username, hasPassword }`. Neither `password` nor `passwordEncrypted` is ever returned. When nothing is stored, the message is `"IMAP provider is not connected."`.

5. **Shared ingestion core.** Extract the per-message routing and persistence logic from `gmail-sync.ts` into a provider-agnostic module, `orchestrator/src/server/services/post-application/ingestion/message-ingest.ts`.
   - The module takes `provider` as a parameter and a normalized message: `externalMessageId`, `externalThreadId`, `from`, `subject`, `date`, `snippet`, plus a lazy `loadBody()`.
   - It covers:
     - the existing-message re-upsert
     - `buildEmailText` and `classifyWithSmartRouter`
     - the 95/50 thresholds
     - `upsertPostApplicationMessage`
     - `createAutoStageEvent`, including the analytics `provider`
     - the counters
     - `runWithConcurrency`
     - run completion and sync-state updates
   - `runGmailIngestionSync` must use this module, and its existing tests must pass unchanged in behaviour.
   - The failure error code becomes provider-specific: `GMAIL_SYNC_FAILED` for Gmail, `IMAP_SYNC_FAILED` for IMAP.

6. **IMAP sync.** Add `runImapIngestionSync({ accountKey, maxMessages?, searchDays? })` in `ingestion/imap-sync.ts`, with the same defaults as Gmail: 90 days and 100 messages.
   - It loads the `imap` integration and decrypts the password. If the integration is missing or the password cannot be decrypted, it throws "IMAP account '<key>' is not connected." The provider maps that to `providerInvalidRequest`.
   - It opens one connection and selects `INBOX` read-only (EXAMINE). It searches `SINCE` now minus `searchDays`, takes the `maxMessages` highest UIDs, and fetches them with peek semantics. It must never set `\Seen` or any other flag, and never move or delete mail.
   - Each fetched message is parsed with `mailparser` and mapped like this:
     - `externalMessageId` is the `Message-ID` header with the angle brackets stripped. If that is missing, use `uid:<uidValidity>:<uid>`.
     - `externalThreadId` is the first `References` id, otherwise `In-Reply-To`, otherwise `null`.
     - `from`, `subject` and `date` keep the same raw header semantics as the Gmail path, so `parseFromHeader` and `parseReceivedAt` behave identically.
     - The body is the `text` part, or the `html` part converted with `html-to-text`.
     - `snippet` is the body with whitespace collapsed, truncated to 200 characters.
   - The messages are fed through `message-ingest.ts` with `provider: "imap"`, so Jev and LLM email routing apply unchanged.
   - The connection is always logged out or closed in `finally`.
   - A per-message parse failure increments `errored` and is logged with `logger.warn` (provider, accountKey, syncRunId, externalMessageId, and the error message only). It does not abort the run.
   - A connection or login failure marks the run `failed` and the integration `error`, then rethrows. The provider maps an auth failure to 400 and other connection failures to 502, as in requirement 3.

7. **IMAP sync and disconnect adapters.**
   - `imapProvider.sync` calls `runImapIngestionSync` and returns the status with the same "Sync complete: discovered=..., relevant=..., classified=..., errored=..." message as Gmail.
   - `imapProvider.disconnect` calls `disconnectPostApplicationIntegration("imap", accountKey)`, which nulls the credentials so the encrypted password is removed. It needs no network call and returns "IMAP integration disconnected.".

8. **Multi-tenancy.** All IMAP reads and writes go through the existing scoped repositories. No module-level state may hold tenant credentials, connections or message data. The only module-level cache allowed is the install-global encryption key. IMAP connections are opened per call and closed before the call returns.

9. **Client connect form.** Add `orchestrator/src/client/pages/tracking-inbox/ImapConnectForm.tsx` and render it in `TrackingInboxPage.tsx` in the Provider Controls card, in place of the Gmail OAuth helper text, when `provider === "imap"` and the account is not connected.
   - Fields:
     - Host (`id="imapHost"`, placeholder for example `mail.example.com`)
     - Port (`id="imapPort"`, numeric, default `993`)
     - Use TLS (`Switch`, `id="imapTls"`, default on)
     - Username (`id="imapUsername"`, `autoComplete="username"`)
     - Password (`id="imapPassword"`, `type="password"`, `autoComplete="current-password"`)
   - Every field has a `Label`.
   - The existing Connect button submits the form for IMAP. It calls `api.postApplicationProviderConnect({ provider: "imap", accountKey, payload: { host, port, tls, username, password } })` and tracks the same `tracking_inbox_connect_started` and `tracking_inbox_connect_completed` events.
   - On success, show the "Provider connected" toast, clear the password field, and refresh.
   - On failure, use `showErrorToast` and keep the entered host, port and username.
   - Client-side, block submit with a toast if host, username or password is empty or the port is not 1-65535.
   - The "not implemented yet. Use Gmail for now." branch is removed.
   - When IMAP is connected, the status row shows the stored `username` and `host` from `status.integration.credentials`.
   - Gmail behaviour is unchanged.

10. **Tests** (vitest; server tests mock `imap-client.ts`, and no real network is used):
    - `orchestrator/src/server/infra/credential-crypto.test.ts`:
      - a round trip works
      - two encryptions of the same input differ
      - a tampered ciphertext fails
      - the key file is created with mode 0600 under a temp `DATA_DIR`
      - `CREDENTIALS_ENCRYPTION_KEY` takes precedence
    - `orchestrator/src/server/services/post-application/providers/imap.test.ts`:
      - connect validation produces 400s
      - connect stores `passwordEncrypted`, and the stored JSON does not contain the plaintext password
      - an auth failure maps to 400 and an unreachable host maps to 502, and neither message contains the password
      - status returns `hasPassword` and no secret fields
      - disconnect nulls the credentials
      - cross-tenant: an integration connected under tenant A is not visible to status or sync under tenant B (`runWithRequestContext`)
    - `orchestrator/src/server/services/post-application/ingestion/imap-sync.test.ts`:
      - the mapping covers Message-ID and the UID fallback, References and In-Reply-To threading, the text and HTML body, the snippet length, and From/Date parsing
      - messages reach `classifyWithSmartRouter` and are upserted with `provider: "imap"`
      - an existing message is not re-classified
      - one bad message increments `errored` and the rest still ingest
      - the client is closed after both success and failure
      - no flag-setting method on the mocked client is called
    - Update `providers/service.test.ts` to replace the "IMAP not implemented" test.
    - `orchestrator/src/client/pages/tracking-inbox/ImapConnectForm.test.tsx`, or new cases in `TrackingInboxPage.test.tsx`:
      - selecting `imap` shows the five fields
      - submit calls `postApplicationProviderConnect` with the typed payload and `provider: "imap"`
      - an empty password blocks submit and makes no API call
      - the password is cleared after success
      - Gmail still uses the OAuth flow
11. **AGENTS.md.** Under *Webhook and LLM Payload Defaults*, add one line stating that IMAP credentials are stored AES-256-GCM encrypted through `infra/credential-crypto.ts` (key from `CREDENTIALS_ENCRYPTION_KEY` or `DATA_DIR/credentials-key`). New stored integration secrets must use that helper.

## Acceptance criteria

1. Starting from the repository root, `./orchestrator/node_modules/.bin/biome ci .` passes.
2. `npm run check:types:shared` and `npm --workspace orchestrator run check:types` pass.
3. `npm --workspace gradcracker-extractor run check:types` and `npm --workspace ukvisajobs-extractor run check:types` pass.
4. `npm --workspace orchestrator run build:client` passes.
5. `npm --workspace orchestrator run test:run` passes, including the new files `credential-crypto.test.ts`, `providers/imap.test.ts`, `ingestion/imap-sync.test.ts`, and the IMAP form tests. The existing `gmail-sync.test.ts` and `gmail-sync.idempotency.test.ts` also pass.
6. `grep -rn "IMAP provider is not implemented yet" orchestrator/src` returns nothing, and `grep -rn "connect is not implemented yet" orchestrator/src/client` returns nothing.
7. `grep -rn "rejectUnauthorized" orchestrator/src/server` shows no `false` value in the IMAP code.
8. In `providers/imap.test.ts`, the connect test reads the stored integration row and asserts that `JSON.stringify(credentials)` does not contain the test password but does contain `passwordEncrypted`. The status test asserts that the returned `integration.credentials` keys are exactly `host, port, tls, username, hasPassword`.
9. In `providers/imap.test.ts`, the cross-tenant test asserts that status under a second tenant reports `connected: false`.
10. In `ingestion/imap-sync.test.ts`, the test asserts that `upsertPostApplicationMessage` (or the DB row) receives `provider: "imap"` and the mapped `externalMessageId`, `fromAddress`, `subject`, `receivedAt` and `snippet`, and that `classifyWithSmartRouter` was called with an `emailText` containing the subject and body.
11. In the running app (`npm --workspace orchestrator run dev`), the Tracking Inbox page with Provider set to `imap` shows labelled Host, Port (993), Use TLS (on), Username and Password (masked) fields. Clicking Connect with an empty password shows an error toast and sends no request. With Provider `gmail`, the OAuth helper text and popup flow are unchanged.
12. `orchestrator/package.json` lists `imapflow` and `mailparser`. `.env.example` contains a commented `CREDENTIALS_ENCRYPTION_KEY` line. `AGENTS.md` contains the credential-encryption line from requirement 11.

## Out of scope

- Encrypting the existing Gmail refresh and access tokens, or migrating existing rows. They stay plaintext for now. This is a follow-up job that can reuse `credential-crypto.ts`.
- OAuth or XOAUTH2 for IMAP, SMTP sending, IDLE or push, background or scheduled IMAP polling, and folders other than `INBOX`.
- Marking messages read, moving, flagging or deleting mail.
- Changing the routes, the shared `PostApplicationProvider` types, the DB schema or migrations. No migration is needed because `credentials` is already JSON and `imap` is already allowed.
- Changing the Jev or LLM email-router logic, thresholds or prompts.
- MxRoute-specific presets or host auto-discovery.
- Product docs. `docs-site/docs/features/post-application-tracking.md` and `docs-site/docs/workflows/post-application-workflow.md` will under-describe IMAP after this change. Updating them is a follow-up for the docs process, not this job.

## Assumptions

- **Only the IMAP password is encrypted, not the Gmail tokens.** The request asks for the password to be protected. Encrypting Gmail would need a data migration on live rows, which is a separate risk.
- **The key is install-global, from env or a `DATA_DIR` file.** This mirrors the existing `jwt.ts` pattern. A per-tenant key adds no protection when every tenant shares one database and process.
- **`tls: false` means STARTTLS is required, not plaintext.** The request lists TLS as a setting, but sending a password unencrypted conflicts with "no leaked secrets".
- **Only INBOX is synced, read-only, with Gmail's defaults (90 days, 100 messages).** This is the closest equivalent to Gmail's query-based listing. MxRoute delivers to INBOX.
- **Message-ID is the dedupe key, with a UID fallback.** Message-ID is stable across UIDVALIDITY resets, so re-syncs stay idempotent through the existing unique index.
- **An auth failure is a 400 and an unreachable server is a 502.** Wrong credentials are user input. Network failures are upstream failures. This matches the existing error kinds.
- **No private-IP or SSRF blocking on the host.** The host is user-supplied in a self-hosted install, and a self-hoster may legitimately use a LAN mail server. Validation only enforces hostname shape and port range. The approver may want to escalate this for hosted mode.
- **`imapflow` and `mailparser` are the libraries.** They are maintained, MIT-licensed and typed, and they are libraries rather than a new third-party data processor.

## Mission fit
Fits: post-application email tracking from "the user's own mail server (MxRoute IMAP, Gmail)" is listed under In scope and Constraints, and routing goes through the existing Jev/LLM email router.
