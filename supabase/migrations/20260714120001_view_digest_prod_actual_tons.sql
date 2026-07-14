-- view_digest_prod_actual_tons — actual production output (tons) per day.
-- Feeds the Home Digest's week-plan band (plan-vs-actual): getDigestData()
-- joins the production_schedule plan against this view's actual tons.
-- Aggregation stays in SQL (HARD RULE), never a TypeScript reduction.
--
-- NOTE: this view was originally applied directly to the remote via the
-- Supabase MCP alongside the production_schedule work; this migration captures
-- it in version control so a rebuild-from-migrations reproduces it. Idempotent.
CREATE OR REPLACE VIEW public.view_digest_prod_actual_tons
WITH (security_invoker = true) AS
  SELECT s.transaction_date AS date,
         sum(r.ttl_kg) / 1000.0 AS actual_tons
    FROM production_shifts s
    JOIN production_runs r ON r.shift_id = s.id
   GROUP BY s.transaction_date;

-- Reporting view: authenticated reads; anon has no data access (RLS posture).
GRANT SELECT ON public.view_digest_prod_actual_tons TO authenticated;
REVOKE ALL ON public.view_digest_prod_actual_tons FROM anon;
