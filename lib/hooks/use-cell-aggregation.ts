import { useMemo } from 'react';
import type { CellRange } from './use-cell-selection';

export type AggregationType = 'SUM' | 'AVERAGE' | 'COUNT' | 'MIN' | 'MAX';

export type CellAggregates = {
  sum: number;
  average: number;
  count: number;
  numericCount: number;
  min: number;
  max: number;
  recommendedCalcType: AggregationType;
};

export function useCellAggregation({
  range,
  getNumericCellValue,
  getColumnDefaultCalcType,
}: {
  range: CellRange | null;
  getNumericCellValue: (row: number, col: number) => number | null;
  getColumnDefaultCalcType?: (col: number) => AggregationType | null;
}): CellAggregates | null {
  return useMemo(() => {
    if (!range) return null;

    let sum = 0;
    let count = 0;
    let numericCount = 0;
    let min = Infinity;
    let max = -Infinity;

    // Track column defaults for recommendation
    let sumCols = 0;
    let avgCols = 0;

    if (getColumnDefaultCalcType) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const def = getColumnDefaultCalcType(c);
        if (def === 'SUM') sumCols++;
        else if (def === 'AVERAGE') avgCols++;
      }
    }

    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        count++;
        const val = getNumericCellValue(r, c);
        if (val !== null) {
          numericCount++;
          sum += val;
          if (val < min) min = val;
          if (val > max) max = val;
        }
      }
    }

    // Determine recommended type: if only AVG columns -> AVERAGE, otherwise SUM
    let recommendedCalcType: AggregationType = 'SUM';
    if (avgCols > 0 && sumCols === 0) {
      recommendedCalcType = 'AVERAGE';
    }

    if (numericCount === 0) {
      return { sum: 0, average: 0, count, numericCount: 0, min: 0, max: 0, recommendedCalcType };
    }

    return {
      sum,
      average: sum / numericCount,
      count,
      numericCount,
      min,
      max,
      recommendedCalcType,
    };
  }, [range, getNumericCellValue, getColumnDefaultCalcType]);
}
