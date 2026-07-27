# 2026-07-27 — Gmail OAuth migration (sync worker) — PLANNED, not yet built

## TL;DR
The sync worker's Gmail login started failing on **2026-07-27** — `imapflow` throws `Error: Command failed` (Google refusing the IMAP connection) on every sync, so **no sync can run**. Root cause is the **App-Password / password-based IMAP auth**, not our code (the worker is healthy — Fly `blackwood-sync`, region `nrt`, machine v5, health check passing; DBOS boots clean; the failure is only at the Gmail-fetch step).

**Two paths were offered to Renzo:**
1. **Quick fix (try first):** regenerate the Gmail App Password → update the Fly secret `GMAIL_APP_PASSWORD` (+ local `~/.config/sync-ictc/credentials.env`) → re-run. If that works, done, and THIS handoff is unnecessary.
2. **Durable fix (THIS handoff):** migrate the worker's Gmail auth from **App Password → OAuth2** ("Sign in with Google" / XOAUTH2). Build this **if the App-Password regen also gets refused**, OR if Renzo wants to future-proof regardless (Google is deprecating password-based access; App Passwords silently die on password change / 2FA reset / security events — which is what just happened).

> **This reverses an earlier LOCKED decision** ("Gmail auth = IMAP + App Password ONLY, never OAuth/Composio" — TIMELINE 2026-05-27, and the `gmail_auth` memory). That was a deliberate simplicity call (no GCP project / OAuth consent / refresh-token plumbing). Renzo is knowingly reversing it because App Passwords have proven fragile. Update the `gmail_auth` memory + TIMELINE when this ships.

## Why NOT just stay on App Password
The Google support page Renzo surfaced (support.google.com/mail/answer/7126229) confirms: raw-password "less secure apps" access is dead, **IMAP is always-on** (not the problem), and Google steers everyone to **"Sign in with Google" (OAuth)**. App Passwords are a separate, still-technically-supported mechanism — but they're on the deprecation trajectory and are the fragile link that just broke. OAuth is the endorsed, durable path.

## Current state / the exact code to change
- **`workers/sync/src/lib/gmail.ts`** — the ONLY place Gmail auth happens. ~line 102-106:
  `this.client = new ImapFlow({ host: "imap.gmail.com", port 993, secure, auth: { user: creds.user, pass: creds.appPassword } })`.
  Creds read from env at ~line 48-49 (`GMAIL_USER`, `GMAIL_APP_PASSWORD`).
- **`workers/sync/src/workflows/mailClerk.ts`** — orchestrates the fetch (uses the gmail.ts client). Also `reports/prodSchedule/josephEmail.ts` fetches a specific email — check if it opens its own IMAP client or reuses gmail.ts.
- Idempotency: the `Blackwood-Processed` Gmail label is applied after ingest (IMAP STORE / label ops) — must keep working under OAuth.
- Secrets today (Fly `blackwood-sync` + local `~/.config/sync-ictc/credentials.env`): `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
- **VERIFY FIRST:** how many mailboxes does the worker actually log into? Likely ONE (`GMAIL_USER` = the central inbox that receives/forwards MC + Ivy + Czarina + RC-delivery reports). Confirm in `mailClerk.ts` — if it's one account, one refresh token; if it opens multiple accounts, one token PER account.

## The OAuth build plan (concrete)
1. **Google Cloud setup (Renzo does the console part):** create/reuse a GCP project → enable the Gmail API → create an **OAuth 2.0 Client ID** (type **Desktop app** is simplest for minting the refresh token) → configure the OAuth consent screen (add the sync Gmail account as a test user, or publish). Scope needed for full IMAP + label writes: **`https://mail.google.com/`** (the broad IMAP scope; XOAUTH2 requires it — the narrower gmail.readonly won't allow STORE/label).
2. **One-time refresh-token mint:** write a tiny local script (`workers/sync/scripts/gmail-oauth-mint.ts` or similar) — runs the OAuth consent flow in the browser once, exchanges the code for a **refresh token**. Renzo runs it (it handles his Google login/consent). Output: the refresh token. **Claude does NOT handle/enter these secret values** — Renzo puts them into Fly + the local creds file himself (same boundary as the Vercel/App-Password work this session).
3. **New secrets:** `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` (per account if multiple). Keep `GMAIL_USER`. Retire `GMAIL_APP_PASSWORD` once OAuth works.
4. **Worker change (minimal — keep imapflow):** in `gmail.ts`, add a helper that exchanges the refresh token → a short-lived **access token** (POST to `https://oauth2.googleapis.com/token` with client id/secret + refresh_token, grant_type=refresh_token), then construct `new ImapFlow({ ..., auth: { user, accessToken } })` (imapflow supports XOAUTH2 natively via `accessToken`). Refresh the access token on connect (they expire ~1h) and on auth-failure retry. All the existing fetch/search/label logic stays. **RECOMMENDED over the Gmail API** — XOAUTH2 is a ~20-line auth swap; the Gmail API would be a full rewrite of the fetch layer.
5. **Deploy + verify:** `fly deploy` the worker → watch logs on a real sync → confirm IMAP connects (no "Command failed") and the `Blackwood-Processed` label still applies.

## Open decisions for the next session
- XOAUTH2-via-imapflow (recommended, minimal) vs full Gmail API rewrite. Default to XOAUTH2.
- One mailbox vs several (drives one-vs-many refresh tokens) — resolve by reading `mailClerk.ts`.
- OAuth client type (Desktop = easiest for the one-time mint) + whether the consent screen needs publishing vs test-user.

## Next concrete action
Only start this if path-1 (App-Password regen) failed or Renzo chose to future-proof. Then: (1) read `gmail.ts` + `mailClerk.ts` end-to-end to confirm the single-vs-multi mailbox question and the label-write calls; (2) write the refresh-token mint script; (3) hand Renzo the GCP-console + mint steps; (4) do the `gmail.ts` XOAUTH2 swap + token-refresh helper; (5) deploy + verify. Update `gmail_auth` memory + TIMELINE + `.claude/skills/sync-ictc` docs to reflect OAuth.

## Safety note
Renzo handles ALL secret values (OAuth client secret, refresh token) — into Fly secrets + the local creds file himself. Claude writes the code + the mint script + gives exact `fly secrets set` commands, but never enters/pushes the token values (consistent with how the Vercel env vars + App Password were handled this session).
