# Blackwood Sync Worker (`workers/sync`)

Durable, web-native TypeScript port of the ICTC sync engine, wrapped in **DBOS**
(durable execution — every workflow step checkpointed to Postgres, crash → resume).
This is a **standalone package**, NOT part of the Next.js build. It runs on a small
cloud host (Fly.io, scale-to-zero) and is woken by an HTTP kick from the app.

> Status: **M0 (Foundations) + M1 (Shared libraries + Mail Clerk) complete.**
> The per-report extract→classify→apply workflows are M3 (not built here).
> Migration plan: `../../SYNC_TS_MIGRATION_PLAN.md`.

## Architecture (this milestone)

```
[Run Sync click]  →  server action: INSERT sync_runs(queued) → POST worker /kick
[worker + DBOS]
  runSyncWorkflow                      (top-level durable workflow)
    └─ mailClerkWorkflow               (ONE Gmail IMAP session → all report files)
         → Supabase Storage: sync-inbox/<runId>/<report>/<file>
    └─ [M3] per-report child workflows: extract → classify → gates → apply
  progress → sync_run_events rows      (Supabase Realtime → the modal)
  result   → sync_runs.result
```

Only **Supabase down** stops a run. Refresh / tab close / laptop off are irrelevant —
the click just writes "sync requested"; the worker does the rest durably.

## Layout

| Path | What |
|---|---|
| `src/lib/norm.ts` | EXACT ports of Python `norm_num`/`norm_int`/`norm_str`/`norm_block_loc`/`coerce_date`/`coerce_float`. **Banker's rounding** (round-half-to-even) — no `Math.round` anywhere. |
| `src/lib/db.ts` | Supabase service client + typed wrappers (readRows/insert/insertIfAbsent/update, `write_ingestion_audit`/`stamp_ingestion_audit` RPCs, sync_runs lifecycle). Mirrors `lib/db.py`. |
| `src/lib/gmail.ts` | imapflow + mailparser: X-GM-RAW search, download, X-GM-LABELS label, latest-xlsx pick. Single-session reuse. |
| `src/lib/xlsx.ts` | exceljs helpers matching openpyxl `data_only` semantics (formula → cached result, date cells, merges, sheet iteration). |
| `src/lib/progress.ts` | `emitEvent` → `sync_run_events`; monotonic pct per (run,report); digestible-language rules carried verbatim; never throws. |
| `src/dbos.ts` | DBOS config + launch/shutdown. |
| `src/workflows/demo.ts` | The crash-resume proof workflow. |
| `src/workflows/mailClerk.ts` | The PINNED Mail Clerk (one session → Storage manifest). `runMailClerk` is the DBOS-free variant for tests. |
| `src/workflows/runSync.ts` | Top-level Run Sync workflow (M0/M1: Mail Clerk + status). |
| `src/server/kick.ts` | `POST /kick` (Bearer auth) + `GET /health`. |
| `src/index.ts` | Entrypoint: register workflows → launch DBOS → start kick server. |

## Setup

```bash
cd workers/sync
npm install
cp .env.example .env      # fill in the secrets (see below)
```

### Required env (see `.env.example`)

- `GMAIL_USER`, `GMAIL_APP_PASSWORD` — Gmail App Password (never OAuth).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — service role (bypasses RLS).
- `DBOS_DATABASE_URL` — **direct** Postgres for DBOS checkpoints. **Not** the
  transaction-mode pooler. Use the Supabase **session-mode** pooler (port 5432) or
  the direct DB host, with the **database password** (Supabase dashboard →
  Settings → Database — not in this repo).
- `SYNC_KICK_SECRET` — shared secret for `POST /kick` (`openssl rand -hex 32`).

## Run

```bash
npm run typecheck        # tsc --noEmit (strict)
npm run test             # vitest — norm parity + gmail/xlsx/progress helpers
npm run build            # esbuild → dist/index.js
npm start                # node dist/index.js  (launches DBOS + kick server)
npm run dev              # tsx watch src/index.ts
```

### Kick a run

```bash
curl -X POST http://localhost:8080/kick \
  -H "Authorization: Bearer $SYNC_KICK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"runId":"<uuid from sync_runs>"}'
```

`GET /health` → `{ ok: true }`.

## Tests & proofs

- **Norm parity (the #1 risk):** `npm run gen:fixtures` runs the ACTUAL Python
  `norm_*`/`coerce_*` and writes `test/fixtures/norm-parity.json`; `npm test`
  asserts the TS ports reproduce every value (incl. `.5` boundaries and binary-noise
  floats like `2.675 → 2.67`, `0.135 → 0.14`). 127 value cases.
- **xlsx fixture:** `npm run gen:fixtures` also has a sibling
  `scripts/gen-xlsx-fixture.ts` (synthesizes `test/fixtures/sample.xlsx`) exercised
  by `xlsx.test.ts` — proves `data_only` formula results, date cells, empty cells.
- **Crash-resume proof (M0 DoD):**
  ```bash
  DBOS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/dbos_sync \
    bash scripts/run-crash-proof.sh
  ```
  Starts the demo workflow, `kill -9`s the worker mid-step-2, restarts, and asserts
  DBOS resumed from the last completed step (step 1 not re-run). Verified against a
  local Postgres (see "DBOS system database" below).
- **Live Mail Clerk (M1 DoD, READ-ONLY):**
  ```bash
  SINCE=2026/06/28 npm run mailclerk:live
  ```
  Fetches the latest xlsx for all report queries over ONE Gmail session and prints
  the manifest. Never uploads / never labels (`dryRun`).

## DBOS system database (checkpoints)

DBOS needs a **direct** Postgres connection for its `dbos` schema. The Supabase
**transaction-mode pooler must NOT be used** (it breaks session state DBOS relies on).
Options, in order of preference:

1. Supabase **session-mode pooler**, port 5432 (with DB password).
2. Supabase **direct DB host** `db.<ref>.supabase.co:5432` (if enabled).
3. A dedicated small Postgres.

If no Supabase DB password is available, the crash-resume proof runs against a local
Postgres (that is what was used to verify this milestone). See `.env.example`.

## Deploy (Fly.io — Renzo owns the `flyctl` step)

```bash
flyctl launch --no-deploy          # or edit fly.toml's `app`/region
flyctl secrets set \
  GMAIL_USER=… GMAIL_APP_PASSWORD=… \
  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  DBOS_DATABASE_URL=… SYNC_KICK_SECRET=…
flyctl deploy
```

`fly.toml` is configured for **scale-to-zero** (`auto_stop_machines`, `min_machines_running=0`)
with **auto-start on the /kick request**. A lost kick is not fatal — DBOS recovery
picks up any incomplete run when the worker next wakes.
