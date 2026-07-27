# Deploying the Blackwood sync worker to Fly.io

The web app (Next.js) runs on **Vercel**. The sync worker in this folder runs on
**Fly.io** — it is a long-lived DBOS worker that keeps a machine awake, holds a
Postgres checkpoint DB, and runs a multi-minute background job, none of which fit
Vercel's serverless model. The Vercel app sends a "go" signal (`POST /kick`) to the
Fly worker; the sync then runs in the cloud, independent of any laptop.

**Trigger model: manual button only.** Sync runs when someone clicks **Run Sync** in
the deployed app. There is no scheduler — the worker sits idle (one always-on
machine, ~$2–3/mo) until a kick arrives. To add a daily automatic run later, add a
scheduled trigger (Fly cron machine or Supabase pg_cron) that hits `POST /kick`.

This folder is already deploy-ready: `fly.toml` (app `blackwood-sync`, region `nrt`)
and `Dockerfile` are committed. `npm run build` (the Docker build step) passes.

---

## One-time runbook

All commands below are run by **you** — they need your Fly account and your real
secret values.

### 1. Install + log in (once)
```bash
brew install flyctl
fly auth login
```

### 2. Sanity-check the DB URL first (the step that bites)
DBOS needs a **DIRECT / session-mode** Postgres connection — port **5432**, the
Supabase pooler in *session* mode (NOT the transaction pooler, which breaks the
advisory locks + LISTEN/NOTIFY DBOS relies on). It also needs the Supabase database
password (Dashboard → Settings → Database), which is not in the repo.

Put the URL in a local `.env`, then:
```bash
cd workers/sync
node scripts/db-connect-test.mjs   # must connect in ~1s
```
URL shape:
```
postgresql://postgres.taadqhgdsmxvkhhniwgm:<DB_PASSWORD>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
```

### 3. Create the Fly app (reuses the committed fly.toml)
```bash
fly launch --no-deploy
```

### 4. Set the worker's secrets
Only `DBOS_DATABASE_URL` is needed for the checkpoint DB (`DBOS_SYSTEM_DATABASE_URL`
is just a fallback for it — don't set both).
```bash
fly secrets set \
  GMAIL_USER="…" \
  GMAIL_OAUTH_CLIENT_ID="…" \
  GMAIL_OAUTH_CLIENT_SECRET="…" \
  GMAIL_OAUTH_REFRESH_TOKEN="…" \
  SUPABASE_URL="https://taadqhgdsmxvkhhniwgm.supabase.co" \
  NEXT_PUBLIC_SUPABASE_URL="https://taadqhgdsmxvkhhniwgm.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="…" \
  DBOS_DATABASE_URL="postgresql://postgres.taadqhgdsmxvkhhniwgm:<DB_PASSWORD>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres" \
  SYNC_KICK_SECRET="$(openssl rand -hex 32)"
```
**Record the `SYNC_KICK_SECRET`** — you reuse the exact same value on Vercel (step 6).

### 5. Deploy
```bash
fly deploy
fly logs                                   # health check should pass
curl https://blackwood-sync.fly.dev/health # expect OK
```

### 6. Wire the Vercel app to the worker
In Vercel → project → Environment Variables:
- `SYNC_WORKER_URL` = `https://blackwood-sync.fly.dev`
- `SYNC_KICK_SECRET` = **the exact same** string from step 4

Redeploy the Vercel app. The **Run Sync** button now kicks the cloud worker.

---

## Gotchas

- **Both sides must share `SYNC_KICK_SECRET`.** If they differ, the worker rejects the
  kick with `401` and the run silently stays QUEUED.
- **A lost kick is not lost work.** DBOS recovers a QUEUED run on the worker's next
  wake; with `min_machines_running = 1` the worker is always up to catch it.
- **The worker never blocks the app.** If `SYNC_WORKER_URL` is unset or the kick
  fails, `enqueueSyncRun` still writes the `sync_runs` row — the run just waits for
  DBOS recovery.

## Secrets reference

| Secret | Where it comes from |
|---|---|
| `GMAIL_USER` | The single sync mailbox address |
| `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` | Google Cloud Console → Credentials → OAuth client ID, type **Desktop app** (Gmail API enabled) |
| `GMAIL_OAUTH_REFRESH_TOKEN` | One-time mint: `npm run gmail:mint` (scope `https://mail.google.com/`) |
| `GMAIL_APP_PASSWORD` | **Legacy fallback only** — superseded by OAuth on 2026-07-27 after Google refused App-Password IMAP auth |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (same value) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key |
| `DBOS_DATABASE_URL` | Session-mode pooler URL (port 5432) + Supabase DB password |
| `SYNC_KICK_SECRET` | `openssl rand -hex 32` — must match Vercel |

See `.env.example` in this folder for the full annotated list.
