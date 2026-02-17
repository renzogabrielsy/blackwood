export interface WarehouseConfig {
  cols: number;
  rows: string[];
}

export const WAREHOUSES: Record<string, WarehouseConfig> = {
  A: { cols: 20, rows: ['A', 'B', 'C'] },
  B: { cols: 20, rows: ['A', 'B'] },
  C: { cols: 20, rows: ['A', 'B'] },
  D: { cols: 20, rows: ['A', 'B', 'C', 'D'] },
};
