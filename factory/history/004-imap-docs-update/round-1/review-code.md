VERDICT: PASS

## Checks
npm run check:docs: pass
git diff --stat main...HEAD: only the two docs-site/docs pages changed (pass)
Frontmatter id/title/sidebar_position unchanged; description mentions IMAP in both: pass
Required terms (mxrouting.net, CREDENTIALS_ENCRYPTION_KEY, credentials-key, INBOX, read-only, 1 MiB, 32 MiB), constant names, API rows and curl bodies present: pass

## Findings
None.

## Notes
- Gmail content is preserved. Gmail headings were nested under a new "Gmail" heading, which is fine.
- The "IMAP sync limits" heading is a sibling of "IMAP" under Setup. That reads fine.
- "Connect and sync are disabled in the public demo" matches the spec's Context.
- Other Gmail-only docs pages (gmail-oauth-setup, overview, self-hosting) remain a possible follow-up, as the spec says.
