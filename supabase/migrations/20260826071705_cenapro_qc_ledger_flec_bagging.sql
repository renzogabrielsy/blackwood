-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — the QC Ledger may now file FLEC BAGGING entries.
--
-- WHY THIS CHANGES
-- On 2026-08-03 this function drew a boundary: "partner draws are added here; flec
-- bagging stays in the Production ledger", on the grounds that the two arrive on two
-- different pieces of paper. Renzo has reversed it: *"make sure that qc ledger allows
-- us to add entries pertaining to flecon bags (as in adding into our inventory, not
-- just partner draws)"*. The QC Ledger is becoming the one place operators type
-- everything, exactly as `p_plant` became typable here on 2026-08-04 for the same
-- reason — `cenapro.production_event` is ONE table, the Production ledger already
-- writes `flec_bagging` rows into it freely through the auto-updatable
-- `public.cenapro_production_events` view, and a rule that lets a row be written on
-- one screen and refuses it on another is a rule with no counterpart.
--
-- So `p_partner_equipment_code = 'FLEC'` (and the aliases `parseCccFlec` already
-- forgives — BAG / BAGGING / FLEC BAGGING / FLEC_BAGGING) is no longer a
-- `wrong_surface` refusal. It is an ENTRY KIND: it produces exactly the row the
-- Production ledger's `CCC/FLEC = FLEC` cell produces —
-- `disposition_kind = 'flec_bagging'`, `partner_equipment_code = NULL` — which is
-- also the only shape `cenapro.production_event_partner_equipment_presence` allows.
--
-- WHAT A BAGGING ENTRY REQUIRES, AND WHY IT IS THE SAME RULE AS A FLEC DRAW
-- `cenapro.flec_ledger(warehouse, from_date)` counts a `flec_bagging` row as
-- `flec_in` only when `warehouse_code IS NOT NULL`, the warehouse's `default_unit`
-- is `flec_count`, and `whse_side IS NOT NULL`. So the bag-field rule the function
-- already applied to a FLEC-SOURCED draw (an OUT) now also applies when the MACHINE
-- is FLEC (an IN):
--
--   • `warehouse_code` REQUIRED, and must be a flec-count warehouse — WHSE 1/2/5/7.
--     WHSE 3 is `default_unit = 'kg'` (the DVO container yard) and is refused BY NAME.
--   • `flec_count` REQUIRED and positive. A bagging entry with no count is bags that
--     entered inventory without anybody being able to say how many.
--   • `whse_side` OPTIONAL, and a sideless entry still SAVES, carrying the existing
--     non-blocking `notice` — the flec ledger counts only sided rows, so the balance
--     will not move until a side is set. (Reworded for the IN direction; the draw
--     wording is untouched.)
--
-- This is STRICTER THAN HISTORY, deliberately and measurably: of the 372 stored
-- `flec_bagging` rows, 183 carry NO `warehouse_code` and 183 no side, so they are
-- invisible to every warehouse balance. Those rows stay exactly as they are — nothing
-- here rewrites data — but a bagging entry typed TODAY, whose whole purpose is
-- "adding into our inventory", must actually reach the inventory it claims to add to.
--
-- SRC = FLEC **and** MACH = FLEC IS REFUSED BY NAME (the decision this change had to make)
-- FLEC as the SOURCE means bagged stock being drawn OUT of a warehouse; FLEC as the
-- MACHINE means fresh charcoal being bagged INTO one. Together they are a self-loop,
-- and it is not merely redundant — it is silently WRONG. `cenapro.flec_ledger`
-- branches on `disposition_kind` FIRST, so such a row would be counted as `flec_in`
-- and its outflow half would never be counted at all: the warehouse would gain bags
-- that were taken out of it. Refused with `invalid` and a sentence that names both
-- readings and offers the two legal ways out. `invalid` rather than a new outcome
-- name, because it is exactly what `invalid` already means here (two supplied values
-- that cannot both be true) and because `readAddOutcome` in `app/(app)/cenapro/qc/
-- actions.ts` narrows an unrecognised outcome to `rpc_error`, which would turn a
-- readable refusal into "it failed".
--
-- WHAT DOES **NOT** CHANGE
-- Batch resolution, plant derivation/override, the date guards, the weight rules, the
-- duplicate warning / `already_exists` pair, the audit provenance (`qc_ledger` through
-- `tr_cenapro_pe_audit`), the sample-group echo, and every message on the partner-draw
-- path — all byte-for-byte. A BLANK machine is still `wrong_surface` (the outcome name
-- is stable because the frontend switches on it in `qc-grid-v2-save.ts`); only its
-- sentence changes, because "name the crusher or kiln" is no longer the whole truth.
-- DVO is still `unsupported_source`, whichever entry kind is asked for.
--
-- The `partner_equipment_code IS NOT DISTINCT FROM` in the two duplicate probes is
-- exact, not approximate: `production_event_partner_equipment_presence` makes
-- "equipment IS NULL" and "disposition is flec_bagging" the same set of rows, and
-- `cenapro.compute_unique_tag` maps `flec_bagging` to the literal 'FLEC' in the tag —
-- so the pre-check still mirrors the UNIQUE index component for component.
--
-- POSTURE — unchanged: SECURITY INVOKER, `SET search_path = ''` with every reference
-- schema-qualified, EXECUTE revoked from PUBLIC and granted back to `authenticated` +
-- `service_role` only. DROP + CREATE (never an overload) with the grants re-issued,
-- per the house idiom — the signature is identical, so every existing call site,
-- positional or named, is unaffected. No table change, no trigger change, no view
-- change, NO DATA CHANGE.
-- ─────────────────────────────────────────────────────────────────────────────────

drop function if exists public.cenapro_add_partner_draw(
    date, text, text, text, text, numeric, date, text, integer, text, text, integer, text, boolean, text);

create function public.cenapro_add_partner_draw(
    p_recv_date              date,
    p_source_location_code   text,
    p_partner_equipment_code text,
    p_grade_code             text,
    p_shift_code             text,
    p_weight_kg              numeric,
    p_prod_date              date    default null,
    p_warehouse_code         text    default null,
    p_flec_count             integer default null,
    p_whse_side              text    default null,
    p_batch                  text    default null,
    p_batch_year             integer default null,
    p_notes                  text    default null,
    p_allow_duplicate        boolean default false,
    p_plant                  text    default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
DECLARE
    v_src          text := cenapro.fn_canon_token(p_source_location_code);
    v_equip_in     text := cenapro.fn_canon_token(p_partner_equipment_code);
    v_equip        text := '';
    v_grade        text := cenapro.fn_canon_token(p_grade_code);
    v_shift        text := cenapro.fn_canon_token(p_shift_code);
    v_whse         text := cenapro.fn_canon_token(p_warehouse_code);
    v_side         text := cenapro.fn_canon_token(p_whse_side);
    v_plant_in     text := cenapro.fn_canon_token(p_plant);
    v_is_bagging   boolean := false;
    v_entry_label  text;          -- how a duplicate_warning names this row's shape
    v_needs_bags   boolean;
    v_src_kind     text;
    v_plant        text;
    v_plant_derived text;
    v_plant_src    text := 'derived';
    v_plant_notice text;
    v_equip_kind   text;
    v_whse_unit    text;
    v_disp         text;
    v_batch        text;
    v_batch_year   integer;
    v_batch_res    text;
    v_notice       text;
    v_dup_id       uuid;
    v_dup_kg       numeric;
    v_dups         jsonb;
    v_id           uuid;
    v_tag          text;
BEGIN
    -- ── 1. What KIND of entry is this? ──────────────────────────────────────────
    -- Checked FIRST, because it decides the shape of everything below. Until
    -- 2026-08-26 this step existed to REFUSE bagging; it now routes it. The two
    -- kinds are told apart by the machine cell alone, exactly as the Production
    -- ledger's single CCC/FLEC column does it (`parseCccFlec` in
    -- app/(app)/cenapro/types.ts) — and the aliases accepted here are that
    -- function's aliases, so a value typed into either screen means the same thing.
    --
    -- A BLANK machine is still a refusal, and still `wrong_surface`: a row that says
    -- neither "the partner drew this" nor "we bagged this" describes no event at all.
    IF v_equip_in = '' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'wrong_surface',
            'message', 'An entry must say what happened to the charcoal: the crusher or kiln the '
                       'partner drew it into (C1-C4 or RK1-RK4), or FLEC if CI bagged it INTO a '
                       'warehouse.');
    END IF;

    IF v_equip_in IN ('FLEC', 'BAG', 'BAGGING', 'FLEC BAGGING', 'FLEC_BAGGING') THEN
        v_is_bagging := true;
        v_disp       := 'flec_bagging';
        v_equip      := '';
    ELSE
        v_equip := v_equip_in;

        SELECT pe.kind INTO v_equip_kind
          FROM cenapro.partner_equipment pe
         WHERE pe.code = v_equip;

        IF v_equip_kind IS NULL THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid_key',
                'message', format('%L is not a known partner machine. Use one of C1, C2, C3, C4 '
                                  '(crushers) or RK1, RK2, RK3, RK4 (rotary kilns) - or FLEC for '
                                  'charcoal bagged into a warehouse.', p_partner_equipment_code));
        END IF;

        v_disp := CASE WHEN v_equip_kind = 'kiln' THEN 'partner_kiln' ELSE 'partner_crusher' END;
    END IF;

    -- ── 2. Required identity ────────────────────────────────────────────────────
    IF p_recv_date IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', 'A receipt date is required - it is the day the draw was logged.');
    END IF;

    -- Year-typo guard. Cenapro data begins 2025-12-01; a date outside this window
    -- is a mistyped year, which is exactly the class of error that silently
    -- stranded five flecon movements for months.
    IF p_recv_date < DATE '2025-01-01' OR p_recv_date > (pg_catalog.now()::date + 30) THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', format('A receipt date of %s is outside the plausible range (2025-01-01 to a '
                              'month ahead of today). Check the year.', p_recv_date));
    END IF;

    IF p_prod_date IS NOT NULL THEN
        IF p_prod_date > p_recv_date THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', format('The production date (%s) is after the receipt date (%s). Charcoal '
                                  'cannot be received before it is made.', p_prod_date, p_recv_date));
        END IF;
        IF p_prod_date < (p_recv_date - 270) THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', format('The production date (%s) is more than 270 days before the receipt '
                                  'date (%s). Check the year.', p_prod_date, p_recv_date));
        END IF;
    END IF;

    -- ── 3. Dimensions — validated by hand so the caller gets a sentence, not a
    -- raw foreign-key violation. The FKs stay in place underneath as the backstop.
    IF v_src = '' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', 'A source is required - where the partner drew from (TNK 1-4, W7, W6 or FLEC).');
    END IF;

    SELECT sl.kind, sl.plant_code INTO v_src_kind, v_plant_derived
      FROM cenapro.source_location sl
     WHERE sl.code = v_src;

    IF v_src_kind IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', format('%L is not a known source. Use TNK 1, TNK 2, TNK 3, TNK 4, W7, W6 or FLEC.',
                              p_source_location_code));
    END IF;

    -- DVO is the Davao container-van flow into WHSE 3, in kg, under its own batch
    -- codes - deferred in v1 (CENAPRO_SCHEMA.md 1.3) and NOT what the partner's
    -- paper slip describes. Its 69 historic rows stay readable and editable; they
    -- are simply not created here. Named explicitly so the refusal is legible
    -- rather than surfacing as a confusing "a warehouse must not be supplied".
    -- Applies to a bagging entry too: WHSE 3 holds kg, not flecs.
    IF v_src_kind = 'dvo_container' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'unsupported_source',
            'message', 'DVO receipts cannot be added here. A DVO row is a Davao container van into '
                       'WHSE 3 with its own batch code - a different document from the partner''s '
                       'daily slip, and still deferred in this version. Existing DVO rows stay '
                       'visible and editable.');
    END IF;

    -- ── 3a. FLEC out of FLEC is a self-loop, and it is refused BY NAME ───────────
    -- The source says bagged stock LEAVING a warehouse; the machine says charcoal
    -- being bagged INTO one. cenapro.flec_ledger tests `disposition_kind` first, so
    -- a row claiming both would be counted as an IN and its OUT half would vanish -
    -- the warehouse would gain bags that had just been taken out of it. A refusal
    -- is the only honest answer; a silent "we picked one" is precisely what this
    -- platform does not do.
    IF v_is_bagging AND v_src_kind = 'warehouse_flec' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'This row says the charcoal came OUT of the flec warehouse and was bagged INTO '
                       'it at the same time. FLEC as the source means bagged stock leaving a '
                       'warehouse; FLEC as the machine means fresh charcoal being bagged into one. '
                       'Together the warehouse balance would count the bags going in and never the '
                       'bags going out. Name the tank or plant the charcoal was bagged from (TNK 1-4, '
                       'W6 or W7), or make this a partner draw by naming the crusher or kiln.');
    END IF;

    -- ── 3b. The plant — the SOURCE's by default, the OPERATOR's on request ──────
    -- Blank is not "no plant", it is "follow the source": the derived value stands,
    -- exactly as it did before this parameter existed. That keeps every existing
    -- caller byte-for-byte unchanged AND keeps a NULL plant unreachable on a tank
    -- draw, where the plant IS the QC sample-group key.
    --
    -- A SUPPLIED plant is validated against `cenapro.plant` - the very dimension
    -- `production_event.plant_code` is foreign-keyed to and `source_location`
    -- draws its own `plant_code` from - so a typed value forms a real sample group
    -- just as a derived one does. Anything else is refused by name.
    --
    -- A valid plant that DISAGREES with the source is ACCEPTED. The QC Ledger
    -- transcribes the partner's paper slip, and a slip may legitimately name
    -- something the source mapping does not predict; the Production ledger already
    -- lets any plant be typed onto this same column, so refusing it here was a rule
    -- with no counterpart and no purpose. The disagreement is REPORTED, not
    -- resolved - `plant_notice` names both values and blocks nothing.
    v_plant := v_plant_derived;

    IF v_plant_in <> '' THEN
        IF NOT EXISTS (SELECT 1 FROM cenapro.plant pl WHERE pl.code = v_plant_in) THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid_key',
                'message', format('%L is not a known plant. Use %s - or leave the plant blank and it '
                                  'follows the source (%s).',
                                  p_plant,
                                  (SELECT pg_catalog.string_agg(pl.code, ', ' ORDER BY pl.code)
                                     FROM cenapro.plant pl),
                                  CASE WHEN v_plant_derived IS NULL
                                       THEN format('a draw from %s carries no plant', v_src)
                                       ELSE format('%s reports to %s', v_src, v_plant_derived) END));
        END IF;

        v_plant     := v_plant_in;
        v_plant_src := 'supplied';

        IF v_plant_in IS DISTINCT FROM v_plant_derived THEN
            -- Three flavours, because the sentence names the SAMPLE GROUP and the
            -- group key is `coalesce(warehouse_code, plant_code)`. A row that
            -- carries a warehouse is grouped by the WAREHOUSE, so telling its
            -- author that the typed plant moved the group would be false - and a
            -- notice that states a wrong fact is worse than no notice at all. A
            -- bagging entry ALWAYS carries a warehouse (step 5 refuses it
            -- otherwise), so it gets its own branch rather than borrowing the tank
            -- wording it would otherwise fall into.
            v_plant_notice := CASE
                WHEN v_is_bagging THEN
                    format('Saved under plant %s as typed, not %s, which is where %s normally reports. '
                           'A bagging entry is grouped by the warehouse the bags went into, so the QC '
                           'sample group is unaffected - only the plant column changed.',
                           v_plant_in,
                           COALESCE(v_plant_derived, 'no plant'),
                           v_src)
                WHEN v_src_kind = 'warehouse_flec' THEN
                    format('Saved under plant %s as typed. A draw from %s normally carries no plant at '
                           'all - once charcoal is bagged its origin is not knowable from the source. '
                           'The QC sample group still follows the warehouse, so only the plant column '
                           'changed.', v_plant_in, v_src)
                ELSE
                    format('Saved under plant %s as typed, not %s, which is where %s normally reports. '
                           'The plant is the QC grouping key for this source, so this draw joins the %s '
                           'sample group for %s. Change the plant cell if that was not intended.',
                           v_plant_in,
                           COALESCE(v_plant_derived, 'no plant'),
                           v_src,
                           v_plant_in,
                           p_recv_date)
            END;
        END IF;
    END IF;

    IF v_grade = '' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', 'A grade is required.');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM cenapro.grade g WHERE g.code = v_grade) THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', format('%L is not a known grade. Use %s.', p_grade_code,
                              (SELECT pg_catalog.string_agg(g.code, ', ' ORDER BY g.sort_order, g.code)
                                 FROM cenapro.grade g)));
    END IF;

    IF v_shift = '' THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', 'A shift is required (M, E or N).');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM cenapro.shift s WHERE s.code = v_shift) THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid_key',
            'message', format('%L is not a known shift. Use M (morning), E (evening) or N (night).',
                              p_shift_code));
    END IF;

    -- ── 4. Weight ───────────────────────────────────────────────────────────────
    -- Same rules, same wording as cenapro_update_event_weight, so a weight typed
    -- into a new row and a weight corrected on an existing one are judged
    -- identically. `parseWeightKg` in lib/cenapro/ccc-analysis.ts is the JS twin.
    IF p_weight_kg IS NULL OR NOT (p_weight_kg > 0) THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'A weight must be a positive number of kilograms.');
    END IF;

    IF p_weight_kg > 10000000 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'That weight is over 10,000,000 kg - check for a mistyped digit.');
    END IF;

    IF pg_catalog.scale(p_weight_kg) > 3 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'A weight carries at most 3 decimal places.');
    END IF;

    -- ── 5. The bag fields — required by the DIRECTION, refused otherwise ────────
    -- Two shapes of row touch bag inventory, and they are mirror images:
    --
    --   • a draw whose SOURCE is FLEC   -> bags leave a warehouse  (flec_out)
    --   • an entry whose MACHINE is FLEC -> bags enter a warehouse (flec_in)
    --
    -- `cenapro.flec_ledger` counts either one only when the warehouse is set, its
    -- `default_unit` is `flec_count`, and a side is present. So both require the
    -- warehouse and the count, both refuse WHSE 3 by name, and both treat the side
    -- as optional-with-a-notice. Every other row touches no bag inventory at all,
    -- so the three fields are meaningless there and are REFUSED rather than dropped
    -- - a silently discarded flec_count is a warehouse balance nobody notices is
    -- wrong.
    v_needs_bags := v_is_bagging OR v_src_kind = 'warehouse_flec';

    IF v_needs_bags THEN
        IF v_whse = '' THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', CASE WHEN v_is_bagging
                    THEN 'A bagging entry puts bags INTO a warehouse, so it must say which one '
                         '(WHSE 1, WHSE 2, WHSE 5 or WHSE 7). Without it the bags are recorded but '
                         'no warehouse balance moves.'
                    ELSE 'A FLEC draw takes bags out of a warehouse, so it must say which one '
                         '(WHSE 1, WHSE 2, WHSE 5 or WHSE 7).' END);
        END IF;

        SELECT w.default_unit INTO v_whse_unit
          FROM cenapro.warehouse w
         WHERE w.code = v_whse;

        IF v_whse_unit IS NULL THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid_key',
                'message', format('%L is not a known warehouse. Use WHSE 1, WHSE 2, WHSE 5 or WHSE 7.',
                                  p_warehouse_code));
        END IF;

        IF v_whse_unit <> 'flec_count' THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', format((CASE WHEN v_is_bagging
                    THEN '%s does not hold flec bags - it is counted in kilograms - so bagged stock '
                         'cannot go into it. Use WHSE 1, WHSE 2, WHSE 5 or WHSE 7.'
                    ELSE '%s does not hold flec bags, so a FLEC draw cannot come out of it. '
                         'Use WHSE 1, WHSE 2, WHSE 5 or WHSE 7.' END)::text, v_whse));
        END IF;

        IF p_flec_count IS NULL THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', CASE WHEN v_is_bagging
                    THEN 'A bagging entry must say how many bags went into the warehouse. Without it '
                         'the bag balance quietly understates what is on hand.'
                    ELSE 'A FLEC draw must say how many bags left the warehouse. Without it the bag '
                         'balance quietly overstates what is on hand.' END);
        END IF;

        IF p_flec_count <= 0 THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', 'A bag count must be a positive whole number.');
        END IF;

        IF v_side <> '' AND v_side NOT IN ('LS', 'RS') THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid_key',
                'message', format('%L is not a warehouse side. Use LS or RS, or leave it blank.',
                                  p_whse_side));
        END IF;

        -- Not a refusal: the side is genuinely optional on the sheet - measured
        -- 2026-08-26, 131 of 301 historic FLEC-sourced draws and 183 of 372
        -- historic bagging rows carry none.
        -- But cenapro.flec_ledger only counts rows with a side, so a sideless row
        -- is invisible to the warehouse balance. Say so rather than let the
        -- operator discover it from a wrong number.
        IF v_side = '' THEN
            v_notice := CASE WHEN v_is_bagging
                THEN 'Saved without a warehouse side. The WHSE ledger only counts sided rows, so '
                     'these bags will not appear in the LS/RS balance until a side is set.'
                ELSE 'Saved without a warehouse side. The WHSE ledger only counts sided rows, so '
                     'this outflow will not move the LS/RS balance until a side is set.' END;
        END IF;
    ELSE
        IF v_whse <> '' THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', format('A draw from %s does not come out of a warehouse - it is taken '
                                  'before the charcoal is ever bagged. Remove the warehouse, or change '
                                  'the source to FLEC if these were bags.', v_src));
        END IF;

        IF p_flec_count IS NOT NULL THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', format('A draw from %s consumes no bags, so a bag count cannot apply to it. '
                                  'Only a FLEC draw takes bagged stock.', v_src));
        END IF;

        IF v_side <> '' THEN
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'invalid',
                'message', format('A draw from %s touches no warehouse, so it has no LS/RS side.', v_src));
        END IF;
    END IF;

    -- ── 6. The batch label ──────────────────────────────────────────────────────
    -- BATCH IS NOT THE CALENDAR MONTH. JULY first appears on 2026-06-27 and JUNE
    -- rows keep arriving until 2026-06-29; thirteen dates in the live table carry
    -- two labels at once. So the default is the batch actually RUNNING at the
    -- receipt date: the label carried by the most rows on the nearest logged date
    -- at or before it, ties broken by whichever label started most recently (which
    -- is what makes a changeover day resolve to the NEW batch). Always overridable.
    IF cenapro.fn_canon_token(p_batch) <> '' THEN
        v_batch     := cenapro.fn_canon_token(p_batch);
        v_batch_res := 'explicit';
        -- Year of that same label as it was last used at or before the receipt
        -- date, so an explicit "JULY" joins the existing JULY period rather than
        -- opening a second one.
        SELECT pe.batch_year INTO v_batch_year
          FROM cenapro.production_event pe
         WHERE pe.batch = v_batch
           AND pe.recv_date <= p_recv_date
         ORDER BY pe.recv_date DESC
         LIMIT 1;
    ELSE
        WITH nearest AS (
            SELECT pg_catalog.max(pe.recv_date) AS d
              FROM cenapro.production_event pe
             WHERE pe.recv_date <= p_recv_date
        ), started AS (
            SELECT pe.batch, pe.batch_year, pg_catalog.min(pe.recv_date) AS first_seen
              FROM cenapro.production_event pe
             GROUP BY pe.batch, pe.batch_year
        )
        SELECT pe.batch, pe.batch_year
          INTO v_batch, v_batch_year
          FROM cenapro.production_event pe
          JOIN nearest n ON pe.recv_date = n.d
          JOIN started s ON s.batch = pe.batch AND s.batch_year = pe.batch_year
         GROUP BY pe.batch, pe.batch_year, s.first_seen
         ORDER BY pg_catalog.count(*) DESC, s.first_seen DESC, pe.batch
         LIMIT 1;

        v_batch_res := 'running';

        -- Nothing logged on or before this date at all (an empty table, or a date
        -- earlier than every row). Fall back to the calendar month, which is what
        -- the label looks like, and say that is what happened.
        IF v_batch IS NULL THEN
            v_batch     := pg_catalog.upper(pg_catalog.to_char(p_recv_date, 'FMMONTH'));
            v_batch_res := 'calendar';
        END IF;
    END IF;

    v_batch_year := COALESCE(p_batch_year, v_batch_year,
                             EXTRACT(YEAR FROM p_recv_date)::integer);

    IF v_batch_year < 2000 OR v_batch_year > 2100 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', format('A batch year of %s is not plausible.', v_batch_year));
    END IF;

    -- ── 7. Duplicates ───────────────────────────────────────────────────────────
    -- Two genuine draws from the same source into the same machine on one day are
    -- real - fourteen such pairs are already in the table - so there is NO unique
    -- constraint on that key and never should be. But every one of those fourteen
    -- differs somewhere in the unique_tag (production date, warehouse, side or
    -- batch), because the tag's UNIQUE index is what actually forbids storing the
    -- same row twice. So the two cases are answered separately:
    --
    --   a) IDENTICAL on every tag component -> `already_exists`. The database
    --      cannot hold it whatever the operator intends, and in practice it is a
    --      double-submit. Hard refusal, carrying the row that is already there.
    --   b) SAME natural key, something else differs -> `duplicate_warning`, a SOFT
    --      refusal the UI can confirm through with p_allow_duplicate := true. This
    --      is the right shape because the ambiguity is the operator's to resolve:
    --      only they know whether the slip lists two trips or they keyed one twice.
    --
    -- The tag includes `plant_code`, so this check is made against the EFFECTIVE
    -- plant (typed when supplied, derived otherwise) - which is correct, because a
    -- deliberately different plant genuinely produces a different tag and so a row
    -- the database CAN hold.
    --
    -- `partner_equipment_code IS NOT DISTINCT FROM nullif(v_equip,'')` covers BOTH
    -- kinds exactly: `production_event_partner_equipment_presence` makes a NULL
    -- equipment and a `flec_bagging` disposition the same set of rows, and
    -- `cenapro.compute_unique_tag` writes the literal 'FLEC' into the tag for them.
    SELECT e.id, e.weight_kg INTO v_dup_id, v_dup_kg
      FROM cenapro.production_event e
     WHERE e.recv_date              = p_recv_date
       AND e.prod_date              IS NOT DISTINCT FROM p_prod_date
       AND e.batch                  = v_batch
       AND e.shift_code             IS NOT DISTINCT FROM v_shift
       AND e.grade_code             = v_grade
       AND e.plant_code             IS NOT DISTINCT FROM v_plant
       AND e.warehouse_code         IS NOT DISTINCT FROM nullif(v_whse, '')
       AND e.whse_side              IS NOT DISTINCT FROM nullif(v_side, '')
       AND e.source_location_code   = v_src
       AND e.partner_equipment_code IS NOT DISTINCT FROM nullif(v_equip, '')
     LIMIT 1;

    IF v_dup_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'already_exists',
            'id', v_dup_id, 'weight_kg', v_dup_kg,
            'message', format('This exact %s is already logged (%s kg). Two rows that match on '
                              'every field cannot both be stored - edit the existing row if the '
                              'weight is wrong, or change the production date, warehouse or side if '
                              'this really is a second one.',
                              CASE WHEN v_is_bagging THEN 'bagging entry' ELSE 'draw' END,
                              pg_catalog.trim_scale(v_dup_kg)::text));
    END IF;

    IF NOT COALESCE(p_allow_duplicate, false) THEN
        SELECT jsonb_agg(jsonb_build_object(
                   'id',             d.id,
                   'weight_kg',      d.weight_kg,
                   'prod_date',      d.prod_date,
                   'warehouse_code', d.warehouse_code,
                   'whse_side',      d.whse_side,
                   'batch',          d.batch)
                 ORDER BY d.created_at, d.id)
          INTO v_dups
          FROM cenapro.production_event d
         WHERE d.recv_date              = p_recv_date
           AND d.source_location_code   = v_src
           AND d.partner_equipment_code IS NOT DISTINCT FROM nullif(v_equip, '')
           AND d.grade_code             = v_grade
           AND d.shift_code             IS NOT DISTINCT FROM v_shift;

        IF v_dups IS NOT NULL THEN
            v_entry_label := CASE WHEN v_is_bagging
                THEN format('bagged from %s into the warehouse', v_src)
                ELSE format('from %s into %s', v_src, v_equip) END;
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'duplicate_warning',
                'existing', v_dups,
                'message', format('%s row(s) %s are already logged for %s. If the slip lists a second '
                                  'one, confirm to add this as well.',
                                  jsonb_array_length(v_dups), v_entry_label, p_recv_date));
        END IF;
    END IF;

    -- ── 8. The insert ───────────────────────────────────────────────────────────
    -- `disposition_kind` and `partner_equipment_code` are the pair decided in step
    -- 1: a partner draw carries the machine and the crusher/kiln disposition, a
    -- bagging entry carries `flec_bagging` and a NULL machine - the only shape
    -- `production_event_partner_equipment_presence` permits, and exactly what the
    -- Production ledger's `CCC/FLEC = FLEC` cell writes.
    --
    -- `plant_code` is the EFFECTIVE plant resolved in step 3b: the source's own
    -- (TNK 1-4 -> W6, W7 -> W7, W6 -> W6, FLEC -> NULL) unless the operator typed
    -- one, in which case theirs - validated against `cenapro.plant`, so it forms a
    -- real QC sample group either way and a NULL can never be typed in.
    --
    -- `unique_tag` and `batch_year` are left to tr_cenapro_pe_unique_tag; the tag
    -- is recomputed on every write, so sending one would be theatre. `batch_year`
    -- is passed because the trigger only fills it when NULL and the resolved
    -- period, not the calendar year of the receipt, is where this row belongs.
    --
    -- `provenance` says 'qc_ledger' because it is true and nothing reads the column
    -- yet; `dirty` is deliberately left at its default so a hand-added row is
    -- indistinguishable from every other one to whatever eventually consumes it.
    --
    -- The audit source is set transaction-locally and CLEARED immediately after
    -- the statement it describes, exactly as cenapro_update_event_weight does -
    -- set_config(..., true) is transaction-local, not statement-local, and a
    -- `source` column that is only conditionally true is worse than none.
    PERFORM pg_catalog.set_config('cenapro.audit_source', 'qc_ledger', true);

    BEGIN
        INSERT INTO cenapro.production_event AS e (
            recv_date, prod_date, batch, batch_year,
            shift_code, grade_code, plant_code, warehouse_code, source_location_code,
            weight_kg, disposition_kind, partner_equipment_code,
            flec_count, whse_side, notes, provenance)
        VALUES (
            p_recv_date, p_prod_date, v_batch, v_batch_year,
            v_shift, v_grade, v_plant, nullif(v_whse, ''), v_src,
            p_weight_kg, v_disp, nullif(v_equip, ''),
            p_flec_count, nullif(v_side, ''), nullif(pg_catalog.btrim(COALESCE(p_notes, '')), ''),
            'qc_ledger')
        RETURNING e.id, e.unique_tag INTO v_id, v_tag;
    EXCEPTION
        -- The tag pre-check above is not a lock, so a concurrent writer can still
        -- land the same row between the check and the insert. Same answer, so the
        -- caller cannot tell a race from a repeat - which is correct, because the
        -- remedy is identical.
        WHEN unique_violation THEN
            PERFORM pg_catalog.set_config('cenapro.audit_source', '', true);
            SELECT e.id, e.weight_kg INTO v_dup_id, v_dup_kg
              FROM cenapro.production_event e
             WHERE e.recv_date              = p_recv_date
               AND e.prod_date              IS NOT DISTINCT FROM p_prod_date
               AND e.batch                  = v_batch
               AND e.shift_code             IS NOT DISTINCT FROM v_shift
               AND e.grade_code             = v_grade
               AND e.plant_code             IS NOT DISTINCT FROM v_plant
               AND e.warehouse_code         IS NOT DISTINCT FROM nullif(v_whse, '')
               AND e.whse_side              IS NOT DISTINCT FROM nullif(v_side, '')
               AND e.source_location_code   = v_src
               AND e.partner_equipment_code IS NOT DISTINCT FROM nullif(v_equip, '')
             LIMIT 1;
            RETURN jsonb_build_object(
                'ok', false, 'outcome', 'already_exists', 'id', v_dup_id,
                'message', 'This exact row was logged by someone else a moment ago. Reload the '
                           'ledger to see it.');
    END;

    PERFORM pg_catalog.set_config('cenapro.audit_source', '', true);

    -- The sample group this row now belongs to, computed the same way
    -- cenapro.view_ccc_sample_group computes it, so the caller can scroll straight
    -- to it without guessing at the coalesce.
    --
    -- `plant_code` is the value ACTUALLY STORED; `plant_source` says where it came
    -- from and `plant_derived` what the source alone would have given, so the UI
    -- can show the disagreement structurally instead of parsing a sentence.
    -- `plant_notice` is that sentence, and is non-null ONLY on a real disagreement.
    --
    -- `disposition_kind` now also carries `flec_bagging`, which is how a caller
    -- tells the two entry kinds apart without re-reading its own input. No extra
    -- key is invented for it: the disposition IS the entry kind, and a second
    -- field saying the same thing is a second place for it to drift.
    RETURN jsonb_build_object(
        'ok', true, 'outcome', 'inserted',
        'id', v_id,
        'unique_tag', v_tag,
        'batch', v_batch,
        'batch_year', v_batch_year,
        'batch_resolution', v_batch_res,
        'plant_code', v_plant,
        'plant_source', v_plant_src,
        'plant_derived', v_plant_derived,
        'plant_notice', v_plant_notice,
        'disposition_kind', v_disp,
        'sample_group', jsonb_build_object(
            'sample_date',          p_recv_date,
            'source_location_code', v_src,
            'whse_key',             cenapro.fn_canon_token(COALESCE(nullif(v_whse, ''), v_plant))),
        'notice', v_notice);
END;
$$;

comment on function public.cenapro_add_partner_draw(
    date, text, text, text, text, numeric, date, text, integer, text, text, integer, text, boolean, text) is
    'Add ONE row to cenapro.production_event from the QC Ledger. p_partner_equipment_code decides the '
    'ENTRY KIND and is REQUIRED: C1-C4 / RK1-RK4 file a PARTNER DRAW (disposition partner_crusher / '
    'partner_kiln), while FLEC (aliases BAG, BAGGING, FLEC BAGGING, FLEC_BAGGING - parseCccFlec''s own '
    'list) files a FLEC BAGGING entry, an inventory IN (disposition flec_bagging, partner_equipment_code '
    'NULL). A blank machine is wrong_surface. Resolves the running batch label at recv_date unless '
    'overridden. BAG FIELDS follow the DIRECTION, not the machine: a FLEC-SOURCED draw (bags out) and a '
    'FLEC-MACHINE entry (bags in) both REQUIRE warehouse_code (a flec_count warehouse - WHSE 1/2/5/7, '
    'never WHSE 3) and flec_count, both treat whse_side as optional with a non-blocking notice (the flec '
    'ledger counts only sided rows); every other row refuses all three. SRC=FLEC together with MACH=FLEC '
    'is REFUSED (invalid) - it is a self-loop the flec ledger would count as an IN only. PLANT: p_plant '
    'is OPTIONAL - blank/NULL derives it from the source (TNK 1-4 -> W6, W7 -> W7, W6 -> W6, FLEC -> '
    'NULL), a supplied value must be a real cenapro.plant code and is ACCEPTED even when it disagrees '
    'with the source, reported back non-blocking in plant_notice. Blank never means "clear the plant": '
    'plant is half the QC sample-group key (coalesce(warehouse_code, plant_code)) and an empty one would '
    'form a phantom group. Returns jsonb {ok, outcome: inserted|duplicate_warning|already_exists|invalid|'
    'invalid_key|wrong_surface|unsupported_source, id, batch, batch_year, batch_resolution, plant_code, '
    'plant_source, plant_derived, plant_notice, disposition_kind, sample_group, notice, message}. '
    'Audited by tr_cenapro_pe_audit with source = qc_ledger.';

revoke all on function public.cenapro_add_partner_draw(
    date, text, text, text, text, numeric, date, text, integer, text, text, integer, text, boolean, text)
    from public;
grant execute on function public.cenapro_add_partner_draw(
    date, text, text, text, text, numeric, date, text, integer, text, text, integer, text, boolean, text)
    to authenticated, service_role;
