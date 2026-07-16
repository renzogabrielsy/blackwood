-- Phase 4 · Step 1 — Enable RLS on the 7 bare public tables.
--
-- Context: the app's server actions read + write the production/electricity/truck
-- tables as the `authenticated` role (anon key + user JWT). Table-level GRANTs for
-- SELECT/INSERT/UPDATE/DELETE to `authenticated` already exist; RLS was simply never
-- enabled, so the advisor flags them as `rls_disabled_in_public` (ERROR).
--
-- Policy shape mirrors rc_out exactly: four permissive TO authenticated policies,
-- all always-true. This is the intended single-org model (authenticated = org member).
-- The Python sync writes with the service-role key, which bypasses RLS entirely, so
-- ingestion is unaffected.
--
-- `ingestion_watermarks` is the exception: the app never touches it (only the
-- service-role sync writes it). RLS is enabled with NO authenticated policy — correct
-- least-privilege. Its stray anon/authenticated table GRANTs are revoked in Step 4.

-- ── production_shifts ──────────────────────────────────────────────────────────
ALTER TABLE public.production_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated SELECT production_shifts" ON public.production_shifts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT production_shifts" ON public.production_shifts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE production_shifts" ON public.production_shifts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE production_shifts" ON public.production_shifts FOR DELETE TO authenticated USING (true);

-- ── production_runs ────────────────────────────────────────────────────────────
ALTER TABLE public.production_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated SELECT production_runs" ON public.production_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT production_runs" ON public.production_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE production_runs" ON public.production_runs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE production_runs" ON public.production_runs FOR DELETE TO authenticated USING (true);

-- ── production_downtime ────────────────────────────────────────────────────────
ALTER TABLE public.production_downtime ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated SELECT production_downtime" ON public.production_downtime FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT production_downtime" ON public.production_downtime FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE production_downtime" ON public.production_downtime FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE production_downtime" ON public.production_downtime FOR DELETE TO authenticated USING (true);

-- ── production_waste ───────────────────────────────────────────────────────────
ALTER TABLE public.production_waste ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated SELECT production_waste" ON public.production_waste FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT production_waste" ON public.production_waste FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE production_waste" ON public.production_waste FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE production_waste" ON public.production_waste FOR DELETE TO authenticated USING (true);

-- ── electricity_readings ───────────────────────────────────────────────────────
ALTER TABLE public.electricity_readings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated SELECT electricity_readings" ON public.electricity_readings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT electricity_readings" ON public.electricity_readings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE electricity_readings" ON public.electricity_readings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE electricity_readings" ON public.electricity_readings FOR DELETE TO authenticated USING (true);

-- ── truck_readings ─────────────────────────────────────────────────────────────
ALTER TABLE public.truck_readings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated SELECT truck_readings" ON public.truck_readings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT truck_readings" ON public.truck_readings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE truck_readings" ON public.truck_readings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE truck_readings" ON public.truck_readings FOR DELETE TO authenticated USING (true);

-- ── ingestion_watermarks ───────────────────────────────────────────────────────
-- RLS enabled, NO authenticated policy: the app never queries this table; only the
-- service-role sync writes it (service-role bypasses RLS). Deny-by-default for
-- anon/authenticated is exactly the intended posture.
ALTER TABLE public.ingestion_watermarks ENABLE ROW LEVEL SECURITY;
