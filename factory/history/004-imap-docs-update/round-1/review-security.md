VERDICT: PASS

## Findings
None.

## Notes
- The change touches only documentation: `docs-site/docs/features/post-application-tracking.md` and `docs-site/docs/workflows/post-application-workflow.md` (commit 4174013). It adds no code, endpoints, dependencies or config.
- Secrets: no real credentials in the diff. The examples use placeholders: `<your-server>.mxrouting.net`, `you@example.com`, `<mailbox-password>` and `CREDENTIALS_ENCRYPTION_KEY=<output of: openssl rand -base64 48>`. None of them looks like a usable secret. The key example makes users generate their own key and does not hand out a shared default, which is the right approach.
- Accuracy of the security claims, checked against the code:
  - STARTTLS is still required with TLS off: `imap-client.ts:78-84` sets `secure: config.tls` and `doSTARTTLS: true`.
  - INBOX is opened read-only: `imap-client.ts:113` uses `readOnly: true`.
  - Messages are fetched with `BODY.PEEK[]`: `imap-client.ts:149`.
  - The key has a 32-character minimum and falls back to the `credentials-key` file: `infra/credential-crypto.ts:16-17, 39, 83`.
  
  None of these claims overstates the protections the code gives. The claim "Certificate validation stays on" also holds: `createImapClient` sets no `rejectUnauthorized: false`.
- Both pages state that connect and sync are disabled in the public demo, which matches the spec.
- The curl examples call `localhost:3001` without any auth header. They follow the existing Gmail examples, so this is not new. Any auth requirement on the API is set by the deployment, not by these docs.
- secure-endpoint: no endpoint in scope (docs-only change). I checked items 1-13. Item 11 (secrets) was the only one that applied, and it raised no concerns. Items 4, 12 and 13 are n/a.
