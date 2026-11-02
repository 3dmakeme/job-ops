# IMAP post-application email provider (MxRoute)
Outcome: merged 2026-11-02 after 2 review rounds (1 rework) · Mission fit: Fits

> Feature: Implement the IMAP post-application email provider for MxRoute (password login over TLS 993): connect, status, sync through the shared ingestion and email-router path, disconnect; client connect form next to Gmail; password protected at rest; multi-tenant scoping; tests.

## What shipped
The IMAP provider in `orchestrator/src/server/services/post-application/providers/imap.ts` was a stub that always threw "not implemented". It now does connect (login verified over implicit TLS or required STARTTLS), status, sync (INBOX, read-only, 90 days, 100 messages) and disconnect. Passwords are stored AES-256-GCM encrypted through the new `orchestrator/src/server/infra/credential-crypto.ts`. Gmail's per-message routing moved into `ingestion/message-ingest.ts`, so both providers share the Jev/LLM email-router path. The Tracking Inbox has an IMAP connect form (`client/pages/tracking-inbox/ImapConnectForm.tsx`). In round 2 the route began blocking IMAP connect and sync in demo mode (`api/routes/post-application-providers.ts:362-374`).

The approver escalated four things: the new dependencies (`imapflow`, `mailparser`, `@types/mailparser`), credential storage with a generated key file, outbound connections to user-typed hosts, and repo-wide `biome ci .` failures that predate the job. The human accepted all four. The app runs only in a container on a Mac mini reachable only from the owner's Tailscale devices. So private-IP blocking, a message size cap and hosted-mode key handling were accepted as-is.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. `biome ci .` passes | Not met as written; accepted by the human | 23 errors, the same count as base (bf20444), none in changed files. Biome on the 16 changed files passes (build.md). |
| 2. Shared and orchestrator type checks | Met | build.md. The round 2 code reviewer reran `check:types`. |
| 3. Extractor type checks | Met | build.md. The approver did not re-run them. |
| 4. `build:client` | Met | build.md |
| 5. `test:run` including the new files | Met except one pre-existing failure | 2387 passed, 1 failed. The failure is `WatchlistPage.test.tsx`, which is date-dependent and also fails on base. Targeted run: 77/77. |
| 6. No "not implemented yet" strings | Met | Both greps returned nothing (build.md, decision.md). |
| 7. No `rejectUnauthorized: false` | Met | Grep returned nothing. `imap-client.test.ts` asserts there is no `tls` option. |
| 8. Password encrypted; status keys exact | Met | `providers/imap.test.ts`; security review |
| 9. Cross-tenant status reports `connected: false` | Met | `providers/imap.test.ts` |
| 10. Sync mapping and router call | Met | `ingestion/imap-sync.test.ts`; code review |
| 11. Form behaviour in the running app | Met | Browser check by the builder (build.md). The UI and UX reviewers worked from the diff only. |
| 12. Dependencies, `.env.example`, AGENTS.md line | Met | Approver checked the diff. |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | CHANGES (1) | PASS | PASS | PASS |
| 2 | PASS | PASS | PASS | PASS |

## Iterations
### 1. IMAP connect and sync reachable anonymously in demo mode
- **Caught by:** security, round 1 (finding 1)
- **What was wrong:** With `DEMO_MODE=true`, `/api/post-application/...` is not on the protected demo route list. An anonymous visitor could therefore POST IMAP connect or sync (reached via `providers/imap.ts:163`) with any host and port. That allowed network probing, SSRF and LLM cost abuse through routing. The 400, 502 and ENOTFOUND responses also showed the visitor what was at the target. Fixed in commit 0e9656c.
- **Why the builder missed it:** The spec covered private-IP blocking only for hosted mode (Assumptions). No acceptance criterion mentioned demo mode or the unauthenticated case. The guard that makes `/api/*` public in demo mode lives in `app.ts`, away from the route and provider files the builder worked in. The round 1 build log shows tests of authenticated, tenant-scoped behaviour only. Before this job the IMAP endpoint threw "not implemented", so it had no demo exposure until the builder made it do real work.
- **Guardrail:** None was configured, and the security reviewer with the `secure-endpoint` skill did its job. The spec-writer rule and checklist line proposed below would catch it earlier.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|
| AGENTS.md (spec-writer rules) | "Any spec that adds or enables an endpoint making outbound network calls to a user-supplied host, or spending paid LLM/API calls, must include an acceptance criterion for `DEMO_MODE=true` (anonymous caller gets 403 via `sendDemoBlocked`) and one for the unauthenticated case." | Turning a former stub into a live endpoint that anonymous demo visitors can reach |
| New `factory/checks/` checklist (the directory does not exist yet) | "For every new or newly enabled route: check `isPublicDemoRoute` / `isProtectedDemoRoute` in `app.ts`. State whether the route is public in demo mode and, if it has side effects or outbound calls, block it with `sendDemoBlocked`." | The same gap, caught at build time instead of in review |
| AGENTS.md validation | Fix or baseline the 23 pre-existing `biome ci .` errors and the date-dependent `WatchlistPage.test.tsx`. Or change the spec rule to "biome ci on changed files; no new errors vs base". | Acceptance criteria 1 and 5 being unmeetable as written, which forces a human escalation each time |

## Follow-ups
- [ ] Encrypt the existing Gmail access and refresh tokens, which are still plaintext in `credentials`. Reuse `credential-crypto.ts`. This is a spec out-of-scope item.
- [ ] Update `docs-site/docs/features/post-application-tracking.md` and `docs-site/docs/workflows/post-application-workflow.md`, which now under-describe IMAP. Spec out-of-scope item.
- [ ] Add a per-message size cap on sync. `ingestion/imap-sync.ts` loads up to 500 full RFC822 sources into memory. Accepted for the Tailscale-only deployment.
- [ ] Add private-IP / SSRF blocking for IMAP hosts before any wider or hosted multi-user use. Accepted for now.
- [ ] Consider requiring `CREDENTIALS_ENCRYPTION_KEY` in hosted mode instead of the generated `DATA_DIR/credentials-key`. Losing the key means every IMAP account must be reconnected.
- [ ] Optional UX notes: suggest port 143 when the TLS switch is off, and use plainer helper text such as "Your password is stored encrypted".
- [ ] Confirm the spec assumption that `tls: false` means required STARTTLS, not plaintext.
- [ ] Layout is unverified by any reviewer, because both UI and UX reviews were diff-only in both rounds. Only the builder's browser check exists, so the Port/TLS switch alignment at narrow widths has not been confirmed.

## Mission fit
Fits. The mission lists "tracking applications, interviews and post-application email" as in scope, and routing uses the existing Jev/LLM email router. Drift: none. `factory/history/` does not exist, so there are no earlier records to compare against. This is job 001.
