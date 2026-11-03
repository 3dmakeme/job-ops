VERDICT: PASS

## Findings
None.

## Notes
1. **The sender check trusts the From header, so a forged alert can add jobs.** `orchestrator/src/server/services/linkedin-alerts/alert-parser.ts:33` (`isLinkedInAlertSender`) checks only the From header. Anyone can send the user an email with `From: jobalerts-noreply@linkedin.com`. If the user's mail server delivers it to INBOX, its listings become discovered jobs for that tenant. Their title and company are chosen by the attacker. The job URL can be any http(s) link (non-LinkedIn links are "kept as given" per spec Requirement 7), which could point the user at a phishing page. The impact is limited:
   - it only affects the mailbox owner's own job list;
   - no job URL is fetched on the server in the discovery, import or scoring paths, so there is no SSRF (I checked);
   - `javascript:` and `data:` links are rejected;
   - titles and company names are rendered as React text.

   This is how the spec defines the feature, so it does not block. A possible hardening step for later: only accept mail whose `Authentication-Results` header shows DKIM/DMARC pass for linkedin.com, or only normalise to the clean LinkedIn form and drop non-LinkedIn links from alert emails.
2. **A crafted HTML-only email can be slow to parse.** `alert-parser.ts:95-117`: for each job key, the code walks up the anchor's ancestors and runs `jobAnchors.some(...contains...)` and `cardTextSegments` at every level. With thousands of job anchors in one HTML-only email this is roughly quadratic. It is bounded by the 1 MiB per-message and 32 MiB per-run caps, and it only runs on mail that passes the sender allowlist. At worst a crafted email slows down that tenant's own discovery step. A cap on job anchors per email (for example 200) would bound it. Not blocking.
3. **Non-IMAP error messages can reach source errors.** `scanner.ts:118` puts `error.message` into `sourceErrors`. For IMAP errors this is safe, because `toImapError` already strips server responses. An unexpected error, for example from the repository or decryption setup outside the inner try, would also have its raw message shown in the pipeline run's source errors. Only that tenant sees it, and the logger gets `sanitizeUnknown(error)`. A generic message for errors that are not `ImapError` would be tidier.
4. **Access control and tenancy look right.**
   - There are no new API routes. The setting goes through the existing settings route and registry: zod boolean, stored per tenant.
   - The scan uses `getPostApplicationIntegration` (scoped by tenant and user) and the `"default"` key. It never writes integration state or mailbox flags (`openInboxReadOnly`, `BODY.PEEK`).
   - The cross-tenant test (`tenant-isolation.test.ts`) uses real repositories.
5. **Logging, secrets and dependencies are clean.**
   - The scan logs counts and UIDs only, never bodies, subjects, addresses or credentials. Moving the budget warnings into `selectUidsWithinBudget` keeps the same fields as before.
   - No secrets or `.env` files are committed, and no new dependencies are added (`jsdom` and `mailparser` already exist).
   - JSDOM is used with default options, so it runs no scripts and loads no resources.
   - The URL regexes are anchored and run in linear time. The host check uses an exact match or a `.linkedin.com` suffix, and look-alike hosts are tested.
6. **secure-endpoint checklist: no concerns.** I checked items 1-13. This change adds no endpoint. Items 1-3, 5 and 8 hold through the existing settings route and the tenant-scoped repositories. Item 6: the setting is validated with zod, and email content is checked for http(s) only. Item 7: no SQL, shell or file-path use of input. Item 9: see Note 3. Item 10: the change needs no new grants. Item 11: clean. Items 4, 12 and 13 do not apply (no impersonation, not Next.js, no unsafe deserialisation).
