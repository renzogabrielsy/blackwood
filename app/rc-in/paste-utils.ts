import type { InputDeliveryRow } from '@/types/rc-in';

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

function formatYMD(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Converts Excel serial numbers, common date formats, or ISO strings → yyyy-MM-dd */
export function parseExcelDate(raw: string): string {
    const trimmed = raw.trim();

    // Already yyyy-MM-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    // Excel serial number (pure integer, realistic range ~1900–2100)
    const num = Number(trimmed);
    if (!isNaN(num) && Number.isInteger(num) && num >= 1 && num < 2958466) {
        // Excel's epoch is Jan 1 1900, but it has a fake Feb 29 1900 (serial 60)
        const adjusted = num > 59 ? num - 1 : num;
        const d = new Date(1900, 0, adjusted);
        return formatYMD(d);
    }

    // MM/DD/YYYY or M/D/YY (slash or dash separated, assumes US locale)
    const parts = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (parts) {
        const [, a, b, yr] = parts;
        let y = parseInt(yr);
        if (y < 100) y += 2000;
        const m = parseInt(a), d = parseInt(b);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
    }

    // Last resort: let the browser try
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) return formatYMD(parsed);

    return trimmed;
}

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
