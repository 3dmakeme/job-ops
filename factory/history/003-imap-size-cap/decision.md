APPROVE

## Why
The branch adds per-message (1 MiB, partial `BODY.PEEK[]<0.n>` fetch plus slice safeguard) and per-sync (32 MiB, greedy newest-first) caps to IMAP sync, with structured warnings that hold no content and the tests the spec asks for. All four round-1 reviews are PASS. The security reviewer's note about servers that under-report `RFC822.SIZE` describes a residual limit that is still bounded by `maxLength`, so it is not a defect. The branch merges cleanly into main. The only non-code file it touches is the root `AGENTS.md`, which Requirement 9 asked for (it is not `docs/`, `.claude/` or `factory/`). It adds no dependencies, migrations, auth changes or config changes.

## Acceptance criteria
1. Constants exported with 1 MiB and 32 MiB values and used in imap-sync.ts: met. I checked this myself with grep (`imap-client.ts:6,8`, and `imap-sync.ts` imports and uses both).
2. No `source: true`, and `maxLength` partial fetch present: met. I checked this myself: the grep for `source: true` finds nothing, and the diff shows `source: { maxLength: maxBytes }`.
3. imap-client tests (sizes query, null size, maxLength, slice to exact limit): met. I ran the imap-client and imap-sync tests myself and all 26 pass. build.md lists the cases.
4. imap-sync tests (truncation warning, budget skip warning, smaller older message fits, no warnings for small messages): met. They pass in the same run, and build.md describes each case.
5. Warning assertions use `objectContaining` with only the Requirement 6 fields: met, per build.md. The security review confirms no subject, body or address is logged.
6. AGENTS.md line naming both constants: met (seen in the diff).
7. CI-parity checks: met, per build.md on Node 22. The one full-suite failure is the WatchlistPage locale test, which also fails on main and is already queued in the backlog. The suite passes under an en_US locale.

## For the human
None.
