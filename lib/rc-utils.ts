
/**
 * Calculates the Warehouse (WHSE) based on the Block Location.
 * Logic: Prefix (or first letter) determines the warehouse.
 * PCA-* -> PCA  (prepared charcoal sundrying area, A-15/16/17 subdivision)
 * PCB-* -> PCB  (prepared charcoal sundrying area, A-15/16/17 subdivision)
 * F -> FEED
 * A -> WHSE A
 * B -> WHSE B
 * C -> WHSE C
 * D -> WHSE D
 * E -> WHSE E
 * G -> WHSE G
 *
 * @param blockLoc The Block Location string (e.g., "A-12", "F-BLK1", "PCA-15A")
 * @returns The warehouse name or "-" if undetermined.
 */
export function calculateWhse(blockLoc: string | undefined | null, batchCode?: string | null): string {
    // Priority: If the Batch Code itself indicates FEED (suffix), it overrides location.
    // Regex matches "FEED" optionally followed by digits at the end of the string (case-insensitive).
    if (batchCode && /FEED\d*$/i.test(batchCode.trim())) {
        return 'FEED';
    }

    if (!blockLoc) return '-';

    const upper = blockLoc.trim().toUpperCase();

    // PCA/PCB are 3-character prefixes — check before single-char fallback
    if (upper.startsWith('PCA-')) return 'PCA';
    if (upper.startsWith('PCB-')) return 'PCB';

    const firstChar = upper.charAt(0);

    if (firstChar === 'F') return 'FEED';
    if (['A', 'B', 'C', 'D', 'E', 'G'].includes(firstChar)) {
        return `WHSE ${firstChar}`;
    }

    return '-';
}
