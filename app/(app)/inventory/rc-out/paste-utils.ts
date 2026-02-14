import type { InputRcOutRow } from '@/types/rc-out';
import { parseExcelDate } from '../rc-in/paste-utils';

// Maps visual column index to the data key. null = read-only/skipped during paste.
export const COLUMN_MAP: (keyof InputRcOutRow | null)[] = [
    null,               // 0: Row action area
    'transaction_date', // 1: DATE
    'production_batch', // 2: BATCH
    'batch_code',       // 3: BLOCK
    'weight_kg',        // 4: WT
    'destination',      // 5: PLANT/ETC
    'block_loc',        // 6: BLOCK LOC
    'remarks',          // 7: REMARKS
    null,               // 8: Remove button
];

const NUMERIC_FIELDS = new Set<keyof InputRcOutRow>(['weight_kg']);

/** Cleans a single pasted cell value based on its target field */
export function cleanCellValue(raw: string, fieldKey: keyof InputRcOutRow): string {
    let value = raw.trim().replace(/^"|"$/g, '');

    if (fieldKey === 'transaction_date') {
        value = parseExcelDate(value);
    } else if (NUMERIC_FIELDS.has(fieldKey)) {
        value = value.replace(/[₱,]/g, '');
    }

    return value;
}
