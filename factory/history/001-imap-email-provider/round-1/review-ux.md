VERDICT: PASS

## Findings
None.

## Notes
Reviewed from the diff only. I did not run the dev server or drive a browser.
- The IMAP form (ImapConnectForm.tsx) uses labelled inputs, a real submit button tied to the form by id, so Enter submits. The password uses type=password with autocomplete hints, and it is cleared after a successful connect.
- Client validation gives plain messages for missing fields and a bad port. Server errors (400 login failed) go through the existing action error toast.
- The form is hidden once connected, and the account shows as "user @ host", so there are no dead ends. Disconnect and Sync are unchanged.
- Layout is a single column on mobile and two columns from md up.
- Optional: when the TLS switch is turned off, the port could suggest 143. Today the user has to change it by hand.
- Optional: the helper text "IMAP connect verifies the login..." is slightly technical. Something like "Your password is stored encrypted" would read more plainly.
