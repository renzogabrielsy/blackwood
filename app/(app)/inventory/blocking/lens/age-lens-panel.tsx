'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE AGE LENS — "show me the charcoal that has been sitting", on the grid itself.
//
// The SECOND lens on the frame the price lens built. Same shape, same shared rows,
// same ratio bar, same Customize disclosure — and three deliberate differences.
//
// ── 1. THERE IS NO PRICE GATE, AND THAT IS THE POINT ────────────────────────
// The price lens refuses a `!canViewPrices()` caller before touching the database,
// because band membership there pins a block's ₱/kg to within a peso. That argument
// has NO analogue here: this payload is days, kilograms, counts and percentages, and
// no money figure is derivable from any of it (asserted, not promised — the verify
// script scans every key of the live payload against /php|peso|cost|price|value/).
// So `AGE_LENS.canShow` is `() => true` and Production — the role that actually
// walks the yard — sees this lens. Do not "tidy up" the asymmetry with its sibling.
//
// ── 2. THE RAMP IS NOT THE COST RAMP ────────────────────────────────────────
// Emerald→amber→rose means cheap→dear on this page. Painting an old block red would
// be read as "expensive", which is a fact about a different column. The age lens
// declares `ramp: 'age'` (sky → indigo → violet → fuchsia) and every shared piece
// derives its swatch from that id, so no class name is spelled here.
//
// ── 3. NULL IS NEVER 0 DAYS ─────────────────────────────────────────────────
// A block whose batch has NO dated delivery has no age at all. It is ABSENT from
// `bandByBlock` and `ageByBlock`, so the classifier returns `null` for it and the
// cell keeps its normal un-lensed look; it is reported on its own muted row. Calling
// it "brand new" would be the ₱11.01-vs-₱39.99 `avg_cost` bug in its third costume.
// The same discipline runs through the panel: an empty band's weighted age reads as
// an em dash, never as `0.0 d`.
//
// ── THIS FILE COMPUTES NO STATISTIC ─────────────────────────────────────────
// Every kilogram, block count, share and weighted age is read verbatim out of
// `fetchBlockingAgeLens`'s payload. No `reduce`, no running total, no division by a
// total — the ratio bar's widths ARE the published shares (SQL guarantees they sum
// to 100, proven against the live database by `scripts/verify-blocking-age-lens.ts`).
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { AlertTriangle, Hourglass, Loader2 } from 'lucide-react';

import { errorToast } from '@/lib/toast';

import { fetchBlockingAgeLens } from '../actions';
import {
  BLOCKING_AGE_EDGE_MAX_DAYS,
  BLOCKING_AGE_EDGE_MIN_DAYS,
  BLOCKING_AGE_LENS_MAX_EDGES,
  type BlockingAgeBand,
  type BlockingAgeLens,
  type BlockingAgeLensResult,
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
import { LensCustomize, type LensBandNameField, type LensCutLineChip, type LensQuickCut } from './lens-customize';
import { LensRatioBar } from './lens-ratio-bar';
import { RefusalBanner } from './lens-refusal-banner';
import { LensSettingsPopover } from './lens-settings-popover';
import {
  formatLensBlocks,
  formatLensDays,
  formatLensKg,
  formatLensSharePct,
  formatLensWholeDays,
  LENS_DEBOUNCE_MS,
  LENS_EMDASH,
  LENS_STALL_MS,
  type LensUnit,
} from './lens-shared';
import {
  addEdgeDay,
  ageBandLabel,
  ageBandRampClass,
  AGE_LENS_ID,
  AGE_LENS_QUICK_CUTS,
  AGE_LENS_RAMP,
  DEFAULT_AGE_LENS_SETTINGS,
  isDefaultAgeLensSettings,
  bandDayKey,
  parseAgeLensSettings,
  parseEdgeDayInput,
  removeEdgeDay,
  serializeAgeLensSettings,
} from './age-lens-settings';

/**
 * The lens's PORT onto its one read — the project's adapter idiom at the smallest
 * possible scale, and the same one `PriceLensPanel` carries.
 *
 * The default adapter is the server action and is what production always uses. It is
 * injectable for exactly one reason: the gated dev fixture at
 * `/dev/table-playground/agelens` has no session, so the real action can only ever
 * return `not_signed_in` there — and a panel that can only be LOOKED at in its
 * refusal state cannot be reviewed for colour, contrast or layout.
 */
export interface AgeLensAdapter {
  fetchLens: (edgeDays: readonly number[]) => Promise<BlockingAgeLensResult>;
}

const LIVE_ADAPTER: AgeLensAdapter = {
  fetchLens: (edges) => fetchBlockingAgeLens([...edges]),
};

export function AgeLensPanel({
  onClassifierChange,
  onFocusBlock,
  adapter = LIVE_ADAPTER,
}: BlockingLensPanelProps & { adapter?: AgeLensAdapter }) {
  const { settings, patch, reset } = useLensSettings(
    AGE_LENS_ID,
    DEFAULT_AGE_LENS_SETTINGS,
    parseAgeLensSettings,
    serializeAgeLensSettings,
  );

  const [lens, setLens] = React.useState<BlockingAgeLens | null>(null);
  const [lensRefusal, setLensRefusal] = React.useState<string | null>(null);
  const [lensPending, setLensPending] = React.useState(false);

  /** Which band rows are isolated. Empty = show every band (the "ratio'd" view). */
  const [picked, setPicked] = React.useState<Set<number>>(() => new Set());
  /** The Settings popover — everything that used to be the docked sidebar's body. */
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [customizeOpen, setCustomizeOpen] = React.useState(false);
  const [edgeDraft, setEdgeDraft] = React.useState('');
  const [edgeError, setEdgeError] = React.useState<string | null>(null);

  // Held in a ref so a caller passing an inline adapter object cannot re-trigger the
  // fetch effect on every render.
  const adapterRef = React.useRef(adapter);
  React.useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  // ── The classification: FIRST REQUEST IMMEDIATELY, then debounced ─────────
  //
  // Both halves of this are the 2026-09-21 stall fix, and the price lens's header note
  // carries the full reasoning. In short: the only request used to be created inside a
  // 250 ms `setTimeout` whose cleanup runs on every effect re-run AND on unmount, so
  // anything that re-mounted the panel body within a quarter of a second — the lens is
  // opened from a URL param mirrored through `useOptimistic` — destroyed the timer
  // before it fired and NO request was ever issued; and the monotonic token guard then
  // discarded any reply whose token had moved, even when that reply was for exactly the
  // request still wanted, so the stall could not recover. The guard is now the
  // request's own SIGNATURE (**a reply for what is currently wanted is ALWAYS
  // applied**) and the first look fires on the mount frame with no timer to lose.
  const edgeKey = settings.edgeDays.join(',');
  const signature = edgeKey;
  /** The signature the panel currently wants a payload for. */
  const wantRef = React.useRef('');
  /** False until this panel instance has issued its first request. */
  const firstDoneRef = React.useRef(false);
  const [lensNonce, setLensNonce] = React.useState(0);
  /** The watchdog: a stall must be VISIBLE and retryable, never an eternal spinner. */
  const [lensStalled, setLensStalled] = React.useState(false);
  /** The live watchdog timer — CLEARED the moment a reply lands, refusal or not. */
  const watchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatchdog = React.useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    wantRef.current = signature;
    setLensPending(true);
    setLensStalled(false);
    const edges = edgeKey.split(',').map(Number);

    const run = () => {
      void adapterRef.current.fetchLens(edges)
        .then((res) => {
          // A reply for the signature the panel still wants is ALWAYS applied.
          if (wantRef.current !== signature) return;
          if (res.ok) {
            setLens(res.lens);
            setLensRefusal(null);
            return;
          }
          // The previous tint STAYS: a refusal about the new cut lines is not a
          // reason to blank the picture the reader is looking at.
          setLensRefusal(res.message);
        })
        .catch((err: unknown) => {
          if (wantRef.current !== signature) return;
          errorToast('Could not work out the age lens', {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (wantRef.current !== signature) return;
          // The read ANSWERED — payload or refusal. Stop the watchdog before it can
          // call a healthy panel stalled eight seconds later.
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
  }, [edgeKey, signature, lensNonce, stopWatchdog]);

  // A band set that no longer exists must not stay picked — three bands isolated and
  // then a cut line removed would isolate a band index that is now somebody else's.
  // Cleared on the EDGES changing (an event), never on every payload.
  React.useEffect(() => {
    setPicked(new Set());
  }, [edgeKey]);

  // ── Publish the classifier ────────────────────────────────────────────────
  const bandCount = lens?.bands.length ?? 0;
  const classifier: BlockingLensClassifier | null = React.useMemo(() => {
    if (!lens) return null;
    const byBlock = lens.bandByBlock;
    const ages = lens.ageByBlock;
    return (locKey: string) => {
      const band = byBlock[locKey];
      // The age the cell will say on hover. Undefined for a block with no dated
      // delivery — it has no age, so the cell says nothing extra.
      const age = ages[locKey];
      const title =
        age === undefined
          ? undefined
          : `${formatLensDays(age)} days old (average of what's in the block)`;
      if (picked.size === 0) {
        // The "ratio'd" view: every DATED block wears its band. A block absent from
        // the map (undated, or an empty slot) is left exactly as it looks with no
        // lens open — never painted as the freshest band.
        return band === undefined
          ? null
          : { className: ageBandRampClass(band, bandCount), title };
      }
      if (band !== undefined && picked.has(band)) {
        return { className: `${ageBandRampClass(band, bandCount)} lens-band-picked`, title };
      }
      return { dimmed: true };
    };
  }, [lens, picked, bandCount]);

  React.useEffect(() => {
    onClassifierChange(classifier);
  }, [classifier, onClassifierChange]);

  // Un-lens the grid when this lens goes away (panel closed, or another lens
  // selected). A separate unmount-only effect, so a classifier CHANGE never passes
  // through a null and flashes the grid back to plain.
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

  const commitEdge = React.useCallback(
    (days: number) => {
      const res = addEdgeDay(settings.edgeDays, days);
      if (!res.ok) {
        setEdgeError(res.message);
        return;
      }
      setEdgeError(null);
      setEdgeDraft('');
      patch({ edgeDays: res.edgeDays });
    },
    [patch, settings.edgeDays],
  );

  const addEdge = React.useCallback(() => {
    const parsed = parseEdgeDayInput(edgeDraft);
    if (!parsed.ok) {
      setEdgeError(parsed.message);
      return;
    }
    commitEdge(parsed.value);
  }, [commitEdge, edgeDraft]);

  const dropEdge = React.useCallback(
    (days: number) => {
      const res = removeEdgeDay(settings.edgeDays, days);
      if (!res.ok) {
        setEdgeError(res.message);
        return;
      }
      setEdgeError(null);
      patch({ edgeDays: res.edgeDays });
    },
    [patch, settings.edgeDays],
  );

  const renameBand = React.useCallback(
    (key: string, name: string) => {
      const next = { ...settings.bandNames };
      const trimmed = name.trim().slice(0, 40);
      if (trimmed === '') delete next[key];
      else next[key] = trimmed;
      patch({ bandNames: next });
    },
    [patch, settings.bandNames],
  );

  const resetBands = React.useCallback(() => {
    setEdgeError(null);
    patch({ edgeDays: [...DEFAULT_AGE_LENS_SETTINGS.edgeDays], bandNames: {} });
  }, [patch]);

  const setUnit = React.useCallback((unit: LensUnit) => patch({ unit }), [patch]);

  const share = React.useCallback(
    (band: BlockingAgeBand) => (settings.unit === 'kg' ? band.kgSharePct : band.blockSharePct),
    [settings.unit],
  );

  // ── Derived view models (labels and strings only — no arithmetic) ──────────

  const bandRows = React.useMemo(
    () =>
      (lens?.bands ?? []).map((b) => ({
        index: b.index,
        label: ageBandLabel(b, settings.bandNames),
        sharePct: share(b),
        // The quiet second line. The weighted age is the band's OWN published figure
        // and reads as an em dash on an empty band — "no charcoal of this age" is not
        // "0 days old".
        detail: `${formatLensBlocks(b.blockCount)} · ${formatLensKg(b.kg)} · avg ${formatLensDays(
          b.kgWeightedAgeDays,
        )} d`,
      })),
    [lens, settings.bandNames, share],
  );

  const chips: LensCutLineChip[] = React.useMemo(
    () =>
      settings.edgeDays.map((d) => ({
        value: d,
        text: `${d} d`,
        removeLabel: `Remove the ${d}-day cut line`,
      })),
    [settings.edgeDays],
  );

  // Only the cuts NOT already on the scale — a chip whose only outcome is "that cut
  // line is already on the scale" is a button that exists to refuse.
  const quickCuts: LensQuickCut[] = React.useMemo(
    () =>
      AGE_LENS_QUICK_CUTS.filter((d) => !settings.edgeDays.includes(d)).map((d) => ({
        value: d,
        text: `${d} d`,
        title: `Add a cut line at ${d} days`,
      })),
    [settings.edgeDays],
  );

  const nameFields: LensBandNameField[] | undefined = React.useMemo(() => {
    if (!lens) return undefined;
    return lens.bands.map((b) => {
      const key = bandDayKey(b.lowerDays, b.upperDays);
      return {
        key,
        value: settings.bandNames[key] ?? '',
        placeholder: ageBandLabel(b),
        ariaLabel: `Name for the band ${ageBandLabel(b)}`,
      };
    });
  }, [lens, settings.bandNames]);

  const atEdgeCap = settings.edgeDays.length >= BLOCKING_AGE_LENS_MAX_EDGES;
  const customised = !isDefaultAgeLensSettings(settings);
  const oldestLoc = lens?.total.oldestBlockLoc ?? null;

  /** THE BAR'S HEADLINE — `Yard 396.7 d avg`. The payload's figure, never averaged here. */
  const headline = lens
    ? `Yard ${formatLensDays(lens.total.kgWeightedAgeDays)} d avg`
    : 'Working out ages…';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ═══ THE LEGEND BAR — one line, never wrapping ═══════════════════════ */}
      <span
        className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
        title={
          lens?.total.kgWeightedAgeDays == null
            ? undefined
            : `${lens.total.kgWeightedAgeDays} days, weighted by the kilograms still in each block`
        }
      >
        {headline}
      </span>

      {lens ? (
        <LensBandChips
          rows={bandRows}
          ramp={AGE_LENS_RAMP}
          picked={picked}
          onToggle={togglePicked}
        />
      ) : (
        // Never an empty bar: a quiet, shimmer-free placeholder while the read runs.
        <span className="shrink-0 text-[10px] text-muted-foreground">…</span>
      )}

      {lens && (
        <div className="hidden w-[110px] shrink-0 lg:block">
          <LensRatioBar
            ramp={AGE_LENS_RAMP}
            segments={lens.bands.map((b) => ({ key: b.index, sharePct: share(b) }))}
            ariaLabel={lens.bands
              .map(
                (b) =>
                  `${ageBandLabel(b, settings.bandNames)}: ${formatLensSharePct(share(b))} by ${
                    settings.unit
                  }`,
              )
              .join('; ')}
          />
        </div>
      )}

      {/* Undated — its OWN chip, never a band and never 0 days. */}
      {lens && lens.undated.blockCount > 0 && (
        <LensExcludedChip
          title={`No dates ${LENS_EMDASH} ${lens.undated.blockCount}`}
          note={`${formatLensBlocks(lens.undated.blockCount)}, ${formatLensKg(
            lens.undated.kg,
          )} with no dated delivery. In no band and out of every percentage and average — a pile with no dated delivery has no age, which is not the same as being new.`}
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
        <LensUnitSwitch unit={settings.unit} onChange={setUnit} />
        <LensSettingsPopover
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          label="Age lens settings"
          customised={customised}
        >
          {/* ═══ THE POPOVER BODY — what used to be the docked sidebar ═══════ */}
          {/* ── (1) The yard's age ───────────────────────────────────────── */}
      <section className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Average age of the yard
        </span>
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
          {lens ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                {/* One decimal on screen, the full weighted figure on hover. The
                    bands were cut on the EXACT fractional ages, so the tooltip is
                    what makes a 396.6891 that DISPLAYS as 396.7 auditable. */}
                <span
                  className="font-mono text-base font-bold text-foreground"
                  title={
                    lens.total.kgWeightedAgeDays === null
                      ? 'No dated delivery in the yard'
                      : `${lens.total.kgWeightedAgeDays} days`
                  }
                >
                  {formatLensDays(lens.total.kgWeightedAgeDays)}
                  <span className="ml-1 text-[11px] font-semibold text-muted-foreground">days</span>
                </span>
                {lensPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                as of {lens.asOf}
                {lens.total.oldestAgeDays !== null && (
                  <>
                    {' · oldest '}
                    {formatLensWholeDays(lens.total.oldestAgeDays)}
                    {oldestLoc && (
                      <>
                        {' at '}
                        {onFocusBlock ? (
                          <button
                            type="button"
                            onClick={() => onFocusBlock(oldestLoc)}
                            title={`Open ${oldestLoc} on the grid`}
                            className="font-mono font-semibold text-foreground underline decoration-dotted transition-colors duration-150 hover:text-primary cursor-pointer"
                          >
                            {oldestLoc}
                          </button>
                        ) : (
                          <span className="font-mono font-semibold text-foreground">{oldestLoc}</span>
                        )}
                      </>
                    )}
                  </>
                )}
              </p>
              {/* Weighted by KILOGRAMS, and the reader should know which kilograms:
                  the dated ones. Said once, quietly, rather than on every row. */}
              <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                Weighted by the kilograms still in each block, from its deliveries&apos; average
                date.
              </p>
            </>
          ) : (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Working out how old the yard is…
            </p>
          )}
        </div>
      </section>

      {/* ── (2)+(4) The detailed band rows, and the undated row ───────────
             The RATIO BAR and the kg|blocks switch live in the legend BAR — they are
             what a reader glances at, and a second copy here would be a second place
             for the same two controls to disagree. */}
      {lens && (
        <section className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Bands
          </span>

          <LensBandRows
            rows={bandRows}
            ramp={AGE_LENS_RAMP}
            picked={picked}
            onToggle={togglePicked}
          />

          {/* Undated — its OWN row, never a band and never 0 days. */}
          {lens.undated.blockCount > 0 && (
            <LensExcludedRow
              title={`No delivery dates ${LENS_EMDASH} ${formatLensBlocks(
                lens.undated.blockCount,
              )}, ${formatLensKg(lens.undated.kg)}`}
              note="In no band, and out of every percentage and average — a pile with no dated delivery has no age, which is not the same as being new. Those cells keep their normal look."
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

      {/* THE WATCHDOG (2026-09-21) — see the price lens's note. A read that never
          lands must SAY so, with Copy and Retry, rather than spin for ever. */}
      {lensStalled && !lensRefusal && (
        <RefusalBanner
          message={
            'The age lens did not come back. The bands on screen (if any) are from an earlier read. ' +
            'Retry, or reload the page; if it keeps happening, copy this and send it on.'
          }
          onRetry={() => setLensNonce((n) => n + 1)}
        />
      )}

      {/* ── (5) Customize bands ────────────────────────────────────────── */}
      <LensCustomize
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        edgeCount={settings.edgeDays.length}
        maxEdges={BLOCKING_AGE_LENS_MAX_EDGES}
        intro={
          <>
            A cut line is a whole number of days ({BLOCKING_AGE_EDGE_MIN_DAYS}
            {LENS_EMDASH}
            {BLOCKING_AGE_EDGE_MAX_DAYS.toLocaleString()}). {settings.edgeDays.length} line
            {settings.edgeDays.length === 1 ? '' : 's'} give {settings.edgeDays.length + 1} bands.
          </>
        }
        chips={chips}
        onRemoveChip={dropEdge}
        quickCuts={quickCuts}
        onQuickCut={commitEdge}
        draft={edgeDraft}
        onDraftChange={(v) => {
          setEdgeDraft(v);
          setEdgeError(null);
        }}
        onAdd={addEdge}
        addPlaceholder="90"
        addAriaLabel="New cut line, in days"
        atCap={atEdgeCap}
        capNote={`${BLOCKING_AGE_LENS_MAX_EDGES} is the most a lens takes — remove one to add another.`}
        error={edgeError}
        names={nameFields}
        onRename={renameBand}
        onResetBands={resetBands}
        onResetAll={
          customised
            ? () => {
                reset();
                setEdgeDraft('');
                setEdgeError(null);
              }
            : undefined
        }
      />
        </LensSettingsPopover>
      </div>
    </>
  );
}

/**
 * The registration.
 *
 * `canShow: () => true` is the whole difference from its price sibling, and it is
 * load-bearing in two directions: Production sees this lens (there is no money in
 * it), and because the registry now offers at least one lens to every reader, the
 * Highlight button stays on the page for every role with only the Price tab absent.
 */
export const AGE_LENS: BlockingLensDefinition = {
  id: AGE_LENS_ID,
  label: 'Age',
  icon: Hourglass,
  blurb: 'Light up the yard by how long the charcoal has been sitting.',
  ramp: AGE_LENS_RAMP,
  canShow: () => true,
  Panel: AgeLensPanel,
};
