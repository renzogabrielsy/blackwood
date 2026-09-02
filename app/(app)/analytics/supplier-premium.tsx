"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PREMIUM / DISCOUNT — did we pay this supplier more or less than the going
// rate, in pesos per kilo?
//
// ── THE ONE RULE THIS PANEL IS BUILT AROUND ──────────────────────────────────
// Every figure here is WEIGHTED BY PRICED KILOS, and the panel says so out
// loud. The month's market price IS the priced-kg-weighted mean of the supplier
// prices, so weighted, the premiums sum to zero every month by construction —
// which is exactly why an UNWEIGHTED average of them is not a rougher answer
// but a meaningless one. The unweighted mean premium for March 2026 is
// −₱2.5209, a number that looks like a finding and is pure artefact of the top
// two sellers being three quarters of the volume.
//
// The panel prints the weighted total at the foot precisely so that identity is
// visible rather than asserted: it reads ₱0.00. `weightedPremiumPhpKg` in
// `lib/analytics/supplier.ts` is the ONE function that aggregates the column,
// here and everywhere.
//
// ── AND THE THING THE READER WOULD OTHERWISE MISREAD ─────────────────────────
// The biggest sellers sit near market BY CONSTRUCTION. Once the top two are
// 75% of the volume they largely ARE the market average, so their premium is
// small whatever they charge. The spread lives at the bottom of the book: in
// March 2026 the gap between the dearest and the cheapest seller was ₱7.14 a
// kilo. That sentence is printed under the panel, not buried in a hover.
//
// No colour semantics: a bar leans left or right of zero and that is all it
// says. The plan withholds threshold colouring until real targets exist, and
// paying below market is not obviously good — it is often the smallest seller
// of the month.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SupplierYear } from "@/lib/analytics/supplier";
import { SUPPLIER_DICTIONARY, weightedPremiumPhpKg } from "@/lib/analytics/supplier";
import { DictionaryPopover } from "./metric-info";

// R3: CSS variables, so the widths move with the big-screen type scale.
// Big values: 148 -> 176, 78 -> 94, 196 -> 234, 82 -> 98, 92 -> 110.
const W_NAME = "var(--an-w-prem-name)";
const W_PRICE = "var(--an-w-prem-price)";
const W_BAR = "var(--an-w-prem-bar)";
const W_PREMIUM = "var(--an-w-prem-premium)";
const W_KG = "var(--an-w-prem-kg)";

function money(v: number | null, decimals = 2): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function signedMoney(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}₱${money(Math.abs(v))}`;
}

function t1(kg: number): string {
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export interface SupplierPremiumProps {
  data: SupplierYear;
  canViewPrices: boolean;
}

export function SupplierPremium({ data, canViewPrices }: SupplierPremiumProps) {
  // Only a supplier who actually BOUGHT and got priced has a premium. A
  // returns-only name has no price on either side of the subtraction.
  const rows = React.useMemo(
    () =>
      data.rows
        .filter((r) => !r.returnsOnly && r.premium != null && r.pricedKg > 0)
        .sort((a, b) => (b.premium ?? 0) - (a.premium ?? 0)),
    [data.rows],
  );

  // THE weighted rollup, and the only one this column allows. It reads ₱0.00
  // by construction — printed rather than claimed.
  const weightedAll = React.useMemo(
    () =>
      weightedPremiumPhpKg(
        rows.map((r) => ({ premiumPhpKg: r.premium, pricedKg: r.pricedKg })),
      ),
    [rows],
  );

  const maxAbs = rows.reduce(
    (acc, r) => Math.max(acc, Math.abs(r.premium ?? 0)),
    0,
  );

  const header = (
    <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <h3 className="flex items-center gap-1 text-[length:var(--bw-fs-11)] font-semibold uppercase tracking-wide">
          Premium &amp; discount
          <DictionaryPopover
            label={SUPPLIER_DICTIONARY.premium.label}
            sublabel={SUPPLIER_DICTIONARY.premium.sublabel}
            entry={SUPPLIER_DICTIONARY.premium.dictionary}
          />
        </h3>
        <p className="text-[length:var(--bw-fs-11)] leading-relaxed text-muted-foreground">
          What we paid each supplier in {data.year}, against the market price of
          the months <strong className="font-medium text-foreground">they</strong>{" "}
          sold in. To the right of the line is above market.
        </p>
      </div>
      {canViewPrices && data.totalAvgPrice != null && (
        <span
          className="shrink-0 font-mono text-[length:var(--bw-fs-105)] text-muted-foreground"
          title="The whole year's weighted market price. It is context, NOT the baseline each row is measured against — a seller who only turned up in a dear month is compared with that month, not with the year."
        >
          year ₱{money(data.totalAvgPrice)}/kg
        </span>
      )}
    </header>
  );

  if (!canViewPrices) {
    return (
      <section className="flex flex-col gap-2">
        {header}
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card px-6 py-10 text-center">
          <Lock className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)] font-medium">
            ₱ figures are restricted for your role
          </p>
          <p className="max-w-[440px] text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
            Prices and premiums are withheld server-side for the Production
            role, so nothing was sent to this browser. The volume, share and
            participation half of the supplier room above is live.
          </p>
        </div>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        {header}
        <div className="rounded-lg border bg-card px-4 py-8 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
          No supplier has priced kilos in {data.year}, so there is nothing to
          compare against the market.
        </div>
      </section>
    );
  }

  const minWidth = `calc(${W_NAME} + ${W_PRICE} + ${W_BAR} + ${W_PREMIUM} + ${W_KG})`;

  return (
    <section className="flex flex-col gap-2">
      {header}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table
          className="table-fixed text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)]"
          style={{
            width: "max-content",
            minWidth,
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_NAME }} />
            <col style={{ width: W_PRICE }} />
            <col style={{ width: W_BAR }} />
            <col style={{ width: W_PREMIUM }} />
            <col style={{ width: W_KG }} />
          </colgroup>
          <thead>
            <tr className="h-[var(--an-h-7)] border-b">
              {[
                ["Supplier", "text-left"],
                ["₱/kg paid", "text-right"],
                ["vs market", "text-center"],
                ["Premium", "text-right"],
                ["Priced kg", "text-right"],
              ].map(([label, align]) => (
                <th
                  key={label}
                  scope="col"
                  className={cn(
                    "border-b bg-muted px-2 py-1 text-[length:var(--bw-fs-10)] font-medium uppercase tracking-wide text-muted-foreground",
                    align,
                  )}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const premium = r.premium ?? 0;
              const width = maxAbs > 0 ? (Math.abs(premium) / maxAbs) * 50 : 0;
              return (
                <tr
                  key={r.supplier}
                  className="h-[var(--an-h-8)] border-b transition-all duration-150 last:border-0 hover:bg-muted/30"
                  title={`${r.supplier} · ₱${money(r.avgPrice)}/kg over ${r.pricedKg.toLocaleString("en-US", { maximumFractionDigits: 0 })} priced kg · ${signedMoney(r.premium)}/kg against the market average. Weighted across their months by priced kilos — never an average of the monthly premiums.`}
                >
                  <td className="px-2 py-1">
                    <span className="block truncate text-[length:var(--bw-fs-11)] font-medium">
                      {r.supplier}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-baseline justify-between gap-1 font-mono text-[length:var(--bw-fs-11)] tabular-nums">
                      <span className="shrink-0 text-[length:var(--bw-fs-95)] text-muted-foreground">
                        ₱
                      </span>
                      <span className="truncate">{money(r.avgPrice)}</span>
                    </div>
                  </td>
                  <td className="px-2 py-1">
                    {/* The diverging bar. Zero is the centre line; a bar leans
                        left for below market and right for above, and carries
                        no good/bad colour of its own. */}
                    <div className="relative h-3">
                      <div
                        aria-hidden
                        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border"
                      />
                      <div
                        aria-hidden
                        className={cn(
                          "absolute top-1/2 h-2 -translate-y-1/2 rounded-sm",
                          premium >= 0 ? "left-1/2" : "right-1/2",
                        )}
                        style={{
                          width: `${Math.max(width, premium === 0 ? 0 : 1.5)}%`,
                          background:
                            premium >= 0 ? "var(--chart-2)" : "var(--chart-4)",
                        }}
                      />
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <span className="font-mono text-[length:var(--bw-fs-11)] tabular-nums">
                      {signedMoney(r.premium)}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <span className="font-mono text-[length:var(--bw-fs-11)] text-muted-foreground tabular-nums">
                      {t1(r.pricedKg)}
                      <span className="ml-0.5 text-[length:var(--bw-fs-95)]">t</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="h-[var(--an-h-8)] border-t bg-muted/30">
              <th
                scope="row"
                title="The only average this column allows: each supplier's premium weighted by the kilos it speaks for. It comes to zero because the market price IS the kilo-weighted average of these prices — an unweighted mean of the same column reads −₱2.52 for March 2026 and means nothing at all."
                className="px-2 py-1 text-left text-[length:var(--bw-fs-11)] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Weighted
              </th>
              <td className="px-2 py-1" />
              <td className="px-2 py-1 text-center">
                <span className="text-[length:var(--bw-fs-95)] text-muted-foreground">
                  weighted by priced kg
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                <span className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] font-semibold tabular-nums">
                  {signedMoney(weightedAll)}
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                <span className="font-mono text-[length:var(--bw-fs-11)] text-muted-foreground tabular-nums">
                  {t1(data.totalPricedKg)}
                  <span className="ml-0.5 text-[length:var(--bw-fs-95)]">t</span>
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── THE FOOTNOTE PARAGRAPHS ARE GONE (owner feedback R5) ──────────
          Renzo's screenshots marked both explanatory blocks under this panel
          for removal — "Each row is measured against its OWN months…" and the
          big-sellers-sit-near-market paragraph.

          **Not one fact went with them.** Every sentence they carried already
          existed at the point of use and still does: the header says the
          comparison is against "the months THEY sold in"; the `year ₱…/kg`
          chip beside it carries the hover explaining it is context and not the
          baseline; each row's own hover spells out the weighting; the
          `Weighted` footer PRINTS the ₱0.00 identity rather than asserting it;
          and the `Premium & discount` dictionary popover in the heading holds
          the full definition, basis, exclusions and rollup. The prose was a
          fourth copy of all of it sitting under a panel a reader had already
          finished reading. */}
    </section>
  );
}
