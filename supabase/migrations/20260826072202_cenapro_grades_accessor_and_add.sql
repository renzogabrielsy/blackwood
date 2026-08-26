-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — GRADES BECOME ADDABLE.
--
-- WHY
-- `cenapro.grade` is one dimension shared by three things: `production_event`
-- (production rows AND partner draws AND bagging entries all FK to it),
-- `cenapro.analysis_sample`'s groups by way of those events, and the flec ledger's
-- per-grade running balance. It carries exactly four seeded rows — 3X50, 2X6, 3.5,
-- 4X8 — and until now there was **no way to add a fifth from the app**: the `cenapro`
-- schema is not exposed over PostgREST ("Only the following schemas are exposed:
-- public, graphql_public"), no `public` accessor existed, and every UI list is the
-- hardcoded `GRADE_CODES` constant in `app/(app)/cenapro/types.ts`. A new grade meant
-- a migration. Renzo asked for it from the Flec Inventory screen; the object it needs
-- is the dimension, not that screen.
--
-- WHAT THIS BUILDS — a read door and a write door, and NOTHING ELSE
--   • `public.cenapro_grades`   — read-only accessor, all five columns, ordered.
--   • `public.cenapro_add_grade(...)` — INSERT-ONLY. There is deliberately no update
--     RPC and no delete RPC.
--
-- WHY INSERT-ONLY, EXPLICITLY
-- `grade_code` is a text FK carried by 1,311 `production_event` rows. RENAMING a code
-- would either break every one of them or need an ON UPDATE CASCADE nobody has
-- reasoned about, and DELETING one is refused by the FK anyway — but only once a row
-- uses it, so a delete would silently succeed on a grade added by mistake five minutes
-- earlier and silently fail later, which is the worst of both. Adding is monotone and
-- safe; the other two are schema decisions that deserve their own migration when
-- somebody actually needs them. This mirrors `cenapro_set_rc_supplier_opening_balance`
-- (append, never amend) and the supplier dimension's "retire with active = false,
-- there is no delete RPC" rule.
--
-- THE DUPLICATE RULE IS CASE-INSENSITIVE, AND IT NAMES BOTH SPELLINGS
-- `cenapro.fn_canon_token` (trim → collapse whitespace → uppercase) is the ONE
-- normalization definition in this schema — the same function the add-draw RPC, the
-- sample table's CHECKs and `canonToken()` in `lib/cenapro/ccc-analysis.ts` use. A
-- typed `3x50` therefore CANNOT create a second grade beside `3X50`; it comes back
-- `already_exists` saying *"'3x50' already exists as '3X50'"*, because an operator who
-- typed the lowercase form needs to be told which row they actually have, not merely
-- that they failed. The code is STORED canonicalized, so the table can never hold two
-- spellings of one grade.
--
-- GRANTS — the `cenapro` DEFAULT-ACL trap does NOT reach into `public`, and the view is
-- read-only ON PURPOSE. `pg_default_acl` has an entry for schema `cenapro`
-- (`{anon=r, authenticated=arwd, service_role=arwd}`) and NONE for `public`, so a view
-- created here is born with no grants at all. But `authenticated` holds `arwd` on the
-- BASE table `cenapro.grade` (that default ACL again), and a single-table view over it
-- is auto-updatable — so granting anything beyond SELECT would hand the app a
-- write path that bypasses the RPC entirely. SELECT to `authenticated` and
-- `service_role`, nothing to `anon`, nothing else to anyone (L-044: the grant must
-- cover the reader that will actually read it, and this view's only dependency is the
-- base table, which both roles already hold).
--
-- POSTURE: SECURITY INVOKER on both objects, `SET search_path = ''` with every
-- reference schema-qualified, EXECUTE revoked from PUBLIC and granted to
-- `authenticated` + `service_role`. The RPC is SECURITY INVOKER and works because
-- `authenticated` genuinely holds INSERT on `cenapro.grade`; it adds the validation
-- and the canonicalization that a bare INSERT would not, and it is the only INSERT
-- path the app can reach, since PostgREST cannot see the base table.
--
-- NO DATA CHANGE. The four seeded grades are untouched.
-- ─────────────────────────────────────────────────────────────────────────────────

-- ── The read door ────────────────────────────────────────────────────────────────
create or replace view public.cenapro_grades
    with (security_invoker = true)
as
    select g.code,
           g.display_name,
           g.sort_order,
           g.expected_kg_per_bag_min,
           g.expected_kg_per_bag_max
      from cenapro.grade g
     order by g.sort_order, g.code;

comment on view public.cenapro_grades is
    'Read-only accessor over the cenapro.grade dimension (the cenapro schema is not exposed to '
    'PostgREST). One row per grade in sort order. SELECT only - the base table is auto-updatable and '
    'authenticated holds arwd on it, so INSERT/UPDATE/DELETE are deliberately NOT granted here; '
    'public.cenapro_add_grade is the only write path, and there is no update or delete counterpart.';

revoke all on public.cenapro_grades from public;
revoke all on public.cenapro_grades from anon;
grant select on public.cenapro_grades to authenticated, service_role;

-- ── The write door ───────────────────────────────────────────────────────────────
drop function if exists public.cenapro_add_grade(text, text, integer);

create function public.cenapro_add_grade(
    p_code         text,
    p_display_name text    default null,
    p_sort_order   integer default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
DECLARE
    v_code    text := cenapro.fn_canon_token(p_code);
    v_name    text := nullif(pg_catalog.btrim(COALESCE(p_display_name, '')), '');
    v_sort    integer;
    v_existing cenapro.grade%ROWTYPE;
BEGIN
    -- ── 1. A code is the whole identity, so it is checked hardest ───────────────
    IF v_code = '' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'A grade needs a code - it is what every production row, partner draw and '
                       'bagging entry refers to. Type the grade exactly as it appears on the sheet '
                       '(for example 3X50).');
    END IF;

    -- 24 characters is far more than any real grade (the longest of the four seeded
    -- is 4). The bound exists so a pasted cell or a whole line of text cannot become
    -- a permanent, undeletable dimension row.
    IF pg_catalog.length(v_code) > 24 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', format('A grade code of %s characters is too long (the limit is 24). This '
                              'looks like a whole cell rather than a grade code.',
                              pg_catalog.length(v_code)));
    END IF;

    IF v_name IS NOT NULL AND pg_catalog.length(v_name) > 64 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'A grade display name is limited to 64 characters.');
    END IF;

    -- ── 2. Already there? Answer with the spelling that IS stored ───────────────
    -- Compared through fn_canon_token on BOTH sides, so `3x50`, ` 3X50 ` and `3X50`
    -- are one grade. The message names the stored spelling when it differs from what
    -- was typed, because "it already exists" without saying AS WHAT leaves the
    -- operator hunting for a row they think is missing.
    SELECT g.* INTO v_existing
      FROM cenapro.grade g
     WHERE cenapro.fn_canon_token(g.code) = v_code
     LIMIT 1;

    IF v_existing.code IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'already_exists',
            'code', v_existing.code,
            'display_name', v_existing.display_name,
            'sort_order', v_existing.sort_order,
            'expected_kg_per_bag_min', v_existing.expected_kg_per_bag_min,
            'expected_kg_per_bag_max', v_existing.expected_kg_per_bag_max,
            'message', CASE
                WHEN v_existing.code = pg_catalog.btrim(COALESCE(p_code, ''))
                    THEN format('%L is already a grade.', v_existing.code)
                ELSE format('%L already exists as %L - grade codes are matched without regard to '
                            'case or spacing, so there is only one of it.',
                            pg_catalog.btrim(COALESCE(p_code, '')), v_existing.code)
            END);
    END IF;

    -- ── 3. Where it sits in the list ────────────────────────────────────────────
    -- Default = the end. A caller may place it, but the value is only ordering: it
    -- is not unique and nothing keys on it, so a collision is a cosmetic tie broken
    -- by `code` in the accessor view, never an error.
    IF p_sort_order IS NOT NULL AND (p_sort_order < 0 OR p_sort_order > 10000) THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', format('A sort order of %s is not plausible - use 0 to 10000, or leave it '
                              'blank to put the grade at the end of the list.', p_sort_order));
    END IF;

    v_sort := COALESCE(p_sort_order,
                       (SELECT pg_catalog.max(g.sort_order) + 1 FROM cenapro.grade g),
                       1);

    -- ── 4. The insert ───────────────────────────────────────────────────────────
    -- The code is stored CANONICALIZED so the table can never hold two spellings of
    -- one grade; the display name keeps whatever the operator typed, and defaults to
    -- the code, which is what all four seeded rows do.
    --
    -- `expected_kg_per_bag_min/max` are deliberately NOT settable here. They are a
    -- QC tolerance, not part of naming a grade, and two of the four seeded rows carry
    -- neither - so leaving them NULL is the normal state, not a gap.
    BEGIN
        INSERT INTO cenapro.grade AS g (code, display_name, sort_order)
        VALUES (v_code, COALESCE(v_name, v_code), v_sort)
        RETURNING g.* INTO v_existing;
    EXCEPTION
        -- The existence check above is not a lock, so a concurrent writer can land
        -- the same code between the check and the insert. Same answer as a repeat,
        -- because the remedy is identical: the grade is there, use it.
        WHEN unique_violation THEN
            SELECT g.* INTO v_existing FROM cenapro.grade g WHERE g.code = v_code;
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'already_exists',
                'code', v_existing.code,
                'display_name', v_existing.display_name,
                'sort_order', v_existing.sort_order,
                'expected_kg_per_bag_min', v_existing.expected_kg_per_bag_min,
                'expected_kg_per_bag_max', v_existing.expected_kg_per_bag_max,
                'message', format('%L was added by someone else a moment ago. Reload to see it.',
                                  v_existing.code));
    END;

    RETURN jsonb_build_object(
        'ok', true, 'outcome', 'inserted',
        'code', v_existing.code,
        'display_name', v_existing.display_name,
        'sort_order', v_existing.sort_order,
        'expected_kg_per_bag_min', v_existing.expected_kg_per_bag_min,
        'expected_kg_per_bag_max', v_existing.expected_kg_per_bag_max);
END;
$$;

comment on function public.cenapro_add_grade(text, text, integer) is
    'Add ONE grade to the cenapro.grade dimension. INSERT-ONLY: there is no update RPC and no delete '
    'RPC, because grade_code is a text FK carried by every production_event row. The code is '
    'canonicalized with cenapro.fn_canon_token (trim, collapse whitespace, uppercase) and stored that '
    'way, so a typed 3x50 can never create a second grade beside 3X50 - it returns already_exists '
    'naming the stored spelling. display_name defaults to the code; sort_order defaults to max+1 and '
    'is ordering only (not unique, nothing keys on it). expected_kg_per_bag_min/max are not settable '
    'here. Returns jsonb {ok, outcome: inserted|already_exists|invalid, code, display_name, '
    'sort_order, expected_kg_per_bag_min, expected_kg_per_bag_max, message}. Read the dimension back '
    'through public.cenapro_grades.';

revoke all on function public.cenapro_add_grade(text, text, integer) from public;
grant execute on function public.cenapro_add_grade(text, text, integer) to authenticated, service_role;
