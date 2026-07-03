-- Phase 4 · Step 4a (correction) — Revoke EXECUTE from PUBLIC on the 14 flagged funcs.
--
-- The prior `REVOKE ... FROM anon` was a no-op: EXECUTE was granted to PUBLIC (ACL
-- `=X/postgres`), which anon (and authenticated) inherit. Revoking from a specific role
-- does not remove an inherited PUBLIC grant. Revoking from PUBLIC is what actually
-- drops anon (and clears BOTH the anon_ and authenticated_security_definer_function
-- advisor warnings).
--
-- SAFE: trigger functions are not privilege-checked when their trigger fires; is_admin
-- runs inside RLS policies as its owner (caller needs no EXECUTE); set_audit_comment is
-- only ever called via the SERVICE-ROLE admin client, so we re-grant it to service_role
-- explicitly (it too relied on the PUBLIC grant).

REVOKE EXECUTE ON FUNCTION public._insert_notification(uuid, notification_type, text, text, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_audit_comment()    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_delivery_created()  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_delivery_deleted()  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_delivery_edited()   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_remarks_added()     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_resolve_decision()  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_notify_resolve_request()   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_audit_log()            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_invite_creation()      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()             FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin(uuid)               FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_delivery_changes()        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_audit_comment(comment text) FROM PUBLIC;

-- set_audit_comment is invoked by the review-queue approval path via the service-role
-- admin client — keep that working.
GRANT EXECUTE ON FUNCTION public.set_audit_comment(comment text) TO service_role;
