'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE SUPPLIER LENS — "whose charcoal is in my yard", on the grid itself.
//
// The THIRD lens on the frame the price lens built, registered AFTER Age. Owner-approved
// direction: *"top suppliers as bands, colour each block by its biggest supplier, mark
// mixed blocks."* Same shared legend, same ratio bar, same Settings popover — and four
// deliberate differences from its two siblings.
//
// ── 1. THERE IS NO PRICE GATE, AND THAT IS THE POINT ────────────────────────
// The price lens refuses a `!canViewPrices()` caller before touching the database,
// because band membership there pins a block's ₱/kg to within a peso. That argument has
// NO analogue here: this payload is supplier names, kilograms, counts and percentages,
// `cost_basis` is never read and `avg_php_kg` is never selected, and a supplier's name
// beside a kilogram total says nothing about what it cost (asserted, not promised — the
// data layer's verify script scans every key of the live payload against
// /php|peso|cost|price|value|amount/). So `SUPPLIER_LENS.canShow` is `() => true` and
// Production sees this lens. Do not "tidy up" the asymmetry with its price sibling.
//
// ── 2. ⚠️ THERE ARE TWO KILOGRAM ATTRIBUTIONS AND THIS PANEL MUST NOT MIX THEM ──
// A block belongs to ONE band, but a MIXED block's kilos belong to SEVERAL suppliers, so
// "how many blocks does ORNALES own" and "what share of the yard is ORNALES" are
// different questions with different answer shapes:
//
//   `dominantBlockCount` / `dominantKg`  →  the grid TINT, and any block COUNT
//   `apportionedKg` (via `kgSharePct`)   →  the yard-share RATIO BAR
//
// Measured 2026-09-22: **8 of the yard's 17 suppliers dominate NO block at all** —
// MERCADO appears in 11 blocks and dominates none. A lens publishing only dominance would
// say Mercado holds 0 kg, which is false; one publishing only apportioned kg could not
// colour a cell. So the kg|blocks switch here does not merely re-scale one number: it
// switches BETWEEN THE TWO ATTRIBUTIONS, and the Settings popover says so in one line.
//
// ── 3. THE RAMP IS NOMINAL, NOT A GRADIENT ──────────────────────────────────
// Suppliers are categories — ORNALES is not "more" than PAQUIBOT — so a band takes the
// `.lens-cat-N` slot matching its own RANK and the `others` fold always takes the
// reserved neutral grey. A positional mapping would move a supplier's colour the moment
// the reader changed N. The twelve hues deliberately avoid the supplier SEARCH's emerald
// and orange, which already mean ALL / SOME of a searched supplier.
//
// ── 4. NULL IS NEVER "OTHERS" ───────────────────────────────────────────────
// A block whose batch has NO delivery at all has no supplier. It is ABSENT from
// `bandByBlock` and `blockByLoc`, so the classifier returns `null` for it and the cell
// keeps its normal un-lensed look; it is reported on its own muted row. Folding it into
// `others` would assert a supplier we do not have — the ₱11.01-vs-₱39.99 `avg_cost`
// mistake in its fourth costume.
//
// ── THIS FILE COMPUTES NO STATISTIC ─────────────────────────────────────────
// Every kilogram, block count, share, dominance and mixed count is read verbatim out of
// `fetchBlockingSupplierLens`'s payload. No `reduce`, no running total, no division by a
// total — the ratio bar's widths ARE the published shares (SQL guarantees they sum to
// 100, proven against the live database by `scripts/verify-blocking-supplier-lens.ts`).
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { AlertTriangle, Loader2, Users } from 'lucide-react';

import { errorToast } from '@/lib/toast';

import { fetchBlockingSupplierLens } from '../actions';
import {
  BLOCKING_SUPPLIER_LENS_MAX_TOP_N,
  BLOCKING_SUPPLIER_LENS_MIN_TOP_N,
  type BlockingSupplierBand,
  type BlockingSupplierLens,
  type BlockingSupplierLensResult,
} from '../types';
import type {
  BlockingLensClassifier,
  BlockingLensDefinition,
  BlockingLensPanelProps,
} from './types';
import { useLensSettings } from './use-lens-settings';
import {
  LensBandChips,
  LensBandRows,
  LensExcludedChip,
  LensExcludedRow,
  LensUnitSwitch,
} from './lens-band-rows';
import { LensRatioBar } from './lens-ratio-bar';
import { RefusalBanner } from './lens-refusal-banner';
import { LensSettingsPopover } from './lens-settings-popover';
import {
  LensSummaryPrintControl,
  type LensSummaryPrintModel,
} from './lens-summary-print';
import { buildLensSummaryBuckets } from './lens-summary-model';
import {
  formatLensBlocks,
  formatLensKg,
  formatLensSharePct,
  LENS_DEBOUNCE_MS,
  LENS_EMDASH,
  LENS_STALL_MS,
  type LensUnit,
} from './lens-shared';
import {
  DEFAULT_SUPPLIER_LENS_SETTINGS,
  isDefaultSupplierLensSettings,
  parseSupplierLensSettings,
  parseTopNInput,
  serializeSupplierLensSettings,
  setTopN,
  supplierBandLabel,
  supplierBandRampClass,
  supplierBandRampStop,
  SUPPLIER_LENS_ID,
  SUPPLIER_LENS_MIXED_CLASS,
  SUPPLIER_LENS_RAMP,
} from './supplier-lens-settings';

/**
 * The lens's PORT onto its one read — the project's adapter idiom at the smallest
 * possible scale, and the same one its two siblings carry.
 *
 * The default adapter is the server action and is what production always uses. It is
 * injectable for exactly one reason: the gated dev fixture at
 * `/dev/table-playground/supplierlens` has no session, so the real action can only ever
 * return `not_signed_in` there — and a panel that can only be LOOKED at in its refusal
 * state cannot be reviewed for colour, contrast or layout.
 */
export interface SupplierLensAdapter {
  fetchLens: (topN: number) => Promise<BlockingSupplierLensResult>;
}

const LIVE_ADAPTER: SupplierLensAdapter = {
  fetchLens: (topN) => fetchBlockingSupplierLens(topN),
};

export function SupplierLensPanel({
  data,
  onClassifierChange,
  adapter = LIVE_ADAPTER,
}: BlockingLensPanelProps & { adapter?: SupplierLensAdapter }) {
  const { settings, patch, reset } = useLensSettings(
    SUPPLIER_LENS_ID,
    DEFAULT_SUPPLIER_LENS_SETTINGS,
    parseSupplierLensSettings,
    serializeSupplierLensSettings,
  );

  const [lens, setLens] = React.useState<BlockingSupplierLens | null>(null);
  const [lensRefusal, setLensRefusal] = React.useState<string | null>(null);
  const [lensPending, setLensPending] = React.useState(false);

  /** Which band rows are isolated. Empty = show every band (the "ratio'd" view). */
  const [picked, setPicked] = React.useState<Set<number>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [topNDraft, setTopNDraft] = React.useState('');
  const [topNError, setTopNError] = React.useState<string | null>(null);

  // Held in a ref so a caller passing an inline adapter object cannot re-trigger the
  // fetch effect on every render.
  const adapterRef = React.useRef(adapter);
  React.useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  // ── The read: FIRST REQUEST IMMEDIATELY, then debounced ───────────────────
  //
  // Both halves are the 2026-09-21 stall fix, ported verbatim from its two siblings (the
  // price lens's header carries the full reasoning). In short: a first request created
  // inside a 250 ms `setTimeout` is destroyed by the cleanup of anything that re-mounts
  // the panel within a quarter of a second, and the panel then spins for ever; and a
  // monotonic token guard discarded replies that were still wanted. The guard here is the
  // request's own SIGNATURE — a reply for what is currently wanted is ALWAYS applied —
  // and the first look fires on the mount frame with no timer to lose.
  const signature = String(settings.topN);
  const wantRef = React.useRef('');
  const firstDoneRef = React.useRef(false);
  const [lensNonce, setLensNonce] = React.useState(0);
  const [lensStalled, setLensStalled] = React.useState(false);
  const watchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatchdog = React.useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const topN = settings.topN;

  React.useEffect(() => {
    wantRef.current = signature;
    setLensPending(true);
    setLensStalled(false);

    const run = () => {
      void adapterRef.current
        .fetchLens(topN)
        .then((res) => {
          if (wantRef.current !== signature) return;
          if (res.ok) {
            setLens(res.lens);
            setLensRefusal(null);
            return;
          }
          // The previous tint STAYS: a refusal about a new N is not a reason to blank
          // the picture the reader is looking at.
          setLensRefusal(res.message);
        })
        .catch((err: unknown) => {
          if (wantRef.current !== signature) return;
          errorToast('Could not work out the supplier lens', {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (wantRef.current !== signature) return;
          stopWatchdog();
          setLensPending(false);
          setLensStalled(false);
        });
    };

    const arm = (ms: number) => {
      stopWatchdog();
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        if (wantRef.current === signature) setLensStalled(true);
      }, ms);
    };

    if (!firstDoneRef.current) {
      firstDoneRef.current = true;
      arm(LENS_STALL_MS);
      run();
      return stopWatchdog;
    }
    const timer = setTimeout(run, LENS_DEBOUNCE_MS);
    arm(LENS_DEBOUNCE_MS + LENS_STALL_MS);
    return () => {
      clearTimeout(timer);
      stopWatchdog();
    };
  }, [topN, signature, lensNonce, stopWatchdog]);

  // A band set that no longer exists must not stay picked — three bands isolated and
  // then N lowered would isolate a band index that is now somebody else's. Cleared on N
  // changing (an event), never on every payload.
  React.useEffect(() => {
    setPicked(new Set());
  }, [topN]);

  // ── Publish the classifier ────────────────────────────────────────────────
  //
  // THE TINT IS DOMINANCE. `bandIndex` on a block is the band of its BIGGEST supplier,
  // and the cell wears that band's colour whatever the mix — the ratio bar is where the
  // apportioned truth lives, and a cell can only be one colour.
  const classifier: BlockingLensClassifier | null = React.useMemo(() => {
    if (!lens) return null;
    const byBlock = lens.bandByBlock;
    const blocks = lens.blockByLoc;
    return (locKey: string) => {
      const band = byBlock[locKey];
      if (band === undefined) {
        // No supplier at all — the batch has no delivery. Left exactly as it looks with
        // no lens open, and NEVER folded into `others`.
        return null;
      }
      const block = blocks[locKey];
      const bandDef = lens.bands[band];
      const cls = bandDef ? supplierBandRampClass(bandDef) : '';
      // THE FULL SPLIT on hover, in the payload's own order (biggest delivered first).
      const title = block
        ? block.suppliers
            .map((s) => `${s.display} ${s.sharePct.toFixed(0)}%`)
            .join(' · ')
        : undefined;
      // `isMixed` is the VIEW's `supplier_count_in_block > 1`, carried — never
      // `suppliers.length`.
      const mixed = block?.isMixed ? ` ${SUPPLIER_LENS_MIXED_CLASS}` : '';

      if (picked.size === 0) {
        return { className: `${cls}${mixed}`, title };
      }
      if (picked.has(band)) {
        return { className: `${cls} lens-band-picked${mixed}`, title };
      }
      return { dimmed: true };
    };
  }, [lens, picked]);

  React.useEffect(() => {
    onClassifierChange(classifier);
  }, [classifier, onClassifierChange]);

  // Un-lens the grid when this lens goes away. A separate unmount-only effect, so a
  // classifier CHANGE never passes through a null and flashes the grid back to plain.
  const publishRef = React.useRef(onClassifierChange);
  React.useEffect(() => {
    publishRef.current = onClassifierChange;
  }, [onClassifierChange]);
  React.useEffect(() => () => publishRef.current(null), []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const togglePicked = React.useCallback((index: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const commitTopN = React.useCallback(
    (value: number) => {
      const res = setTopN(value);
      if (!res.ok) {
        setTopNError(res.message);
        return;
      }
      setTopNError(null);
      setTopNDraft('');
      patch({ topN: res.topN });
    },
    [patch],
  );

  const applyTopNDraft = React.useCallback(() => {
    const parsed = parseTopNInput(topNDraft);
    if (!parsed.ok) {
      setTopNError(parsed.message);
      return;
    }
    commitTopN(parsed.value);
  }, [commitTopN, topNDraft]);

  const setUnit = React.useCallback((unit: LensUnit) => patch({ unit }), [patch]);

  /**
   * WHICH SHARE the legend and the bar show — and it is not one number in two units.
   *
   * `kg` reads `kgSharePct`, computed on APPORTIONED kilograms (each supplier's own slice
   * of every block it appears in). `blocks` reads `blockSharePct`, computed on DOMINANT
   * blocks. See the header note: these are two attributions, not two scalings.
   */
  const share = React.useCallback(
    (band: BlockingSupplierBand) =>
      settings.unit === 'kg' ? band.kgSharePct : band.blockSharePct,
    [settings.unit],
  );

  // ── Derived view models (labels and strings only — no arithmetic) ──────────

  const bandRows = React.useMemo(
    () =>
      (lens?.bands ?? []).map((b) => ({
        index: b.index,
        label: supplierBandLabel(b),
        sharePct: share(b),
        // The quiet second line names BOTH attributions, because the two figures
        // legitimately disagree and a reader must be able to see which is which.
        detail: `${formatLensBlocks(b.dominantBlockCount)} dominant · ${formatLensKg(
          b.apportionedKg,
        )} apportioned${b.mixedBlockCount > 0 ? ` · ${b.mixedBlockCount} mixed` : ''}`,
        // NOMINAL: the band's own slot, never its position across a gradient.
        rampStop: supplierBandRampStop(b),
      })),
    [lens, share],
  );

  const customised = !isDefaultSupplierLensSettings(settings);

  /**
   * THE PRINTED SUMMARY's model — this lens as it is configured RIGHT NOW.
   *
   * Built here rather than in the print component, because only the lens knows what its
   * settings mean. Nothing is computed: every figure is the payload's own, formatted by
   * the shared formatters, and the per-band block lists are a BUCKETING of `bandByBlock`
   * (a lookup, never a sum) joined to the grid's own `data` map.
   *
   * There is NO price gate here and there must never be one: nothing in this payload is
   * money and none of it is derivable into money.
   */
  const printModel: LensSummaryPrintModel | null = React.useMemo(() => {
    if (!lens) return null;
    const bandCount = lens.bands.length;

    const { byBand, excludedRows } = buildLensSummaryBuckets({
      data,
      bandOf: (loc) => lens.bandByBlock[loc],
      figureOf: (loc) => {
        const block = lens.blockByLoc[loc];
        if (!block) return LENS_EMDASH;
        const pct =
          block.dominantSharePct === null ? '' : ` ${block.dominantSharePct.toFixed(0)}%`;
        return `${block.dominantSupplierDisplay}${pct}${block.isMixed ? ' (mixed)' : ''}`;
      },
      // Biggest pile first inside a warehouse — the balance the cell itself shows.
      sortKeyOf: (loc) => lens.blockByLoc[loc]?.kg ?? 0,
      formatKg: formatLensKg,
      formatBlocks: formatLensBlocks,
      excludedFigure: LENS_EMDASH,
    });

    const visible = lens.bands.filter((b) => picked.size === 0 || picked.has(b.index));

    return {
      // THE TITLE IS THE LENS'S NAME. The settings line says what it is set to.
      title: 'Supplier lens',
      settingsLine: [
        `Top ${lens.topN} of ${lens.total.supplierCount} suppliers`,
        `${lens.total.mixedBlockCount} mixed blocks`,
        `by ${settings.unit === 'kg' ? 'apportioned kilograms' : 'dominant blocks'}`,
      ].join(' · '),
      unit: settings.unit,
      ramp: SUPPLIER_LENS_RAMP,
      bandCount,
      figureColumnLabel: 'Supplier',
      bands: visible.map((b) => ({
        index: b.index,
        label: supplierBandLabel(b),
        // A COUNT is dominance; the kilograms beside it are the apportioned slice.
        blocks: formatLensBlocks(b.dominantBlockCount),
        kg: formatLensKg(b.apportionedKg),
        sharePct: share(b),
        share: formatLensSharePct(share(b)),
        figure: `${formatLensKg(b.dominantKg)} dominant`,
        rampStop: supplierBandRampStop(b),
        warehouses: byBand.get(b.index) ?? [],
      })),
      total: {
        blocks: formatLensBlocks(lens.total.blockCount),
        kg: formatLensKg(lens.total.kg),
        figure: `${lens.total.supplierCount} suppliers`,
        figureNote: '',
      },
      excluded:
        lens.unattributed.blockCount > 0
          ? {
              title: `No supplier ${LENS_EMDASH} ${formatLensBlocks(
                lens.unattributed.blockCount,
              )}, ${formatLensKg(lens.unattributed.kg)}`,
              note: 'In no band and out of both percentages. A batch with no delivery has no supplier, which is not the same as being Others.',
              rows: excludedRows,
            }
          : null,
    };
  }, [lens, data, picked, settings.unit, share]);

  /** THE BAR'S HEADLINE — `17 suppliers · 23 mixed`. The payload's own figures. */
  const headline = lens
    ? `${lens.total.supplierCount} suppliers · ${lens.total.mixedBlockCount} mixed`
    : 'Working out suppliers…';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ═══ THE LEGEND BAR — one line, never wrapping ═══════════════════════ */}
      <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
        {headline}
      </span>

      {lens ? (
        <LensBandChips
          rows={bandRows}
          ramp={SUPPLIER_LENS_RAMP}
          picked={picked}
          onToggle={togglePicked}
        />
      ) : (
        <span className="shrink-0 text-[10px] text-muted-foreground">…</span>
      )}

      {lens && (
        <div className="hidden w-[110px] shrink-0 lg:block">
          {/* THE RATIO BAR IS APPORTIONED (via `kgSharePct`), never dominance —
              see the header note on the two attributions. */}
          <LensRatioBar
            ramp={SUPPLIER_LENS_RAMP}
            segments={lens.bands.map((b) => ({
              key: b.index,
              sharePct: share(b),
              rampStop: supplierBandRampStop(b),
            }))}
            ariaLabel={lens.bands
              .map(
                (b) =>
                  `${supplierBandLabel(b)}: ${formatLensSharePct(share(b))} by ${
                    settings.unit === 'kg' ? 'apportioned kilograms' : 'dominant blocks'
                  }`,
              )
              .join('; ')}
          />
        </div>
      )}

      {/* No supplier at all — its OWN chip, never a band and never "Others". */}
      {lens && lens.unattributed.blockCount > 0 && (
        <LensExcludedChip
          title={`No supplier ${LENS_EMDASH} ${lens.unattributed.blockCount}`}
          note={`${formatLensBlocks(lens.unattributed.blockCount)}, ${formatLensKg(
            lens.unattributed.kg,
          )} whose batch has no delivery at all. In no band and out of both percentages — that is not the same as being Others.`}
        />
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {lensPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {(lensStalled || lensRefusal) && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive cursor-pointer"
            title="Open Settings to read the problem, copy it, and retry"
          >
            <AlertTriangle className="h-3 w-3" />
            <span className="max-sm:hidden">Problem</span>
          </button>
        )}
        {/* PRINT — no price gate: there is no money in this payload, so every role can
            print it. */}
        <LensSummaryPrintControl model={printModel} lensLabel="supplier" />
        <LensUnitSwitch unit={settings.unit} onChange={setUnit} />
        <LensSettingsPopover
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          label="Supplier lens settings"
          customised={customised}
        >
          {/* ── (1) The yard's suppliers ──────────────────────────────────── */}
          <section className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Suppliers in the yard
            </span>
            <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
              {lens ? (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-base font-bold text-foreground">
                      {lens.total.supplierCount}
                      <span className="ml-1 text-[11px] font-semibold text-muted-foreground">
                        suppliers
                      </span>
                    </span>
                    {lensPending && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                    {formatLensBlocks(lens.total.mixedBlockCount)} hold more than one
                    supplier, of {formatLensBlocks(lens.total.blockCount)} occupied.
                  </p>
                  {/* THE ONE LINE that keeps the two attributions apart. */}
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                    The grid tint and every block count are DOMINANCE — the blocks where a
                    supplier is biggest. The ratio bar is APPORTIONED — each supplier&apos;s
                    own slice of every block it appears in.
                  </p>
                </>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Working out whose charcoal is in the yard…
                </p>
              )}
            </div>
          </section>

          {/* ── (2) The detailed band rows, and the no-supplier row ───────── */}
          {lens && (
            <section className="flex flex-col gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Bands
              </span>

              <LensBandRows
                rows={bandRows}
                ramp={SUPPLIER_LENS_RAMP}
                picked={picked}
                onToggle={togglePicked}
              />

              {lens.unattributed.blockCount > 0 && (
                <LensExcludedRow
                  title={`No supplier ${LENS_EMDASH} ${formatLensBlocks(
                    lens.unattributed.blockCount,
                  )}, ${formatLensKg(lens.unattributed.kg)}`}
                  note="In no band, and out of both percentages — a batch with no delivery has no supplier, which is not the same as being Others. Those cells keep their normal look."
                />
              )}

              <p className="text-[10px] text-muted-foreground">
                {formatLensBlocks(lens.total.blockCount)} occupied · {formatLensKg(lens.total.kg)}
                {picked.size > 0 && (
                  <>
                    {' '}
                    ·{' '}
                    <button
                      type="button"
                      onClick={() => setPicked(new Set())}
                      className="font-semibold text-foreground underline decoration-dotted cursor-pointer"
                    >
                      show all bands
                    </button>
                  </>
                )}
              </p>
            </section>
          )}

          {lensRefusal && (
            <RefusalBanner message={lensRefusal} onRetry={() => setLensNonce((n) => n + 1)} />
          )}

          {lensStalled && !lensRefusal && (
            <RefusalBanner
              message={
                'The supplier lens did not come back. The bands on screen (if any) are from an earlier read. ' +
                'Retry, or reload the page; if it keeps happening, copy this and send it on.'
              }
              onRetry={() => setLensNonce((n) => n + 1)}
            />
          )}

          {/* ── (3) Top suppliers ─────────────────────────────────────────── */}
          <section className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Top suppliers
            </span>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Name the biggest {BLOCKING_SUPPLIER_LENS_MIN_TOP_N}
              {LENS_EMDASH}
              {BLOCKING_SUPPLIER_LENS_MAX_TOP_N}. Everyone else is one Others band.
            </p>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                min={BLOCKING_SUPPLIER_LENS_MIN_TOP_N}
                max={BLOCKING_SUPPLIER_LENS_MAX_TOP_N}
                step={1}
                value={topNDraft === '' ? settings.topN : topNDraft}
                aria-label="How many suppliers to name"
                onChange={(e) => {
                  setTopNDraft(e.target.value);
                  setTopNError(null);
                }}
                onBlur={applyTopNDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyTopNDraft();
                  }
                }}
                className="h-6 w-16 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] text-foreground"
              />
              <button
                type="button"
                onClick={applyTopNDraft}
                className="h-6 rounded-md border border-border bg-muted px-2 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer"
              >
                Apply
              </button>
              {customised && (
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setTopNDraft('');
                    setTopNError(null);
                  }}
                  className="h-6 rounded-md px-1.5 text-[10px] font-semibold text-muted-foreground underline decoration-dotted transition-colors duration-150 hover:text-foreground cursor-pointer"
                >
                  Reset
                </button>
              )}
            </div>
            {topNError && (
              <p className="text-[10px] leading-snug text-destructive">{topNError}</p>
            )}
          </section>
        </LensSettingsPopover>
      </div>
    </>
  );
}

/**
 * The registration.
 *
 * `canShow: () => true`, for the same reason the age lens reads it: there is no money in
 * this payload and none of it is derivable into money, so Production — the role that
 * actually walks the yard and knows whose truck came in — sees this lens.
 */
export const SUPPLIER_LENS: BlockingLensDefinition = {
  id: SUPPLIER_LENS_ID,
  label: 'Supplier',
  icon: Users,
  blurb: 'Light up the yard by whose charcoal is in each block.',
  ramp: SUPPLIER_LENS_RAMP,
  canShow: () => true,
  Panel: SupplierLensPanel,
};
