'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE SUPPLIER LENS — "whose charcoal is in my yard", on the grid itself.
//
// The THIRD lens on the frame the price lens built, registered AFTER Age. Owner-approved
// direction: *"top suppliers as bands, colour each block by its biggest supplier, mark
// mixed blocks."* Same shared legend, same ratio bar, same Settings popover — and four
// deliberate differences from its two siblings.
//
// ── 1. THE LENS IS NOT GATED; EXACTLY ONE COLUMN IS ─────────────────────────
// The price lens refuses a `!canViewPrices()` caller before touching the database, because
// band membership there pins a block's ₱/kg to within a peso. That argument has NO analogue
// here: bands are SUPPLIERS, and a supplier's name beside a kilogram total says nothing
// about what it cost. So `SUPPLIER_LENS.canShow` is `() => true`, Production sees this lens,
// and every band, kilogram, share and the ratio bar — and the **Print button** — are
// unconditional. Do not "tidy up" the asymmetry with its price sibling.
//
// Since 2026-09-22 the payload does carry **exactly two ₱ keys**, `kgWeightedPhpKg` and
// `pricedDominantKg` per band and on `total`, which `fetchBlockingSupplierLens` NULLS
// server-side beside `pricesHidden: true` for a reader without the flag (the
// `fetchBlendAnalysis` idiom, narrowed from a section to two keys). This panel therefore
// reads `caps.canViewPrices` in ONE place — `showPrice` — and it decides one thing only:
// whether the printed band table's last column is **₱/kg** or **Mixed**. A null ₱ means two
// different things and only `pricesHidden` tells them apart, so both halves are read; see
// `showPrice`'s own note.
//
// The SECOND read, added the same day, is PRINT-ONLY and is gated the same way — see
// `SupplierLensAdapter.fetchMarket`. It fills page one's PRICE vs VOLUME panels and table
// (the owner's *"utilize the existing price-to-volume graph / area graph"*), is asked for
// only when the effective flag is true, and its whole section is ABSENT — not blank, not
// zeroed — otherwise. The band table, the yard map and the per-band pages are unaffected.
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

import { fetchBlockingSupplierLens, fetchBlockingSupplierMarket } from '../actions';
import {
  BLOCKING_SUPPLIER_LENS_MAX_TOP_N,
  BLOCKING_SUPPLIER_LENS_MIN_TOP_N,
  BLOCKING_SUPPLIER_MARKET_DEFAULT_MONTHS,
  type BlockingSupplierBand,
  type BlockingSupplierLens,
  type BlockingSupplierLensResult,
  type BlockingSupplierMarket,
  type BlockingSupplierMarketResult,
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
import { buildLensSupplierMarketPrintModel } from './lens-market-model';
import {
  LENS_SUPPLIER_MARKET_PANEL_COLS,
  LensSupplierMarketSection,
} from './lens-supplier-market-print';
import { buildLensYardMap } from './lens-yard-map-model';
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
  /**
   * The PRINT-ONLY second read (2026-09-22) — the per-supplier price-and-volume history
   * page one's PRICE vs VOLUME panels and table are built from.
   *
   * ⚠️ **IT IS MONEY ALMOST END TO END** (including `priceVolumeCorr`, which is DERIVED from
   * price and is price information however it is labelled), so the action REFUSES a
   * `!canViewPrices()` caller — and this panel does not even ASK when the effective flag is
   * false. It is in no signature and no dependency of the band read, so it can never delay
   * or re-trigger the tint; a refusal or an error leaves the section out of the printed
   * model, and the sheet then prints page one exactly as it did before.
   */
  fetchMarket: (
    months: number,
    supplierKeys: readonly string[],
  ) => Promise<BlockingSupplierMarketResult>;
}

const LIVE_ADAPTER: SupplierLensAdapter = {
  fetchLens: (topN) => fetchBlockingSupplierLens(topN),
  fetchMarket: (months, supplierKeys) => fetchBlockingSupplierMarket(months, supplierKeys),
};

/**
 * The separator that joins the named band keys into ONE primitive an effect can depend on,
 * and splits them back out again.
 *
 * ⚠️ **IT MUST NOT BE THE EMPTY STRING, AND IT MUST NOT BE A RAW CONTROL BYTE.**
 *
 *   - `''` would make `split` return ONE CHARACTER PER LETTER — `['O','R','N',…]` — which
 *     matches no `canonical_supplier()` name, so the read would succeed, return no entry,
 *     and the printed section would render an empty table NAMING every band as having no
 *     purchase history. A silent failure that looks like data.
 *   - A literal `U+0001` typed into the source works at runtime and is **invisible in a
 *     diff, in a review and in most editors** — it renders as `join('')`, i.e. exactly the
 *     bug above. Written as an ESCAPE it is the same byte and a reader can see it.
 *
 * `U+0001` can never occur inside a canonical supplier name, so it can never split one in
 * half. `scripts/verify-blocking-lens-ui.ts` pins both halves: the escape is used, and no
 * raw control byte appears anywhere in the file.
 */
const SUPPLIER_KEY_SIG_SEP = '\u0001';

/** `₱43.5690` split for the printed sheet's ACCOUNTING column. Four decimals, as SQL gives. */
const PESO = '₱';
function pesoAmount(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

export function SupplierLensPanel({
  data,
  caps,
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

  // ── THE PRICE-vs-VOLUME READ — print only, and price-gated BEFORE it is made ──
  //
  // The owner, on page one's barren lower half: *"utilize the existing price-to-volume
  // graph / area graph; a table that shows the direction of price per supplier and its
  // relationship with the volume delivered."*
  //
  // ⚠️ **`others` IS NOT A SUPPLIER**, so only the NAMED bands' keys are asked about. The
  // fold has no key (`key: null`, `isOthers: true`) and the market view is keyed on real
  // canonical suppliers; aggregating a fold here would be a TypeScript average of weighted
  // prices, which is the one thing this directory may not do.
  //
  // The two identities AGREE — the lens keys on
  // `canonical_supplier(split_part(supplier,' - ',1))` and the market view on
  // `canonical_supplier(supplier)` — and that is MEASURED every verify run rather than
  // assumed, which is what makes handing these keys straight in legal.
  const namedKeys = React.useMemo(
    () =>
      (lens?.bands ?? [])
        .filter((b): b is BlockingSupplierBand & { key: string } => !b.isOthers && b.key !== null)
        .map((b) => b.key),
    [lens],
  );
  /**
   * A string, so an array rebuilt on every render cannot re-fire the read. The effect
   * SPLITS it back apart to recover the keys — which is what lets its dependency be a
   * primitive — so the separator is load-bearing. See `SUPPLIER_KEY_SIG_SEP`.
   */
  const namedKeysSig = namedKeys.join(SUPPLIER_KEY_SIG_SEP);

  const [market, setMarket] = React.useState<BlockingSupplierMarket | null>(null);
  React.useEffect(() => {
    // THE GATE IS BEFORE THE REQUEST. The action refuses a price-denied caller anyway; not
    // asking at all is what keeps a Production reader's sheet free of a pointless round
    // trip and this panel free of a refusal it would have to ignore.
    if (!caps.canViewPrices || namedKeysSig === '') {
      setMarket(null);
      return;
    }
    let cancelled = false;
    const keys = namedKeysSig.split(SUPPLIER_KEY_SIG_SEP);
    void adapterRef.current
      .fetchMarket(BLOCKING_SUPPLIER_MARKET_DEFAULT_MONTHS, keys)
      .then((res) => {
        if (!cancelled) setMarket(res.ok ? res.market : null);
      })
      .catch(() => {
        // Quietly: this read is not on the screen's critical path, so a failure takes the
        // printed section away and says nothing. See the adapter's doc.
        if (!cancelled) setMarket(null);
      });
    return () => {
      cancelled = true;
    };
  }, [caps.canViewPrices, namedKeysSig]);

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

  /**
   * ⚠️ MAY THIS READER SEE THE BAND'S ₱/kg? — BOTH halves, and neither alone.
   *
   * `caps.canViewPrices` is the grid's EFFECTIVE flag (`serverCanViewPrices && showPrices`),
   * so flipping the page's own Prices toggle off takes the column away exactly as being
   * Production does. `lens.pricesHidden` is the payload's own statement that the two ₱ keys
   * were **WITHHELD rather than absent** — `fetchBlockingSupplierLens` nulls
   * `kgWeightedPhpKg` / `pricedDominantKg` server-side and sets the flag, so a null here can
   * mean two different things and only the flag tells them apart (data-layer contract:
   * *"null + pricesHidden = WITHHELD; null + pricedDominantKg 0 = dominates no priced
   * block"*). Reading only the cap would print an em dash where the honest answer is that
   * the figure does not exist; reading only the flag would ignore the toggle.
   *
   * Note what this does NOT gate: the lens itself, its bands, its kilograms, its ratio bar
   * and its **Print button** are unconditional and must stay so — this payload is otherwise
   * peso-free and Production is the role that actually walks the yard.
   */
  const showPrice = caps.canViewPrices && lens !== null && !lens.pricesHidden;

  const bandRows = React.useMemo(
    () =>
      (lens?.bands ?? []).map((b) => ({
        index: b.index,
        label: supplierBandLabel(b),
        sharePct: share(b),
        // The quiet second line names BOTH attributions, because the two figures
        // legitimately disagree and a reader must be able to see which is which — and it is
        // now **the only place `dominantKg` is shown**. The owner, on the printed sheet:
        // *"I don't get the last column — 'kg dominant' — kind of useless."* It left the
        // print and stayed here, because it is still the attribution the TINT is drawn from
        // and the popover is where a reader goes to ask what a colour means.
        detail: [
          `${formatLensBlocks(b.dominantBlockCount)} dominant`,
          `${formatLensKg(b.dominantKg)} dominant`,
          `${formatLensKg(b.apportionedKg)} apportioned`,
          ...(showPrice && b.kgWeightedPhpKg !== null
            ? [`${PESO}${pesoAmount(b.kgWeightedPhpKg)}/kg`]
            : []),
          ...(b.mixedBlockCount > 0 ? [`${b.mixedBlockCount.toLocaleString()} mixed`] : []),
        ].join(' · '),
        // NOMINAL: the band's own slot, never its position across a gradient.
        rampStop: supplierBandRampStop(b),
      })),
    [lens, share, showPrice],
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
   * ── THE BAND TABLE'S LAST COLUMN IS ₱/kg, OR **MIXED** (2026-09-22) ─────────
   * The owner, on the live sheet: *"I don't get the last column — 'kg dominant' — kind of
   * useless. Replace it with average weighted price or something."* He was right: a band row
   * already carried `Blocks` and `Kg`, so a third kilogram figure beside them said nothing a
   * reader could act on. It is now **`kgWeightedPhpKg`** — the kg-weighted mean of
   * `view_blocking_grid.avg_php_kg` over the band's PRICED DOMINANT blocks, i.e. the price of
   * the kilograms on its own row — in the Excel Standard's accounting layout, with the footer
   * labelled `avg of priced` exactly as the price lens's is.
   *
   * **AND IT IS ABSENT, NOT BLANK AND NEVER ₱0, FOR A READER WITHOUT THE PRICE FLAG.** The
   * column then heads **Mixed** and carries `mixedBlockCount`, so the table keeps its width
   * and a Production reader still gets a last column worth reading rather than a row of em
   * dashes. That is the data layer's own rule: the two ₱ keys are WITHHELD (nulled
   * server-side beside `pricesHidden: true`), and a withheld figure is not a figure of zero.
   *
   * Everything ELSE here is unconditional, including the Print button: the rest of this
   * payload is peso-free.
   */
  const printModel: LensSummaryPrintModel | null = React.useMemo(() => {
    if (!lens) return null;
    const bandCount = lens.bands.length;
    // Recomputed inside the memo rather than closed over, so the memo's dependency is the
    // flag itself and not a value that changed shape between renders.
    const priced = caps.canViewPrices && !lens.pricesHidden;

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

    // THE YARD MAP page — the SAME `bandOf` lookup the buckets above use, so the map and
    // the per-band tables can never place a block in two different bands. This is the one
    // lens that can answer `isMixed`, and it reads the VIEW's carried ALL/SOME column
    // rather than a list length, exactly as the grid classifier does.
    const yardMap = buildLensYardMap({
      data,
      bandOf: (loc) => lens.bandByBlock[loc],
      isMixed: (loc) => lens.blockByLoc[loc]?.isMixed === true,
    });

    const visible = lens.bands.filter((b) => picked.size === 0 || picked.has(b.index));

    // ── PAGE ONE'S PRICE vs VOLUME ───────────────────────────────────────────
    // Present only when the reader may see prices AND the read landed. The LABEL comes from
    // the LENS's own `display` (`Ornales`) joined on `key`: the analytics view publishes
    // only the CANONICAL name, so its own `display` equals its `key` (`ORNALES`) — the data
    // layer's contract says to take the label from here.
    const marketSection =
      !priced || market === null
        ? null
        : buildLensSupplierMarketPrintModel({
            market,
            displayByKey: new Map(
              lens.bands
                .filter((b) => !b.isOthers && b.key !== null)
                .map((b) => [b.key as string, b.display ?? (b.key as string)]),
            ),
            requestedKeys: namedKeys,
            maxPanels: LENS_SUPPLIER_MARKET_PANEL_COLS * 2,
          });

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
      // The PER-BLOCK tables still name the block's dominant supplier — right per row. The
      // BAND table heads its own column, because a band row already IS a supplier.
      figureColumnLabel: 'Supplier',
      bandFigureColumnLabel: priced ? '₱/kg' : 'Mixed',
      // ⚠️ THE WHOLE SECTION IS ABSENT for a price-denied reader — no chart, no table, not
      // an empty one. The lens itself still prints in full.
      page1Extra:
        marketSection === null ? null : <LensSupplierMarketSection model={marketSection} />,
      bands: visible.map((b) => ({
        index: b.index,
        label: supplierBandLabel(b),
        // A COUNT is dominance; the kilograms beside it are the apportioned slice.
        blocks: formatLensBlocks(b.dominantBlockCount),
        kg: formatLensKg(b.apportionedKg),
        sharePct: share(b),
        share: formatLensSharePct(share(b)),
        // ⚠️ NULL IS AN EM DASH, NEVER ₱0 — a band that dominates no PRICED block has no
        // price, which is a different statement from a free one (the L-008 placeholder).
        figure: priced
          ? b.kgWeightedPhpKg === null
            ? LENS_EMDASH
            : `${PESO}${pesoAmount(b.kgWeightedPhpKg)}`
          : `${b.mixedBlockCount.toLocaleString()} mixed`,
        figureAccounting:
          priced && b.kgWeightedPhpKg !== null
            ? { symbol: PESO, amount: pesoAmount(b.kgWeightedPhpKg) }
            : null,
        rampStop: supplierBandRampStop(b),
        warehouses: byBand.get(b.index) ?? [],
      })),
      total: {
        blocks: formatLensBlocks(lens.total.blockCount),
        kg: formatLensKg(lens.total.kg),
        figure: priced
          ? lens.total.kgWeightedPhpKg === null
            ? LENS_EMDASH
            : `${PESO}${pesoAmount(lens.total.kgWeightedPhpKg)}`
          : `${lens.total.mixedBlockCount.toLocaleString()} mixed`,
        figureAccounting:
          priced && lens.total.kgWeightedPhpKg !== null
            ? { symbol: PESO, amount: pesoAmount(lens.total.kgWeightedPhpKg) }
            : null,
        // THE DOCUMENTED ASYMMETRY, said on the sheet in the price lens's own words: the
        // counts cover every occupied block, the ₱/kg covers the PRICED ones. A `Mixed`
        // column needs no qualifier — it counts exactly what its header says.
        figureNote: priced ? 'avg of priced' : '',
      },
      yardMap,
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
  }, [lens, data, picked, settings.unit, share, caps.canViewPrices, market, namedKeys]);

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
