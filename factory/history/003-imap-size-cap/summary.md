# IMAP sync: per-message and per-sync size caps
Outcome: merged 2026-11-02 after 1 review round (0 reworks) · Mission fit: Fits

> Feature: IMAP sync: cap the size of each fetched message and the total memory used per sync (skip or truncate oversized messages, log a warning), with tests

## What shipped
IMAP sync used to pull the full source of up to 500 messages into memory with no limit, a risk flagged in the security reviews of job 001. Each message is now fetched with a partial `BODY.PEEK[]<0.n>` request capped at 1 MiB (`IMAP_MAX_MESSAGE_BYTES`), with a slice safeguard on the returned buffer. A new `fetchMessageSizes` call lets `fetchRecentInboxMessages` fill a 32 MiB budget (`IMAP_MAX_SYNC_BYTES`) newest-first before any source is fetched. Changes are in `orchestrator/src/server/services/post-application/ingestion/imap-client.ts` and `imap-sync.ts`, their tests, and one line in `AGENTS.md`. Truncated and skipped messages produce structured warnings with no message content.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. Both constants exported (1 MiB, 32 MiB) and used in `imap-sync.ts` | Met | `imap-client.ts:6,8`; grep confirmed in decision.md |
| 2. No `source: true`; `maxLength` partial fetch present | Met | `imap-client.ts:153`; grep confirmed in decision.md |
| 3. `imap-client` tests (sizes query, null size, maxLength, slice) | Met | 12 passed in build.md; reviewer ran 26 across both files |
| 4. `imap-sync` tests (truncate + warn, budget skip + warn, older message fits, no warnings) | Met | 14 passed in build.md |
| 5. Warning assertions use `objectContaining`, no content fields | Met | build.md; security review confirms fields |
| 6. `AGENTS.md` line names both constants | Met | `AGENTS.md` diff |
| 7. CI-parity checks | Met, one caveat | `WatchlistPage` test fails under en_GB locale; it is pre-existing and queued in `factory/backlog.md`. Full suite passes under en_US. |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |

## Iterations
None: every reviewer passed round 1.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|

## Follow-ups
- [ ] Security note: the 32 MiB budget trusts the server-reported `RFC822.SIZE`. A server that under-reports sizes (for example 0) leaves the real cap at `maxMessages * 1 MiB`, up to 500 MiB at the route maximum. A server that ignores the partial range is still fully buffered before the slice. Possible hardening: charge actual `source.length` against the budget during ingestion, or lower `maxMessages` when no sizes are reported. The IMAP host is chosen by the account owner, so the reviewer did not block.
- [ ] Locale-dependent `WatchlistPage.test.tsx` failure under en_GB is already queued in `factory/backlog.md`.
- [ ] Spec out-of-scope items that may still matter: making the limits configurable, and a docs-site mention of the limits (the existing backlog item for post-application pages).
- [ ] Assumption to confirm: 1 MiB per message and 32 MiB per sync are product-tunable numbers chosen by the spec-writer. Truncating oversized messages (rather than skipping) assumes headers and text come before attachments.
- [ ] `factory/checks/` does not exist in this repo, so no checklist was compared against.

## Mission fit
Fits: hardens the self-hosted IMAP post-application email tracking, which is In scope ("Tracking applications, interviews and post-application email"; "Self-hosting and operating the app in Docker"). Drift: none. The last 2 history records (001, 002) and this job are all Fits.
