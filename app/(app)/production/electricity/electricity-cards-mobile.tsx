"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ElectricityCardsMobile — the Electricity readings phone read layer.
//
// Rendered `sm:hidden` by ElectricityView; the desktop inline-editable `<table>`
// grid is `hidden sm:block` and untouched. The simplest MobileCardList surface.
//
// Fed the SAME `readings` array the desktop grid loads (single source of truth).
// DIFF + TTL KWH read straight off the DB's generated columns (`diff_kwh`,
// `consumption_kwh`) — never recomputed here. No ₱ anywhere → no gating.
//
// Card headline: date · meter · consumption (TTL KWH) · [start→end].
// Detail sheet: start / end / diff / mult / consumption / remarks.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { cn } from "@/lib/utils";
import { MobileCardList } from "@/components/shared/mobile/mobile-card-list";
import type { Tables } from "@/types/supabase";

type ElectricityReadingRow = Tables<"electricity_readings">;

const fmt2 = (v: number | null | undefined) =>
  v == null || Number.isNaN(v)
    ? "—"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const fmtInt = (v: number | null | undefined) =>
  v == null || Number.isNaN(v)
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function ElectricityCardsMobile({
  readings,
}: {
  readings: ElectricityReadingRow[];
}) {
  return (
    <MobileCardList<ElectricityReadingRow>
      items={readings}
      getKey={(r) => r.id}
      estimateSize={62}
      renderCard={(r) => <ElectricityCard row={r} />}
      renderDetail={(r) => <ElectricityDetail row={r} />}
      getDetailTitle={(r) => r.meter || "Reading"}
      getDetailDescription={(r) => `${r.reading_date} · ${fmt2(r.consumption_kwh)} kWh`}
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

function ElectricityCard({ row }: { row: ElectricityReadingRow }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span
        className="mt-0.5 inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-muted-foreground"
        aria-hidden
      >
        {row.meter || "—"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
            {row.reading_date}
          </span>
          <span className="shrink-0 font-mono text-sm tabular-nums">
            {fmt2(row.consumption_kwh)} kWh
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          {fmtInt(row.start_kwh)} → {fmtInt(row.end_kwh)}
        </div>
      </div>
    </div>
  );
}

function ElectricityDetail({ row }: { row: ElectricityReadingRow }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
      <Field label="Date" value={row.reading_date} mono />
      <Field label="Meter" value={row.meter || "—"} />
      <Field label="Start KWH" value={fmt2(row.start_kwh)} mono />
      <Field label="End KWH" value={fmt2(row.end_kwh)} mono />
      <Field label="Diff" value={fmt2(row.diff_kwh)} mono />
      <Field label="Multiplier" value={fmt2(row.meter_multiplier)} mono />
      <Field label="TTL KWH" value={fmt2(row.consumption_kwh)} mono />
      <div className="col-span-2">
        <Field
          label="Remarks"
          value={row.remarks?.trim() ? row.remarks : "—"}
          wrap
        />
      </div>
    </div>
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
