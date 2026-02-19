Read TIMELINE.md, CLAUDE.md, and components/widgets/CONTEXT.md before starting. Read components/widgets/kpi-strip/KPIStripWidget.tsx and its types file to understand the current state. Enter plan mode first — lay out every step, get approval, then execute. When done, give me a clear summary of every feature built, every file changed, and any decisions you made along the way.

## Task: KPI Strip Widget — Full Customization System

The KPIStripWidget now accepts KPIData[] via props and is fully decoupled from domain data. The next step is to make it genuinely user-configurable and production-polished. Build all features in the order listed below — each step depends on the previous one.

## Architecture Constraints (Non-Negotiable)

- The widget (components/widgets/kpi-strip/) must remain source-agnostic — it renders KPIData[], nothing more
- All domain-specific values (thresholds, period logic, sparkline data) are set by the ADAPTER in lib/widgets/adapters/, never hardcoded in the widget
- Settings that the USER controls (show/hide, order, period, chip mode) live in KPIStripSettings and persist via the existing DashboardGrid prefs system (already persists to Supabase/localStorage)
- No new dependencies unless absolutely necessary — use SVG for sparklines, Radix primitives for the popover

## Step 1 — Extend the KPIData and KPIStripSettings Interfaces

Update components/widgets/kpi-strip/types.ts with these additions:

For KPIData, add these optional fields:
- thresholds: an optional array of objects, each with a numeric value and a status of 'good', 'warning', or 'danger'. The adapter pre-sorts these — the widget picks the first threshold whose value is exceeded.
- sparkline: an optional array of numbers representing recent historical values (the adapter decides the period and count).
- comparison: an optional object with a formatted value string, a label string (e.g., "vs Jan"), and a trend of 'up', 'down', or 'neutral'.
- variant: a string union of 'default', 'flow', 'progress', or 'ratio'. Controls which chip renderer is used. Default is 'default'.
- pinned: an optional boolean. When true, this chip always renders even at xs/sm tier when others collapse.
- drilldown: an optional object with an href string. When present, the entire chip becomes a clickable link to that route.

For KPIStripSettings, add these optional fields:
- hidden: an array of KPI key strings that the user has toggled off. Default empty array.
- order: an array of KPI key strings defining display order. Keys not in this array render last in their original order.
- chipMode: a string union of 'auto', 'compact', or 'expanded'. Auto uses the existing tier system. Compact always hides sub-lines. Expanded always shows sub-lines.
- period: a string union of 'today', 'week', 'month', 'quarter', 'year'. Default 'month'. Passed to the adapter on fetch.

## Step 2 — Build the Chip Variant Renderers

Inside KPIStripWidget.tsx (or a co-located chips.tsx file), build a closed set of chip renderers. The widget dispatches to the correct renderer based on KPIData.variant.

Default variant: label on top, value in the middle (already exists as KPIChip), sub-line below, trend color applied to value text based on the threshold check.

Flow variant: label on top, then a horizontal row showing two values separated by a minus sign and equals sign (e.g., "1,132 T in — 546 T out = +587 T"). This replaces the current custom JSX in the lg/xl layout for Feb Flow. The variant receives its values via a structured value string — the adapter is responsible for formatting "1132 in 546 out 587 net" into whatever structure the flow chip needs. Think carefully about how to type this cleanly.

Progress variant: label on top, a thin progress bar (height 3px, full width), numeric percentage below. The adapter passes a value between 0 and 100 as a number string. Useful for warehouse occupancy.

Ratio variant: two numbers separated by a slash with a percentage (e.g., 154/220 — 70%). The adapter pre-formats the string.

Threshold coloring rule for all variants: evaluate the chip's thresholds array against the primary numeric value. The adapter sets thresholds from highest to lowest — pick the first one whose value the data exceeds, apply its status color (good = emerald, warning = amber, danger = red) to the value text and optionally a left border on the chip.

## Step 3 — Sparkline Chip Enhancement

When KPIData.sparkline is present, render a tiny inline SVG spark line (28px wide, 14px tall) immediately to the right of the value. Rules:
- Pure SVG path, no Recharts — keep the bundle tiny
- Normalize values to fit within the 14px height
- Stroke color inherits from the current threshold status color, or uses muted-foreground if no thresholds
- No axes, no labels, no tooltip — purely visual trend indicator
- Only render in md/lg/xl tiers, hide at xs/sm

## Step 4 — Comparison Display

When KPIData.comparison is present, render it as a small sub-line below the value in the format: trend arrow + comparison value + comparison label. Use emerald for up, red for down, muted for neutral. This replaces the current static "vs Jan" text in the charcoal adapter with a properly typed structure.

## Step 5 — Settings Popover for Show/Hide and Reorder

Add a settings gear icon to the WidgetShell header action slot (WidgetShell already accepts a headerAction prop). When clicked, open a Radix Popover containing:

A list of all available chips (from the full KPIData array before filtering) with a toggle switch next to each. Toggling updates KPIStripSettings.hidden and persists immediately via the existing onSettingsChange callback.

A drag handle next to each row for reordering. On drag-end, update KPIStripSettings.order. Use the HTML5 drag API or a simple up/down button pair as an alternative — avoid adding a drag library.

A row at the bottom with a chip mode selector (Auto / Compact / Expanded) as three small toggle buttons.

The popover must be keyboard accessible and close on Escape or outside click.

## Step 6 — Period Selector

Add a period toggle to the widget header (compact, inline with the title). Options: D (today), W (week), M (month), Q (quarter), Y (year). Selecting one updates KPIStripSettings.period and calls onSettingsChange. This triggers a re-fetch via React state — the parent DashboardGrid needs to re-call the charcoal KPI adapter with the new period. Wire this up properly so changing period actually produces different chip values from the adapter.

In charcoal-kpi.ts, update the adapter to read the period from settings and adjust its date filter accordingly.

## Step 7 — Pinned Chip Behavior at Small Sizes

At xs and sm tiers, only render chips where KPIData.pinned is true. All other chips are hidden. Instead of the current simplified stack layout, just render the pinned chips in their normal chip renderer. Show a small pill below the pinned chips that says "+N more" where N is the number of hidden chips. Tapping or clicking the pill expands to show all chips (add local state for this). This replaces the current custom xs/sm layout.

In the charcoal KPI adapter, set pinned: true on Total Inventory and Current PHP/KG as sensible defaults.

## Step 8 — Drilldown Links

When KPIData.drilldown is present, wrap the entire chip in a Next.js Link to drilldown.href. Apply hover styles (subtle bg-muted/50 rounded, cursor-pointer) so it's clear the chip is interactive. In the charcoal adapter, set drilldown on the Warehouse chip pointing to /inventory, and on the Flow chip pointing to /inventory.

## Step 9 — Update the Charcoal KPI Adapter

After all widget changes, update lib/widgets/adapters/charcoal-kpi.ts to produce the full new KPIData shape for every chip:
- Add sparkline arrays (last 12 monthly values per metric, derived from the existing deliveries/rc_out historical queries)
- Add thresholds (warehouse occupancy: good below 70%, warning 70-85%, danger above 85%)
- Add comparison objects (current month vs previous month for flow and price)
- Add variant assignments (warehouse chip uses progress, flow chip uses flow, price uses default)
- Add pinned flags (Total Inventory and Price are pinned)
- Add drilldown hrefs where relevant
- Wire period into date filter

Also update CHARCOAL_KPI_DATA in lib/widgets/mock-data.ts to include the same new fields so the static fallback stays in sync with the live adapter shape.

## Step 10 — Final Polish and Documentation

- Ensure all new chips pass through the existing responsive tier logic naturally
- Run npm run build — zero TypeScript errors required
- Update components/widgets/kpi-strip/README or add inline comments documenting each variant
- Update components/widgets/CONTEXT.md — document new KPIData fields, KPIStripSettings additions, and the chip variant system
- Update TIMELINE.md — mark relevant current sprint tasks done, add entries to Recent Completions and Changelog
