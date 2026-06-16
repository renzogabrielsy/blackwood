-- Add Nazarino/Nazareno typo-merge to canonical_supplier(). "Nazarino" and
-- "Nazareno" are the same vendor -> both canonicalize to NAZARENO.
--
-- Function-only change: both supplier views + the subgroup view call
-- canonical_supplier(), so CREATE OR REPLACE FUNCTION updates all three at once
-- (no view recreation needed). All WHERE exclusions + weighting unchanged.
--
-- PLACEMENT: the nazareno/nazarino clause sits AFTER the "/" combo rules, so
-- "Nazarte/ Arbelera" still maps to ORNALES (caught by the combo WHEN first).
-- "Nazarte" contains neither 'nazareno' nor 'nazarino', so it would not match
-- this clause anyway -- the ordering is belt-and-suspenders.
--
-- Verified: NAZARENO merges Nazareno (5 kept rows / 49,196 kg) + Nazarino
-- (5 kept rows / 52,414 kg; the NAZARINO-on-MARCH-26-SUNDRY1 row is already
-- excluded by the sundried filter). No other %nazar% supplier exists.

CREATE OR REPLACE FUNCTION public.canonical_supplier(p_supplier text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_supplier ILIKE '%tipal%' OR p_supplier ILIKE '%tipla%' THEN 'BAGUIO/TIPALAN'
    WHEN p_supplier ILIKE '%bagui%' OR p_supplier ILIKE '%bagi%'  THEN 'BAGUIO'
    -- misdeclares -> ORNALES (combo rules FIRST: catches "Nazarte/ Arbelera")
    WHEN p_supplier ILIKE '%mercado%ornales%' OR p_supplier ILIKE '%ornales%mercado%'
      OR p_supplier ILIKE '%mercado%paquibot%' OR p_supplier ILIKE '%paquibot%mercado%'
      OR p_supplier ILIKE '%arbelera%mercado%' OR p_supplier ILIKE '%mercado%arbelera%'
      OR p_supplier ILIKE '%nazarte%arbelera%'  OR p_supplier ILIKE '%arbelera%nazarte%'  THEN 'ORNALES'
    -- combos -> PAQUIBOT
    WHEN p_supplier ILIKE '%compra%paquibot%'  OR p_supplier ILIKE '%paquibot%compra%'
      OR p_supplier ILIKE '%suarez%paquibot%'  OR p_supplier ILIKE '%paquibot%suarez%'
      OR p_supplier ILIKE '%baraquel%paquibot%'OR p_supplier ILIKE '%paquibot%baraquel%' THEN 'PAQUIBOT'
    -- typo merge: Nazarino / Nazareno -> NAZARENO (same vendor)
    WHEN p_supplier ILIKE '%nazareno%' OR p_supplier ILIKE '%nazarino%' THEN 'NAZARENO'
    ELSE COALESCE(NULLIF(UPPER(TRIM(p_supplier)), ''), 'UNKNOWN')
  END;
$$;
