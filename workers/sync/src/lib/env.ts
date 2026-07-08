/**
 * env.ts — small, centralized readers for feature-flag environment variables.
 *
 * Keeping these in ONE module (rather than scattering `process.env` lookups across
 * the apply/reconcile paths) means a flag's parse rules + default live in exactly one
 * place. Boolean flags parse leniently: any of 0/false/off/no (case-insensitive) is
 * OFF; anything else — including UNSET — is ON when the flag defaults ON.
 */

/** Lenient boolean env parse. Returns `fallback` when unset/blank. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return fallback;
}

/**
 * `SYNC_RCOUT_RECONCILE_CUTOVER` — the R4b cutover flag. DEFAULT ON.
 *
 * ON  (default): gsheet-sync does NOT write `rc_out` (neither Sheet-wins UPDATEs nor NEW
 *                inserts). The PROPOSED report (rc-out-manager) is the SOLE rc_out writer,
 *                and multi-source reconciliation is the flagging authority. This makes the
 *                L-037 clobber structurally impossible.
 * OFF          : exact prior behavior — gsheet applies Sheet-wins rc_out as before. A
 *                one-line production revert (`SYNC_RCOUT_RECONCILE_CUTOVER=off`) if the
 *                cutover misbehaves. Reconciliation stays purely observational (as R4a).
 *
 * rc_in / deliveries writes are UNCHANGED in BOTH states — this flag gates rc_out only.
 */
export function rcOutReconcileCutover(): boolean {
  return envBool("SYNC_RCOUT_RECONCILE_CUTOVER", true);
}
