-- Fix: view_digest_stream_freshness production row must reflect ACTUAL OUTPUT, not any shift.
--
-- Problem: the "production" stream reported through_date = max(production_shifts.transaction_date).
-- But production_shifts rows are ALSO created by the WASTE report (production_waste FKs to shift_id),
-- which stays current even when MC's Daily Production Report (production_runs / actual output) stalls.
-- Result: the digest falsely showed Production current through the latest waste date, masking a
-- multi-day output-ingestion stall (runs frozen at 2026-07-03 while waste ran through 2026-07-13).
--
-- Fix: the production branch now keys on the max shift date that has at least one production_runs row
-- (actual output). All other stream rows (deliveries, rc_out, electricity, trucks) are UNCHANGED.
-- Electricity/trucks are correctly keyed on their own tables and legitimately behind — left as-is.

CREATE OR REPLACE VIEW public.view_digest_stream_freshness
WITH (security_invoker = true) AS
 SELECT 'deliveries'::text AS stream,
    'RC In (deliveries)'::text AS label,
    max(deliveries.transaction_date) AS through_date
   FROM deliveries
UNION ALL
 SELECT 'rc_out'::text AS stream,
    'RC Out (usage)'::text AS label,
    max(rc_out.transaction_date) AS through_date
   FROM rc_out
UNION ALL
 SELECT 'production'::text AS stream,
    'Production'::text AS label,
    max(ps.transaction_date) AS through_date
   FROM production_shifts ps
  WHERE (EXISTS ( SELECT 1
           FROM production_runs pr
          WHERE pr.shift_id = ps.id))
UNION ALL
 SELECT 'electricity'::text AS stream,
    'Electricity'::text AS label,
    max(electricity_readings.reading_date) AS through_date
   FROM electricity_readings
UNION ALL
 SELECT 'trucks'::text AS stream,
    'Trucks'::text AS label,
    max(truck_readings.reading_date) AS through_date
   FROM truck_readings;

GRANT SELECT ON public.view_digest_stream_freshness TO authenticated;
