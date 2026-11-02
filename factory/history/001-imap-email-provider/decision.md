ESCALATE

## Why
The work looks solid. All four round-2 reviews (security, ux, ui, code) are PASS, and the branch merges into main with no conflicts. It still needs a human because it hits several rules that always escalate. It adds three dependencies (`imapflow`, `mailparser`, `@types/mailparser`). It adds a new way of storing user credentials (AES-256-GCM encrypted IMAP passwords, with a key file generated under DATA_DIR). It also makes outbound connections to any host the user types in, with no private-IP/SSRF blocking in hosted mode. The spec left that last point for the approver to decide. Acceptance criterion 1 (`biome ci .` passes) is also not strictly met: build.md says it still reports 23 errors, the same number as on main.

## Acceptance criteria
1. `biome ci .` passes: not met as written. build.md says it gives 23 errors, the same as base. Biome on the changed files passes. I did not re-run it.
2. Type checks (shared, orchestrator): met per build.md and the code review (`check:types` 0 errors).
3. Extractor type checks: met per build.md. Not re-run.
4. `build:client`: met per build.md. Not re-run.
5. `test:run` incl. the new IMAP, crypto and form tests: met per build.md and the code review (targeted run 77/77, route tests 11/11).
6. No "not implemented yet" strings: met. I ran both greps in the worktree and they returned nothing.
7. No `rejectUnauthorized: false`: met. I ran the grep and it returned nothing. `imap-client.ts` uses `secure: config.tls`, `doSTARTTLS: true` when TLS is off, and a greeting timeout.
8. Connect stores only `passwordEncrypted`; status credential keys are exact: met per the security review and build.md.
9. Cross-tenant status reports `connected: false`: met per the reviews.
10. imap-sync mapping, `provider: "imap"` upsert and router call assertions: met per the code review.
11. Running-app form behaviour: met per the UI and UX reviews (labelled fields, empty password blocked, Gmail flow unchanged).
12. package.json deps, `.env.example` line, AGENTS.md line: met. I checked them in the diff.

## For the human
Please decide the following:
1. **Dependencies.** Are you OK adding `imapflow` ^2.10.0 and `mailparser` ^3.14.1 (plus `@types/mailparser`) to `orchestrator/package.json`? The root `package-lock.json` grows by about 440 lines.
2. **Credential storage.** Review `orchestrator/src/server/infra/credential-crypto.ts`. The key comes from `CREDENTIALS_ENCRYPTION_KEY`, or is generated at `DATA_DIR/credentials-key` (mode 0600). Losing the key means every IMAP account must be reconnected. Decide whether hosted deployments should be required to set the env var rather than rely on the generated file.
3. **SSRF in hosted mode.** In hosted mode, any authenticated user can make the server open a TCP/TLS connection to any host and port, including private and internal addresses. Demo mode is now blocked (`orchestrator/src/server/api/routes/post-application-providers.ts`, lines 362-374). Decide whether hosted mode also needs private-IP blocking before this ships. See `orchestrator/src/server/services/post-application/providers/imap.ts` and `ingestion/imap-client.ts`.
4. **Non-blocking note from the security review.** Sync fetches the full RFC822 source of up to 500 messages with no per-message size cap, which is a memory risk (`ingestion/imap-sync.ts`). Decide whether to cap it now or in a follow-up.
5. **AGENTS.md.** The branch adds one line to `AGENTS.md`, as the spec requires (requirement 11). Confirm you want that edit.
6. **Lint.** Confirm you accept AC1 as met even though repo-wide `biome ci .` still fails with errors that already exist on main.
