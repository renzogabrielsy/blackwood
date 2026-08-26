# Sync Worker — Ops Runbook (M5)

Plain-language playbook for the Blackwood sync worker (`workers/sync`). This is the
durable TypeScript/DBOS engine that replaced the Mac-tied Python sync. When something
looks stuck or broken, start here. No prior context needed.

## The 30-second mental model

- Clicking **Run Sync** in the app does ONE thing: it writes a row into the
  `sync_runs` table (status `queued`) and pokes the worker over HTTP (`POST /kick`).
- The **worker** (a small always-reachable cloud process) does everything else:
  pulls the emails + the Google Sheet, compares them to the database, and — on a real
  (non-dry) run — writes the new/changed rows. It reports progress by inserting rows
  into `sync_run_events`, which the app watches live.
- **DBOS** is the durability layer. Every step of a run is checkpointed into a Postgres
  database. If the worker crashes or is restarted mid-run, it **resumes from the last
  finished step** when it comes back up — no data is lost, nothing is re-kicked.
- The only thing that truly stops a run is **the database being unreachable**. Refresh,
  tab close, laptop off, Wi-Fi drop — all irrelevant.

The six reports run in this fixed order every time: **gsheet first (alone)** → then
**deliveries, rc_out, production, flecon in parallel** → then **rc_movement_audit last**
(read-only). A report that fails does not stop the others; the run just finishes as
`partial`.

---

## Where to look

| Thing | Where |
|---|---|
| Run ledger (one row per click) | `sync_runs` table (Supabase) |
| Live progress feed | `sync_run_events` table (Supabase) |
| Durable checkpoints | the `dbos` schema in the DBOS system database |
| Worker health | `GET https://<worker-host>/health` → `{ok:true}` |
| Worker logs | `flyctl logs` (prod) or the terminal (local) |

---

## Symptom → what to do

### Stopping a run mid-flight (the Stop button)

While a run is in flight the app shows a **Stop** button. Clicking it:

1. Flips `sync_runs.status` to **`cancelled`** immediately (so the modal settles to
   "Stopped" even if the worker is unreachable), then
2. Best-effort pokes the worker's **`POST /cancel`**, which cancels the DBOS parent
   workflow `run:<runId>` and all its children. The workflow stops at its next step
   boundary and settles `cancelled`.

**A stop KEEPS every row already written — nothing is rolled back** (idempotent /
never-delete philosophy). `cancelled` is a NEUTRAL terminal, not a failure. To stop a
run from the CLI (e.g. the app is down):

```bash
curl -X POST https://<worker-host>/cancel \
  -H "Authorization: Bearer $SYNC_KICK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"runId":"<the-run-id>"}'
```

`/cancel` is idempotent and safe even if no workflow exists for that runId (returns
`200`). If the worker is asleep and you only need the UI unstuck, updating the row is
enough: `update sync_runs set status='cancelled', finished_at=now() where id='<id>'`.

### A run is stuck on `queued` (never goes `running`)

`queued` means the app wrote the row but the worker never picked it up. Almost always:
**the worker is asleep or dead, so the kick was lost.**

**The worker now self-heals this on its own.** On every boot it runs **startup
recovery**: it re-starts every `queued` run from the last 24h using the deterministic
workflowID (`run:<id>`), which DBOS dedups. So simply **waking the worker fixes a stuck
`queued` run** — no manual re-kick needed. And a **stale-run watchdog** sweeps every
3 min and auto-expires (→ `failed`) any queued/running run that has shown no progress
for >15 min and isn't a live DBOS workflow, so a truly-orphaned run never hangs forever.

1. **Check the worker is up:** `curl https://<worker-host>/health`. If it doesn't answer,
   the machine is down/asleep.
2. **Wake it.** On Fly with scale-to-zero, any inbound request wakes the machine — a
   `/health` curl is enough. On boot, **startup recovery** picks up the queued run
   automatically. If for some reason it doesn't, **re-kick** it:

   ```bash
   curl -X POST https://<worker-host>/kick \
     -H "Authorization: Bearer $SYNC_KICK_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"runId":"<the-queued-run-id>"}'
   ```

   Re-kicking is **safe and idempotent**: the workflow ID is `run:<runId>`, so a second
   kick for the same run is a no-op if it already started.
3. **If the worker is up but the run stays queued:** check the worker logs for a launch
   error (bad `DBOS_DATABASE_URL`, missing secret). Fix the env and restart.

### A run finished as `partial`

`partial` is **not** a failure of the run — it means the orchestration completed but
**at least one report needs a look**. Open the run's `result.reports` (or the app modal):
each report has an `ok` flag and, if it stumbled, an `error` string or `gate_failures`.

Common, EXPECTED `partial` causes (not bugs):
- **rc_movement_audit** reports `ok:false` on **serious drift** (a day where the feeding
  total on the movement sheet disagrees with `rc_out` by >500 kg). It never writes — it's
  a watchdog. Investigate the day it flagged.
- **gsheet** carries **flagged conflicts** (e.g. a NEW row that collides with a different
  batch on the same date/slot/weight). These are held for a human, never auto-written.
- **flecon** reports the `stale_workbook` gate when the FLECON BAGGED attachment is an
  OLDER copy of the cumulative workbook than what the app already holds. It writes nothing
  (applying it would blank out the days the older copy is missing). Since 2026-08-26 that
  email is **marked processed on the run that refuses it**, so you see this once and the
  next run stops re-reading the same dead attachment — before that fix one stale email of
  2026-08-24 turned every run `partial` indefinitely. Nothing to do unless it recurs with a
  *new* email, which means Ivy is sending an out-of-date file.
- **flecon** reports `settlement_ledger_unreadable` when `flecon_bag_date_settlements`
  could not be read. flecon rewrites a whole day at a time, and that table is the list of
  days it must leave alone, so it refuses to run rather than risk erasing a hand-corrected
  day. This one IS a real problem — read the error (a permissions or connectivity failure)
  and fix it; the report resumes by itself once the table is readable.

A `partial` from these is the system working as designed. A `partial` with an `error`
string on a report is a real problem — read the error (it's copyable in the modal).

### A run finished as `failed`

`failed` means the **orchestration itself** broke (not just one report) — e.g. the Mail
Clerk couldn't reach Gmail, or the database went unreachable mid-run. The `error` column
on `sync_runs` has the text.

1. Read `sync_runs.error`.
2. If it's a transient outage (Gmail EOF, Supabase blip): **just run it again.** Re-running
   is safe (see idempotency below).
3. If it's a config problem (auth, missing secret): fix it, then re-run.

**Auto-expired `failed`:** if `sync_runs.error` reads *"Auto-expired: no progress for
>15 min…"*, the stale-run watchdog terminalized an orphaned run (the worker had
restarted or the run was never really running). This is the watchdog doing its job —
nothing was written by the expiry. Just run a fresh sync.

### A run finished as `cancelled`

Someone hit **Stop** (or the CLI `/cancel`). This is NOT an error — it's a deliberate,
neutral terminal. **Every row written before the stop was kept** (no rollback). Nothing
to do; run a fresh sync when ready.

### Gmail auth expired / "authentication failed" / "Command failed"

Since **2026-07-27** the worker authenticates with **OAuth2 (XOAUTH2)** over IMAP.
App Password is a legacy fallback only — Google refused it outright on 2026-07-27
(`imapflow: Error: Command failed` at connect) and blocked every sync, which is why
this reversed the earlier "App Password only, never OAuth" rule.

Env the worker reads (see `src/lib/gmail.ts`): `GMAIL_USER` **plus either** the OAuth
trio `GMAIL_OAUTH_CLIENT_ID` + `GMAIL_OAUTH_CLIENT_SECRET` + `GMAIL_OAUTH_REFRESH_TOKEN`
(preferred), **or** the legacy `GMAIL_APP_PASSWORD`.

If Gmail rejects the login:

1. **Diagnose locally first** — from `workers/sync`, `npm run gmail:check`. It prints
   which auth mode resolved and the mailbox, connects read-only, and runs one search.
2. **If the refresh token was revoked** (`invalid_grant` in the error) — re-mint it:
   ```bash
   npm run gmail:mint          # opens Google consent, prints a new refresh token
   flyctl secrets set -a blackwood-sync GMAIL_OAUTH_REFRESH_TOKEN=<new token>
   ```
   A refresh token dies on: password change, revoking the app at
   https://myaccount.google.com/permissions, or ~6 months of disuse while the OAuth
   consent screen is still in **Testing** (publish the app to avoid the 7-day/testing
   expiry surprises).
3. **If the whole OAuth client changed** — set all three secrets together.
4. **Scope check:** the client MUST have `https://mail.google.com/`. A narrower scope
   connects but then fails at `markProcessed` (IMAP STORE / `+X-GM-LABELS`).
5. Re-run the sync. (Each `flyctl secrets set` restarts the worker; DBOS recovers any
   in-flight run on restart.)

The account itself is in `GMAIL_USER`. If the whole mailbox changed, re-mint against
the new account and set `GMAIL_USER` too.

### Supabase went down mid-run

This is the one accepted failure line — but DBOS makes it survivable:

- If Supabase (the **DBOS system database**) is unreachable, the worker cannot checkpoint,
  so the current step stalls or the process errors.
- **When Supabase comes back and the worker restarts, DBOS recovers the run** from its last
  completed step. A completed Gmail fetch is NOT re-done; a report that was mid-flight
  re-runs from the start of its step (which is safe — see idempotency).
- You don't have to do anything except make sure the worker is running again. If it
  scaled to zero during the outage, wake it (`/health` curl); recovery is automatic on
  launch.

**DBOS resume semantics, precisely:** DBOS resumes from the last *completed* step. A step
that was killed mid-execution re-runs on resume; a fully-completed step never re-runs.
This is why the Mail Clerk fetch (one step) is not repeated once done, and why a report
that was halfway through re-classifies cleanly.

---

## Re-running safely (idempotency)

You can re-run a sync as many times as you like without creating duplicates. The safety
lives in the report logic, not in luck:

- **deliveries / rc_out / production** use `insertIfAbsent` — before each insert they
  re-check the natural key and skip a row that already exists (L-020). Identical
  truckloads are allowed by design; accidental double-writes are not.
- **flecon** is **REPLACE-BY-DATE** — for each in-scope day it deletes that day's rows and
  re-inserts the sheet's current movements. Re-running just re-replaces to the same state.
- **gsheet** classifies against a fresh DB snapshot each run — a row already written is
  seen as a NOOP.
- **rc_movement_audit** never writes at all.
- The whole run is keyed by `run:<runId>` in DBOS, so re-kicking the SAME run is a no-op.
  A NEW **Run Sync** click makes a NEW run row — that's a fresh, safe pass.

**Dry run** (`{"runId":"…","dryRun":true}` on the kick) is the zero-risk way to preview:
it classifies against live data and streams events + a full result, but a write-blocking
layer no-ops every insert/update/delete/audit/watermark. Nothing is written. Use it to
confirm the worker is healthy end to end without touching data.

---

## Reading `sync_run_events` for debugging

Every run streams a plain-language progress feed. To read it directly:

```sql
select report_type, stage, pct, label, detail, level, at
from public.sync_run_events
where run_id = '<runId>'
order by at;
```

- `report_type` groups the events per card (`_run` is the overall track).
- `stage` is one of fetch | extract | classify | apply | reconcile | finalize.
- `level = 'warn'` marks a retry, a tripped gate, or a finish-with-problems — scan for
  these first when a run looks off.
- `label` is the human sentence shown in the modal; `detail` is the extra specifics.

The `sync_runs.result` jsonb holds the final per-report envelopes (counts, gate failures,
apply summary, any error) — the authoritative record of what the run decided.

---

## Secret rotation

All secrets live as Fly secrets (never in the repo). Rotate by setting the new value —
each `flyctl secrets set` restarts the worker, and DBOS recovers any in-flight run:

```bash
flyctl secrets set GMAIL_OAUTH_REFRESH_TOKEN=…     # re-minted via `npm run gmail:mint` (see above)
flyctl secrets set GMAIL_OAUTH_CLIENT_SECRET=…     # only if the OAuth client itself was rotated
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=…     # if the service role key is rotated
flyctl secrets set SYNC_KICK_SECRET=…              # MUST also update the app's SYNC_KICK_SECRET
flyctl secrets set DBOS_DATABASE_URL=…             # DB password change → new connection string
```

**`SYNC_KICK_SECRET` must match on both sides** — the worker and the Next.js app. Rotate
them together, or the app's kicks start returning 401 (runs then stay `queued` until the
worker's recovery picks them up, which is slower but not lost).

---

## Deploying the worker (Fly.io — Renzo owns this step)

The worker is a standalone package (`workers/sync`), NOT part of the Next.js build. It
ships to Fly.io with scale-to-zero (wakes on the kick, sleeps when idle).

First-time launch:

```bash
cd workers/sync
flyctl launch --no-deploy          # creates/edits fly.toml (set app name + region); does NOT deploy yet
```

Set the secrets (one time, and on any rotation):

```bash
flyctl secrets set \
  GMAIL_USER=you@gmail.com \
  GMAIL_OAUTH_CLIENT_ID=<oauth-desktop-client-id> \
  GMAIL_OAUTH_CLIENT_SECRET=<oauth-client-secret> \
  GMAIL_OAUTH_REFRESH_TOKEN=<from `npm run gmail:mint`> \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<service_role_jwt> \
  DBOS_DATABASE_URL=<direct-postgres-url> \
  SYNC_KICK_SECRET=<openssl rand -hex 32>
```

- **`DBOS_DATABASE_URL` must be a DIRECT Postgres connection** — the Supabase **session-mode**
  pooler (port 5432) or the direct DB host, with the database password. **NOT** the
  transaction-mode pooler (it breaks the session state DBOS needs). See `.env.example`.
- Generate `SYNC_KICK_SECRET` with `openssl rand -hex 32` and set the SAME value as the
  app's `SYNC_KICK_SECRET`. The app also needs **`SYNC_WORKER_URL`** pointing at the
  deployed worker (`https://<app-name>.fly.dev`).

Deploy:

```bash
cd workers/sync && npm run deploy     # NOT a bare `flyctl deploy` — see below
```

**MERGING TO `main` DOES NOT DEPLOY THIS WORKER.** Vercel deploys the Next.js app from
`main` and never touches Fly. Worker code ships only on an explicit deploy, so landing a
fix and shipping it are two separate steps. On 2026-08-08 the Fly machine was found five
days and several fixes stale for exactly this reason.

**Pre-deploy gate (required):**

```bash
cd workers/sync && npm run verify:container-build
```

The container's file set is not your disk's. `src/reports/excel/findingsBridge.ts`
intentionally imports the app's finding flattener across the package boundary
(`../../../../../lib/sync/findings` — ONE definition shared with the Sync panel), and
`tsc`, `npm test`, `npm run parity`, `npm run lint` and even `npm run build` all resolve
that off the dev machine where it plainly exists. On 2026-08-08 `flyctl deploy` was the
first thing in the pipeline to resolve it against the *image*, and failed:
`ERROR: Could not resolve "../../../../../lib/sync/findings"`. This gate parses the
Dockerfile's builder-stage `COPY`s plus the repo-root `.dockerignore`, rebuilds that exact
file set in a temp dir and runs the worker's own esbuild over it (~2 s, no Docker daemon
needed). It is wired as npm `predeploy`, so `npm run deploy` refuses to ship on red.

`npm run deploy` also handles the two things a bare `flyctl deploy` gets wrong: the build
context must be the **repo root** (so the shared files exist in the image) and the commit
sha must be passed as `--build-arg BUILD_SHA=…` (`.git` is not in the context, so the
startup banner would otherwise read `build unknown`). Full reasoning: `DEPLOY.md` →
"The build context is the REPO ROOT".

Verify it's alive:

```bash
curl https://<app-name>.fly.dev/health     # → {"ok":true,...}
```

A lost kick is never fatal: `fly.toml` is set for `auto_start_machines` (wakes on the kick
request) and `min_machines_running=0`. If a kick arrives while the machine is asleep, Fly
wakes it; if a kick is truly dropped, DBOS recovery picks up the queued run when the worker
next starts.

---

## The Python is still the fallback

The original Python sync engine (`.claude/skills/sync-ictc/scripts/**`) and the Claude Code
sync employees remain in the repo as the **manual fallback path** and the parity **oracle**.
If the worker is down and a sync must happen NOW, run the employees the old way (the `sync
ICTC` flow). They write to the same tables with the same guards. The Python is not deleted
until the TS worker has earned trust over several clean weeks (plan M6).

To confirm the worker still matches the Python before trusting a change, run the parity
gate: `cd workers/sync && npm run parity` — it must stay green (12/12).
```
