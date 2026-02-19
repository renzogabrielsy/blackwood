Read TIMELINE.md, CLAUDE.md, and components/widgets/CONTEXT.md before starting. Also read components/dashboard/DashboardGrid.tsx (specifically the sticky header section starting around line 373) and components/widgets/kpi-strip/KPIStripWidget.tsx to understand current state. Enter plan mode first — outline what you will do and get my approval before executing. When done, give me a clear summary of every file changed, every animation added, and any design decisions you made.

## Task: Sticky KPI Bar — Merged with the Dashboard Header

The KPI strip currently lives as a standard widget inside the react-grid-layout grid. The goal is to give users the option to "pin" the KPI strip so it merges visually with the existing sticky header bar (the one that shows "Blackwood Dashboard" and today's date), creating a unified control surface that stays fixed at the top while the grid scrolls underneath — exactly like Excel's frozen rows, but polished.

## Current Structure (READ BEFORE TOUCHING ANYTHING)

The layout has three vertical layers on the dashboard:
1. The Navbar — fixed, dark zinc-800, h-12 — inside components/navbar.tsx. DO NOT TOUCH THIS.
2. The Dashboard Sticky Header — sticky top-0 z-30 inside DashboardGrid.tsx at approximately line 374. This has "Blackwood Dashboard" + date on the left, and "N widgets" count + Edit Layout button on the right.
3. The Grid — react-grid-layout content below the header.

When the KPI strip is pinned, it should become a third sub-row inside that same sticky header block, so the whole thing sticks together as one unified surface. When unpinned, the KPI strip returns to the grid as a normal widget.

## What to Build

### 1. Sticky state toggle in DashboardGrid settings

Add isPinned boolean to prefs for the KPI strip widget specifically (or a generic pinnedToHeader: string[] array in D6Prefs that can later support other widgets). Wire this to a pin icon button that appears in the KPI strip WidgetShell header alongside the existing gear icon. Clicking the pin icon calls onSettingsChange with the new pinned state and persists it to prefs.

### 2. Conditional rendering — pinned vs. grid

When the KPI strip is pinned:
- Remove it from the react-grid-layout grid entirely (exclude its ID from the rendered widget list and from the layout array)
- Render it inside the sticky header bar instead, as a new row below the existing title+controls row
- The sticky header expands vertically to accommodate it

When unpinned:
- Render it normally in the grid like any other widget

### 3. Sticky header redesign for the expanded state

When the KPI strip is in the header, the header block needs a second row. The new layout:

Row 1 (existing): "Blackwood Dashboard" title + date on the left, N widgets pill + Edit Layout button on the right. Keep exactly as-is.

Row 2 (new, only when pinned): Full-width KPI strip, rendered directly using the KPIStripWidget component with the same data and settings it would have had as a grid widget. The strip should have a subtle top border (border-t border-border/50) and a small amount of vertical padding (py-1.5 or py-2).

The entire header block has bg-card border-b border-border and is sticky top-0 z-30. Row 2 inherits this background — it should feel like the title bar grew a chin, not like a separate panel snapped below it.

### 4. The Animations — This Is the Polish Layer

These must be compositor-only animations (transform + opacity only, never height/width changes). Use CSS transitions or keyframes defined in globals.css following the project's existing animation conventions (150ms micro-interactions, 250ms reveals, 300ms max).

Pinning animation (grid widget → sticky header):
- The sticky header's second row slides in from top with a combination of translateY(-8px) → translateY(0) and opacity 0 → 1 over 250ms. Use ease-out.
- Simultaneously, the grid slot where the widget WAS fades out (opacity 1 → 0, 150ms). To do this cleanly, during the transition render a ghost/placeholder div in the grid at the original position with the same dimensions, then fade it out, then fully remove it after the transition completes. Use a short setTimeout (250ms) to handle the removal.
- Add a thin highlight line (2px, emerald or primary color) on the bottom border of the sticky header to signal the active pinned state, fading in at 150ms with opacity transition.

Unpinning animation (sticky header → grid widget):
- The reverse: the header second row slides out (translateY(0) → translateY(-8px), opacity 1 → 0, 200ms)
- The grid widget fades back in (opacity 0 → 1, 200ms, slight translateY(4px) → 0 entrance)
- Remove the highlight line

Scroll behavior — when the user scrolls and the header sticks (becomes fixed at the top after scrolling past its natural position):
- Use an IntersectionObserver on a 1px sentinel element placed just above the sticky header to detect when it becomes stuck
- When stuck: add a shadow to the header (shadow-lg or a custom box-shadow), and if the KPI strip is pinned, slightly compress its padding (py-1.5 → py-1) for a slimmed compact mode
- When unstuck: remove the shadow and restore padding
- The shadow should transition in smoothly using CSS transition on box-shadow (200ms)

### 5. Pin button in WidgetShell

When the widget is rendered in the grid (unpinned state), show a small pin icon button in the WidgetShell header action slot alongside the existing gear icon. Use a Lucide Pin icon. Tooltip: "Pin to top". When pinned and the widget is rendered inside the header, show an Unpin button (PinOff icon or the same Pin icon in active state) — place it at the far right of the KPI row inside the header. Tooltip: "Return to grid".

### 6. Edit mode behavior

In edit mode (drag and resize enabled), the pin button should be hidden — you cannot pin while editing layout. If the kpi strip is pinned and the user enters edit mode, temporarily unpin it back to the grid for the duration of edit mode (do not change the persisted pinned state — just render it in the grid while edit mode is active). On exit from edit mode, re-pin it.

### 7. Mobile behavior

On mobile (width less than 640px), pinning should be automatically disabled — the KPI strip always renders in the grid. The pin button should not appear on mobile. The header stays compact.

## Files to Change

- components/dashboard/DashboardGrid.tsx — main changes: prefs shape, sticky header JSX, conditional rendering logic, animation state
- components/dashboard/WidgetShell.tsx — add pin button to header actions
- app/globals.css — add any new animation keyframes if needed (follow existing patterns)
- TIMELINE.md — update Current Sprint tasks and add to Recent Completions and Changelog

## Rules

- Do not use any animation libraries — pure CSS transitions and keyframes only
- Do not animate height or width — only transform, opacity, box-shadow
- Do not modify components/navbar.tsx
- The KPI strip component itself (KPIStripWidget.tsx) should not need changes — it just renders wherever it is placed
- Build passes with zero TypeScript errors (run npm run build to verify)
