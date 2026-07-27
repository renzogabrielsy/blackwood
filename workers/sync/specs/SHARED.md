# SHARED.md — cross-cutting contracts every TS porter must read first

Covers: `fetch_gmail.py`, `lib/db.py`, `lib/orchestrator_common.py`, the CLI/progress contract,
and a consolidated normalization table with computed examples. Every report spec references
this file instead of re-deriving these rules.

---

## 1. `fetch_gmail.py` — Gmail IMAP contract

File: `.claude/skills/sync-ictc/scripts/fetch_gmail.py` (573 lines).

### 1.1 Auth

> **PORTED BEHAVIOR DIVERGES (2026-07-27).** This section describes the *Python oracle's*
> App-Password login. The TS worker (`src/lib/gmail.ts`) no longer matches it: Google
> refused App-Password IMAP auth on 2026-07-27 and blocked every sync, so the worker
> now authenticates with **OAuth2/XOAUTH2** (`GMAIL_USER` + `GMAIL_OAUTH_CLIENT_ID` +
> `GMAIL_OAUTH_CLIENT_SECRET` + `GMAIL_OAUTH_REFRESH_TOKEN`, scope
> `https://mail.google.com/`), keeping `GMAIL_APP_PASSWORD` only as a fallback. This
> reverses the "App Password ONLY — never OAuth" rule. Everything else in this section
> (X-GM-RAW search, X-GM-LABELS, folder, query strings) is unchanged parity.

- Credentials: `~/.config/sync-ictc/credentials.env` (default; overridable via `--credentials-path`), keys `GMAIL_USER` + `GMAIL_APP_PASSWORD` (fetch_gmail.py:55, 65-125).
- **Hard permission check** (fetch_gmail.py:83-97): file mode must not have group/other bits (`mode & 0o077`), else exit 1 with an error JSON on stderr telling the user to `chmod 600`.
- IMAP: `imaplib.IMAP4_SSL("imap.gmail.com", 993)`, plain login (fetch_gmail.py:53-54, 131-152). IMAP4 login failure → stderr JSON `{error, hint}`, exit 1.

### 1.2 Query building (Gmail-syntax via X-GM-RAW)

- `gm_raw_search(imap, gmail_query)` (fetch_gmail.py:197-211): escapes `\` and `"` in the query, then issues `imap.uid("SEARCH", "X-GM-RAW", f'"{escaped}"')`. Returns UIDs (bytes) or `[]`.
- Default folder searched: `"[Gmail]/All Mail"` (fetch_gmail.py:496-499) — searches across all labels via X-GM-RAW without needing to know the exact folder.
- **Exact query strings used by each orchestrator** (verbatim, with `{since}` substituted `YYYY/MM/DD`):
  - deliveries (operator): `label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:{since} -label:"Blackwood-Processed"` (sync_deliveries.py:67)
  - deliveries (Czarina prices): `from:czarinaloumaximoictc@gmail.com newer_than:5d` (sync_deliveries.py:68) — NOT watermark-scoped, always last 5 days.
  - rc_out (PROPOSED): `label:"Work/ICTC Daily" subject:"PROPOSED DAILY REPORT" after:{since} -label:"Blackwood-Processed"` (sync_rc_out.py:59)
  - rc_out (RC MOVEMENT cross-check): `subject:"RC MOVEMENT" newer_than:7d -in:sent` (sync_rc_out.py:60) — NOT watermark-scoped.
  - rc_movement_audit (auditor): `subject:"RC MOVEMENT" newer_than:7d -in:sent` (audit_rc_movement.py:47) — same query as above, standalone.
  - production (MC): `from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:{since} -label:"Blackwood-Processed"` (sync_production.py:72)
  - production (Ivy waste): `from:edilloivymae306ictc@gmail.com subject:"WASTE PRODUCTION REPORT" after:{since} -label:"Blackwood-Processed"` (sync_production.py:73)
  - flecon (Ivy bags): `from:edilloivymae306ictc@gmail.com subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"` (sync_flecon.py:52)
  - gsheet: no Gmail query — pulled via `curl` from a Google Sheets export URL (see gsheet.md).

### 1.3 UID handling, ordering, size caps

- UIDs returned by search are sorted ascending as **byte-strings cast to int**: `sorted(uids, key=lambda b: int(b))` (fetch_gmail.py:380). If `--limit` (default 50) is exceeded, **keeps the tail** (newest): `uids_sorted[-limit:]` (fetch_gmail.py:381-382).
- Per-message size cap: `MAX_BYTES_PER_MESSAGE = 50 * 1024 * 1024` (fetch_gmail.py:59). Oversized messages are recorded as `{"uid":..., "skipped": true, "reason": "message size ... exceeds cap ..."}` and NOT fetched (fetch_gmail.py:386-395).
- `fetch_email_size` uses `FETCH (RFC822.SIZE)` regex-parsed (fetch_gmail.py:237-244); `fetch_email_body` uses `FETCH (RFC822)` (fetch_gmail.py:247-258).
- `orchestrator_common.latest_xlsx(fetch_result)` (orchestrator_common.py:332-343): iterates `reversed(fetch_result["emails"])` (i.e. newest UID first since the list is UID-ascending) and returns the **first** email that has an attachment ending in `.xlsx`/`.xls` (case-insensitive). This is how "latest report" is picked — deterministic, no model judgment.

### 1.4 Thread ID

- `fetch_thread_id(imap, uid)` (fetch_gmail.py:226-234): `FETCH (X-GM-THRID)`, regex `X-GM-THRID\s+(\d+)`. Every email record in the fetch result carries `thread_id`.

### 1.5 Attachment extraction

- `extract_attachments` (fetch_gmail.py:288-337): walks all non-multipart MIME parts; skips a part with no filename; keeps a part whose **decoded** filename matches any of the glob patterns (default `*.xlsx,*.xls`, case-insensitive via `fnmatch`).
- Saved filename = `{uid}_{safe_filename(original_name)}` (fetch_gmail.py:274-285, 318-321). `safe_filename` takes `os.path.basename`, replaces every char outside `[A-Za-z0-9 ._-]` with `_`, truncates to 200 chars preserving the extension.
- Each saved file is `chmod 0o600` (best-effort, fetch_gmail.py:322-325).

### 1.6 Label mutation (idempotency mechanism)

- `add_label_to_thread(imap, uid, label)` (fetch_gmail.py:261-268): `imap.uid("STORE", uid, "+X-GM-LABELS", f'"{escaped_label}"')`. Gmail labels are thread-scoped, so labeling one message's UID effectively labels the whole thread for search purposes.
- `PROCESSED_LABEL = "Blackwood-Processed"` (fetch_gmail.py:56). Search queries append `-label:"Blackwood-Processed"` to exclude already-ingested threads.
- `cmd_mark_processed` (fetch_gmail.py:442-463): takes `--uids` (comma-separated), applies the label to each, returns `{ok, label, results:[{uid, labeled}]}`.
- `orchestrator_common.mark_processed(uids)` (orchestrator_common.py:346-359) is the wrapper every sync_*.py calls; it drops falsy UIDs, and if none remain returns `False` without invoking the child process at all.

### 1.7 Retry/jitter (added 2026-07-03)

`orchestrator_common.py` lines 220-330 implement transient-fault handling for the **Gmail child process** (both fetch and mark-processed), NOT for arbitrary IMAP calls inside `fetch_gmail.py` itself — the retry loop is at the orchestrator level, wrapping the whole `python3 fetch_gmail.py ...` subprocess invocation.

- **Transient markers** (case-insensitive substring match on `rc={rc} {stderr} {stdout}`): `"socket error"`, `"eof"`, `"abort"`, `"timed out"`, `"timeout"`, `"connection reset"`, `"broken pipe"`, `"child produced no stdout"` (orchestrator_common.py:227-236, `_looks_transient`).
- A **clean rc=0 with output that fails JSON parse is NOT retried** — it's a bug, surfaced immediately (orchestrator_common.py:281-290).
- An **empty stdout is treated as transient regardless of markers** (orchestrator_common.py:294-295: `transient = (not out) or _looks_transient(combined)`).
- **Attempts**: 3 total (`attempts=3` default, orchestrator_common.py:264). Backoff schedule: `_GMAIL_BACKOFFS = (2.0, 6.0)` seconds (orchestrator_common.py:240), each attempt adds `random.uniform(0.0, 1.0)` jitter (orchestrator_common.py:304). Formula: `wait = _GMAIL_BACKOFFS[min(attempt-1, len-1)] + uniform(0,1)`.
- On a retry, emits a `##SYNC_PROGRESS` event with `stage="fetch"`, `level="warn"`, label `"Gmail dropped the connection — retrying (attempt {attempt+1} of {attempts})…"` (orchestrator_common.py:305-306).
- **Startup jitter**: once per process, before the FIRST Gmail fetch, sleeps `random.Random(os.getpid()).uniform(0.0, 2.5)` seconds (orchestrator_common.py:252-261, `_gmail_startup_jitter`) — deterministic per-PID, meant to de-sync 4 parallel orchestrators hammering Gmail simultaneously. **Porting trap**: this uses `os.getpid()` as a seed, which a TS port cannot reproduce identically — the intent (spread out concurrent starts) matters more than exact reproducibility; a TS port should use an equivalent per-process random delay, not try to match Python's `Random(pid)` stream.
- `_run_json_gmail` vs plain `run_json` (orchestrator_common.py:200-217): non-Gmail child scripts (extract_*/classify_*/reconcile_*) use the plain `run_json` with NO retry — only Gmail fetch/mark-processed go through the retry wrapper.

---

## 2. `lib/db.py` — PostgREST client contract

File: `.claude/skills/sync-ictc/scripts/lib/db.py` (345 lines). A thin `requests`-based PostgREST client using the Supabase **service-role key** (bypasses RLS). Reads `.env.local` by walking up from the script's own path until a `.env.local` is found (db.py:61-68); falls back to `~/blackwood`.

### 2.1 Connection

- Base URL = `f"{NEXT_PUBLIC_SUPABASE_URL.rstrip('/')}/rest/v1"` (db.py:98).
- Headers: `apikey`, `Authorization: Bearer <key>`, `Content-Type: application/json` (db.py:101-105).
- **Every request gets an injected default timeout `(connect=10, read=120)` seconds** unless the caller overrides it (db.py:106-115) — a monkeypatch on `session.request`. Prevents an unbounded hang on a large PostgREST GET.

### 2.2 Reads

- `read_rows(table, since_date=None, since_column="transaction_date", columns=None, extra_filters=None, page_size=1000)` (db.py:118-156): pages via the `Range`/`Range-Unit: items` header, `{offset}-{offset+page_size-1}`, looping until a batch returns fewer than `page_size` rows. Accepts 200 or 206.
  - `columns` → PostgREST `select=col1,col2`; omitted → `select=*`.
  - `since_date` → `{since_column}=gte.{since_date}`. Pass `since_column=None` to a caller that ALSO doesn't want the `since_date` filter applied (many callers pass `since_column=None` alongside `extra_filters={"order":..., "limit":...}` to fetch e.g. the single max-date row — see `data_watermark` below).
- `select_one(table, filters, columns="*")` (db.py:158-163): `GET` with `limit=1` + the filters dict merged into query params (each value already a PostgREST operator string like `"eq.FOO"` or `"is.null"`), returns the first row or `None`.

### 2.3 Writes

- `insert(table, rows, returning="representation")` (db.py:166-174): `POST` with `Prefer: return={returning}`. Empty `rows` → returns `[]` without a network call. Raises `RuntimeError` on any non-`200/201` status, embedding up to 1000 chars of the response body.
- `insert_if_absent(table, rows, *, natural_key, returning="representation")` (db.py:176-240) — **the idempotency mechanism (L-020)**:
  1. For each candidate row, build filters from `natural_key` column names: `None` → `{col: "is.null"}`, else `{col: f"eq.{val}"}`.
  2. `select_one(table, filters, columns="id")` — if a match exists, the row is **skipped** (added to `skipped`), never re-inserted.
  3. Rows with no match are batched into ONE `insert()` call.
  4. Returns `{"inserted": [...], "skipped": [...], "inserted_count": N, "skipped_count": M}`.
  - **This is a per-row synchronous re-check immediately before insert, not a DB constraint.** It is explicitly NOT a substitute for a UNIQUE index — legitimately identical rows (same date/batch/truck/weight/sacks) are allowed to exist twice in the DB; the guard only prevents this SPECIFIC sync run from writing the same logical row twice (e.g. after a retry).
- `update(table, filters, patch, returning="representation")` (db.py:242-250): `PATCH` with the filters as query params and `patch` as the JSON body. Raises on non-`200/204`.

### 2.4 Audit RPCs — the two signatures and when each is used

Two SECURITY DEFINER Postgres RPCs exist because the service-role PostgREST key has **no direct INSERT or UPDATE grant on `audit_logs`** (L-009, L-032). Both RPCs are owned by `postgres` and are `service_role`-only EXECUTE.

- **`stamp_ingestion_audit(p_table_name, p_record_id, p_operation, p_comment, p_snapshot)`** — called via `db.update_trigger_audit_provenance(table_name, record_id, comment, snapshot=None)` (db.py:253-283).
  - Used for tables whose INSERT fires a DB audit **trigger** (currently: `deliveries` only). The trigger already wrote an `audit_logs` row on INSERT (L-001: never INSERT a second one); this RPC **UPDATEs** that trigger-written row's comment/snapshot for provenance.
  - `p_operation` is hardcoded to `"INSERT"` in the Python wrapper (db.py:270) — this RPC always stamps an INSERT-type audit row, whether called after a delivery INSERT or a delivery UPDATE (in the UPDATE case it's re-stamping the row's provenance comment, not creating a new operation type).
  - Returns a row COUNT (int) from the RPC; `update_trigger_audit_provenance` returns `bool(count)` — `True` iff at least one row was updated. Callers (e.g. `sync_gsheet.py::_apply_from_compact`) use this return value to decide whether to FALL BACK to `insert_manual_audit` (i.e., if no trigger-written row was found to stamp, e.g. because the table has no audit trigger at all, write a fresh manual audit row instead).
  - Raises `RuntimeError` on any non-`200/201/204` status.

- **`write_ingestion_audit(p_table_name, p_record_id, p_operation, p_diff, p_snapshot, p_comment)`** — called via `db.insert_manual_audit(*, table_name, record_id, operation, comment, diff=None, snapshot=None)` (db.py:285-317).
  - Used for tables with **NO** audit trigger: `rc_out`, `production_shifts`/`production_runs`/`production_downtime`/`production_waste`, `electricity_readings`, `truck_readings`, `flecon_bag_movements`.
  - `p_operation` is caller-supplied — values used across the codebase: `"INSERT"`, `"UPDATE"`, `"REPLACE"` (flecon only — `audit_logs.operation` CHECK constraint was widened in migration `20260703043000` to allow `REPLACE` as a first-class whole-day-replace operation, per L-032).
  - Returns `{"id": new_id}` or `None` if the RPC responded with no body/id.

### 2.5 `insert_if_absent` natural keys used per table (cross-reference)

| Table | Natural key passed to `insert_if_absent` | Caller |
|---|---|---|
| `deliveries` | `(transaction_date, batch_code, truck_plate, weight_kg, sacks)` | sync_deliveries.py:343 |
| `rc_out` | `(transaction_date, batch_id, destination)` | sync_rc_out.py:265 |
| `production_shifts` | `(transaction_date, production_batch, shift)` | sync_production.py:296 |
| `production_runs` | `(shift_id, customer, grade)` | sync_production.py:341 |
| `production_downtime` | `(shift_id,)` | sync_production.py:367 (nkey tuple `("shift_id",)`) |
| `production_waste` | `(shift_id,)` | sync_production.py:367 |
| `electricity_readings` | `(reading_date, meter)` | sync_production.py:391 |
| `truck_readings` | `(reading_date, plate_no)` | sync_production.py:391 |

Note `sync_gsheet.py`'s legacy `_apply_from_compact` uses plain `db.insert()` (NOT `insert_if_absent`) for both `deliveries` and `rc_out` NEW rows (sync_gsheet.py:362, 386) — idempotency there is enforced upstream by the classifier's NEW/NOOP decision against a freshly-queried DB window, not by a second per-row re-check at write time. This is a **deliberate asymmetry** a TS porter must preserve: gsheet's apply path does NOT re-check-then-insert; it trusts the classify-time decision.

---

## 3. `lib/orchestrator_common.py` — shared orchestrator plumbing

File: `.claude/skills/sync-ictc/scripts/lib/orchestrator_common.py` (428 lines).

### 3.1 Envelope contracts (frozen — see SYNC_CLI_CONTRACT.md, not reproduced here verbatim, but the Python shapes are canonical)

- `classify_envelope(*, report_type, ok, gate_failures, counts, rows_preview, classified_path, source, watermark, codified_rules_applied, extra=None)` (orchestrator_common.py:365-396):
  - `counts` is always reshaped to exactly the 4 keys `{noop, insert, update, flagged}` via `.get(k, 0)` — any other keys in the caller's dict are silently dropped.
  - `rows_preview` is **hard-truncated to the first 20 items** (`rows_preview[:20]`).
  - `extra` (if given) is shallow-merged into the top-level envelope dict via `env.update(extra)` — so `extra` keys can clobber the standard keys if named the same (no caller currently does this deliberately, but a TS port must replicate "extra wins on collision").
- `apply_envelope(*, report_type, ok, inserts=0, updates=0, replaced_dates=0, held=None, labeled=False, watermark_updated=False, errors=None, extra=None)` (orchestrator_common.py:399-427): same `extra`-shallow-merge behavior. `held`/`errors` default to `[]` when `None`.

### 3.2 Progress events — `progress(stage, label, pct, detail=None, level="info")`

(orchestrator_common.py:74-108)

- Sentinel-prefixed single line on **stderr**: `"##SYNC_PROGRESS " + json.dumps({...}, separators=(",", ":"))`.
- `stage` is coerced to one of `{"fetch","extract","classify","apply","reconcile","finalize"}`; anything else silently becomes `"classify"` (line 102).
- `pct` is coerced via `int(round(pct))` (falls back to the last value on a `TypeError`/`ValueError`), then clamped `[0,100]`, then **forced monotonically non-decreasing** within the process via a module-level `_LAST_PCT` global (lines 92-100). A TS port needs an equivalent process-lifetime monotonic guard — passing a lower `pct` than a prior call must NOT actually decrease the emitted value.
- `level` is coerced to `"info"` unless exactly `"warn"`.
- `detail` is included in the JSON only if truthy (omitted key, not `null`, when absent).

### 3.3 Digestible-language rule (HARD, from SYNC_CLI_CONTRACT.md, restated for porters)

Every `label` string passed to `progress()` must read like a plant-manager status update — no file paths, no SQL, no tracebacks, no raw terminal echoes. Verified examples actually used in the codebase (grep every `oc.progress(` call across all `sync_*.py`/`audit_rc_movement.py` for the canonical vocabulary): `"Checking Gmail for new delivery reports…"`, `"Found the report: {subject}"`, `"Reading the delivery spreadsheet…"`, `"{noop} already recorded · {new} new · {changed} changed"`, `"Writing {n} of {total} — {batch} @ {loc}"`, `"Marking the email as processed…"`, `"Done — {n} new, {m} updated."`, `"Nothing new today — no {X} report waiting."`. Numbers must be derived from real counts, never hardcoded/faked.

### 3.4 `is_location_collision(exc)` (orchestrator_common.py:114-126)

`True` iff `"23505" in str(exc)` AND (`"idx_unique_active_batch_per_location" in str(exc)` OR `"location_ref" in str(exc)`). Used by `sync_deliveries.py` and `sync_gsheet.py` to catch a batch-INSERT failure caused by "1 block_loc = 1 active batch" and route the affected row to `held` (`reason: "location_occupied"`) instead of crashing the whole run (L-032).

### 3.5 Watermark functions

- `data_watermark(db, table, date_column="transaction_date")` (orchestrator_common.py:145-159): `db.read_rows(table, columns=[date_column], since_column=None, extra_filters={"order": f"{date_column}.desc", "limit": "1"})`. Returns the first row's date column, string-sliced to the first 10 chars (`str(val)[:10]`), or `None` if the table is empty. **This is the canonical "DATA watermark" = `MAX(date_column)` used everywhere** — NOT a stored value, recomputed live every run.
- `upsert_ingestion_watermark(db, report_type, *, last_email_id=None, last_email_received_at=None)` (orchestrator_common.py:162-194): upserts one row into `ingestion_watermarks` keyed on `report_type` via `on_conflict=report_type` + `Prefer: resolution=merge-duplicates,return=minimal`. Always sets `last_run_at = RUN_TS` (the module-level `datetime.now(timezone.utc).isoformat()` captured ONCE at process import time — every progress/audit/watermark call in one process shares the exact same timestamp string). **Best-effort**: any exception is caught, logged as a `[warn]`, and the function returns `False` — a watermark-write failure NEVER fails the overall apply.

### 3.6 `make_work_dir(report_type, work_dir)` (orchestrator_common.py:132-139)

If `work_dir` is not given, defaults to `/tmp/sync-{report_type}/{UTC timestamp "%Y%m%dT%H%M%SZ"}`. Always `mkdir(parents=True, exist_ok=True)`.

### 3.7 `run_json(cmd)` (orchestrator_common.py:200-217) — the non-Gmail child runner

Runs a subprocess, captures stdout/stderr, logs stderr verbatim to our own stderr, and parses stdout as JSON. If direct `json.loads` fails, falls back to scanning `reversed(out.splitlines())` for the last line starting with `{` (tolerates a child that prints a human-readable line before its JSON). Raises `RuntimeError` if stdout is empty. **No retry** — only the Gmail-specific wrapper retries.

---

## 4. Consolidated normalization table

Every `norm_*` helper across the codebase, its exact semantics, and **computed** example outputs (ran via `python3` against the live scripts on 2026-07-04).

| Function | File(s) | Semantics | Computed examples |
|---|---|---|---|
| `norm_str(s)` | classify_deliveries.py, classify_rc_out.py, classify_electricity.py, classify_trucks.py, classify_gsheet.py | `None`→`None`; else `str(s).strip()`, empty→`None`, else `.lower()` | `norm_str(" Foo BAR ")` → `'foo bar'`; `norm_str("")` → `None`; `norm_str(None)` → `None` |
| `norm_key_part(s)` | classify_production_runs/downtime/waste.py | Same as `norm_str` but `.upper()` instead of `.lower()` — used for natural-key components (production_batch, shift, customer, grade) | `norm_key_part(" cebu ")` → `'CEBU'`; `norm_key_part("3x50")` → `'3X50'`; `norm_key_part(None)` → `None` |
| `norm_block_loc(s)` | classify_deliveries.py, classify_gsheet.py | `None`→`None`; else `str(s).strip()`, empty→`None`, else `.upper()` (case-insensitive key, format-preserving) | `norm_block_loc(" a-1a ")` → `'A-1A'`; `norm_block_loc("d-20d")` → `'D-20D'` |
| `norm_num(v, places=3)` (deliveries/rc_out/gsheet default `places=3`) | classify_deliveries.py, classify_rc_out.py, classify_gsheet.py | `None`→`None`; else `round(float(v), places)`; `TypeError`/`ValueError`→`None` | `norm_num("1234.5")` → `1234.5`; `norm_num(1234.5006)` → `1234.501`; `norm_num("  12,345.6  ")` → `None` (comma+whitespace NOT stripped by this function — only the extractors strip commas before this is called); `norm_num(True)` → `1.0` (bool IS accepted here — **inconsistent** with the extractors' `coerce_float`, which explicitly rejects bool) |
| `norm_num(v, places=2)` (production/electricity/trucks default) | classify_production_*.py, classify_electricity.py, classify_trucks.py | Same function, default `places=2` | `norm_num(11.5, 2)` → `11.5`; `norm_num(11, 2)` → `11.0` |
| `norm_int(v)` | classify_deliveries.py, classify_gsheet.py | `None`→`None`; else `int(round(float(v)))` (gsheet) or `int(float(v))` (deliveries — **truncates, does NOT round**) — see porting trap below | classify_deliveries: `norm_int("123.0")` → `123`; `norm_int(45.9)` → `45` (truncated, not rounded); classify_gsheet: `norm_int(45.9)` → `46` (rounds) |
| `nums_equal(a, b)` | classify_production_runs/downtime/waste.py | Both `None` → `True`; exactly one `None` → `False`; else `abs(norm_num(a)-norm_num(b)) <= 0.01` (`NUM_TOLERANCE`) | `nums_equal(10.004, 10.0)` → `True`; `nums_equal(10.006, 10.0)` → `True` (0.006 ≤ 0.01... wait, rounds to 2dp first: `norm_num(10.006,2)=10.01`, `abs(10.01-10.0)=0.01<=0.01` → `True`); `nums_equal(None, None)` → `True`; `nums_equal(None, 0)` → `False` (asymmetric null-handling — a DB `0` is NOT treated as equal to email/sheet `None` here, unlike the `sacks` null↔0 special-case in gsheet's `is_material`) |
| `norm_supplier(s)` | enrich_prices.py | `None`→`None`; else `str(s).strip().lower()`, then regex-strip a leading single-letter-dot prefix `^[a-z]\.\s+` (e.g. `"M. Cruz"` → `"cruz"`) | not independently re-verified beyond source read; regex is `re.sub(r"^[a-z]\.\s+", "", s)` |
| `norm_truck(s)` / `_norm_truck` | enrich_prices.py; sync_deliveries.py (inline lambda, L-033) | Strip ALL whitespace/hyphen/underscore chars, `.upper()`; sync_deliveries' inline version keeps only `ch.isalnum()` characters (functionally near-identical, slightly stricter — drops any punctuation, not just `-_`) | `norm_truck("CCN 7397")` → `'CCN7397'` (enrich_prices); sync_deliveries `_norm_truck("MAN 3625")` → `'MAN3625'` |
| `norm_weight(v)` | enrich_prices.py | `None`→`None`; else `round(float(v), 0)` (whole-kg precision for matching); `TypeError`/`ValueError`→`None` | — |
| `norm_meter(v)` | classify_electricity.py | `None`→`None`; else `str(v).strip()`, empty→`None`, else `.upper()` | — |
| `norm_plate(v)` | classify_trucks.py | `None`→`None`; else collapse internal whitespace via `re.sub(r"\s+", " ", str(v).strip())`, empty→`None`, else `.upper()` | `norm_plate("AAV  6111")` == `norm_plate("AAV 6111")` == `'AAV 6111'` |
| `norm_particular(s)` | classify_flecon_bags.py | `None`→`""`; else `" ".join(str(s).upper().split())` (collapse ALL whitespace, uppercase) — deliberately does NOT canonicalize spelling variants (e.g. both `"RS 1 ZAMBOANGA"` and `"RS 1 ZAMBAONGA"` stay DISTINCT) | — |
| `normalize_sig(text)` | extract_flecon_bags.py | `None`→`""`; else `re.sub(r"[^a-z0-9]", "", text.lower())` — drops ALL non-alphanumerics | `normalize_sig("590 kls (Kuraray)")` → `'590klskuraray'` (from the module docstring, not independently re-run but trivial to verify) |
| `deep_lab_equal(a, b)` | classify_deliveries.py, classify_gsheet.py | For every key in `set(a)∪set(b)`: `norm_num(a.get(k), 2) == norm_num(b.get(k), 2)`; any mismatch → not equal | — |
| `_lab_diff_is_immaterial(sheet_lab, db_lab)` | classify_gsheet.py (gsheet-only; classify_deliveries has NO immateriality gate — every lab diff is material there) | Per-key: equal at `places=2` → skip; else null↔0 pad → skip; else one side missing and the PRESENT value rounds to 0 at `places=0` → skip; else equal at `places=0` → skip; else MATERIAL | **`_lab_diff_is_immaterial({"mc": 11.5}, {"mc": 11})` → `False`** — see Porting Trap #1 below; this CONTRADICTS the function's own docstring, which claims this exact pair is immaterial. `_lab_diff_is_immaterial({"ash": None}, {"ash": 0})` → `True` (null↔0 pad); `_lab_diff_is_immaterial({"ash": 5}, {})` → `False` (present value 5 doesn't round to 0) |
| `norm_col letter -> index` | extract_flecon_bags.py `_col_letter_to_index` | `'C'` → `3` (base-26, 1-indexed, `A=1`) | — |

### 4.1 Round-half-to-even (banker's rounding) — computed boundary examples

Python's built-in `round()` uses IEEE-754 round-half-to-even, NOT round-half-up. Every `norm_num`/`round(...)` call in this codebase inherits this behavior. A naive TS port using `Math.round` (round-half-up, and also mishandles negative numbers differently) will silently diverge on `.5`-boundary values. Computed on 2026-07-04:

| Expression | Python result |
|---|---|
| `round(0.005, 2)` | `0.01` |
| `round(0.015, 2)` | `0.01` (looks like round-DOWN, but is actually a float-representation artifact — 0.015 is not exactly representable; the *stored* double is slightly below 0.015) |
| `round(0.025, 2)` | `0.03` |
| `round(0.125, 2)` | `0.12` (exact half → rounds to even: 12 is even) |
| `round(2.675, 2)` | `2.67` (float representation artifact, not true banker's rounding — 2.675 is stored as slightly less than 2.675) |
| `round(1.005, 2)` | `1.0` (float representation artifact) |
| `round(22.225, 2)` | `22.23` |
| `round(0.375, 2)` | `0.38` |
| `round(11.5, 0)` | `12.0` (exact half → rounds to even: 12) |

**Porting implication**: because most of these ".5-boundary" inputs are not exactly representable in binary floating point, the "round half to even" rule rarely triggers on decimal literals as written — the ACTUAL behavior is dominated by which way the nearest representable double falls. A TS port MUST use the same IEEE-754 double representation (JS `number` already is IEEE-754 double, so this is achievable) and implement true round-half-to-even (not `Math.round`, which is round-half-up and also has a well-known bug for negative half values). The fixture shopping lists in each report spec include exact literal values to golden-test against these Python outputs — do not re-derive expected values from decimal intuition; run the Python and copy the literal output.

---

## 5. Porting traps (general, cross-cutting)

1. **`_lab_diff_is_immaterial`'s own docstring example is wrong.** classify_gsheet.py's docstring (lines 129-134) claims `sheet mc=11.5 vs db mc=11 rounds-equal at 0 dp`, but computed: `round(11.5, 0) == 12.0` and `round(11, 0) == 11.0` — NOT equal. This means the ACTUAL behavior for that exact pair is **MATERIAL** (returns `False`, triggers a Sheet-wins UPDATE), not immaterial as documented. A TS porter must implement the CODE's actual comparison (equal at 2dp, then null↔0 pad, then "present value rounds to 0dp" for a missing side, then equal at 0dp) and NOT "fix" it to match the docstring's aspirational claim — the fixture harness should include this exact pair and assert the CODE's real behavior (material/UPDATE), flagging the docstring as stale documentation, not a bug to silently correct. **Flag this for a human decision**: is the intended behavior the code's or the docstring's?
2. **`bool` handling is inconsistent between classifier `norm_num` and extractor `coerce_float`.** Every extractor's `coerce_float` explicitly rejects `bool` (`isinstance(value, bool): return None` — since `bool` is a subtype of `int` in Python and would otherwise silently coerce `True`→`1.0`). But classifier `norm_num` functions have NO such guard — `norm_num(True)` computed as `1.0`. In practice this never matters because classifiers only ever receive already-extracted numeric fields (never raw booleans), but a TS port implementing a SHARED norm_num for both extract and classify must preserve the asymmetry (or verify it's provably dead code).
3. **`norm_int` truncates in `classify_deliveries.py` but rounds in `classify_gsheet.py`.** `classify_deliveries.norm_int(45.9)` → `45` (Python `int()` truncates toward zero). `classify_gsheet.norm_int(45.9)` → `46` (uses `int(round(float(v)))`). These are DIFFERENT functions with the same name in different files — a TS port must NOT unify them into one shared helper without preserving this exact per-file divergence, or sacks-field diffing will silently change behavior for fractional sack counts (rare but real on some 2023/2024 backlog rows).
4. **Dict/JSON key ordering is never semantically relied upon** — every dict comparison in the classifiers is via `set()` union of keys or explicit named-field lookups, never via ordered iteration + zip. Python 3.7+ dict insertion order is preserved but nothing here depends on it; a TS port using a plain object (whose key order is engine-dependent for numeric-like keys) is safe. The one place iteration ORDER does matter: `_build_deduction_note`'s fragment de-dup (`lib/deductions.py:222-226`) preserves first-seen order via `seen: set()` + list comprehension — a TS port must use an order-preserving Map/Set, not re-sort.
5. **Regexes with `re.IGNORECASE` (`re.I`)** — every regex in `lib/deductions.py` that matches deduction fragments (`NET_KILOS_GROSS_RE`, `PCT_FRAG_RE` implicitly via case handling downstream, `ABS_KILOS_RE`) uses `re.IGNORECASE`. `lib/deductions.py:56, 70` explicitly; `PCT_FRAG_RE` (line 62-64) has NO `re.IGNORECASE` flag but doesn't need one (matches digits/%/parens, case-agnostic by construction) — TS port must use the `i` flag on the equivalent regexes but can skip it on patterns with no letter-class ambiguity.
6. **Date serials**: `openpyxl` with `data_only=True` returns Python `datetime.date`/`datetime.datetime` objects directly (Excel serial dates are already resolved by openpyxl) — none of these scripts manually decode an Excel epoch serial number. A TS port using a library that returns raw serials (e.g. some minimal xlsx parsers) MUST implement the Excel epoch conversion (1899-12-30 epoch, with the well-known Lotus 1-2-3 leap-year bug for 1900) itself; this codebase never needed to because openpyxl abstracts it away. **This is the single biggest hidden dependency a TS port inherits from openpyxl** — verify whatever xlsx library is chosen resolves dates the same way (correctly handling the 1900 leap-year bug) before trusting any date-cell parity test.
7. **String `.strip()` is used pervasively but Python's `.strip()` strips a specific whitespace set** (space, tab, newline, CR, FF, VT, and Unicode whitespace when the string is `str`, which it always is here) — equivalent to JS `.trim()` for ASCII cases; no known divergence found in this codebase's inputs, but non-breaking-space or other exotic Unicode whitespace in a real operator's file (typo'd copy-paste from a PDF) could diverge subtly. Not exercised in the codebase; flag as a residual risk, not a confirmed bug.
8. **`float` equality is never used directly for weight/quantity comparisons** — every comparison funnels through `norm_num(..., places=N)` first, so exact binary-float equality bugs (`0.1+0.2 != 0.3`) are avoided by the rounding step. The ONE exception: `classify_flecon_bags.py`'s day-multiset diff (`Counter` of `(particular, code, qty_delta)` tuples) uses `qty_delta` coerced via `int(round(float(m.get("qty_delta"))))` (classify_flecon_bags.py:79) — already an integer by the time it's a multiset key, so no float-equality risk there either.

---

## 6. Fixture shopping list (SHARED — used by every report's parity harness)

- A `.env.local`-shaped fixture with dummy `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` to test `load_env`/`DBClient.__init__` error paths (missing file, missing keys).
- A synthetic PostgREST mock server (or recorded HTTP fixtures) exercising: `read_rows` pagination boundary (exactly `page_size` rows on the last page — must still terminate, since `len(batch) < page_size` is the loop-exit condition, so an EXACT multiple requires one extra empty-page round-trip — a TS port must replicate this "one extra fetch" behavior, not optimize it away), `insert_if_absent` skip-vs-insert branching, both audit RPCs returning `200`/`204`/`403` (to test the L-009 "no fallback, no retry" contract, if a TS port keeps this behavior — flag as an open decision whether the TS port should even preserve the 403-tolerant behavior or fix the grant instead).
- A fake Gmail IMAP server (or `imaplib` mock) that: returns a normal successful search+fetch; returns a UID list that must be truncated by `--limit`; simulates a transient EOF on attempt 1 and succeeds on attempt 2 (to test the retry/backoff timing — assert on wait ordering, not wall-clock, given jitter); simulates a permanent (non-transient) error to confirm no retry occurs; returns a message exceeding `MAX_BYTES_PER_MESSAGE`.
- Exact literal decimal values from §4.1 (the round-half-to-even table) as a golden numeric-parity fixture — one test per row, asserting the TS port's rounding function produces the SAME output Python produced (not the "textbook" banker's-rounding answer).
- A `_lab_diff_is_immaterial` fixture pair `{"mc": 11.5}` vs `{"mc": 11}` — MUST assert `False` (material), contradicting the stale docstring (see Porting Trap #1). Also include `{"ash": None}` vs `{"ash": 0}` → `True`, and `{"ash": 5}` vs `{}` → `False`.
- A `norm_int` fixture with `45.9` run against BOTH `classify_deliveries.norm_int` (expect `45`) and `classify_gsheet.norm_int` (expect `46`) to lock in the divergence (Porting Trap #3).

## 7. Ambiguities needing a human decision (SHARED)

- **[FLAG]** Should the TS port preserve the `_lab_diff_is_immaterial` docstring-vs-code mismatch (Porting Trap #1) as-is, or is this the moment to fix the code to match the intended "immaterial at 0dp" behavior? This changes real classify-time behavior (NOOP vs Sheet-wins UPDATE) for any lab value landing near a `.5` rounding boundary.
- **[FLAG]** Should the TS port unify `norm_int`'s two divergent implementations (truncate vs round) into one, or preserve the historical per-file split (Porting Trap #3)? Preserving it means carrying forward what looks like an accidental inconsistency; unifying it changes `sacks`-field diff behavior for fractional inputs.
- **[FLAG]** The L-009/L-032 403-on-`audit_logs` workaround (two SECURITY DEFINER RPCs) is a permissions workaround for a PostgREST grant gap. Should a TS port replicate the RPC-calling pattern verbatim (safest, byte-parity), or is this an opportunity to grant the service role proper `audit_logs` privileges and simplify to direct INSERT/UPDATE? This is a schema/ops decision outside the Python's control, but the TS port's `db.ts` equivalent shape depends on the answer.
