# IMAP incremental sync watermark
Outcome: merged 2026-11-02 after 2 review rounds (1 rework) · Mission fit: Fits

> Feature: IMAP incremental sync watermark: per IMAP account, store the last-seen UID together with the mailbox uidValidity (for example in the integration sync state), and on later syncs search and fetch only UIDs greater than the watermark. The first sync keeps the existing 90-day / 100-message window. If uidValidity changes, discard the watermark and fall back to the full window. Only advance the watermark past messages that were actually fetched and processed (never past messages skipped by the size budget or that errored), so nothing is silently lost. Keep the Message-ID dedupe as a safety net. Read-only on the mailbox, tenant-scoped, with tests for first sync, incremental sync, uidValidity reset, skipped/errored messages, and no change to Gmail behaviour.

## What shipped
Every IMAP sync used to re-read the whole 90-day / 100-message window. Each IMAP account now keeps a `syncWatermark` (`{ uidValidity, lastUid }`) inside its stored `credentials` JSON, so no schema change was needed. Later syncs fetch only UIDs above it. A uidValidity change resets it, and it never moves past messages that were skipped by the size budget, not fetched, or errored. The main changes are in `orchestrator/src/server/services/post-application/ingestion/imap-sync.ts`, `imap-client.ts` and `message-ingest.ts`, plus a new compare-and-set write, `replacePostApplicationIntegrationCredentialsIfUnchanged`, in `orchestrator/src/server/repositories/post-application-integrations.ts`. `AGENTS.md` has a new `syncWatermark` bullet. Gmail files are unchanged.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. `imap-sync.test.ts` covers cases (a) to (i) | Met | build.md; approver re-ran the file |
| 2. `imap-client.test.ts` has a `searchUidsAfter(10)` test for `11:*` | Met | approver re-ran it |
| 3. `providers/imap.test.ts`: stored watermark, exact public keys, cross-tenant, round-2 race tests | Met | approver re-ran it |
| 4. Gmail tests pass; `gmail-sync.ts` / `gmail-api.ts` unchanged | Met | empty three-dot diff for both |
| 5. Nothing under `db/`, `docs/` or `docs-site/` changed | Met | `git diff --stat` |
| 6. `AGENTS.md` has the `syncWatermark` bullet | Met | approver read the diff |
| 7. No flag, move, delete or expunge calls | Met | approver grep |
| 8. All seven CI-parity checks pass | Met | build.md (2451 tests); approver did not re-run the full suite |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |
| 2 | PASS | PASS | PASS | PASS |

Round 1 was all PASS, but the approver escalated instead of approving (Iteration 1). Round 2 followed `rework-1.md`, and the approver then approved.

## Iterations
### 1. Watermark save could write back removed or replaced credentials
- **Caught by:** the approver at the round-1 decision, not a reviewer. The round-1 security reviewer had listed it as a "minor race (non-blocking)" Note.
- **What was wrong:** `persistImapSyncWatermark` read the credentials and later wrote `{ ...currentCredentials, syncWatermark }` through `updatePostApplicationIntegrationSyncState`, which matches the row by id only. A disconnect, or a same-host reconnect with a new password, between the read and the write would have the old credentials, including the encrypted password, written back.
- **Why the builder missed it:** the spec prescribed the design (Requirement 6) and its reconnect check compared only host, port and username. No acceptance criterion asked for a test that changes the row between the read and the write.
- **Why the round-1 security reviewer did not stop it:** it described the race and the fix correctly but judged the window small and limited to the caller's own row, and rated it non-blocking.
- **Fix (rework-1, commit `0e5f952`):** a synchronous, tenant-scoped transaction re-reads the row, compares with `isDeepStrictEqual`, and updates only on a match; a changed `passwordEncrypted` also counts as a reconnect. Three real-DB tests added; the first two fail without the compare.
- **Guardrail:** the two rows below.

### 2. Log line reported an unsaved `newLastUid`
- **Caught by:** code reviewer, round 1 (Note), folded into rework-1.
- **Fix:** the log is written after the save with `watermarkWrite: "stored" | "unchanged" | "skipped"`, and `newLastUid` is null when skipped.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|
| AGENTS.md, spec-writer rules | "Any requirement that reads a stored row and later writes it back (read-modify-write, especially of `credentials` or secrets) must say how it stays safe against a concurrent disconnect, reconnect or update: one synchronous transaction, or a compare-and-set on what was read. It must also include an acceptance criterion with a real-DB test that changes the row between the read and the write." | A spec that prescribes a lost-update race |
| New `factory/checks/` checklist (or the security reviewer's brief) | "A write that can restore credentials or secrets the user removed or replaced (write-back of a stale read, row matched by id only) is a blocking finding, not a Note, however small the timing window." | Security reviewers recording a credential-resurrection race as non-blocking |

## Follow-ups
- [ ] Update the two IMAP docs-site pages to say Search Days applies only to the first sync and after a reset, and that later syncs fetch only new messages.
- [ ] Confirm: an empty first sync stores no watermark, so an empty mailbox re-searches the window each time until mail arrives.
- [ ] Confirm: incremental syncs take the oldest `maxMessages` UIDs above the watermark (ascending), so a backlog drains over several syncs, and incremental mode ignores `searchDays`.
- [ ] Confirm: concurrent syncs of one account may move the watermark backwards (an extra re-read, absorbed by Message-ID dedupe); no lock added.
- [ ] Spec Requirement 4 ("reset stores nothing new") and 10(c) (reset stores the new uidValidity) disagree; the build follows 10(c).

## Mission fit
Fits: makes "Tracking applications, interviews and post-application email" from the user's own IMAP mailbox cheaper and safer, with no lost messages, inside the multi-tenant constraint. Drift: none.
