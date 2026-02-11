/** Maps DB column keys to human-readable labels */
const FIELD_LABELS: Record<string, string> = {
  transaction_date: 'Date',
  supplier: 'Supplier',
  batch_code: 'Batch Code',
  block_loc: 'Block/Loc',
  truck_plate: 'Truck Plate',
  sacks: 'Sacks',
  weight_kg: 'Weight (kg)',
  cost_basis: 'PHP/KG',
  remarks: 'Remarks',
  lab_results: 'Lab Results',
  state: 'State',
};

const LAB_LABELS: Record<string, string> = {
  mc: 'MC',
  ash: 'Ash',
  bd_astm: 'BD ASTM',
  bd_jis: 'BD JIS',
  grit: 'Grit',
  vm: 'VM',
  fc: 'FC',
};

/** Fields to skip in display (internal/meta) */
const HIDDEN_FIELDS = new Set(['id', 'created_at', 'updated_at']);

export function getFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? LAB_LABELS[key] ?? key;
}

export function isHiddenField(key: string): boolean {
  return HIDDEN_FIELDS.has(key);
}

/** Format a value for display based on its field key */
export function formatFieldValue(key: string, value: any): string {
  if (value == null || value === '') return '-';

  if (key === 'cost_basis') {
    const num = Number(value);
    return isNaN(num)
      ? String(value)
      : `₱${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  if (key === 'weight_kg') {
    const num = Number(value);
    return isNaN(num) ? String(value) : Math.round(num).toLocaleString();
  }

  if (key === 'sacks') {
    return Number(value).toLocaleString();
  }

  if (['bd_astm', 'bd_jis'].includes(key)) {
    const num = Number(value);
    return isNaN(num) ? String(value) : num.toFixed(3);
  }

  if (['mc', 'ash', 'grit', 'vm', 'fc'].includes(key)) {
    const num = Number(value);
    return isNaN(num) ? String(value) : num.toFixed(2);
  }

  return String(value);
}

/**
 * Flatten a diff entry for lab_results into individual sub-key diffs.
 * Input:  { lab_results: { old: { mc: 1, ash: 2 }, new: { mc: 1.5, ash: 2 } } }
 * Output: [{ key: 'mc', label: 'MC', old: '1.00', new: '1.50' }]
 */
export function flattenLabResultsDiff(
  oldVal: Record<string, any> | null,
  newVal: Record<string, any> | null
): { key: string; label: string; oldFormatted: string; newFormatted: string }[] {
  const results: { key: string; label: string; oldFormatted: string; newFormatted: string }[] = [];
  const allKeys = new Set([
    ...Object.keys(oldVal ?? {}),
    ...Object.keys(newVal ?? {}),
  ]);

  for (const subKey of allKeys) {
    const oldSub = oldVal?.[subKey];
    const newSub = newVal?.[subKey];
    // Only include if actually changed
    if (JSON.stringify(oldSub) !== JSON.stringify(newSub)) {
      results.push({
        key: subKey,
        label: LAB_LABELS[subKey] ?? subKey,
        oldFormatted: formatFieldValue(subKey, oldSub),
        newFormatted: formatFieldValue(subKey, newSub),
      });
    }
  }

  return results;
}
