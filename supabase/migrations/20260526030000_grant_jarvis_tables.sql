-- ============================================================
-- Grant table privileges on Jarvis tables to Supabase roles.
-- Without these, authenticated users hit "permission denied for table"
-- before RLS even gets a chance to evaluate. RLS policies (defined in
-- 20260526020000_create_jarvis_tables.sql) handle row-level filtering.
-- Matches the grant pattern of pre-existing tables like `deliveries`.
-- ============================================================

GRANT ALL ON TABLE public.jarvis_conversations TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.jarvis_messages      TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.jarvis_learnings     TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.pending_review       TO anon, authenticated, service_role;
