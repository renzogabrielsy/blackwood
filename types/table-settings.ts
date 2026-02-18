export type DensityMode = 'normal' | 'expanded';
export type LabMetric = 'mc' | 'grit' | 'bd_astm' | 'bd_jis' | 'vm' | 'ash' | 'fc';
export type HighlightDirection = 'above' | 'below';

export interface LabHighlightSpec {
  limit: number;
  direction: HighlightDirection;
  color: string;
  enabled: boolean;
}

export interface ColumnFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface RcInTableSettings {
  densityMode: DensityMode;
  fontSize: number;                                    // px, 9-14 range
  hiddenColumns: string[];                             // column IDs
  labHighlights: Record<LabMetric, LabHighlightSpec>;  // replaces labRanges + disabledHighlights
  columnWidths: Record<string, number>;                // column ID -> px
  columnFormats: Record<string, ColumnFormat>;          // column ID -> formatting
}

export const HIGHLIGHT_COLORS = [
  { key: 'red',    label: 'Red',    bg: 'bg-red-500/15 dark:bg-red-500/20',    dot: 'bg-red-500',    text: 'text-red-600 dark:text-red-400' },
  { key: 'amber',  label: 'Amber',  bg: 'bg-amber-500/15 dark:bg-amber-500/20',  dot: 'bg-amber-500',  text: 'text-amber-600 dark:text-amber-400' },
  { key: 'orange', label: 'Orange', bg: 'bg-orange-500/15 dark:bg-orange-500/20', dot: 'bg-orange-500', text: 'text-orange-600 dark:text-orange-400' },
  { key: 'yellow', label: 'Yellow', bg: 'bg-yellow-500/15 dark:bg-yellow-500/20', dot: 'bg-yellow-500', text: 'text-yellow-600 dark:text-yellow-400' },
  { key: 'blue',   label: 'Blue',   bg: 'bg-blue-500/15 dark:bg-blue-500/20',   dot: 'bg-blue-500',   text: 'text-blue-600 dark:text-blue-400' },
  { key: 'purple', label: 'Purple', bg: 'bg-purple-500/15 dark:bg-purple-500/20', dot: 'bg-purple-500', text: 'text-purple-600 dark:text-purple-400' },
  { key: 'pink',   label: 'Pink',   bg: 'bg-pink-500/15 dark:bg-pink-500/20',   dot: 'bg-pink-500',   text: 'text-pink-600 dark:text-pink-400' },
  { key: 'emerald', label: 'Green', bg: 'bg-emerald-500/15 dark:bg-emerald-500/20', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
] as const;

export const DEFAULT_LAB_HIGHLIGHTS: Record<LabMetric, LabHighlightSpec> = {
  mc:      { limit: 14,   direction: 'above', color: 'red', enabled: true },
  grit:    { limit: 2,    direction: 'above', color: 'red', enabled: true },
  bd_astm: { limit: 0.35, direction: 'below', color: 'red', enabled: true },
  bd_jis:  { limit: 0.38, direction: 'below', color: 'red', enabled: true },
  vm:      { limit: 24,   direction: 'above', color: 'red', enabled: true },
  ash:     { limit: 4,    direction: 'above', color: 'red', enabled: true },
  fc:      { limit: 60,   direction: 'below', color: 'red', enabled: true },
};

export const DEFAULT_RC_IN_SETTINGS: RcInTableSettings = {
  densityMode: 'normal',
  fontSize: 12,
  hiddenColumns: [],
  labHighlights: DEFAULT_LAB_HIGHLIGHTS,
  columnWidths: {},
  columnFormats: {},
};

export const LAB_METRICS_ORDERED: LabMetric[] = ['mc', 'grit', 'bd_astm', 'bd_jis', 'vm', 'ash', 'fc'];

export const LAB_METRIC_FULL_NAMES: Record<LabMetric, string> = {
  mc: 'Moisture Content',
  grit: 'Grit',
  bd_astm: 'Bulk Density (ASTM)',
  bd_jis: 'Bulk Density (JIS)',
  vm: 'Volatile Matter',
  ash: 'Ash Content',
  fc: 'Fixed Carbon',
};

/** Get background tint class for lab highlight coloring (single-threshold system) */
export function getLabHighlightBg(
  metric: LabMetric,
  value: number,
  highlights: Record<LabMetric, LabHighlightSpec>
): string {
  const spec = highlights[metric];
  if (!spec.enabled) return '';
  const isBad = spec.direction === 'above' ? value > spec.limit : value < spec.limit;
  if (!isBad) return '';
  return HIGHLIGHT_COLORS.find(c => c.key === spec.color)?.bg ?? '';
}

/** Get text color class for lab highlight (used on blocking grid cards) */
export function getLabHighlightText(
  metric: LabMetric,
  value: number,
  highlights: Record<LabMetric, LabHighlightSpec>
): string {
  const spec = highlights[metric];
  if (!spec.enabled) return '';
  const isBad = spec.direction === 'above' ? value > spec.limit : value < spec.limit;
  if (!isBad) return '';
  return HIGHLIGHT_COLORS.find(c => c.key === spec.color)?.text ?? '';
}

/** Get the colored dot class for batch state */
export function getStateDotClass(state: string): string {
  switch (state) {
    case 'STORED':    return 'bg-emerald-500';
    case 'IN-USE':    return 'bg-blue-500';
    case 'CLOSED':    return 'bg-red-500';
    case 'SUNDRYING': return 'bg-amber-500';
    case 'SUNDRIED':  return 'bg-amber-400';
    default:          return 'bg-muted-foreground';
  }
}
