STATUS: READY

# Build: Make the WatchlistPage "Posted" date assertion locale-independent

## Summary
The test "shows new rows by default with ignore actions" no longer hard-codes `"May 1, 2026"`. It builds the expected text the same way `formatPostedDate` does, `new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-05-01"))`, and still asserts with `screen.getByText(expectedPostedDate)`. That makes it independent of both locale and time zone. I repeated the `"2026-05-01"` literal rather than reading `backendJob.postedAt`, because that field is typed `string | null` and reading it would need a cast.

Files changed:
- `orchestrator/src/client/pages/WatchlistPage.test.tsx`

Commit: `e40518e test: compute WatchlistPage posted date with runtime locale`

## Acceptance criteria
1. [x] en_GB: `LANG=en_GB.UTF-8 LC_ALL=en_GB.UTF-8 npx vitest run src/client/pages/WatchlistPage.test.tsx` gave 1 file passed, 8 tests passed.
2. [x] en_US: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx vitest run ...` gave 8/8 passed.
3. [x] `TZ=America/Los_Angeles npx vitest run ...` gave 8/8 passed (shell LANG was en_GB.UTF-8).
4. [x] `grep -n '"May 1, 2026"' orchestrator/src/client/pages/WatchlistPage.test.tsx` printed nothing (exit 1).
5. [x] `git diff --name-only main` lists only `orchestrator/src/client/pages/WatchlistPage.test.tsx`.
6. [x] All CI-parity checks passed (see Validation).

Requirement 3 still holds: `getByText` throws if no element has the formatted date, so the test fails if the Posted cell stops rendering.

## Validation
- `./orchestrator/node_modules/.bin/biome ci .`: pass
- `npm run check:types:shared`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace gradcracker-extractor run check:types`: pass
- `npm --workspace ukvisajobs-extractor run check:types`: pass
- `npm --workspace orchestrator run build:client`: pass
- `npm --workspace orchestrator run test:run`: pass, 321 files; 2398 tests passed, 2 skipped (run under LANG=en_GB.UTF-8)

## Log
### Round 1
- Replaced the hard-coded date assertion with a computed expected value that mirrors the component's `Intl` call.
- Ran the targeted test under en_GB, en_US and America/Los_Angeles, then the full CI-parity list.
- No production code, `docs/` or AGENTS.md changes.
