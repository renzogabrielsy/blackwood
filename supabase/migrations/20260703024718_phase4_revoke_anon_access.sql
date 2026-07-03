-- Phase 4 · Step 4 — Revoke anon access.
--
-- SAFE because: middleware walls every route except /login,/auth,/access-denied,/api;
-- there is no app/api directory; the auth callback reads profiles via the SERVICE-ROLE
-- admin client and only writes profiles AFTER exchangeCodeForSession (i.e. as
-- `authenticated`, never anon). No `.rpc()` or `.from()` runs as a logged-out anon.
-- Nothing is revoked from `authenticated` in this phase.

-- ── (a) Functions: REVOKE EXECUTE FROM anon on the 14 flagged SECURITY DEFINER funcs ──
-- All are trigger-fired, RLS-policy-internal (is_admin), or called via the service-role
-- admin client (set_audit_comment). None require a direct anon EXECUTE grant.
REVOKE EXECUTE ON FUNCTION public._insert_notification(uuid, notification_type, text, text, jsonb, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_audit_comment()    FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_delivery_created()  FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_delivery_deleted()  FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_delivery_edited()   FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_remarks_added()     FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_resolve_decision()  FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_notify_resolve_request()   FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_audit_log()            FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_invite_creation()      FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()             FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin(uuid)               FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_delivery_changes()        FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_audit_comment(comment text) FROM anon;

-- ── (b) Public base tables: REVOKE ALL FROM anon (removes SELECT + stray anon DML) ──
REVOKE ALL ON TABLE public.audit_comments               FROM anon;
REVOKE ALL ON TABLE public.batches                      FROM anon;
REVOKE ALL ON TABLE public.deliveries                   FROM anon;
REVOKE ALL ON TABLE public.flecon_bag_movements         FROM anon;
REVOKE ALL ON TABLE public.flecon_bag_opening_balances  FROM anon;
REVOKE ALL ON TABLE public.flecon_bag_types             FROM anon;
REVOKE ALL ON TABLE public.ingestion_watermarks         FROM anon;
REVOKE ALL ON TABLE public.jarvis_conversations         FROM anon;
REVOKE ALL ON TABLE public.jarvis_learnings             FROM anon;
REVOKE ALL ON TABLE public.jarvis_messages              FROM anon;
REVOKE ALL ON TABLE public.pending_review               FROM anon;
REVOKE ALL ON TABLE public.profiles                     FROM anon;
REVOKE ALL ON TABLE public.rc_out                       FROM anon;

-- ── (b) Public views: REVOKE SELECT FROM anon ──
REVOKE SELECT ON public.cenapro_production_events                  FROM anon;
REVOKE SELECT ON public.view_blocking_grid                         FROM anon;
REVOKE SELECT ON public.view_delivery_monthly_analytics            FROM anon;
REVOKE SELECT ON public.view_delivery_supplier_monthly_analytics   FROM anon;
REVOKE SELECT ON public.view_delivery_supplier_subgroup_yearly_analytics FROM anon;
REVOKE SELECT ON public.view_delivery_supplier_yearly_analytics    FROM anon;
REVOKE SELECT ON public.view_delivery_yearly_analytics             FROM anon;
REVOKE SELECT ON public.view_digest_grades                         FROM anon;
REVOKE SELECT ON public.view_flecon_bag_balance                    FROM anon;
REVOKE SELECT ON public.view_rc_movement                           FROM anon;
REVOKE SELECT ON public.view_rc_movement_batch_price               FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_cells            FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_day_price        FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_options          FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_price            FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_production       FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_production_daily FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_production_daily_total FROM anon;
REVOKE SELECT ON public.view_rc_movement_campaign_yield            FROM anon;
REVOKE SELECT ON public.view_rc_movement_day_price                 FROM anon;
REVOKE SELECT ON public.view_rc_movement_month_price               FROM anon;
REVOKE SELECT ON public.view_rc_movement_production_daily          FROM anon;
REVOKE SELECT ON public.view_rc_movement_production_daily_total    FROM anon;
REVOKE SELECT ON public.view_rc_movement_production_monthly        FROM anon;
REVOKE SELECT ON public.view_rc_movement_yield_monthly             FROM anon;
REVOKE SELECT ON public.view_rc_out_closed_blocks                  FROM anon;

-- ── (c) cenapro schema objects exposed to anon via GraphQL — revoke anon, KEEP authenticated ──
-- The app reaches cenapro ONLY through the public.cenapro_* look-through accessors,
-- which run as `authenticated`; the cenapro schema is never queried by anon.
REVOKE SELECT ON cenapro.drift_log                 FROM anon;
REVOKE SELECT ON cenapro.grade                     FROM anon;
REVOKE SELECT ON cenapro.partner_equipment         FROM anon;
REVOKE SELECT ON cenapro.plant                     FROM anon;
REVOKE SELECT ON cenapro.production_event          FROM anon;
REVOKE SELECT ON cenapro.shift                     FROM anon;
REVOKE SELECT ON cenapro.source_location           FROM anon;
REVOKE SELECT ON cenapro.view_production_daily      FROM anon;
REVOKE SELECT ON cenapro.warehouse                 FROM anon;
REVOKE SELECT ON cenapro.warehouse_opening_balance FROM anon;
