# Dev testing the Daily Sync modal WITHOUT the worker

Wave 4B retired the old `SYNC_MOCK=1` + SSE path. The modal now watches Supabase
Realtime (`sync_runs` + `sync_run_events`). To exercise the UI without running
`workers/sync`, insert a fake run with the service client:

```bash
# from repo root
npx tsx scripts/dev-fake-run.ts           # full run: inserts + a gate-fail + held rows (status=partial)
npx tsx scripts/dev-fake-run.ts --clean   # a clean "nothing new" run (status=succeeded)
```

Requires `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (the service role bypasses the
INSERT lock on both tables — authenticated users only have SELECT).

## What it does

1. INSERTs a `sync_runs` row (`status=running`).
2. Emits a realistic sequence of `sync_run_events` beats (`_run` overall track +
   per-report `deliveries`/`rc_out`/`production`/`flecon` progress, with an
   `rc_out` `warn` reconcile beat).
3. UPDATEs the run to a terminal status with a `result.reports` payload — the SAME
   per-report `ClassifyResult` / `ApplyResult` shape the worker (M3) writes. The
   logged-in browser's `useSyncRun` subscription animates the cards, aggregates the
   held rows, and narrates exactly as a real run would.

## To watch it

Open the dashboard (`/`) as an Owner/Admin/Dev, open the **Daily Sync** modal, then
run the script in a terminal. The modal attaches to the in-flight run automatically
(on mount it queries the latest non-terminal run) — you do NOT have to click "Run
Sync". This is the same path that makes a real run laptop-proof: a second viewer or
a page refresh re-attaches to the running job.

> Note: Realtime must be enabled for both tables (it is — the migration adds them to
> the `supabase_realtime` publication). If Realtime is blocked (e.g. WSS proxied
> away), the hook degrades to a ~3s poll of the two tables, so the cards still fill.
