APPROVE

## Why
The round-1 escalation was about a race where the watermark save could write back credentials that had been removed or replaced. Rework 1 fixed it. The save now goes through `replacePostApplicationIntegrationCredentialsIfUnchanged`, which compares and writes inside one synchronous, tenant-scoped better-sqlite3 transaction. Real-DB tests cover a disconnect during the save, a reconnect during the save and the normal path. All four round-2 reviews (security, ux, ui, code) are PASS, and none of their Notes describes a real problem. `git merge-tree --write-tree main factory/008-imap-watermark` reports no conflicts. The change adds no dependency, schema change, CI/deploy config, auth or permission logic, and touches nothing under docs/, .claude/ or factory/. The AGENTS.md bullet is one the spec requires.

## Acceptance criteria
1. imap-sync.test.ts covers cases (a) to (i): met. build.md lists each case, and I re-ran the file and it passes.
2. imap-client.test.ts has a `searchUidsAfter(10)` test for the `11:*` range that filters out UIDs of 10 or lower: met. build.md describes the test, and I re-ran it and it passes.
3. providers/imap.test.ts covers the stored watermark, exact public credential keys, a cross-tenant test and the round-2 race tests: met. I re-ran it and it passes.
4. Gmail tests pass and gmail-sync.ts / gmail-api.ts are unchanged: met. I re-ran both Gmail test files and they pass (98 tests in total across the 5 files). The three-dot diff for both Gmail files is empty.
5. Nothing changed under db/, docs/ or docs-site/: met. I checked `git diff main...branch --stat` on those paths, plus .claude, factory, package files and .github: all empty.
6. AGENTS.md has the syncWatermark bullet: met. I read the diff, and the bullet covers storage, incremental fetch, the reset conditions and never advancing past budget-skipped, unfetched or errored messages.
7. No flag, move, delete or expunge calls: met. I ran the grep and it finds no matches.
8. CI-parity checks pass: met according to build.md's Validation section (all seven pass, 2451 tests). The code reviewer also ran biome and the type checks. I did not re-run the full suite.

## For the human
Nothing needed.
