# Make the WatchlistPage "Posted" date assertion locale-independent

> Feature: Make WatchlistPage.test.tsx ("shows new rows by default with ignore actions") locale-independent: it expects "May 1, 2026" but renders "1 May 2026" under en_GB, and fails on unmodified main

## Context
- Test: `orchestrator/src/client/pages/WatchlistPage.test.tsx`, test `"shows new rows by default with ignore actions"` (around line 292). It asserts `expect(screen.getByText("May 1, 2026")).toBeInTheDocument();` (line 302). The fixture `backendJob` has `postedAt: "2026-05-01"` (line 90).
- Rendering: `orchestrator/src/client/pages/watchlist/WatchlistJobRow.tsx`, module-private `formatPostedDate` (around line 58), formats with `new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))`. `undefined` means the runtime's default locale, so the output follows the host's `LANG`/`LC_ALL`.
- Checked on this machine (`LANG=en_GB.UTF-8`): `npx vitest run src/client/pages/WatchlistPage.test.tsx -t "shows new rows"` from `orchestrator/` fails at line 302. It passes with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`.
- `new Date("2026-05-01")` parses as UTC midnight and is then formatted in the local time zone, so the hard-coded string also depends on the time zone (a negative UTC offset gives April 30).
- Test runner: Vitest (jsdom), configured in `orchestrator/vite.config.ts`. Run with `npm --workspace orchestrator run test:run`.

## Requirements
1. The assertion in `"shows new rows by default with ignore actions"` no longer hard-codes `"May 1, 2026"`. It computes the expected text in the test the same way the component does: `new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-05-01"))`. The `postedAt` value may be read from the `backendJob` fixture instead of repeating the literal. It still asserts with `screen.getByText(expected)`.
2. Only `orchestrator/src/client/pages/WatchlistPage.test.tsx` changes. Production code (`WatchlistJobRow.tsx`, `watchlist/utils.ts`) is not modified.
3. The test still checks that the Posted date for the fixture row appears, so it would fail if the date cell stopped rendering.
4. All other tests in the file keep passing unchanged.

## Acceptance criteria
1. From `orchestrator/`, `LANG=en_GB.UTF-8 LC_ALL=en_GB.UTF-8 npx vitest run src/client/pages/WatchlistPage.test.tsx` passes all tests.
2. From `orchestrator/`, `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx vitest run src/client/pages/WatchlistPage.test.tsx` passes all tests.
3. From `orchestrator/`, `TZ=America/Los_Angeles npx vitest run src/client/pages/WatchlistPage.test.tsx` passes all tests.
4. `grep -n '"May 1, 2026"' orchestrator/src/client/pages/WatchlistPage.test.tsx` returns nothing.
5. `git diff --name-only main` lists only `orchestrator/src/client/pages/WatchlistPage.test.tsx`, apart from files under `factory/`.
6. The CI-parity checks from AGENTS.md pass: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

## Out of scope
- Changing `formatPostedDate` or `formatWatchlistCheckTimestamp` to use a fixed locale or time zone. That would change what users see.
- Pinning `LANG`/`TZ` globally in `vite.config.ts`, `src/setupTests.ts` or the npm scripts.
- Fixing other locale-dependent tests elsewhere in the repo.
- Exporting `formatPostedDate` from `WatchlistJobRow.tsx` so the test can import it.
- AGENTS.md or `docs/` changes. Nothing user-facing or procedural changes.

## Assumptions
- Mirror the component's `Intl` call in the test instead of importing it. Reason: the formatter is module-private, and exporting it would mean changing production code for a test.
- Make the test independent of the time zone as well as the locale. Reason: the same hard-coded string breaks for the same reason in western time zones, and the computed-expected approach fixes both at no extra cost.

## Mission fit
Fits: a test-only fix so the CI-parity suite passes on the owner's en_GB machine. It supports operating the app ("Self-hosting and operating the app") and touches nothing in the mission's out-of-scope list.
