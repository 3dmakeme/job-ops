# LinkedIn job-alert emails as a discovery source

> Feature: LinkedIn job-alert emails as a jobs source: via the existing IMAP provider, scan the connected inbox for LinkedIn job alert/notification emails (sender linkedin.com job alerts), parse the job listings in them (title, company, location, job URL) and add them as discovered jobs through the normal job ingestion path (dedupe by job URL, so repeats and existing jobs are not duplicated). Scan only the previous 7 days of mail (a fixed 7-day lookback for this source, independent of the general IMAP searchDays default of 90). Read-only on the mailbox, no LinkedIn scraping or login, no auto-apply, reuse the 1 MiB/32 MiB IMAP limits, tests with sample alert email fixtures, and a setting to turn it on or off (default off). Jobs then flow through normal scoring. Note: IMAP sync now has a per-account UID watermark (job 008) and size caps (job 003); decide in the spec whether this source reuses or bypasses the watermark, and keep the multi-tenant and API-contract rules from AGENTS.md. LinkedIn alert emails usually carry tracking redirect links: the spec should say how the job URL is normalised (keep the clean /jobs/view/<id> form when it can be derived, otherwise store the link as given).

## Context

**IMAP provider (post-application tracking).** `orchestrator/src/server/services/post-application/ingestion/imap-client.ts` wraps `imapflow` behind the `ImapClient` interface (`connect`, `openInboxReadOnly`, `searchUidsSince`, `searchUidsAfter`, `fetchMessageSizes`, `fetchMessageSources`, `close`). It opens INBOX read-only and fetches with `BODY.PEEK[]<0.maxBytes>`, so `\Seen` is never set. It exports `IMAP_MAX_MESSAGE_BYTES` (1 MiB) and `IMAP_MAX_SYNC_BYTES` (32 MiB). `imap-sync.ts` in the same folder:
- `parseStoredImapCredentials()` reads the stored `{ host, port, tls, username, passwordEncrypted }`, and `decryptSecret()` (`@infra/credential-crypto`) decrypts the password.
- The private `selectUidsWithinBudget()` fits UIDs into the 32 MiB budget and charges each at most 1 MiB. `fetchInboxMessages()` logs truncated and skipped messages with `logger.warn`.
- The per-account watermark `credentials.syncWatermark` (`parseImapSyncWatermark`, `resolveNextWatermark`, `persistImapSyncWatermark`) tracks how far the post-application classifier has read.

The integration row comes from `getPostApplicationIntegration("imap", accountKey)` in `orchestrator/src/server/repositories/post-application-integrations.ts`, which scopes by tenant/user through `integrationsScopeFilter()` / `getPrivateDataScope()`. The UI and routes use account key `"default"` (`TrackingInboxPage.tsx`, `post-application-review.ts`). The IMAP account is connected on the Tracking Inbox page, through `orchestrator/src/server/services/post-application/providers/imap.ts`.

**Job discovery and ingestion (the normal path).** `orchestrator/src/server/pipeline/orchestrator.ts` runs `discoverJobsStep` (`pipeline/steps/discover-jobs.ts`), then `importJobsStep` (`pipeline/steps/import-jobs.ts`), then `scoreJobsStep` (`pipeline/steps/score-jobs.ts`).
- `discoverJobsStep` runs the extractor manifests. It then runs the Watchlist as an extra, non-extractor source: `discoverWatchlistJobsForPipeline` in `pipeline/steps/watchlist-jobs.ts`, gated by `includeWatchlist`, counted in `totalSources`, with fanout task id `"watchlist"` and errors pushed into `sourceErrors`. After that it applies the location-intent filter and the blocked-company filter to every discovered `CreateJobInput`.
- The challenge-retry call in `orchestrator.ts` passes `includeWatchlist: false`.
- `importJobsStep` calls `jobsRepo.createJobs()` (`orchestrator/src/server/repositories/jobs.ts`). It skips any input whose `jobUrl` already exists in the tenant's jobs and collapses duplicate URLs within the batch.
- `scoreJobsStep` scores every unscored `discovered` job (`getUnscoredDiscoveredJobs`).
- `CreateJobInput` / `JobSource` live in `shared/src/types/jobs.ts`. The source id `"linkedin"` already exists in `shared/src/extractors/index.ts`, and JobSpy stores LinkedIn jobs as `https://www.linkedin.com/jobs/view/<id>`.

**Settings.** Settings are declared in `shared/src/settings-registry.ts`. Boolean settings follow the `ghostwriterStopSlopEnabled` / `backupEnabled` pattern: `z.boolean()`, `parseBitBoolOrNull`, `serializeBitBool`, default `false`. They are typed in `shared/src/types/settings.ts`, have test factories in `shared/src/testing/factories.ts`, and are stored per tenant by `orchestrator/src/server/repositories/settings.ts` (`settingsScopeFilter`). The Settings page (`orchestrator/src/client/pages/SettingsPage.tsx`) lists sections in `SETTINGS_NAV_GROUPS`. The checkbox pattern to copy is the `ghostwriterStopSlopEnabled` checkbox in `orchestrator/src/client/pages/settings/components/ChatSettingsSection.tsx`, inside a `SettingsSectionFrame`.

**Parsing tools available.** `mailparser`'s `simpleParser` is used with `PARSER_OPTIONS` in `imap-sync.ts`. `jsdom` is already an orchestrator dependency. Tests use vitest. `imap-sync.test.ts` shows how to mock `createImapClient` and `decryptSecret`.

## Requirements

1. **Setting.** Add a boolean setting `linkedinAlertsEnabled` (default `false`) to `shared/src/settings-registry.ts`. Follow the `backupEnabled` pattern, with matching entries in `shared/src/types/settings.ts`, `shared/src/testing/factories.ts` and anywhere else the typecheck needs it. It is stored per tenant like every other setting.
2. **Settings UI.** Add a "LinkedIn Alerts" section to the **Integrations** group in `SETTINGS_NAV_GROUPS`. It holds one checkbox, "Import jobs from LinkedIn alert emails", built like the `ghostwriterStopSlopEnabled` checkbox and saved through the existing Settings form. Helper text says it reads LinkedIn job-alert emails from the last 7 days in the IMAP account connected on the Tracking Inbox page, during pipeline runs, without changing the mailbox.
3. **IMAP search.** Add one method to `ImapClient` in `imap-client.ts`: `searchUidsSinceFrom(since: Date, from: string): Promise<number[]>`. It wraps `client.search({ since, from }, { uid: true })` and maps errors through `toImapError` like the other search methods. No other change to the client.
4. **Budget reuse.** Export the existing byte-budget selection from `imap-sync.ts`, or move it into a shared helper both callers import, so this source applies the same 1 MiB per-message and 32 MiB per-run limits with the same truncation and skip warnings. Do not duplicate the constants or the algorithm.
5. **Inbox scan.** Add a scanner in a new folder `orchestrator/src/server/services/linkedin-alerts/`. It:
   - loads the `"imap"` integration for account key `"default"` through `getPostApplicationIntegration`, so it is tenant/user-scoped, and decrypts the password with `parseStoredImapCredentials` and `decryptSecret`;
   - connects with `createImapClient`, calls `openInboxReadOnly()`, then `searchUidsSinceFrom(now - 7 days, "linkedin.com")`. The 7 days is a fixed constant `LINKEDIN_ALERT_LOOKBACK_DAYS = 7`, independent of `DEFAULT_SEARCH_DAYS`;
   - takes the newest 100 UIDs, applies the shared byte-budget selection, fetches sources with `fetchMessageSources(selected, IMAP_MAX_MESSAGE_BYTES)` and always closes the client;
   - parses each message with `simpleParser` and keeps it only if the From address (case-insensitive) is in a constant allowlist `LINKEDIN_ALERT_SENDERS = ["jobalerts-noreply@linkedin.com", "jobs-listings@linkedin.com"]`;
   - **bypasses the watermark.** It never reads or writes `credentials.syncWatermark` and never writes the integration row (no `replacePostApplicationIntegrationCredentialsIfUnchanged`, no `updatePostApplicationIntegrationSyncState`). Repeat scans of the same 7 days are made harmless by URL dedupe in `createJobs`;
   - does not call the post-application ingestion (`runPostApplicationIngestion`), so no post-application messages are stored or classified by this source.
6. **Alert parser.** Add a pure function, for example `parseLinkedInAlertEmail(parsed: ParsedMail): LinkedInAlertJob[]`, that returns `{ title, company, location?, jobUrl, sourceJobId? }` per listing:
   - If the email has a `text/plain` part, parse that. A listing is a block of non-empty lines (title, company, optional location) followed by a line containing a LinkedIn job link (for example `View job: <url>`).
   - Otherwise parse the HTML with `jsdom`. Each distinct job link (by derived job id, or by href when no id can be derived) is one listing. The title comes from the link text, and company and location from the text of the listing's enclosing card.
   - Whitespace is collapsed and values are trimmed. A listing without a title, company or job URL is dropped, as is any URL that is not `http:` or `https:`. Listings are de-duplicated by `jobUrl` within one email.
7. **URL normalisation.** For each job link:
   - first, if the URL (or, for a redirect wrapper, any query-parameter value after URL-decoding) has a host of `linkedin.com` or a subdomain of it and a path matching `/jobs/view/<digits>`, `/comm/jobs/view/<digits>` or `/jobs/view/<slug>-<digits>`, with or without a trailing slash and query string, store `jobUrl = "https://www.linkedin.com/jobs/view/<digits>"` and `sourceJobId = "<digits>"`;
   - otherwise store the link exactly as given (trimmed), with no `sourceJobId`.

   The clean form matches the JobSpy LinkedIn form, so dedupe works across both sources.
8. **Pipeline integration.**
   - In `discover-jobs.ts`, add `includeLinkedInAlerts?: boolean` (default true), modelled on the Watchlist block. When it is true and the tenant's `linkedinAlertsEnabled` setting is true, run the scan once as an extra source: count it in `totalSources`, use fanout task id `"linkedin-alerts"` and progress detail `"LinkedIn alerts: reading inbox..."`.
   - Turn each listing into a `CreateJobInput` with `source: "linkedin"`, `title`, `employer` (the company), `location`, `jobUrl` and `sourceJobId`, and add it to `discoveredJobs`. The existing location and blocked-company filters then apply, followed by `importJobsStep` / `createJobs` and then `scoreJobsStep`. Nothing else is set on the job.
   - The challenge-retry `discoverJobsStep` call in `orchestrator.ts` passes `includeLinkedInAlerts: false`.
   - When the setting is off, the source is not counted, no IMAP connection is made, and `discoverJobsStep` behaves exactly as today.
9. **Failure handling.** The source never aborts a run.
   - If the IMAP account is missing or its password can't be decrypted, push `"LinkedIn alerts: no IMAP account connected"` to `sourceErrors`.
   - If connecting, searching or fetching fails, push `"LinkedIn alerts: <error.message>"` (the `ImapAuthenticationError` / `ImapConnectionError` messages already exclude server responses) and log through `logger.warn` with `sanitizeUnknown(error)`.
   - If one message fails to parse, skip it, log a warning with the UID only, and carry on.
10. **Logging and privacy.** Use `@infra/logger` only. Log one structured info line per scan: `step: "discover-linkedin-alerts"`, candidate, selected, skipped, matched-sender and listing counts. Never log email bodies, subjects, sender addresses or credentials. No new API routes. The existing settings route keeps the `{ ok, data | error, meta.requestId }` contract unchanged.
11. **Tests with fixtures.** Add synthetic `.eml` fixtures (no real personal data) under `orchestrator/src/server/services/linkedin-alerts/__fixtures__/`:
    - (a) a multipart alert from `jobalerts-noreply@linkedin.com` with text and HTML parts and at least 3 listings using `/comm/jobs/view/<id>/?trackingId=...` links, one listing repeated;
    - (b) an HTML-only alert with at least 2 listings;
    - (c) a LinkedIn email from a non-allowlisted sender (for example `messages-noreply@linkedin.com`) that contains a `/jobs/view/` link;
    - (d) an alert whose job link has no derivable id.

    Vitest tests in that folder cover the parser, the URL normaliser and the scanner, using mocked `createImapClient` / `decryptSecret` / repository calls in the style of `imap-sync.test.ts`. `discover-jobs.test.ts` gets cases for the setting being on, the setting being off, and a failure.
12. **Multi-tenant regression.** One test proves the scan uses the active tenant's data only: tenant B has the setting on and no IMAP account, tenant A has an account. Tenant B gets the "no IMAP account connected" source error and `createImapClient` is never called.
13. **AGENTS.md.** Add one bullet after the IMAP watermark bullet. It names the `linkedinAlertsEnabled` setting (default off), the code location `orchestrator/src/server/services/linkedin-alerts/`, the fixed 7-day lookback, the sender allowlist, read-only access, the reused 1 MiB/32 MiB limits, the deliberate bypass of `syncWatermark`, the `"default"` account key, the URL normalisation rule, and `source: "linkedin"`.

## Acceptance criteria

1. With the default settings, a pipeline run makes no IMAP connection for this source. Verify with the `discover-jobs.test.ts` case: setting unset leads to `createImapClient` not being called and `totalSources` staying unchanged.
2. Turning the checkbox on in **Settings → Integrations → LinkedIn Alerts** and saving persists `linkedinAlertsEnabled: true`; reloading the page shows it still checked. Verify in the browser at `/settings`, or with a `SettingsPage` test.
3. Parsing fixture (a) gives one listing per distinct job, each with the right title, company and location, `jobUrl` equal to `https://www.linkedin.com/jobs/view/<id>` and `sourceJobId` equal to `<id>`, with the repeated listing collapsed. Verify with `npm --workspace orchestrator run test:run -- linkedin-alerts`.
4. Fixture (b) gives the expected listings from HTML alone. Fixture (c) gives zero listings because the sender is not allowlisted. Fixture (d) gives a listing whose `jobUrl` equals the original href and has no `sourceJobId`. All are checked in the same test run.
5. Normaliser unit tests cover `https://www.linkedin.com/comm/jobs/view/123/?trackingId=x`, `https://uk.linkedin.com/jobs/view/senior-data-lead-at-acme-123`, a redirect wrapper with a URL-encoded `/jobs/view/123` query value (all becoming `https://www.linkedin.com/jobs/view/123`), a non-LinkedIn URL (kept as given) and a `javascript:` URL (rejected).
6. The scanner test shows:
   - the search uses `since` about 7 days before now and `from: "linkedin.com"`;
   - `openInboxReadOnly` is used;
   - `fetchMessageSources` gets `IMAP_MAX_MESSAGE_BYTES`;
   - messages beyond `IMAP_MAX_SYNC_BYTES` are skipped with a warning;
   - the client is closed on success and on error;
   - no integration write function is called and the stored `syncWatermark` is untouched.
7. A `discover-jobs.test.ts` case with the setting on returns the parsed listings as `CreateJobInput` with `source: "linkedin"`, and they pass through the existing location and blocked-company filters.
8. Feeding the same listing twice, or a listing whose URL already exists, into `importJobsStep` creates it at most once (existing `createJobs` URL dedupe). Verify with a test, or by reading that the listings go only through `importJobsStep`.
9. A connection failure and a not-connected account each add one `LinkedIn alerts: ...` entry to `sourceErrors` without throwing. Verified in `discover-jobs.test.ts` or the scanner tests.
10. The cross-tenant test from Requirement 12 passes.
11. `AGENTS.md` contains the new LinkedIn alerts bullet described in Requirement 13.
12. All CI-parity checks from AGENTS.md pass, run from the repo root: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

## Out of scope

- Fetching LinkedIn job pages, logging in to LinkedIn, or calling any LinkedIn API. The job description stays empty unless the alert email itself carries it (this build does not try).
- Any write to the mailbox: flags, moves, deletes, `\Seen`.
- Changing the post-application IMAP sync, its watermark, its 90-day / 100-message defaults or its email routing. That sync may still see these alert emails, as it does today.
- Scanning Gmail, other IMAP account keys, or folders other than INBOX.
- A new extractor workspace under `extractors/` or a new `ExtractorSourceId`. The source reuses `"linkedin"`.
- New API routes, a manual "scan now" button, scheduling or making the lookback configurable.
- Auto-applying or auto-tailoring beyond what the pipeline already does for discovered jobs.
- Follow-up (not for this job): the product docs in `docs-site/docs/features/settings.md`, `docs-site/docs/features/pipeline-run.md`, `docs-site/docs/features/post-application-tracking.md` and `docs-site/docs/extractors/overview.md` should mention the new source.

## Assumptions

- **Runs in the pipeline's discovery step, not in the post-application sync.** That is the "normal job ingestion path" (`importJobsStep` → `createJobs`), and scoring picks the jobs up in the same run.
- **Bypasses the watermark.** The watermark records post-application classifier progress. Reusing it would hide alerts the classifier has already read, and writing it would disturb that sync. A fixed 7-day rescan plus URL dedupe is simpler and safe.
- **Account key `"default"` only.** That is the key the UI and routes use, and there is no "list accounts" repository function.
- **Sender allowlist `jobalerts-noreply@linkedin.com` and `jobs-listings@linkedin.com`.** This matches "sender linkedin.com job alerts" and excludes LinkedIn application confirmations and messages, which also contain `/jobs/view/` links. Whether to add more LinkedIn senders is a product call.
- **`source: "linkedin"`.** It reuses the existing label, so these jobs look like LinkedIn jobs and dedupe with JobSpy's LinkedIn URLs, without adding a source to the pipeline source picker.
- **Location and blocked-company filters apply to these jobs.** That is the normal path for discovered jobs, though it means some alert jobs outside the user's location intent are dropped.
- **IMAP `SINCE` has day granularity.** The scan may include up to one extra calendar day, which is harmless because of dedupe.
- **Cap of 100 newest messages per scan.** This mirrors `DEFAULT_MAX_MESSAGES`, and 7 days of alerts fits well inside it.
- **"Notification" emails are covered only through the allowlisted senders.** Other LinkedIn notifications are ignored.

## Mission fit
Fits: discovering jobs across job boards (LinkedIn) through the user's own mail server, which the mission already lists as an external service, with read-only access and no auto-apply.
