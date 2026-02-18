'use client';

import { cn } from '@/lib/utils';
import { useAuth } from '@/components/providers/auth-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Columns } from 'lucide-react';

interface ColumnDef {
  id: string;
  label: string;
  costOnly?: boolean;
}

// Full column definitions for the checkbox list (matches table column order)
const ALL_COLUMNS: readonly ColumnDef[] = [
  { id: 'state', label: 'State' },
  { id: 'transaction_date', label: 'Date' },
  { id: 'supplier', label: 'Supplier' },
  { id: 'batch_code', label: 'Batch Code' },
  { id: 'block_loc', label: 'Block/LOC' },
  { id: 'truck_plate', label: 'Truck Plate' },
  { id: 'weight_kg', label: 'Weight (kg)' },
  { id: 'sacks', label: 'Sacks' },
  { id: 'mc', label: 'Moisture Content' },
  { id: 'grit', label: 'Grit' },
  { id: 'bd_astm', label: 'BD ASTM' },
  { id: 'bd_jis', label: 'BD JIS' },
  { id: 'vm', label: 'Volatile Matter' },
  { id: 'ash', label: 'Ash Content' },
  { id: 'fc', label: 'Fixed Carbon' },
  { id: 'remarks', label: 'Remarks' },
  { id: 'cost_basis', label: 'PHP/KG', costOnly: true },
  { id: 'php_total', label: 'PHP Total', costOnly: true },
] as const;

interface ColumnsPopoverProps {
  hiddenColumns: string[];
  onToggle: (colId: string) => void;
  onShowAll: () => void;
}

export function ColumnsPopover({ hiddenColumns, onToggle, onShowAll }: ColumnsPopoverProps) {
  const { hasPermission } = useAuth();
  const canViewPrices = hasPermission('view:prices');
  const hiddenCount = hiddenColumns.length;

  const visibleCols = ALL_COLUMNS.filter((col) => {
    if (col.costOnly && !canViewPrices) return false;
    return true;
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1.5">
          <Columns className="size-3.5" />
          Columns
          {hiddenCount > 0 && (
            <span className="bg-primary/15 text-primary text-[10px] rounded-full px-1.5 font-semibold ml-0.5">
              {hiddenCount} hidden
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3 bg-popover/95 backdrop-blur-lg">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-muted-foreground">Toggle Columns</p>
          {hiddenCount > 0 && (
            <button
              onClick={onShowAll}
              className="text-[10px] text-primary hover:text-primary/80 transition-colors duration-150 cursor-pointer"
            >
              Show All
            </button>
          )}
        </div>
        <div className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
          {visibleCols.map((col) => {
            const isVisible = !hiddenColumns.includes(col.id);
            return (
              <label
                key={col.id}
                className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/50 cursor-pointer text-xs"
              >
                <Checkbox
                  checked={isVisible}
                  onCheckedChange={() => onToggle(col.id)}
                  className="size-3.5"
                />
                <span className={cn(!isVisible && 'text-muted-foreground')}>
                  {col.label}
                </span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
