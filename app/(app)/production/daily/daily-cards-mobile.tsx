"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DailyCardsMobile — the Production Daily ledger phone read layer.
//
// Rendered `sm:hidden` by DailyView; the desktop unified `<table>` grid is
// `hidden sm:block` and untouched (editing/keyboard/paste stay desktop-only).
// Built on the platform MobileCardList primitive (Archetype C).
//
// Fed the SAME four arrays the desktop grid loads (shifts/runs/downtime/waste)
// and reshaped through the grid's OWN `buildGridRows()` — one card per run row,
// single source of truth, no refetch. Derived DT TTL / PROD HRS / PROD LOSS /
// TTL WASTE come from the shared `deriveDailyMetrics()` (mirrors the grid's
// inline compute) — never recomputed differently here.
//
// Card headline (≤6): date · batch · shift · TTL KG (metric) · customer ·
// [downtime/waste badge]. Detail sheet SECTION-groups the rest into
// Identity / Production / Downtime / Waste. No ₱ exists in production → no gating.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { cn } from "@/lib/utils";
import { MobileCardList } from "@/components/shared/mobile/mobile-card-list";
import { buildGridRows, type GridRow } from "./daily-ledger-grid";
import { deriveDailyMetrics, hasDowntimeOrWaste } from "./ledger-derive";
import type {
  ProductionShiftRow,
  ProductionRunRow,
  ProductionDowntimeRow,
  ProductionWasteRow,
} from "./actions";

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmt0 = (v: number | null | undefined) =>
  v == null || Number.isNaN(v)
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmt2 = (v: number | null | undefined) =>
  v == null || Number.isNaN(v)
    ? "—"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
/** Waste-stream value: blank dash when empty/zero, else up to 2 dp. */
const fmtStream = (raw: string) => {
  const n = parseFloat(raw);
  return raw.trim() === "" || Number.isNaN(n) || n === 0 ? "—" : fmt2(n);
};

const SHIFT_LABEL: Record<string, string> = { M: "Morning", E: "Evening", N: "Night" };

// ─── Keyed row model ─────────────────────────────────────────────────────────

interface KeyedRow extends GridRow {
  _key: string;
}

export interface DailyCardsMobileProps {
  shifts: ProductionShiftRow[];
  runs: ProductionRunRow[];
  downtime: ProductionDowntimeRow[];
  waste: ProductionWasteRow[];
}

export function DailyCardsMobile({
  shifts,
  runs,
  downtime,
  waste,
}: DailyCardsMobileProps) {
  const rows: KeyedRow[] = React.useMemo(() => {
    const base = buildGridRows(shifts, runs, downtime, waste, "asc");
    return base.map((r, i) => ({
      ...r,
      _key: r._ids.run_id ?? `${r._shiftKey}:${i}`,
    }));
  }, [shifts, runs, downtime, waste]);

  return (
    <MobileCardList<KeyedRow>
      items={rows}
      getKey={(r) => r._key}
      estimateSize={66}
      renderCard={(r) => <DailyCard row={r} />}
      renderDetail={(r) => <DailyDetail row={r} />}
      getDetailTitle={(r) => `${r.grade || "Run"} · ${r.batch || "—"}`}
      getDetailDescription={(r) =>
        `${r.date} · ${SHIFT_LABEL[r.shift_code] ?? r.shift_code} · ${r.customer || "—"}`
      }
      emptyState={
        <div className="animate-fade-up flex h-full flex-col items-center justify-center gap-1 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            Awaiting Production Manager sync.
          </p>
        </div>
      }
    />
  );
}

// ─── Card headline (≤6 fields) ───────────────────────────────────────────────

function DailyCard({ row }: { row: KeyedRow }) {
  const metrics = deriveDailyMetrics(row);
  const badge = row._isPrimary && hasDowntimeOrWaste(metrics);
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span
        className="mt-1 inline-flex h-5 w-6 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] font-semibold uppercase text-muted-foreground"
        aria-hidden
      >
        {row.shift_code || "—"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {row.grade || "—"}
          </span>
          <span className="shrink-0 font-mono text-sm tabular-nums">
            {fmt0(parseFloat(row.ttl_kg))} kg
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
          <span className="tabular-nums">{row.date}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{row.batch || "—"}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{row.customer || "—"}</span>
          {badge ? (
            <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              DT / Waste
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Detail sheet body (section-grouped) ─────────────────────────────────────

function DailyDetail({ row }: { row: KeyedRow }) {
  const m = deriveDailyMetrics(row);
  const primary = row._isPrimary;

  return (
    <div className="flex flex-col gap-4">
      {/* Identity */}
      <Section title="Identity">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Field label="Date" value={row.date} mono />
          <Field label="Batch" value={row.batch || "—"} mono />
          <Field
            label="Shift"
            value={SHIFT_LABEL[row.shift_code] ?? row.shift_code ?? "—"}
          />
        </div>
      </Section>

      {/* Production */}
      <Section title="Production">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Field label="Customer" value={row.customer || "—"} />
          <Field label="Grade" value={row.grade || "—"} />
          <Field label="TTL KG" value={fmt0(parseFloat(row.ttl_kg))} mono />
        </div>
        <Field
          label="Remarks"
          value={row.run_remarks?.trim() ? row.run_remarks : "—"}
          wrap
        />
      </Section>

      {/* Downtime — belongs to the shift's primary run. */}
      <Section title="Downtime">
        {primary ? (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Field label="DT HRS" value={fmt2(m.dtHrs)} mono />
              <Field label="DT MIN" value={fmt2(m.dtMins)} mono />
              <Field label="DT TTL" value={fmt2(m.dtTtl)} mono />
              <Field label="PROD HRS" value={fmt2(m.prodHrs)} mono />
            </div>
            <Field
              label="DT Reason"
              value={row.dt_reason?.trim() ? row.dt_reason : "—"}
              wrap
            />
          </>
        ) : (
          <SecondaryNote kind="Downtime" />
        )}
      </Section>

      {/* Waste — belongs to the shift's primary run. */}
      <Section title="Waste">
        {primary ? (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Field
                label="PROD LOSS"
                value={m.prodLossPct == null ? "—" : `${fmt2(m.prodLossPct)}%`}
                mono
              />
              <Field label="TTL WASTE" value={fmt2(m.totalWaste)} mono />
            </div>
            <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border bg-border">
              <WasteCell label="RS1A" value={fmtStream(row.rs1a)} />
              <WasteCell label="RS1B" value={fmtStream(row.rs1b)} />
              <WasteCell label="BF" value={fmtStream(row.bf)} />
              <WasteCell label="RS2/3" value={fmtStream(row.rs23)} />
              <WasteCell label="RS5" value={fmtStream(row.rs5)} />
              <WasteCell label="TRML1" value={fmtStream(row.trml1)} />
              <WasteCell label="TRML2" value={fmtStream(row.trml2)} />
              <WasteCell label="GRIT" value={fmtStream(row.grit)} />
            </div>
          </>
        ) : (
          <SecondaryNote kind="Waste" />
        )}
      </Section>
    </div>
  );
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function SecondaryNote({ kind }: { kind: string }) {
  return (
    <p className="text-xs italic text-muted-foreground/70">
      {kind} is recorded once per shift on the primary run row.
    </p>
  );
}

function Field({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-sm",
          mono && "font-mono tabular-nums",
          wrap ? "break-words" : "truncate"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function WasteCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-card px-1 py-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}
