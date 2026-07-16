-- sync-inbox Storage bucket — where the Mail Clerk uploads each run's report
-- attachments under <runId>/<report>/<filename> (SYNC_TS_MIGRATION_PLAN M0).
--
-- PRIVATE bucket. Only the service role (which bypasses storage RLS) reads/writes
-- it — the worker uploads, the per-report workflows download. No authenticated/anon
-- Storage policy is created, so browser clients cannot list or fetch these raw
-- source files. Idempotent insert.
insert into storage.buckets (id, name, public)
values ('sync-inbox', 'sync-inbox', false)
on conflict (id) do nothing;
