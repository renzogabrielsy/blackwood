import type { InputDeliveryRow } from '@/types/rc-in';
import { parseExcelDate } from '@/lib/paste-utils';

// Maps visual column index to the data key. null = read-only/skipped during paste.
export const COLUMN_MAP: (keyof InputDeliveryRow | null)[] = [
    null,               // 0: Trash Button
    'state',            // 1: STATE
    null,               // 2: WHSE (Calculated)
    'transaction_date', // 3: DATE
    'supplier',         // 4: SUPPLIER
    'batch_code',       // 5: BLOCK
    'block_loc',        // 6: LOC
    'truck_plate',      // 7: TRUCK
    'weight_kg',        // 8: WT
    'sacks',            // 9: SKS
    'mc',               // 10: MC
    'grit',             // 11: GRIT
    'bd_astm',          // 12: ASTM
    'bd_jis',           // 13: JIS
    'vm',               // 14: VM
    'ash',              // 15: ASH
    'fc',               // 16: FC
    'remarks',          // 17: REMARKS
    'cost_basis',       // 18: PHP/KG
    null                // 19: PHP TTL (Calculated)
];

const NUMERIC_FIELDS = new Set<keyof InputDeliveryRow>([
    'weight_kg', 'sacks', 'cost_basis', 'mc', 'ash', 'grit', 'bd_astm', 'bd_jis', 'vm', 'fc'
]);

/** Cleans a single pasted cell value based on its target field */
export function cleanCellValue(raw: string, fieldKey: keyof InputDeliveryRow): string {
    let value = raw.trim().replace(/^"|"$/g, '');

    if (fieldKey === 'transaction_date') {
        value = parseExcelDate(value);
    } else if (NUMERIC_FIELDS.has(fieldKey)) {
        value = value.replace(/[₱,]/g, '');
    }

    return value;
}
