VERDICT: CHANGES

## Findings
1. orchestrator/src/server/services/post-application/providers/imap.ts:163 (reached through orchestrator/src/server/api/routes/post-application-providers.ts:343-412, and the auth guard in orchestrator/src/server/app.ts:284-291). In demo mode (`DEMO_MODE=true`), `isPublicDemoRoute` makes every `/api/*` path public unless it is in `isProtectedDemoRoute`, and `/api/post-application/...` is not on that list. Before this branch, IMAP connect and sync threw "not implemented", and Gmail connect only works after a Google OAuth exchange. Now an anonymous visitor to a public demo can call `POST /api/post-application/providers/imap/actions/connect` with any `host` and `port`, and the server will open a TCP/TLS connection there with a 15 s timeout. The response tells them which case they hit: 400 for an auth failure (a live IMAP server), 502 with an `ENOTFOUND`/`ECONNREFUSED`/timeout reason, or a fast versus slow failure. That turns the demo host into an unauthenticated network-probe and SSRF primitive against its internal network. There is no rate limit. A visitor who points it at a server they control can also store credentials in the demo DB, and `sync` will then fetch up to 500 full messages and send them through the LLM/Jev router at the operator's cost. Fix: use the project's existing pattern. In demo mode, call `sendDemoBlocked(res, "Connecting mail providers is disabled in the public demo.", { route: ... })` in the provider action route for `connect` and `sync`, at least for `imap` (blocking every non-`status` action matches the other write routes). Alternatively, add `/api/post-application/providers` to `isProtectedDemoRoute`. Add a test that demo mode blocks IMAP connect without creating a client.

## Notes
- secure-endpoint checklist, applied to the IMAP provider actions:
  - Item 1 (gated first): only true outside demo mode. In non-demo modes the global auth guard requires a valid token. Demo mode is Finding 1.
  - Item 2 (role): any authenticated user may connect their own scoped mailbox. This matches the Gmail path and the spec.
  - Item 3 (IDOR): passes. All reads and writes go through `getPostApplicationIntegration`, `upsertConnectedPostApplicationIntegration` and `disconnectPostApplicationIntegration`, which are scoped by `privateDataScopeFilter`. `accountKey` cannot reach another tenant's row, and a cross-tenant test exists.
  - Item 4: n/a.
  - Item 5 (actor): passes. `initiatedBy` comes from the server.
  - Item 6 (input validation): passes. host is hostname-shaped and at most 253 characters, port is an integer from 1 to 65535, tls is a boolean, username and password are non-empty, and the route caps maxMessages at 500 and searchDays at 365.
  - Item 7 (parameterised queries): passes. All queries use the ORM, and there are no shell or file paths.
  - Item 8: passes. The page shows only the caller's scoped status.
  - Item 9 (errors): passes. Error messages are fixed strings, the raw server response is never forwarded, the logger is off on ImapFlow, and only error codes are logged.
  - Item 10: no new DB grants. The process now needs to write `DATA_DIR/credentials-key` when no env key is set, which it already does for `jwt-secret`.
  - Item 11 (secrets): passes. There is no key in the code, `.env.example` has only a commented placeholder, and the plaintext password is never stored, logged or returned. `toPublicIntegration` returns exactly `host, port, tls, username, hasPassword`.
  - Items 12 and 13: n/a (Express plus a React SPA, no Next.js or Python).
- Transport security checked against imapflow 2.10.0's source. `doSTARTTLS: true` makes `_failSTARTTLS` throw instead of falling back to plaintext, so the password never goes out unencrypted. `rejectUnauthorized` is not overridden.
- Crypto checked. AES-256-GCM uses a random 12-byte IV and a 16-byte tag. The format and tag lengths are checked before decrypt. Errors carry no plaintext or ciphertext. The key file is created with `wx` and `0600`, with EEXIST race handling. The only module-level cache is the install-global key.
- Hosted mode, with authenticated users: a user can still point `host` at internal addresses, a weaker version of Finding 1. The spec chose not to block private IPs, so this is not a blocker here. If hosted multi-user deployments matter, the approver should consider a private-range block or allow-list in hosted mode.
- DoS: sync fetches the full RFC822 source of up to 500 messages into memory before parsing, with no per-message size cap. A mailbox with large attachments could spike memory. Consider `size` in the fetch query and skipping messages over a few MB. Not blocking.
- Dependencies: `imapflow` 2.10.0 and `mailparser` 3.14.1 are both maintained (same author, MIT) and justified by the spec.
- XSS: the client renders `username @ host` through React text nodes. There is no `dangerouslySetInnerHTML` in the new code, and the password input is `type="password"` and is cleared on success.
- Pre-existing and unchanged: Gmail refresh and access tokens stay plaintext in `credentials`. The spec makes this out of scope, as a follow-up.
