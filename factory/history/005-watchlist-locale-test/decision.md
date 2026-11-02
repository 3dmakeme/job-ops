APPROVE

## Why
This change only touches one test assertion. It now builds the expected "Posted" date with the same Intl call the component uses, so the test passes whatever the locale or time zone. All four reviewers (security, ux, ui, code) gave PASS in round 1 with no real issues. `git merge-tree` against main shows no conflicts, and no escalation trigger applies.

## Acceptance criteria
1. en_GB run passes: met. build.md reports 8/8, and I re-ran it myself with LANG/LC_ALL=en_GB.UTF-8 plus TZ=America/Los_Angeles: 8/8 passed.
2. en_US run passes: met. build.md shows 8/8, and the code reviewer independently confirmed it.
3. TZ=America/Los_Angeles run passes: met. I spot-checked it (combined with en_GB) and got 8/8.
4. No `"May 1, 2026"` in the test file: met. I ran the grep in the worktree and it found nothing (exit 1).
5. Only the test file changed: met. `git diff --stat main...branch` shows only `orchestrator/src/client/pages/WatchlistPage.test.tsx` (4 lines added, 1 removed).
6. CI-parity checks pass: met per build.md (biome, all type checks, client build, full suite 2398 passed / 2 skipped). The change is test-only and type-safe, so I find this convincing.

## For the human
Nothing needed.
