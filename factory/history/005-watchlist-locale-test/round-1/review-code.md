VERDICT: PASS

## Checks
vitest WatchlistPage.test.tsx under en_GB: pass (8/8)
vitest WatchlistPage.test.tsx under en_US: pass (8/8)
vitest WatchlistPage.test.tsx under TZ=America/Los_Angeles: pass (8/8)
biome ci on the changed file: pass
git diff --name-only main: only the test file
Full CI-parity list (types, build, full suite): not run; the change is test-only in one file.

## Findings
None.

## Notes
The fix mirrors the component's Intl call as the spec asks. The literal "2026-05-01" is repeated rather than read from the fixture, which the spec allows.
