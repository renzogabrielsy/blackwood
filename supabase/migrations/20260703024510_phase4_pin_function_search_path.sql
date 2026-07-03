-- Phase 4 · Step 3 — Pin search_path on the 12 flagged functions.
--
-- Resolves advisor `function_search_path_mutable` (WARN). We pin to `public` rather
-- than the docs' stricter `''` because two of these (handle_audit_log,
-- log_delivery_changes) reference unqualified public objects in their bodies
-- (audit_logs, jsonb_diff_val); `= public` keeps them resolving WITHOUT touching any
-- body, satisfying the "do not modify bodies" constraint. Bodies' auth.uid() calls are
-- already fully qualified, so they are unaffected. No SECURITY DEFINER/INVOKER change.

ALTER FUNCTION public.canonical_supplier(p_supplier text)        SET search_path = public;
ALTER FUNCTION public.fn_blend_proposal(p_block_locs text[])     SET search_path = public;
ALTER FUNCTION public.fn_process_blackwood_usage()               SET search_path = public;
ALTER FUNCTION public.fn_update_blackwood_state()                SET search_path = public;
ALTER FUNCTION public.handle_audit_log()                         SET search_path = public;
ALTER FUNCTION public.handle_invite_creation()                   SET search_path = public;
ALTER FUNCTION public.handle_new_user()                          SET search_path = public;
ALTER FUNCTION public.handle_updated_at()                        SET search_path = public;
ALTER FUNCTION public.log_delivery_changes()                     SET search_path = public;
ALTER FUNCTION public.rc_out_avg_price(rc_out_row rc_out)        SET search_path = public;
ALTER FUNCTION public.rc_out_avg_wtd_value(rc_out_row rc_out)    SET search_path = public;
ALTER FUNCTION public.set_audit_comment(comment text)            SET search_path = public;
