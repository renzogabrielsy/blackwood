
/**
 * Calculates the Warehouse (WHSE) based on the Block Location.
 * Logic: First letter determines the warehouse.
 * F -> FEED
 * A -> WHSE A
 * B -> WHSE B
 * C -> WHSE C
 * D -> WHSE D
 * E -> WHSE E
 * G -> WHSE G
 * 
 * @param blockLoc The Block Location string (e.g., "A-12", "F-BLK1")
 * @returns The warehouse name or "-" if undetermined.
 */
export function calculateWhse(blockLoc: string | undefined | null): string {
    if (!blockLoc) return '-';

    const firstChar = blockLoc.trim().toUpperCase().charAt(0);

    if (firstChar === 'F') return 'FEED';
    if (['A', 'B', 'C', 'D', 'E', 'G'].includes(firstChar)) {
        return `WHSE ${firstChar}`;
    }

    return '-';
}
