/**
 * Shared chrome for every `/inventory/*` route: the muted full-bleed background and the
 * padded content area. It is intentionally THIN — it does NOT own the Deliveries/Usage
 * tab shell. That shell (Card + InventoryTabProvider + the bottom tab bar) wraps ONLY the
 * logs page (`/inventory`) via the client `LogsShell` rendered in page.tsx. The standalone
 * routes (`/inventory/blocking`, `/inventory/rc-movement`) render their own full-height
 * container here with no tab-bar footer.
 */
export default function InventoryLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/20">
            <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">{children}</div>
        </div>
    );
}
